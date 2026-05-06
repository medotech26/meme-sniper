import React, { useState, useEffect, useCallback, useRef } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts';

const API = '/api';

// ── Helpers ──────────────────────────────────────────────────────────────────
const fmt = (n, d = 2) => {
  if (n == null || isNaN(n)) return '—';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  if (n >= 1) return '$' + n.toFixed(d);
  if (n >= 0.001) return '$' + n.toFixed(4);
  if (n >= 0.000001) return '$' + n.toFixed(7);
  return '$' + n.toExponential(3);
};
const pct = v => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
const fmtAge = ts => {
  if (!ts) return '?';
  const m = Math.floor((Date.now() - ts) / 60000);
  return m < 60 ? m + 'm' : m < 1440 ? Math.floor(m / 60) + 'h' : Math.floor(m / 1440) + 'd';
};
const fmtDate = ts => {
  if (!ts) return '—';
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return time;
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + time;
};
const sigCfg = {
  BUY:   { bg: '#0d2b0d', border: '#1a5c1a', color: '#39ff5a', label: '▲ BUY' },
  SELL:  { bg: '#2b0d0d', border: '#5c1a1a', color: '#ff3a5c', label: '▼ SELL' },
  WAIT:  { bg: '#1a1a0a', border: '#4a4a00', color: '#ffe94d', label: '◆ WAIT' },
  DEGEN: { bg: '#1a0a00', border: '#5c2a00', color: '#ff8c00', label: '🎲 DEGEN' },
};

// ── Styles ───────────────────────────────────────────────────────────────────
const S = {
  app:    { fontFamily: "'Space Mono',monospace", background: '#08080f', color: '#e0ddf5', minHeight: '100vh', fontSize: 13 },
  topbar: { display:'flex', alignItems:'center', justifyContent:'space-between', padding:'10px 20px', background:'#0e0e1a', borderBottom:'1px solid #1e1e35', position:'sticky', top:0, zIndex:100 },
  logo:   { fontFamily:"'Unbounded',sans-serif", fontSize:15, fontWeight:900, letterSpacing:-0.5, display:'flex', alignItems:'baseline', gap:4 },
  badge:  (color='#39ff5a',bg='rgba(57,255,90,0.1)') => ({ display:'inline-flex', alignItems:'center', gap:5, background:bg, border:`1px solid ${color}33`, borderRadius:20, padding:'3px 10px', fontSize:10, color }),
  card:   { background:'#0e0e1a', border:'1px solid #1e1e35', borderRadius:10, padding:'14px 16px' },
  btn:    (active=false,color='#39ff5a') => ({ padding:'6px 14px', borderRadius:6, border:`1px solid ${active?color:'#2a2a45'}`, background:active?color+'22':'transparent', color:active?color:'#888', cursor:'pointer', fontFamily:'inherit', fontSize:11, transition:'all 0.15s' }),
  input:  { background:'#111119', border:'1px solid #2a2a45', borderRadius:6, padding:'8px 10px', color:'#e0ddf5', fontFamily:'inherit', fontSize:12, outline:'none', width:'100%' },
  label:  { fontSize:9, color:'#666', letterSpacing:1, textTransform:'uppercase', marginBottom:4, display:'block' },
  row:    { display:'flex', gap:10, alignItems:'center' },
  grid2:  { display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 },
  grid4:  { display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10 },
  statBox:{ background:'#111119', border:'1px solid #1e1e35', borderRadius:8, padding:'10px 12px' },
  tab:    (a) => ({ padding:'8px 16px', borderBottom:`2px solid ${a?'#39ff5a':'transparent'}`, color:a?'#39ff5a':'#666', cursor:'pointer', fontSize:11, letterSpacing:0.5, textTransform:'uppercase' }),
};

// ── Components ───────────────────────────────────────────────────────────────
const Dot = ({ color='#39ff5a' }) => (
  <span style={{ width:7, height:7, borderRadius:'50%', background:color, display:'inline-block', animation:'pulse 1.5s infinite' }} />
);

const SigBadge = ({ verdict }) => {
  const c = sigCfg[verdict] || sigCfg.WAIT;
  return <span style={{ padding:'3px 8px', borderRadius:4, background:c.bg, border:`1px solid ${c.border}`, color:c.color, fontSize:10, fontWeight:700 }}>{c.label}</span>;
};

const PnlText = ({ val, suffix='' }) => (
  <span style={{ color: val >= 0 ? '#39ff5a' : '#ff3a5c', fontWeight:700 }}>
    {val >= 0 ? '+' : ''}{val?.toFixed(2)}{suffix}
  </span>
);

// ── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState('feed');
  const [tokens, setTokens] = useState([]);
  const [selected, setSelected] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [stats, setStats] = useState(null);
  const [trades, setTrades] = useState([]);
  const [logs, setLogs] = useState([]);
  const [auto, setAuto] = useState(null);
  const [loading, setLoading] = useState(false);
  const [tradeAmt, setTradeAmt] = useState('200');
  const [tradeMsg, setTradeMsg] = useState('');
  const [chain, setChain] = useState('all');
  const [sort, setSort] = useState('age');
  const [tradeFilter, setTradeFilter] = useState({ status: 'all', result: 'all', signal: 'all', reason: 'all' });
  const [lastRefresh, setLastRefresh] = useState(null);
  const [portfolioLastRefresh, setPortfolioLastRefresh] = useState(null);
  const refreshRef = useRef(null);
  const portfolioIntervalRef = useRef(null);

  const fetchTokens = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/dex/new`);
      const d = await r.json();
      setTokens(d.pairs || []);
      setLastRefresh(new Date());
    } catch { }
    setLoading(false);
  }, []);

  const fetchStats  = useCallback(async () => { try { const r = await fetch(`${API}/stats`); setStats(await r.json()); } catch {} }, []);
  const fetchTrades = useCallback(async () => { try { const r = await fetch(`${API}/trades`); setTrades(await r.json()); } catch {} }, []);
  const fetchLogs   = useCallback(async () => { try { const r = await fetch(`${API}/logs?limit=200`); setLogs(await r.json()); } catch {} }, []);
  const fetchAuto   = useCallback(async () => { try { const r = await fetch(`${API}/automation`); setAuto(await r.json()); } catch {} }, []);

  useEffect(() => {
    fetchTokens(); fetchStats(); fetchTrades(); fetchLogs(); fetchAuto();
    refreshRef.current = setInterval(() => { fetchStats(); fetchTrades(); }, 30000);
    return () => clearInterval(refreshRef.current);
  }, []);

  // Fast 10s refresh when portfolio tab is active
  useEffect(() => {
    clearInterval(portfolioIntervalRef.current);
    if (tab === 'portfolio') {
      fetchStats(); fetchTrades();
      setPortfolioLastRefresh(new Date());
      portfolioIntervalRef.current = setInterval(() => {
        fetchStats(); fetchTrades();
        setPortfolioLastRefresh(new Date());
      }, 10000);
    }
    return () => clearInterval(portfolioIntervalRef.current);
  }, [tab]);

  const analyze = async (token) => {
    setAnalysis(null); setAnalyzing(true);
    try {
      const r = await fetch(`${API}/analyze`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ token }) });
      setAnalysis(await r.json());
    } catch { setAnalysis({ verdict:'WAIT', confidence:0, risk:3, reasoning:'Analysis failed.', entry:'—', target:'—', stopLoss:'—', redFlags:[], catalysts:[] }); }
    setAnalyzing(false);
  };

  const selectToken = (t) => { setSelected(t); setAnalysis(null); setTradeMsg(''); analyze(t); };

  const buy = async () => {
    if (!selected) return;
    const r = await fetch(`${API}/trades/buy`, { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ token:selected, usdAmount:parseFloat(tradeAmt), aiVerdict:analysis?.verdict, aiConfidence:analysis?.confidence, aiReasoning:analysis?.reasoning }) });
    const d = await r.json();
    if (d.error) { setTradeMsg('❌ ' + d.error); }
    else { setTradeMsg(`✅ Bought ${selected.baseToken?.symbol}`); fetchStats(); fetchTrades(); fetchLogs(); }
  };

  const sell = async (tradeId, currentPrice) => {
    const r = await fetch(`${API}/trades/sell`, { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ tradeId, currentPrice, reason:'manual' }) });
    const d = await r.json();
    if (!d.error) { fetchStats(); fetchTrades(); fetchLogs(); }
  };

  const sellAll = async () => {
    if (!openTrades.length) return;
    if (!window.confirm(`Sell all ${openTrades.length} open position(s) at current market price?`)) return;
    const r = await fetch(`${API}/trades/sell-all`, { method: 'POST' });
    const d = await r.json();
    if (!d.error) { fetchStats(); fetchTrades(); fetchLogs(); }
  };

  const saveAuto = async (changes) => {
    const r = await fetch(`${API}/automation/config`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(changes) });
    setAuto(await r.json());
  };

  const startAuto = async () => { await fetch(`${API}/automation/start`, { method:'POST' }); fetchAuto(); fetchLogs(); };
  const stopAuto  = async () => { await fetch(`${API}/automation/stop`,  { method:'POST' }); fetchAuto(); fetchLogs(); };
  const resetPort = async () => { if(!window.confirm('Reset portfolio to $10,000?')) return; await fetch(`${API}/portfolio/reset`, {method:'POST'}); fetchStats(); fetchTrades(); };

  // Filter/sort
  const visible = tokens
    .filter(t => chain === 'all' || t.chainId === chain)
    .sort((a, b) => {
      if (sort === 'age') return (b.pairCreatedAt||0) - (a.pairCreatedAt||0);
      if (sort === 'vol') return (b.volume?.h24||0) - (a.volume?.h24||0);
      if (sort === 'chg') return (b.priceChange?.h1||0) - (a.priceChange?.h1||0);
      if (sort === 'liq') return (b.liquidity?.usd||0) - (a.liquidity?.usd||0);
      return 0;
    });

  const openTrades = trades.filter(t => t.status === 'OPEN');
  const closedTrades = trades.filter(t => t.status === 'CLOSED');

  // P&L chart data
  const pnlChartData = closedTrades.slice().reverse().map((t, i) => ({
    name: t.symbol, pnl: +t.pnl.toFixed(2), idx: i + 1,
    fill: t.pnl >= 0 ? '#39ff5a' : '#ff3a5c'
  }));

  // Live portfolio value using current token prices for open positions
  const liveTotalValue = (() => {
    if (!stats) return 0;
    const liveOpen = openTrades.reduce((sum, t) => {
      const tok = tokens.find(x => x.pairAddress === t.pairAddress);
      const price = tok ? parseFloat(tok.priceUsd) : t.entryPrice;
      return sum + t.units * price;
    }, 0);
    return stats.cash + liveOpen;
  })();

  // Portfolio value over time — each closed trade is a data point with real timestamp
  const portfolioChartData = (() => {
    if (!stats) return [];
    const sorted = closedTrades.slice().reverse(); // chronological oldest→newest
    let running = stats.startingCash;

    const startTs = sorted.length > 0
      ? new Date(sorted[0].ts).getTime() - 60000
      : Date.now() - 60000;

    const points = [{ label: fmtDate(startTs), ts: startTs, value: running, event: 'Start' }];

    sorted.forEach(t => {
      running += t.pnl;
      const ts = new Date(t.exitTs).getTime();
      points.push({
        label: fmtDate(t.exitTs),
        ts,
        value: +running.toFixed(2),
        event: `${t.symbol} ${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)}`,
      });
    });

    points.push({
      label: fmtDate(Date.now()),
      ts: Date.now(),
      value: +liveTotalValue.toFixed(2),
      event: 'Now',
    });

    return points;
  })();

  return (
    <div style={S.app}>
      <style>{`
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 4px; background: #0e0e1a; }
        ::-webkit-scrollbar-thumb { background: #2a2a45; border-radius: 4px; }
        input:focus { border-color: #39ff5a !important; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.2} }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>

      {/* ── Topbar ── */}
      <div style={S.topbar}>
        <div style={S.row}>
          <div style={S.logo}>
            <span style={{ color:'#39ff5a' }}>SNIPER</span>
            <span style={{ color:'#ff3a5c' }}>.DEX</span>
            <span style={{ fontFamily:"'Space Mono'", fontSize:9, color:'#555', fontWeight:400, marginLeft:8 }}>Paper Trading</span>
          </div>
        </div>
        <div style={S.row}>
          {stats && (
            <span style={{ fontSize:11, color: stats.totalPnl >= 0 ? '#39ff5a' : '#ff3a5c' }}>
              Portfolio: ${stats.totalValue?.toFixed(2)} ({stats.totalPnl >= 0 ? '+' : ''}{stats.totalPnl?.toFixed(2)})
            </span>
          )}
          <span style={S.badge(auto?.running ? '#39ff5a' : '#666')}>
            <Dot color={auto?.running ? '#39ff5a' : '#666'} />
            {auto?.running ? 'BOT ON' : 'BOT OFF'}
          </span>
          <button style={{ ...S.btn(), padding:'5px 12px' }} onClick={() => { fetchTokens(); fetchStats(); fetchTrades(); }}>
            {loading ? '⟳' : '↺'} Refresh
          </button>
          {openTrades.length > 0 && (
            <button style={{ ...S.btn(), padding:'5px 14px', color:'#ff3a5c', borderColor:'#5c1a1a', background:'rgba(255,58,92,0.08)', fontWeight:700 }} onClick={sellAll}>
              ▼ Sell All ({openTrades.length})
            </button>
          )}
          <button style={{ ...S.btn(), padding:'5px 12px', color:'#ff4444', borderColor:'#4a1a1a' }} onClick={resetPort}>Reset</button>
        </div>
      </div>

      {/* ── Tabs ── */}
      <div style={{ display:'flex', borderBottom:'1px solid #1e1e35', background:'#0e0e1a', padding:'0 20px' }}>
        {['feed','portfolio','trades','logs','automation'].map(t => (
          <div key={t} style={S.tab(tab===t)} onClick={() => { setTab(t); if(t==='logs') fetchLogs(); if(t==='trades') fetchTrades(); }}>{t}</div>
        ))}
      </div>

      {/* ── Feed Tab ── */}
      {tab === 'feed' && (
        <div style={{ display:'grid', gridTemplateColumns:'1fr 360px', height:'calc(100vh - 93px)' }}>
          {/* Left: token list */}
          <div style={{ borderRight:'1px solid #1e1e35', display:'flex', flexDirection:'column', overflow:'hidden' }}>
            {/* Controls */}
            <div style={{ padding:'8px 16px', background:'#0a0a12', borderBottom:'1px solid #1e1e35', display:'flex', gap:6, flexWrap:'wrap', alignItems:'center' }}>
              {['all','solana','ethereum','base','bsc','arbitrum'].map(c => (
                <button key={c} style={S.btn(chain===c)} onClick={() => setChain(c)}>{c}</button>
              ))}
              <div style={{ marginLeft:'auto', display:'flex', gap:6 }}>
                {[['age','🆕 New'],['vol','🔥 Vol'],['chg','📈 Movers'],['liq','💧 Liq']].map(([k,v]) => (
                  <button key={k} style={S.btn(sort===k)} onClick={() => setSort(k)}>{v}</button>
                ))}
              </div>
            </div>

            {/* Header */}
            <div style={{ display:'grid', gridTemplateColumns:'28px 1fr 90px 70px 70px 80px 75px 65px', padding:'6px 16px', background:'#0d0d18', borderBottom:'1px solid #1e1e35', fontSize:10, color:'#555', letterSpacing:0.5 }}>
              <div>#</div><div>Token</div><div style={{textAlign:'right'}}>Price</div>
              <div style={{textAlign:'right'}}>5m</div><div style={{textAlign:'right'}}>1h</div>
              <div style={{textAlign:'right'}}>Vol 24h</div><div style={{textAlign:'right'}}>Liquidity</div>
              <div style={{textAlign:'right'}}>Signal</div>
            </div>

            {/* Rows */}
            <div style={{ overflowY:'auto', flex:1 }}>
              {loading && !visible.length && (
                <div style={{ padding:30, textAlign:'center', color:'#555' }}>Fetching DexScreener…</div>
              )}
              {visible.map((t, i) => {
                const c5 = t.priceChange?.m5;
                const c1 = t.priceChange?.h1;
                const liq = t.liquidity?.usd || 0;
                const isNew = t.pairCreatedAt && (Date.now()-t.pairCreatedAt) < 10800000;
                const isSel = selected?.pairAddress === t.pairAddress;
                const hasPos = openTrades.some(tr => tr.pairAddress === t.pairAddress);

                return (
                  <div key={t.pairAddress || i}
                    onClick={() => selectToken(t)}
                    style={{ display:'grid', gridTemplateColumns:'28px 1fr 90px 70px 70px 80px 75px 65px',
                      padding:'9px 16px', borderBottom:'1px solid #111118', cursor:'pointer',
                      background: isSel ? '#131328' : 'transparent',
                      borderLeft: isSel ? '2px solid #39ff5a' : hasPos ? '2px solid #ffe94d' : '2px solid transparent',
                      alignItems:'center' }}>
                    <div style={{ color:'#444', fontSize:10 }}>{i+1}</div>
                    <div>
                      <div style={{ fontSize:12, fontWeight:700, display:'flex', alignItems:'center', gap:6 }}>
                        {t.baseToken?.name || t.baseToken?.symbol}
                        {t.url && <a href={t.url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} style={{ fontSize:9, color:'#4db8ff', textDecoration:'none', opacity:0.7 }} title="DexScreener">↗</a>}
                        {isNew && <span style={{ fontSize:8, padding:'1px 5px', background:'rgba(180,110,255,0.15)', color:'#b87bff', border:'1px solid rgba(180,110,255,0.3)', borderRadius:3 }}>NEW</span>}
                        {hasPos && <span style={{ fontSize:8, padding:'1px 5px', background:'rgba(255,233,77,0.15)', color:'#ffe94d', border:'1px solid rgba(255,233,77,0.3)', borderRadius:3 }}>IN</span>}
                        {liq < 2000 && <span style={{ fontSize:8, padding:'1px 5px', background:'rgba(255,58,92,0.1)', color:'#ff3a5c', border:'1px solid rgba(255,58,92,0.25)', borderRadius:3 }}>⚠</span>}
                      </div>
                      <div style={{ fontSize:9, color:'#666', marginTop:1, display:'flex', gap:6 }}>
                        <span>{t.baseToken?.symbol}</span>
                        <span style={{ padding:'0 4px', background:'#1a1a2a', borderRadius:2, textTransform:'uppercase' }}>{t.chainId}</span>
                        <span style={{ color:'#ff8c00' }}>{fmtAge(t.pairCreatedAt)}</span>
                      </div>
                    </div>
                    <div style={{ textAlign:'right', fontSize:11 }}>{fmt(parseFloat(t.priceUsd))}</div>
                    <div style={{ textAlign:'right', fontSize:11, color:c5>=0?'#39ff5a':'#ff3a5c', fontWeight:700 }}>{pct(c5)}</div>
                    <div style={{ textAlign:'right', fontSize:11, color:c1>=0?'#39ff5a':'#ff3a5c', fontWeight:700 }}>{pct(c1)}</div>
                    <div style={{ textAlign:'right', fontSize:10, color:'#888' }}>{fmt(t.volume?.h24)}</div>
                    <div style={{ textAlign:'right', fontSize:10, color:'#888' }}>{fmt(liq)}</div>
                    <div style={{ textAlign:'right' }}>
                      {(() => {
                        const c1v = t.priceChange?.h1 || 0;
                        const volLiq = liq > 0 ? (t.volume?.h24||0)/liq : 0;
                        let v = c1v > 30 && volLiq > 2 ? 'BUY' : c1v < -20 ? 'SELL' : c1v > 10 ? 'BUY' : 'WAIT';
                        if (liq < 1500) v = 'DEGEN';
                        return <SigBadge verdict={v} />;
                      })()}
                    </div>
                  </div>
                );
              })}
              {!loading && !visible.length && (
                <div style={{ padding:30, textAlign:'center', color:'#555' }}>No tokens. Click Refresh.</div>
              )}
            </div>
            {lastRefresh && <div style={{ padding:'4px 16px', fontSize:9, color:'#444', borderTop:'1px solid #111', background:'#0a0a12' }}>Last: {lastRefresh.toLocaleTimeString()} · {visible.length} tokens · {chain}</div>}
          </div>

          {/* Right: detail panel */}
          <div style={{ overflowY:'auto', padding:16, display:'flex', flexDirection:'column', gap:12 }}>
            {!selected ? (
              <div style={{ textAlign:'center', color:'#444', paddingTop:60 }}>
                <div style={{ fontSize:32, marginBottom:12 }}>🎯</div>
                <div style={{ fontSize:12 }}>Select a token to analyze & trade</div>
              </div>
            ) : (
              <>
                {/* Token header */}
                <div style={S.card}>
                  <div style={{ fontFamily:"'Unbounded'", fontSize:16, fontWeight:700, marginBottom:2 }}>{selected.baseToken?.name}</div>
                  <div style={{ fontSize:10, color:'#666', marginBottom:10 }}>{selected.baseToken?.symbol} · {selected.chainId?.toUpperCase()} · {selected.dexId}</div>
                  <div style={{ fontFamily:"'Unbounded'", fontSize:20, color:'#39ff5a' }}>{fmt(parseFloat(selected.priceUsd))}</div>
                  <div style={{ fontSize:11, color:(selected.priceChange?.h1||0)>=0?'#39ff5a':'#ff3a5c', marginTop:4 }}>
                    {pct(selected.priceChange?.h1)} (1h) &nbsp; {pct(selected.priceChange?.h24)} (24h)
                  </div>
                  <div style={{ marginTop:10, display:'flex', gap:6, flexWrap:'wrap', alignItems:'center' }}>
                    <span style={{ fontSize:9, color:'#ff8c00' }}>Age: {fmtAge(selected.pairCreatedAt)}</span>
                    {selected.url && <a href={selected.url} target="_blank" rel="noreferrer" style={{ fontSize:9, color:'#4db8ff' }}>↗ DexScreener</a>}
                  </div>
                  {openTrades.filter(t => t.pairAddress === selected.pairAddress).map(t => (
                    <button key={t.id} onClick={() => sell(t.id, parseFloat(selected.priceUsd))}
                      style={{ marginTop:12, width:'100%', padding:'10px', borderRadius:6, background:'rgba(255,58,92,0.15)', border:'2px solid #ff3a5c66', color:'#ff3a5c', fontFamily:'inherit', fontSize:13, fontWeight:700, cursor:'pointer', letterSpacing:0.5 }}>
                      ▼ SELL NOW · {t.symbol} &nbsp;<span style={{ fontSize:10, fontWeight:400, color:'#ff7a7a' }}>Est ${(t.units * parseFloat(selected.priceUsd))?.toFixed(2)}</span>
                    </button>
                  ))}
                </div>

                {/* Stats */}
                <div style={S.grid2}>
                  {[['Liquidity',fmt(selected.liquidity?.usd)],['Volume 24h',fmt(selected.volume?.h24)],['Market Cap',fmt(selected.marketCap)],['FDV',fmt(selected.fdv)]].map(([l,v])=>(
                    <div key={l} style={S.statBox}><div style={S.label}>{l}</div><div style={{ fontWeight:700 }}>{v}</div></div>
                  ))}
                </div>

                {/* AI Analysis */}
                <div style={S.card}>
                  <div style={{ fontSize:10, color:'#555', letterSpacing:1, textTransform:'uppercase', marginBottom:10 }}>🤖 Claude Analysis</div>
                  {analyzing ? (
                    <div style={{ color:'#555', fontSize:11 }}>Analyzing… ⟳</div>
                  ) : analysis ? (
                    <>
                      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10 }}>
                        <SigBadge verdict={analysis.verdict} />
                        <span style={{ fontSize:11 }}>Confidence: <strong style={{ color:'#39ff5a' }}>{analysis.confidence}%</strong></span>
                        <span style={{ fontSize:11 }}>Risk: <strong style={{ color: analysis.risk >= 4 ? '#ff3a5c' : analysis.risk >= 3 ? '#ff8c00' : '#39ff5a' }}>{analysis.risk}/5</strong></span>
                      </div>
                      <div style={{ fontSize:11, color:'#c0bde0', lineHeight:1.7, marginBottom:10 }}>{analysis.reasoning}</div>
                      <div style={S.grid2}>
                        {[['Entry',analysis.entry,'#4db8ff'],['Target',analysis.target,'#39ff5a'],['Stop Loss',analysis.stopLoss,'#ff3a5c']].map(([l,v,c])=>(
                          <div key={l} style={{ ...S.statBox, borderColor:c+'33' }}><div style={S.label}>{l}</div><div style={{ color:c, fontWeight:700, fontSize:12 }}>{v}</div></div>
                        ))}
                      </div>
                      {analysis.redFlags?.length > 0 && (
                        <div style={{ marginTop:8, fontSize:10, color:'#ff3a5c' }}>⚠ {analysis.redFlags.join(' · ')}</div>
                      )}
                      {analysis.catalysts?.length > 0 && (
                        <div style={{ marginTop:4, fontSize:10, color:'#39ff5a' }}>✦ {analysis.catalysts.join(' · ')}</div>
                      )}
                      <button style={{ ...S.btn(), marginTop:10, width:'100%', fontSize:10 }} onClick={() => analyze(selected)}>↺ Re-analyze</button>
                    </>
                  ) : null}
                </div>

                {/* Trade */}
                <div style={S.card}>
                  <div style={{ fontSize:10, color:'#555', letterSpacing:1, textTransform:'uppercase', marginBottom:10 }}>📋 Paper Trade</div>
                  {stats && <div style={{ fontSize:11, marginBottom:8 }}>Cash: <strong style={{ color:'#39ff5a' }}>${stats.cash?.toFixed(2)}</strong></div>}
                  <div style={{ marginBottom:8 }}>
                    <label style={S.label}>Amount (USD)</label>
                    <input style={S.input} type="number" value={tradeAmt} onChange={e => setTradeAmt(e.target.value)} min="1" />
                  </div>
                  <button onClick={buy} style={{ width:'100%', padding:'10px', borderRadius:6, background:'#39ff5a22', border:'1px solid #39ff5a44', color:'#39ff5a', fontFamily:'inherit', fontSize:12, fontWeight:700, cursor:'pointer', letterSpacing:0.5 }}>
                    ▲ BUY {selected.baseToken?.symbol}
                  </button>
                  {tradeMsg && <div style={{ marginTop:6, fontSize:11, color: tradeMsg.startsWith('✅') ? '#39ff5a' : '#ff3a5c' }}>{tradeMsg}</div>}

                  {/* Open position for this token */}
                  {openTrades.filter(t => t.pairAddress === selected.pairAddress).map(t => (
                    <div key={t.id} style={{ marginTop:10, padding:10, background:'#111', borderRadius:6, border:'1px solid #2a2a45' }}>
                      <div style={{ fontSize:11, marginBottom:6 }}>Open position: <strong>{t.units?.toExponential(3)}</strong> units @ {fmt(t.entryPrice)}</div>
                      <div style={{ fontSize:11, marginBottom:8 }}>Cost: ${t.usdAmount?.toFixed(2)} · Est value: ${(t.units * parseFloat(selected.priceUsd))?.toFixed(2)}</div>
                      <button onClick={() => sell(t.id, parseFloat(selected.priceUsd))}
                        style={{ width:'100%', padding:'8px', borderRadius:6, background:'#ff3a5c22', border:'1px solid #ff3a5c44', color:'#ff3a5c', fontFamily:'inherit', fontSize:11, fontWeight:700, cursor:'pointer' }}>
                        ▼ SELL {t.symbol}
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Portfolio Tab ── */}
      {tab === 'portfolio' && (
        <div style={{ padding:20, maxWidth:1100, margin:'0 auto' }}>
          {stats && (
            <>
              <div style={S.grid4}>
                {[
                  ['Total Value', '$'+stats.totalValue?.toFixed(2), stats.totalPnl >= 0 ? '#39ff5a' : '#ff3a5c'],
                  ['Total P&L', (stats.totalPnl>=0?'+':'')+stats.totalPnl?.toFixed(2), stats.totalPnl>=0?'#39ff5a':'#ff3a5c'],
                  ['Win Rate', stats.winRate?.toFixed(1)+'%', '#ffe94d'],
                  ['Open Positions', stats.openPositions, '#4db8ff'],
                ].map(([l,v,c]) => (
                  <div key={l} style={{ ...S.statBox, borderRadius:10, padding:16 }}>
                    <div style={{ fontSize:10, color:'#555', letterSpacing:1, textTransform:'uppercase', marginBottom:6 }}>{l}</div>
                    <div style={{ fontSize:22, fontWeight:700, color:c, fontFamily:"'Unbounded'" }}>{v}</div>
                  </div>
                ))}
              </div>
              <div style={{ ...S.grid2, gridTemplateColumns:'repeat(4,1fr)', marginTop:10 }}>
                {[
                  ['Cash', '$'+stats.cash?.toFixed(2)],
                  ['Closed Trades', stats.closedTrades],
                  ['Avg Win', '+'+stats.avgWin?.toFixed(1)+'%'],
                  ['Avg Loss', stats.avgLoss?.toFixed(1)+'%'],
                ].map(([l,v]) => (
                  <div key={l} style={{ ...S.statBox, borderRadius:10 }}>
                    <div style={{ fontSize:9, color:'#555', letterSpacing:1, textTransform:'uppercase', marginBottom:4 }}>{l}</div>
                    <div style={{ fontSize:16, fontWeight:700 }}>{v}</div>
                  </div>
                ))}
              </div>

              {/* Portfolio performance chart */}
              {portfolioChartData.length > 1 && (
                <div style={{ ...S.card, marginTop:16 }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
                    <div>
                      <div style={{ fontSize:10, color:'#555', letterSpacing:1, textTransform:'uppercase', marginBottom:3 }}>Portfolio Performance</div>
                      {portfolioLastRefresh && (
                        <div style={{ fontSize:9, color:'#444' }}>Updated {portfolioLastRefresh.toLocaleTimeString()}</div>
                      )}
                    </div>
                    <div style={{ display:'flex', alignItems:'center', gap:12 }}>
                      <div style={{ textAlign:'right' }}>
                        <div style={{ fontSize:16, fontWeight:700, fontFamily:"'Unbounded'", color: liveTotalValue >= stats.startingCash ? '#39ff5a' : '#ff3a5c' }}>
                          ${liveTotalValue.toFixed(2)}
                        </div>
                        <div style={{ fontSize:10, color:'#666' }}>
                          {(liveTotalValue - stats.startingCash) >= 0 ? '+' : ''}${(liveTotalValue - stats.startingCash).toFixed(2)}
                          &nbsp;({((liveTotalValue - stats.startingCash) / stats.startingCash * 100).toFixed(1)}%)
                        </div>
                      </div>
                      <button style={{ ...S.btn(), padding:'4px 10px', fontSize:10 }} onClick={() => { fetchStats(); fetchTrades(); setPortfolioLastRefresh(new Date()); }}>↺</button>
                    </div>
                  </div>
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={portfolioChartData} margin={{ top:4, right:8, left:0, bottom:40 }}>
                      <XAxis
                        dataKey="label"
                        tick={{ fill:'#555', fontSize:9 }}
                        angle={-35}
                        textAnchor="end"
                        interval="preserveStartEnd"
                        height={55}
                      />
                      <YAxis tick={{ fill:'#555', fontSize:9 }} tickFormatter={v=>'$'+v} domain={['auto','auto']} width={65} />
                      <Tooltip
                        contentStyle={{ background:'#0e0e1a', border:'1px solid #2a2a45', fontFamily:'Space Mono', fontSize:11 }}
                        formatter={(v, _, props) => [`$${v.toFixed(2)}`, props.payload.event]}
                        labelStyle={{ color:'#555', fontSize:9 }}
                      />
                      <Line
                        type="monotone" dataKey="value" stroke="#39ff5a" strokeWidth={2}
                        dot={{ r:3, fill:'#39ff5a', strokeWidth:0 }}
                        activeDot={{ r:5, fill:'#fff', stroke:'#39ff5a', strokeWidth:2 }}
                        isAnimationActive={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* Per-trade P&L bars */}
              {pnlChartData.length > 0 && (
                <div style={{ ...S.card, marginTop:16 }}>
                  <div style={{ fontSize:10, color:'#555', letterSpacing:1, textTransform:'uppercase', marginBottom:12 }}>Trade P&L History</div>
                  <ResponsiveContainer width="100%" height={180}>
                    <BarChart data={pnlChartData}>
                      <XAxis dataKey="name" tick={{ fill:'#555', fontSize:9 }} />
                      <YAxis tick={{ fill:'#555', fontSize:9 }} tickFormatter={v=>'$'+v} />
                      <Tooltip contentStyle={{ background:'#0e0e1a', border:'1px solid #2a2a45', fontFamily:'Space Mono' }} formatter={v=>['$'+v,'P&L']} />
                      <Bar dataKey="pnl" fill="#39ff5a" radius={[3,3,0,0]} label={false} style={{ transition:'fill 0.2s' }} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* Open positions */}
              <div style={{ ...S.card, marginTop:16 }}>
                <div style={{ fontSize:10, color:'#555', letterSpacing:1, textTransform:'uppercase', marginBottom:12 }}>Open Positions</div>
                {openTrades.length === 0 && <div style={{ color:'#444', fontSize:11 }}>No open positions.</div>}
                {openTrades.map(t => {
                  const tok = tokens.find(x => x.pairAddress === t.pairAddress);
                  const curPrice = tok ? parseFloat(tok.priceUsd) : t.entryPrice;
                  const curVal = t.units * curPrice;
                  const pnl = curVal - t.usdAmount;
                  const pnlPct = (pnl / t.usdAmount) * 100;
                  return (
                    <div key={t.id} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'10px 0', borderBottom:'1px solid #111' }}>
                      <div>
                        <strong>{t.dexUrl ? <a href={t.dexUrl} target="_blank" rel="noreferrer" style={{ color:'inherit', textDecoration:'none', borderBottom:'1px dotted #4db8ff' }}>{t.symbol} <span style={{ fontSize:9, color:'#4db8ff' }}>↗</span></a> : t.symbol}</strong>
                        <span style={{ marginLeft:8, fontSize:9, color:'#666' }}>{t.chain}</span>
                        {t.aiVerdict && <SigBadge verdict={t.aiVerdict} />}
                      </div>
                      <div style={{ textAlign:'right' }}>
                        <div style={{ fontSize:11 }}>Entry: {fmt(t.entryPrice)} → Now: {fmt(curPrice)}</div>
                        <PnlText val={pnl} /> &nbsp;
                        <span style={{ color: pnlPct >= 0 ? '#39ff5a' : '#ff3a5c', fontSize:11 }}>({pnlPct>=0?'+':''}{pnlPct?.toFixed(1)}%)</span>
                      </div>
                      <button onClick={() => sell(t.id, curPrice)} style={{ ...S.btn(), color:'#ff3a5c', borderColor:'#4a1a1a', marginLeft:10, padding:'5px 10px' }}>SELL</button>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Trades Tab ── */}
      {tab === 'trades' && (() => {
        const tf = tradeFilter;
        const setTf = setTradeFilter;
        const isDefault = tf.status==='all' && tf.result==='all' && tf.signal==='all' && tf.reason==='all';

        const filtered = trades.filter(t => {
          if (tf.status === 'open'   && t.status !== 'OPEN')   return false;
          if (tf.status === 'closed' && t.status !== 'CLOSED') return false;
          if (tf.result === 'wins'   && (t.status !== 'CLOSED' || t.pnl <= 0))  return false;
          if (tf.result === 'losses' && (t.status !== 'CLOSED' || t.pnl >= 0))  return false;
          if (tf.signal !== 'all' && t.aiVerdict !== tf.signal) return false;
          if (tf.reason === 'manual'   && t.closeReason !== 'manual')                   return false;
          if (tf.reason === 'tp'       && !t.closeReason?.startsWith('take_profit'))     return false;
          if (tf.reason === 'sl'       && !t.closeReason?.startsWith('stop_loss'))       return false;
          if (tf.reason === 'sell_all' && t.closeReason !== 'sell_all')                 return false;
          if (tf.reason === 'bot'      && t.closeReason !== 'automation')               return false;
          return true;
        });

        const filteredPnl = filtered.filter(t => t.status === 'CLOSED').reduce((s, t) => s + t.pnl, 0);

        return (
          <div style={{ padding:20 }}>
            {/* Filter bar */}
            <div style={{ ...S.card, padding:'10px 14px', marginBottom:12 }}>
              <div style={{ display:'flex', gap:20, flexWrap:'wrap', alignItems:'center' }}>

                <div style={{ display:'flex', gap:4, alignItems:'center' }}>
                  <span style={{ ...S.label, marginBottom:0, marginRight:4 }}>Status</span>
                  {[['all','All'], ['open','Open'], ['closed','Closed']].map(([k,v]) => (
                    <button key={k} style={S.btn(tf.status===k)} onClick={() => setTf(f=>({...f, status:k}))}>{v}</button>
                  ))}
                </div>

                <div style={{ display:'flex', gap:4, alignItems:'center' }}>
                  <span style={{ ...S.label, marginBottom:0, marginRight:4 }}>Result</span>
                  {[['all','All'], ['wins','✅ Wins'], ['losses','❌ Losses']].map(([k,v]) => (
                    <button key={k} style={S.btn(tf.result===k)} onClick={() => setTf(f=>({...f, result:k}))}>{v}</button>
                  ))}
                </div>

                <div style={{ display:'flex', gap:4, alignItems:'center' }}>
                  <span style={{ ...S.label, marginBottom:0, marginRight:4 }}>Signal</span>
                  {[['all','All'], ['BUY','BUY'], ['DEGEN','DEGEN'], ['WAIT','WAIT'], ['SELL','SELL']].map(([k,v]) => (
                    <button key={k} style={S.btn(tf.signal===k)} onClick={() => setTf(f=>({...f, signal:k}))}>{v}</button>
                  ))}
                </div>

                <div style={{ display:'flex', gap:4, alignItems:'center' }}>
                  <span style={{ ...S.label, marginBottom:0, marginRight:4 }}>Close</span>
                  {[['all','All'], ['manual','Manual'], ['tp','Take Profit'], ['sl','Stop Loss'], ['sell_all','Sell All']].map(([k,v]) => (
                    <button key={k} style={S.btn(tf.reason===k)} onClick={() => setTf(f=>({...f, reason:k}))}>{v}</button>
                  ))}
                </div>

                {!isDefault && (
                  <button style={{ ...S.btn(), marginLeft:'auto', color:'#ff8c00', borderColor:'#5c3a00' }}
                    onClick={() => setTf({ status:'all', result:'all', signal:'all', reason:'all' })}>
                    ✕ Clear
                  </button>
                )}
              </div>
            </div>

            {/* Summary row */}
            <div style={{ display:'flex', gap:16, marginBottom:10, alignItems:'center' }}>
              <span style={{ fontSize:10, color:'#555', letterSpacing:1, textTransform:'uppercase' }}>
                {filtered.length} of {trades.length} trades
              </span>
              {filtered.some(t => t.status === 'CLOSED') && (
                <span style={{ fontSize:11, color: filteredPnl >= 0 ? '#39ff5a' : '#ff3a5c', fontWeight:700 }}>
                  P&L: {filteredPnl >= 0 ? '+' : ''}${filteredPnl.toFixed(2)}
                </span>
              )}
            </div>

            <div style={{ ...S.card, padding:0, overflow:'auto', maxHeight:'calc(100vh - 240px)' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
                <thead style={{ position:'sticky', top:0, zIndex:2 }}>
                  <tr style={{ background:'#0a0a14', borderBottom:'1px solid #1e1e35' }}>
                    {['Buy Time','Sell Time','Token','Chain','Type','Entry','Exit','Units','Cost','P&L','P&L%','AI Signal','Reason'].map(h => (
                      <th key={h} style={{ padding:'8px 12px', textAlign:'left', fontSize:9, color:'#555', letterSpacing:0.5, fontWeight:400, whiteSpace:'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(t => (
                    <tr key={t.id} style={{ borderBottom:'1px solid #111', cursor:'default' }}
                      onMouseEnter={e => e.currentTarget.style.background='#0d0d18'}
                      onMouseLeave={e => e.currentTarget.style.background='transparent'}>
                      <td style={{ padding:'7px 12px', color:'#666', fontSize:10, whiteSpace:'nowrap' }}>{fmtDate(t.ts)}</td>
                      <td style={{ padding:'7px 12px', color: t.exitTs ? '#888' : '#333', fontSize:10, whiteSpace:'nowrap' }}>{fmtDate(t.exitTs)}</td>
                      <td style={{ padding:'7px 12px', fontWeight:700 }}>{t.dexUrl ? <a href={t.dexUrl} target="_blank" rel="noreferrer" style={{ color:'inherit', textDecoration:'none', borderBottom:'1px dotted #4db8ff' }}>{t.symbol} <span style={{ fontSize:9, color:'#4db8ff' }}>↗</span></a> : t.symbol}</td>
                      <td style={{ padding:'7px 12px', color:'#888', fontSize:10, textTransform:'uppercase' }}>{t.chain}</td>
                      <td style={{ padding:'7px 12px' }}><span style={{ color: t.type==='BUY'?'#39ff5a':'#ff3a5c', fontWeight:700 }}>{t.type}</span></td>
                      <td style={{ padding:'7px 12px' }}>{fmt(t.entryPrice)}</td>
                      <td style={{ padding:'7px 12px', color:'#888' }}>{t.exitPrice ? fmt(t.exitPrice) : '—'}</td>
                      <td style={{ padding:'7px 12px', color:'#888', fontSize:10 }}>{t.units?.toExponential(2)}</td>
                      <td style={{ padding:'7px 12px' }}>${t.usdAmount?.toFixed(2)}</td>
                      <td style={{ padding:'7px 12px' }}>
                        {t.status === 'CLOSED' ? <PnlText val={t.pnl} suffix="" /> : <span style={{ color:'#ffe94d' }}>OPEN</span>}
                      </td>
                      <td style={{ padding:'7px 12px' }}>
                        {t.status === 'CLOSED' ? <span style={{ color: t.pnlPct>=0?'#39ff5a':'#ff3a5c', fontWeight:700 }}>{t.pnlPct>=0?'+':''}{t.pnlPct?.toFixed(1)}%</span> : '—'}
                      </td>
                      <td style={{ padding:'7px 12px' }}>{t.aiVerdict ? <SigBadge verdict={t.aiVerdict} /> : <span style={{ color:'#444' }}>—</span>}</td>
                      <td style={{ padding:'7px 12px', color:'#666', fontSize:10, maxWidth:220 }}>
                        {t.closeReason
                          ? <span style={{ color:'#ff8c00' }}>{t.closeReason}</span>
                          : t.aiReasoning
                            ? <span title={t.aiReasoning} style={{ cursor:'help', borderBottom:'1px dotted #444', color:'#a0a0c0' }}>
                                {t.aiReasoning.length > 70 ? t.aiReasoning.slice(0, 70) + '…' : t.aiReasoning}
                              </span>
                            : <span style={{ color:'#333' }}>—</span>}
                      </td>
                    </tr>
                  ))}
                  {filtered.length === 0 && (
                    <tr><td colSpan={13} style={{ padding:30, textAlign:'center', color:'#444' }}>
                      No trades match the current filters.
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      {/* ── Logs Tab ── */}
      {tab === 'logs' && (
        <div style={{ padding:20 }}>
          <div style={{ display:'flex', justifyContent:'space-between', marginBottom:12, alignItems:'center' }}>
            <div style={{ fontSize:10, color:'#555', letterSpacing:1, textTransform:'uppercase' }}>Activity Logs — {logs.length} entries</div>
            <button style={S.btn()} onClick={fetchLogs}>↺ Refresh</button>
          </div>
          <div style={{ ...S.card, padding:0, maxHeight:'calc(100vh - 160px)', overflowY:'auto' }}>
            {logs.map(l => (
              <div key={l.id} style={{ padding:'8px 16px', borderBottom:'1px solid #0f0f1a', display:'flex', gap:16, fontSize:11, alignItems:'flex-start' }}>
                <span style={{ color:'#444', fontSize:10, whiteSpace:'nowrap', minWidth:140 }}>{new Date(l.ts).toLocaleString()}</span>
                <span style={{ padding:'1px 7px', borderRadius:3, fontSize:9, fontWeight:700, background:
                  l.type.includes('buy')?'rgba(57,255,90,0.1)':
                  l.type.includes('sell')?'rgba(255,58,92,0.1)':
                  l.type.includes('error')?'rgba(255,58,92,0.15)':
                  l.type.includes('auto')?'rgba(77,184,255,0.1)':'rgba(255,233,77,0.1)',
                  color:l.type.includes('buy')?'#39ff5a':l.type.includes('sell')?'#ff3a5c':l.type.includes('error')?'#ff3a5c':l.type.includes('auto')?'#4db8ff':'#ffe94d',
                  whiteSpace:'nowrap' }}>{l.type}</span>
                <span style={{ color:'#c0bde0', flex:1, fontSize:10 }}>
                  {l.symbol && <strong>{l.symbol} </strong>}
                  {l.verdict && `verdict=${l.verdict} `}
                  {l.confidence && `conf=${l.confidence}% `}
                  {l.pnl != null && <PnlText val={l.pnl} suffix="" />}
                  {l.amount && ` $${l.amount}`}
                  {l.price && ` @ ${fmt(l.price)}`}
                  {l.reason && ` [${l.reason}]`}
                  {l.error && <span style={{ color:'#ff3a5c' }}> {l.error}</span>}
                  {l.cashAfter != null && (
                    <span style={{ marginLeft:8, padding:'1px 7px', borderRadius:3, background:'rgba(255,233,77,0.08)', border:'1px solid rgba(255,233,77,0.2)', color:'#ffe94d', fontSize:9, whiteSpace:'nowrap' }}>
                      balance ${l.cashAfter.toFixed(2)}
                    </span>
                  )}
                </span>
              </div>
            ))}
            {logs.length === 0 && <div style={{ padding:30, textAlign:'center', color:'#444' }}>No logs yet.</div>}
          </div>
        </div>
      )}

      {/* ── Automation Tab ── */}
      {tab === 'automation' && auto && (
        <div style={{ padding:20, maxWidth:700, margin:'0 auto' }}>
          <div style={{ ...S.card, marginBottom:16 }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
              <div>
                <div style={{ fontFamily:"'Unbounded'", fontSize:15, fontWeight:700, marginBottom:4 }}>Automation Bot</div>
                <div style={{ fontSize:11, color:'#888' }}>
                  Status: <span style={{ color:auto.running?'#39ff5a':'#ff3a5c', fontWeight:700 }}>{auto.running?'RUNNING':'STOPPED'}</span>
                  {auto.lastRun && <span style={{ marginLeft:12, color:'#555' }}>Last run: {new Date(auto.lastRun).toLocaleTimeString()}</span>}
                  {auto.runsTotal > 0 && <span style={{ marginLeft:12, color:'#555' }}>Total runs: {auto.runsTotal}</span>}
                </div>
              </div>
              <div style={S.row}>
                <button onClick={startAuto} style={{ ...S.btn(!auto.running,'#39ff5a'), padding:'8px 18px', fontWeight:700 }}>▶ Start</button>
                <button onClick={stopAuto}  style={{ ...S.btn(auto.running,'#ff3a5c'),  padding:'8px 18px', fontWeight:700 }}>■ Stop</button>
              </div>
            </div>

            {/* Config */}
            <div style={{ borderTop:'1px solid #1e1e35', paddingTop:14 }}>
              <div style={{ fontSize:10, color:'#555', letterSpacing:1, textTransform:'uppercase', marginBottom:12 }}>Configuration</div>
              <div style={S.grid2}>
                <div>
                  <label style={S.label}>Scan Interval (seconds)</label>
                  <input style={S.input} type="number" defaultValue={auto.intervalSec} onBlur={e => saveAuto({ intervalSec: +e.target.value })} />
                </div>
                <div>
                  <label style={S.label}>Trade Size (USD)</label>
                  <input style={S.input} type="number" defaultValue={auto.tradeSize} onBlur={e => saveAuto({ tradeSize: +e.target.value })} />
                </div>
                <div>
                  <label style={S.label}>Min Liquidity (USD)</label>
                  <input style={S.input} type="number" defaultValue={auto.minLiquidity} onBlur={e => saveAuto({ minLiquidity: +e.target.value })} />
                </div>
                <div>
                  <label style={S.label}>Min AI Confidence (%)</label>
                  <input style={S.input} type="number" defaultValue={auto.minConfidence} onBlur={e => saveAuto({ minConfidence: +e.target.value })} />
                </div>
                <div>
                  <label style={S.label}>Max Risk Level (1-5)</label>
                  <input style={S.input} type="number" defaultValue={auto.maxRisk} min="1" max="5" onBlur={e => saveAuto({ maxRisk: +e.target.value })} />
                </div>
                <div>
                  <label style={S.label}>Take Profit (%)</label>
                  <input style={S.input} type="number" defaultValue={auto.takeProfitPct} onBlur={e => saveAuto({ takeProfitPct: +e.target.value })} />
                </div>
                <div>
                  <label style={S.label}>Stop Loss (%)</label>
                  <input style={S.input} type="number" defaultValue={auto.stopLossPct} onBlur={e => saveAuto({ stopLossPct: +e.target.value })} />
                </div>
                <div>
                  <label style={S.label}>Max Coin Age (hours)</label>
                  <input style={S.input} type="number" defaultValue={auto.maxAgeHours ?? 6} min="1" max="24" onBlur={e => saveAuto({ maxAgeHours: +e.target.value })} />
                </div>
              </div>

              <div style={{ marginTop:16, display:'flex', gap:16 }}>
                <label style={{ display:'flex', alignItems:'center', gap:8, cursor:'pointer', fontSize:12 }}>
                  <input type="checkbox" defaultChecked={auto.autoBuy} onChange={e => saveAuto({ autoBuy: e.target.checked })} />
                  <span style={{ color: auto.autoBuy ? '#39ff5a' : '#888' }}>Auto-Buy on BUY signal</span>
                </label>
                <label style={{ display:'flex', alignItems:'center', gap:8, cursor:'pointer', fontSize:12 }}>
                  <input type="checkbox" defaultChecked={auto.autoSell} onChange={e => saveAuto({ autoSell: e.target.checked })} />
                  <span style={{ color: auto.autoSell ? '#ff3a5c' : '#888' }}>Auto-Sell (TP/SL)</span>
                </label>
              </div>
            </div>
          </div>

          <div style={{ ...S.card, background:'rgba(255,58,92,0.04)', border:'1px solid rgba(255,58,92,0.2)' }}>
            <div style={{ fontSize:10, color:'#ff3a5c', fontWeight:700, marginBottom:6 }}>⚠ SIMULATION ONLY</div>
            <div style={{ fontSize:11, color:'#ff7a7a', lineHeight:1.7 }}>
              This bot executes paper trades only. No real money, no wallet connections, no actual token purchases.
              All data is saved locally for analysis and validation. Meme coins are extremely high-risk assets.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
