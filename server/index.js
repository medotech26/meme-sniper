import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const TRADES_FILE = path.join(DATA_DIR, 'trades.json');
const PORTFOLIO_FILE = path.join(DATA_DIR, 'portfolio.json');
const LOGS_FILE = path.join(DATA_DIR, 'logs.json');
const AUTO_FILE = path.join(DATA_DIR, 'automation.json');

const app = express();
app.use(cors());
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });

// ─── Data helpers ────────────────────────────────────────────────────────────
async function readJSON(file, def) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch { return def; }
}
async function writeJSON(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

async function appendLog(entry) {
  const logs = await readJSON(LOGS_FILE, []);
  logs.unshift({ id: uuidv4(), ts: new Date().toISOString(), ...entry });
  if (logs.length > 1000) logs.splice(1000);
  await writeJSON(LOGS_FILE, logs);
}

// ─── DexScreener proxy ───────────────────────────────────────────────────────
app.get('/api/dex/new', async (req, res) => {
  try {
    const MAX_AGE_H = 24;
    const MAX_AGE_MS = MAX_AGE_H * 3600000;

    // Rotate keyword searches — all biased toward "new" launch culture
    const queries = ['launch','new','gem','snipe','just','pump','meme','pepe','doge','inu','moon','based','chad'];
    const q = queries[Math.floor(Date.now() / 60000) % queries.length];

    const [searchRes, profilesRes] = await Promise.allSettled([
      fetch(`https://api.dexscreener.com/latest/dex/search?q=${q}`),
      fetch('https://api.dexscreener.com/token-profiles/latest/v1'),
    ]);

    let pairs = [];

    // Keyword search results — strict 24h filter
    if (searchRes.status === 'fulfilled') {
      const d = await searchRes.value.json();
      const fresh = (d.pairs || []).filter(p => {
        const liq = p.liquidity?.usd || 0;
        const ageMs = p.pairCreatedAt ? Date.now() - p.pairCreatedAt : Infinity;
        return parseFloat(p.priceUsd) > 0 && liq > 500 && ageMs < MAX_AGE_MS;
      });
      pairs.push(...fresh);
    }

    // Latest token profiles — these are the freshest discoveries
    if (profilesRes.status === 'fulfilled') {
      const profiles = await profilesRes.value.json();
      if (Array.isArray(profiles)) {
        await Promise.allSettled(
          profiles.slice(0, 20).map(async prof => {
            if (!prof.tokenAddress) return;
            try {
              const r3 = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${prof.tokenAddress}`);
              const td = await r3.json();
              if (td.pairs) pairs.push(...td.pairs);
            } catch {}
          })
        );
      }
    }

    // Keep only pairs < 24h old with valid price
    pairs = pairs.filter(p => {
      const ageMs = p.pairCreatedAt ? Date.now() - p.pairCreatedAt : Infinity;
      return parseFloat(p.priceUsd) > 0 && ageMs < MAX_AGE_MS;
    });

    // Dedupe
    const seen = new Set();
    pairs = pairs.filter(p => {
      if (seen.has(p.pairAddress)) return false;
      seen.add(p.pairAddress); return true;
    });

    // Sort newest first
    pairs.sort((a, b) => (b.pairCreatedAt || 0) - (a.pairCreatedAt || 0));

    res.json({ pairs, fetchedAt: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/dex/token/:address', async (req, res) => {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${req.params.address}`);
    const d = await r.json();
    res.json(d);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Claude AI analysis ──────────────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'No token provided' });

  const prompt = `Token: ${token.baseToken?.name} (${token.baseToken?.symbol})
Chain: ${token.chainId} | DEX: ${token.dexId}
Price: $${token.priceUsd}
Age: ${token.pairCreatedAt ? Math.round((Date.now()-token.pairCreatedAt)/60000)+'min' : 'unknown'}
5m: ${token.priceChange?.m5 ?? '?'}% | 1h: ${token.priceChange?.h1 ?? '?'}% | 6h: ${token.priceChange?.h6 ?? '?'}% | 24h: ${token.priceChange?.h24 ?? '?'}%
Volume 24h: $${token.volume?.h24 ?? 0} | Liquidity: $${token.liquidity?.usd ?? 0}
Market Cap: $${token.marketCap ?? 0} | FDV: $${token.fdv ?? 0}
Txns 24h: buys=${token.txns?.h24?.buys??0} sells=${token.txns?.h24?.sells??0}`;

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 500,
      system: `You are an aggressive meme coin sniper AI analyzing fresh DEX launches for paper trading.
Return ONLY valid JSON (no markdown) with this exact shape:
{
  "verdict": "BUY" | "SELL" | "WAIT" | "DEGEN",
  "confidence": 0-100,
  "risk": 1-5,
  "reasoning": "2-3 sentence analysis",
  "entry": "price or range",
  "target": "take-profit price",
  "stopLoss": "stop-loss price",
  "redFlags": ["flag1","flag2"],
  "catalysts": ["cat1","cat2"]
}
Verdict guide:
- BUY: positive momentum, buy pressure > sell pressure, growing liquidity, promising volume/liq ratio
- DEGEN: high risk but strong upside signals (very new, thin liq, but explosive volume or buys)
- WAIT: mixed or neutral signals, no clear edge
- SELL: declining momentum, more sells than buys, falling price, likely dump
Risk 1=safe, 5=likely rug. Be decisive — most fresh meme launches with net buy pressure deserve BUY or DEGEN, not WAIT. Base decisions on momentum direction, volume/liq ratio, buy vs sell tx count, and age.`,
      messages: [{ role: 'user', content: prompt }]
    });

    let analysis;
    try {
      const text = msg.content[0].text.replace(/```json|```/g, '').trim();
      analysis = JSON.parse(text);
    } catch {
      analysis = { verdict: 'WAIT', confidence: 50, risk: 3, reasoning: msg.content[0].text, entry: '—', target: '—', stopLoss: '—', redFlags: [], catalysts: [] };
    }

    const ageMin = token.pairCreatedAt ? Math.round((Date.now() - token.pairCreatedAt) / 60000) : null;
    console.log('\n─────────────────────────────────────────────');
    console.log(`🔍 ANALYSIS: ${token.baseToken?.name} (${token.baseToken?.symbol}) · ${token.chainId?.toUpperCase()}`);
    console.log(`   Age: ${ageMin != null ? ageMin + 'm' : 'unknown'} | Price: $${token.priceUsd} | Liq: $${token.liquidity?.usd ?? 0}`);
    console.log(`   Verdict: ${analysis.verdict} | Confidence: ${analysis.confidence}% | Risk: ${analysis.risk}/5`);
    console.log(`   Reasoning: ${analysis.reasoning}`);
    console.log(`   Entry: ${analysis.entry} | Target: ${analysis.target} | Stop: ${analysis.stopLoss}`);
    if (analysis.redFlags?.length)  console.log(`   ⚠  Red flags: ${analysis.redFlags.join(', ')}`);
    if (analysis.catalysts?.length) console.log(`   ✦  Catalysts: ${analysis.catalysts.join(', ')}`);
    console.log('─────────────────────────────────────────────\n');

    await appendLog({ type: 'analysis', token: token.baseToken?.symbol, chain: token.chainId, analysis });
    res.json(analysis);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Portfolio ───────────────────────────────────────────────────────────────
app.get('/api/portfolio', async (req, res) => {
  const p = await readJSON(PORTFOLIO_FILE, { cash: 10000, startingCash: 10000, createdAt: new Date().toISOString() });
  res.json(p);
});

app.post('/api/portfolio/reset', async (req, res) => {
  const p = { cash: 10000, startingCash: 10000, createdAt: new Date().toISOString() };
  await writeJSON(PORTFOLIO_FILE, p);
  await appendLog({ type: 'portfolio_reset' });
  res.json(p);
});

// ─── Trades ──────────────────────────────────────────────────────────────────
app.get('/api/trades', async (req, res) => {
  const trades = await readJSON(TRADES_FILE, []);
  res.json(trades);
});

app.post('/api/trades/buy', async (req, res) => {
  const { token, usdAmount, aiVerdict, aiConfidence, aiReasoning } = req.body;
  const portfolio = await readJSON(PORTFOLIO_FILE, { cash: 10000, startingCash: 10000 });
  const trades = await readJSON(TRADES_FILE, []);

  const price = parseFloat(token.priceUsd);
  const amount = parseFloat(usdAmount);

  if (amount > portfolio.cash) return res.status(400).json({ error: 'Insufficient cash' });
  if (amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  const units = amount / price;
  const trade = {
    id: uuidv4(),
    type: 'BUY',
    ts: new Date().toISOString(),
    symbol: token.baseToken?.symbol,
    name: token.baseToken?.name,
    chain: token.chainId,
    pairAddress: token.pairAddress,
    baseTokenAddress: token.baseToken?.address || null,
    dexUrl: token.url,
    entryPrice: price,
    units,
    usdAmount: amount,
    aiVerdict: aiVerdict || null,
    aiConfidence: aiConfidence || null,
    aiReasoning: aiReasoning || null,
    status: 'OPEN',
    pnl: 0,
    pnlPct: 0
  };

  portfolio.cash -= amount;
  trades.unshift(trade);

  await writeJSON(PORTFOLIO_FILE, portfolio);
  await writeJSON(TRADES_FILE, trades);
  await appendLog({ type: 'trade_buy', symbol: trade.symbol, amount, price, aiVerdict, cashAfter: portfolio.cash });

  res.json({ trade, portfolio });
});

app.post('/api/trades/sell', async (req, res) => {
  const { tradeId, currentPrice, reason } = req.body;
  const portfolio = await readJSON(PORTFOLIO_FILE, { cash: 10000 });
  const trades = await readJSON(TRADES_FILE, []);

  const trade = trades.find(t => t.id === tradeId && t.status === 'OPEN');
  if (!trade) return res.status(404).json({ error: 'Open trade not found' });

  const exitPrice = parseFloat(currentPrice) || trade.entryPrice;
  const saleValue = trade.units * exitPrice;
  const pnl = saleValue - trade.usdAmount;
  const pnlPct = (pnl / trade.usdAmount) * 100;

  trade.status = 'CLOSED';
  trade.exitPrice = exitPrice;
  trade.exitTs = new Date().toISOString();
  trade.saleValue = saleValue;
  trade.pnl = pnl;
  trade.pnlPct = pnlPct;
  trade.closeReason = reason || 'manual';

  portfolio.cash += saleValue;

  await writeJSON(PORTFOLIO_FILE, portfolio);
  await writeJSON(TRADES_FILE, trades);
  await appendLog({ type: 'trade_sell', symbol: trade.symbol, pnl, pnlPct, exitPrice, reason, cashAfter: portfolio.cash });

  res.json({ trade, portfolio });
});

app.post('/api/trades/sell-all', async (_req, res) => {
  const portfolio = await readJSON(PORTFOLIO_FILE, { cash: 10000 });
  const trades = await readJSON(TRADES_FILE, []);
  const open = trades.filter(t => t.status === 'OPEN');

  if (open.length === 0) return res.json({ closed: 0, portfolio });

  let totalSaleValue = 0;

  await Promise.allSettled(open.map(async (trade) => {
    let exitPrice = trade.entryPrice;
    try {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/pairs/${trade.chain}/${trade.pairAddress}`);
      const d = await r.json();
      const price = parseFloat(d.pairs?.[0]?.priceUsd || d.pair?.priceUsd);
      if (price > 0) exitPrice = price;
    } catch {}

    const saleValue = trade.units * exitPrice;
    const pnl = saleValue - trade.usdAmount;
    const pnlPct = (pnl / trade.usdAmount) * 100;

    trade.status = 'CLOSED';
    trade.exitPrice = exitPrice;
    trade.exitTs = new Date().toISOString();
    trade.saleValue = saleValue;
    trade.pnl = pnl;
    trade.pnlPct = pnlPct;
    trade.closeReason = 'sell_all';

    totalSaleValue += saleValue;
    console.log(`   🔴 SELL-ALL: ${trade.symbol} @ ${exitPrice} | PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%)`);
  }));

  portfolio.cash += totalSaleValue;
  await writeJSON(PORTFOLIO_FILE, portfolio);
  await writeJSON(TRADES_FILE, trades);
  await appendLog({ type: 'sell_all', count: open.length, totalSaleValue, cashAfter: portfolio.cash });

  console.log(`\n💥 SELL ALL — closed ${open.length} position(s), returned $${totalSaleValue.toFixed(2)} to cash\n`);
  res.json({ closed: open.length, totalSaleValue, portfolio });
});

// ─── Automation ──────────────────────────────────────────────────────────────
let autoInterval = null;

app.get('/api/automation', async (req, res) => {
  const cfg = await readJSON(AUTO_FILE, {
    enabled: false, intervalSec: 60,
    minLiquidity: 5000, minConfidence: 70,
    maxRisk: 3, tradeSize: 200,
    autoBuy: false, autoSell: false,
    takeProfitPct: 50, stopLossPct: 20,
    maxAgeHours: 6,
    lastRun: null, runsTotal: 0
  });
  res.json({ ...cfg, running: autoInterval !== null });
});

app.post('/api/automation/config', async (req, res) => {
  const cfg = await readJSON(AUTO_FILE, {});
  const updated = { ...cfg, ...req.body, updatedAt: new Date().toISOString() };
  await writeJSON(AUTO_FILE, updated);
  await appendLog({ type: 'automation_config', config: req.body });
  res.json(updated);
});

async function runAutomation() {
  const cfg = await readJSON(AUTO_FILE, { enabled: false });
  if (!cfg.enabled) return;

  const maxAgeMs = (cfg.maxAgeHours || 6) * 3600000;
  await appendLog({ type: 'automation_scan_start' });

  try {
    const portfolio = await readJSON(PORTFOLIO_FILE, { cash: 10000, startingCash: 10000 });
    const trades = await readJSON(TRADES_FILE, []);
    const open = trades.filter(t => t.status === 'OPEN');
    const openValue = open.reduce((s, t) => s + t.usdAmount, 0);
    const deployedRatio = openValue / (portfolio.startingCash || 10000);
    const heavilyInvested = deployedRatio >= 0.5;

    console.log(`\n🤖 Automation scan — deployed: ${(deployedRatio * 100).toFixed(0)}% of start | ${heavilyInvested ? '🔴 SELL MODE' : '🟢 BUY MODE'}`);

    // Auto-sell: always check open positions first; when heavily invested use a lower take-profit threshold
    if (cfg.autoSell) {
      const effectiveTakeProfit = heavilyInvested ? Math.min(cfg.takeProfitPct, 20) : cfg.takeProfitPct;

      // Batch price lookup — one request per 30 positions instead of one per position
      const priceMap = {}; // pairAddress → currentPrice

      const withAddr = open.filter(t => t.baseTokenAddress);
      for (let i = 0; i < withAddr.length; i += 30) {
        const batch = withAddr.slice(i, i + 30);
        const addrList = batch.map(t => t.baseTokenAddress).join(',');
        try {
          const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addrList}`);
          const d = await r.json();
          (d.pairs || []).forEach(p => {
            if (!priceMap[p.pairAddress]) priceMap[p.pairAddress] = parseFloat(p.priceUsd);
          });
        } catch (e) {
          console.log(`   ❌ Batch price fetch failed: ${e.message}`);
        }
      }

      // Fallback: individual lookup for legacy trades without baseTokenAddress
      for (const trade of open.filter(t => !t.baseTokenAddress)) {
        try {
          const r = await fetch(`https://api.dexscreener.com/latest/dex/pairs/${trade.chain}/${trade.pairAddress}`);
          const d = await r.json();
          const price = parseFloat(d.pairs?.[0]?.priceUsd);
          if (price > 0) priceMap[trade.pairAddress] = price;
        } catch {}
      }

      console.log(`   💰 Prices fetched for ${Object.keys(priceMap).length}/${open.length} open positions`);

      for (const trade of open) {
        const currentPrice = priceMap[trade.pairAddress];
        if (!currentPrice) {
          console.log(`   ⚠  ${trade.symbol}: no price data, skipping`);
          continue;
        }
        const pnlPct = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;

        console.log(`   📊 ${trade.symbol}: entry=${trade.entryPrice} now=${currentPrice} pnl=${pnlPct.toFixed(1)}% | TP≥${effectiveTakeProfit}% SL≤-${cfg.stopLossPct}%`);

        let shouldSell = false;
        let reason = '';
        if (pnlPct >= effectiveTakeProfit) { shouldSell = true; reason = `take_profit_${pnlPct.toFixed(1)}pct`; }
        if (pnlPct <= -cfg.stopLossPct)    { shouldSell = true; reason = `stop_loss_${pnlPct.toFixed(1)}pct`; }

        if (shouldSell) {
          console.log(`   🔴 AUTO-SELL: ${trade.symbol} | Reason: ${reason} | PnL: ${pnlPct.toFixed(1)}%`);
          await fetch('http://localhost:3001/api/trades/sell', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tradeId: trade.id, currentPrice, reason })
          });
          await appendLog({ type: 'automation_sell', symbol: trade.symbol, pnlPct, reason });
        }
      }
    }

    // Skip new buys when more than 50% of starting cash is tied up in open positions
    if (heavilyInvested) {
      await appendLog({ type: 'automation_buy_skipped', reason: 'deployed_over_50pct', deployedPct: (deployedRatio * 100).toFixed(1) });
      console.log(`   ⏭  Skipping buys — ${(deployedRatio * 100).toFixed(0)}% of capital deployed. Focus: close positions.`);
    } else {
      // Fetch tokens
      const r = await fetch('http://localhost:3001/api/dex/new');
      const { pairs } = await r.json();

      const candidates = pairs
        .filter(p => {
          const ageMs = p.pairCreatedAt ? Date.now() - p.pairCreatedAt : Infinity;
          return (p.liquidity?.usd || 0) >= cfg.minLiquidity && ageMs <= maxAgeMs;
        })
        .sort((a, b) => (b.pairCreatedAt || 0) - (a.pairCreatedAt || 0))
        .slice(0, 10);

      console.log(`   Found ${pairs.length} pairs → ${candidates.length} candidates within age/liq filters`);

      for (const token of candidates) {
        const ar = await fetch('http://localhost:3001/api/analyze', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        });
        const analysis = await ar.json();

        await appendLog({
          type: 'automation_analysis',
          symbol: token.baseToken?.symbol,
          verdict: analysis.verdict,
          confidence: analysis.confidence,
          risk: analysis.risk
        });

        // Auto-buy logic — DEGEN is a valid buy signal for high-risk meme snipes
        if (cfg.autoBuy &&
            (analysis.verdict === 'BUY' || analysis.verdict === 'DEGEN') &&
            analysis.confidence >= cfg.minConfidence &&
            analysis.risk <= cfg.maxRisk) {
          console.log(`   🟢 AUTO-BUY: ${token.baseToken?.symbol} | ${analysis.verdict} ${analysis.confidence}% risk=${analysis.risk}/5`);
          console.log(`      Reason: ${analysis.reasoning}`);
          await fetch('http://localhost:3001/api/trades/buy', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              token, usdAmount: cfg.tradeSize,
              aiVerdict: analysis.verdict, aiConfidence: analysis.confidence,
              aiReasoning: analysis.reasoning
            })
          });
          await appendLog({ type: 'automation_buy', symbol: token.baseToken?.symbol, amount: cfg.tradeSize, analysis });
        }
      }
    }

    // Update run stats
    const updated = { ...cfg, lastRun: new Date().toISOString(), runsTotal: (cfg.runsTotal || 0) + 1 };
    await writeJSON(AUTO_FILE, updated);
  } catch (e) {
    await appendLog({ type: 'automation_error', error: e.message });
  }
}

app.post('/api/automation/start', async (req, res) => {
  const cfg = await readJSON(AUTO_FILE, { intervalSec: 60 });
  if (autoInterval) clearInterval(autoInterval);
  const updated = { ...cfg, enabled: true };
  await writeJSON(AUTO_FILE, updated);
  autoInterval = setInterval(runAutomation, (cfg.intervalSec || 60) * 1000);
  runAutomation(); // run immediately
  await appendLog({ type: 'automation_started', intervalSec: cfg.intervalSec });
  res.json({ status: 'started' });
});

app.post('/api/automation/stop', async (req, res) => {
  if (autoInterval) { clearInterval(autoInterval); autoInterval = null; }
  const cfg = await readJSON(AUTO_FILE, {});
  await writeJSON(AUTO_FILE, { ...cfg, enabled: false });
  await appendLog({ type: 'automation_stopped' });
  res.json({ status: 'stopped' });
});

// ─── Logs ─────────────────────────────────────────────────────────────────────
app.get('/api/logs', async (req, res) => {
  const { limit = 100, type } = req.query;
  let logs = await readJSON(LOGS_FILE, []);
  if (type) logs = logs.filter(l => l.type === type);
  res.json(logs.slice(0, parseInt(limit)));
});

app.get('/api/stats', async (req, res) => {
  const trades = await readJSON(TRADES_FILE, []);
  const portfolio = await readJSON(PORTFOLIO_FILE, { cash: 10000, startingCash: 10000 });
  const closed = trades.filter(t => t.status === 'CLOSED');
  const open = trades.filter(t => t.status === 'OPEN');

  const totalPnl = closed.reduce((s, t) => s + t.pnl, 0);
  const wins = closed.filter(t => t.pnl > 0);
  const losses = closed.filter(t => t.pnl <= 0);
  const openValue = open.reduce((s, t) => s + t.usdAmount, 0);
  const totalValue = portfolio.cash + openValue;

  res.json({
    totalValue,
    cash: portfolio.cash,
    startingCash: portfolio.startingCash,
    totalPnl,
    totalPnlPct: ((totalPnl / portfolio.startingCash) * 100),
    openPositions: open.length,
    closedTrades: closed.length,
    winRate: closed.length ? (wins.length / closed.length * 100) : 0,
    avgWin: wins.length ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0,
    avgLoss: losses.length ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0,
    bestTrade: closed.length ? Math.max(...closed.map(t => t.pnl)) : 0,
    worstTrade: closed.length ? Math.min(...closed.map(t => t.pnl)) : 0,
    openTrades: open
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`\n🚀 Meme Sniper API running on http://localhost:${PORT}\n`));
