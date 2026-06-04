(() => {
  const debugEl = document.getElementById('debugLog');
  function dbg(msg) {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
    console.log('[live]', msg);
    if (debugEl) {
      debugEl.textContent = (debugEl.textContent === 'esperando...' ? '' : debugEl.textContent) + line + '\n';
      debugEl.scrollTop = debugEl.scrollHeight;
    }
  }
  window.addEventListener('error', (e) => dbg('JS ERROR: ' + (e.message || e.error?.message || 'unknown') + ' @ ' + e.filename + ':' + e.lineno));

  dbg('script loaded');
  const symbols = Array.isArray(window.WATCHLIST) ? window.WATCHLIST : [];
  dbg('watchlist: ' + JSON.stringify(symbols));
  if (!symbols.length) { dbg('aborting: empty watchlist'); return; }

  if (typeof window.LightweightCharts === 'undefined') {
    dbg('FAIL: LightweightCharts CDN not loaded — check network');
    const el = document.getElementById('connState');
    if (el) { el.className = 'conn-pill conn-err'; el.textContent = 'CDN charts bloqueado'; }
    return;
  }
  dbg('LightweightCharts version: ' + (LightweightCharts.version?.() || 'unknown'));

  const heatmapEl = document.getElementById('heatmap');
  const gridEl = document.getElementById('tickerGrid');
  const alertsListEl = document.getElementById('alertsList');
  const alertsCountEl = document.getElementById('alertsCount');
  const watchChipsEl = document.getElementById('watchlistChips');
  const connEl = document.getElementById('connState');

  const cards = new Map();
  const openPositions = new Map();
  let strategyStats = { trades: 0, wins: 0, losses: 0, winRate: null, totalPnl: 0 };
  let strategyCfg = { capitalUSD: 100, stopPct: 0.3, targetPct: 0.6, paperBankrollStart: 1000 };
  let strategyBankroll = 1000;

  function fmtPrice(n) {
    return Number.isFinite(n) ? n.toFixed(2) : '—';
  }
  function fmtPct(n) {
    if (!Number.isFinite(n)) return '—';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function relTime(ts) {
    const diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (diff < 60) return `hace ${diff}s`;
    if (diff < 3600) return `hace ${Math.floor(diff / 60)}m`;
    return `hace ${Math.floor(diff / 3600)}h`;
  }
  function pctColor(p) {
    if (!Number.isFinite(p)) return 'flat';
    if (p > 0.05) return 'up-strong';
    if (p > 0) return 'up';
    if (p < -0.05) return 'down-strong';
    if (p < 0) return 'down';
    return 'flat';
  }

  function renderWatchlistChips() {
    watchChipsEl.innerHTML = '';
    for (const sym of symbols) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = sym;
      watchChipsEl.appendChild(chip);
    }
  }

  function buildHeatmap() {
    heatmapEl.innerHTML = '';
    for (const sym of symbols) {
      const tile = document.createElement('div');
      tile.className = 'heat-tile flat';
      tile.id = `heat-${sym}`;
      tile.innerHTML = `
        <div class="heat-sym">${sym}</div>
        <div class="heat-price">—</div>
        <div class="heat-pct">—</div>
      `;
      heatmapEl.appendChild(tile);
    }
  }

  function buildCards() {
    gridEl.innerHTML = '';
    for (const sym of symbols) {
      const card = document.createElement('article');
      card.className = 'ticker-card';
      card.dataset.symbol = sym;
      card.innerHTML = `
        <header class="tc-header">
          <div class="tc-sym">${sym}</div>
          <div class="tc-prices">
            <span class="tc-last">—</span>
            <span class="tc-change flat">—</span>
          </div>
        </header>
        <div class="tc-position pos-waiting" data-state="waiting">
          <div class="pos-action">ESPERANDO SETUP</div>
          <div class="pos-detail">—</div>
        </div>
        <div class="tc-chart">
          <div class="tc-chart-overlay">esperando ticks…</div>
        </div>
        <div class="tc-meta">
          <div class="meta-row">
            <span class="meta-label">VWAP</span>
            <span class="meta-val" data-key="vwap">—</span>
          </div>
          <div class="meta-row">
            <span class="meta-label">EMA9/20</span>
            <span class="meta-val" data-key="ema">—</span>
          </div>
        </div>
        <div class="gauges">
          ${gaugeMarkup('rvol', 'RVOL', 0, 5)}
          ${gaugeMarkup('rsi', 'RSI', 0, 100)}
        </div>
      `;
      gridEl.appendChild(card);

      const chartEl = card.querySelector('.tc-chart');
      const chart = LightweightCharts.createChart(chartEl, chartOptions(chartEl));
      const candleSeries = chart.addCandlestickSeries({
        upColor: '#2ecc71',
        downColor: '#e74c3c',
        wickUpColor: '#2ecc71',
        wickDownColor: '#e74c3c',
        borderVisible: false,
        priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      });
      const vwapSeries = chart.addLineSeries({
        color: '#7c5cff',
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      const ema9Series = chart.addLineSeries({
        color: '#f39c12',
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      const ema20Series = chart.addLineSeries({
        color: '#3498db',
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });

      cards.set(sym, { card, chart, candleSeries, vwapSeries, ema9Series, ema20Series });
    }
  }

  function chartOptions(el) {
    return {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: '#8a90a4', fontSize: 11 },
      grid: { vertLines: { color: '#1f2333' }, horzLines: { color: '#1f2333' } },
      timeScale: { borderColor: '#2a2f42', timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: '#2a2f42' },
      crosshair: { mode: 1 },
      handleScroll: false,
      handleScale: false,
      watermark: { visible: false },
    };
  }

  function gaugeMarkup(key, label, min, max) {
    return `
      <div class="gauge" data-key="${key}" data-min="${min}" data-max="${max}">
        <svg viewBox="0 0 100 60" class="gauge-svg">
          <path d="M 10 55 A 40 40 0 0 1 90 55" stroke="#2a2f42" stroke-width="8" fill="none" stroke-linecap="round" />
          <path class="gauge-fill" d="M 10 55 A 40 40 0 0 1 90 55" stroke="#7c5cff" stroke-width="8" fill="none" stroke-linecap="round"
            stroke-dasharray="0 200" />
        </svg>
        <div class="gauge-label">${label}</div>
        <div class="gauge-value">—</div>
      </div>
    `;
  }

  function updateGauge(card, key, value) {
    const g = card.querySelector(`.gauge[data-key="${key}"]`);
    if (!g) return;
    const min = parseFloat(g.dataset.min);
    const max = parseFloat(g.dataset.max);
    const valEl = g.querySelector('.gauge-value');
    const fill = g.querySelector('.gauge-fill');
    if (!Number.isFinite(value)) {
      valEl.textContent = '—';
      fill.setAttribute('stroke-dasharray', '0 200');
      return;
    }
    const clamped = Math.max(min, Math.min(max, value));
    const pct = (clamped - min) / (max - min);
    const arc = 125;
    fill.setAttribute('stroke-dasharray', `${arc * pct} 200`);
    let color = '#7c5cff';
    if (key === 'rvol') {
      color = value >= 2 ? '#e74c3c' : value >= 1.5 ? '#f39c12' : '#2ecc71';
    } else if (key === 'rsi') {
      color = value >= 70 ? '#e74c3c' : value <= 30 ? '#2ecc71' : '#7c5cff';
    }
    fill.setAttribute('stroke', color);
    valEl.textContent = key === 'rvol' ? value.toFixed(2) + '×' : value.toFixed(0);
  }

  function applySnapshot(sym, snap) {
    const c = cards.get(sym);
    if (!c) return;
    const card = c.card;

    const last = snap.lastPrice;
    const changePct = snap.changePct;
    card.querySelector('.tc-last').textContent = fmtPrice(last);
    const chEl = card.querySelector('.tc-change');
    chEl.textContent = fmtPct(changePct);
    chEl.className = 'tc-change ' + pctColor(changePct);

    card.querySelector('[data-key="vwap"]').textContent = fmtPrice(snap.vwap);
    card.querySelector('[data-key="ema"]').textContent =
      `${fmtPrice(snap.ema9)} / ${fmtPrice(snap.ema20)}`;

    updateGauge(card, 'rvol', snap.rvol);
    updateGauge(card, 'rsi', snap.rsi);

    if (Array.isArray(snap.candles1m) && snap.candles1m.length) {
      const overlay = card.querySelector('.tc-chart-overlay');
      if (overlay) overlay.remove();
      const data = snap.candles1m.map(k => ({
        time: Math.floor(k.t / 1000),
        open: k.o, high: k.h, low: k.l, close: k.c,
      }));
      c.candleSeries.setData(data);

      if (Number.isFinite(snap.vwap)) {
        const v = snap.vwap;
        c.vwapSeries.setData(data.map(d => ({ time: d.time, value: v })));
      }
      if (Number.isFinite(snap.ema9)) {
        c.ema9Series.setData([
          { time: data[Math.max(0, data.length - 20)].time, value: snap.ema9 },
          { time: data[data.length - 1].time, value: snap.ema9 },
        ]);
      }
      if (Number.isFinite(snap.ema20)) {
        c.ema20Series.setData([
          { time: data[Math.max(0, data.length - 20)].time, value: snap.ema20 },
          { time: data[data.length - 1].time, value: snap.ema20 },
        ]);
      }
    }

    const tile = document.getElementById(`heat-${sym}`);
    if (tile) {
      tile.className = `heat-tile ${pctColor(changePct)}`;
      tile.querySelector('.heat-price').textContent = fmtPrice(last);
      tile.querySelector('.heat-pct').textContent = fmtPct(changePct);
    }

    renderPosition(sym);
  }

  function renderPosition(sym) {
    const c = cards.get(sym);
    if (!c) return;
    const card = c.card;
    const pos = openPositions.get(sym);
    const posEl = card.querySelector('.tc-position');
    if (!posEl) return;
    if (!pos) {
      posEl.className = 'tc-position pos-waiting';
      posEl.dataset.state = 'waiting';
      posEl.querySelector('.pos-action').textContent = 'ESPERANDO SETUP';
      posEl.querySelector('.pos-detail').textContent = '—';
      card.classList.remove('has-position');
      return;
    }
    const last = c.card.querySelector('.tc-last').textContent;
    const lastPrice = parseFloat(last);
    let pnlTxt = '—';
    let pnlClass = '';
    if (Number.isFinite(lastPrice)) {
      const pnl = (lastPrice - pos.entry) * pos.shares;
      const pnlPct = ((lastPrice - pos.entry) / pos.entry) * 100;
      const sign = pnl >= 0 ? '+' : '';
      pnlTxt = `${sign}$${pnl.toFixed(2)} (${sign}${pnlPct.toFixed(2)}%)`;
      pnlClass = pnl > 0 ? 'up' : pnl < 0 ? 'down' : '';
    }
    posEl.className = 'tc-position pos-long';
    posEl.dataset.state = 'long';
    posEl.querySelector('.pos-action').innerHTML = `🟢 LONG @ $${pos.entry.toFixed(2)} · <span class="pos-pnl ${pnlClass}">${pnlTxt}</span>`;
    posEl.querySelector('.pos-detail').innerHTML =
      `stop $${pos.stop.toFixed(2)}${pos.beActive ? ' (BE)' : ''} · target $${pos.target.toFixed(2)}<br>${pos.shares.toFixed(4)} acc · $${pos.positionUSD.toFixed(2)}`;
    card.classList.add('has-position');
  }

  function flashExit(sym, sig) {
    const c = cards.get(sym);
    if (!c) return;
    const card = c.card;
    const posEl = card.querySelector('.tc-position');
    if (!posEl) return;
    const p = sig.position;
    const sign = p.pnl >= 0 ? '+' : '';
    posEl.className = 'tc-position pos-exit';
    posEl.dataset.state = 'exit';
    posEl.querySelector('.pos-action').textContent = `🔴 VENDIDA · ${p.result}`;
    posEl.querySelector('.pos-detail').innerHTML =
      `${sign}$${p.pnl} (${sign}${p.pnlPct}%) · ${sig.reason}`;
    card.classList.add('signal-flash');
    setTimeout(() => {
      card.classList.remove('signal-flash');
      card.classList.remove('has-position');
      renderPosition(sym);
    }, 6000);
  }

  function renderStats() {
    const pnlEl = document.getElementById('sbPnl');
    const tradesEl = document.getElementById('sbTrades');
    const wrEl = document.getElementById('sbWinRate');
    const openEl = document.getElementById('sbOpen');
    const brEl = document.getElementById('sbBankroll');
    const brDeltaEl = document.getElementById('sbBankrollDelta');
    if (!pnlEl) return;
    const p = strategyStats.totalPnl || 0;
    const sign = p >= 0 ? '+' : '';
    pnlEl.textContent = `${sign}$${p.toFixed(2)}`;
    pnlEl.className = p > 0 ? 'up' : p < 0 ? 'down' : 'flat';
    tradesEl.textContent = strategyStats.trades || 0;
    wrEl.textContent = strategyStats.winRate != null ? strategyStats.winRate + '%' : '—';
    openEl.textContent = openPositions.size;
    if (brEl) {
      brEl.textContent = `$${strategyBankroll.toFixed(2)}`;
      const start = strategyCfg.paperBankrollStart || 1000;
      const delta = strategyBankroll - start;
      const pct = start > 0 ? (delta / start) * 100 : 0;
      brEl.className = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
      if (brDeltaEl) {
        const dSign = delta >= 0 ? '+' : '';
        brDeltaEl.textContent = `${dSign}$${delta.toFixed(2)} (${dSign}${pct.toFixed(2)}%)`;
        brDeltaEl.className = 'muted-sm ' + (delta > 0 ? 'up' : delta < 0 ? 'down' : '');
      }
    }
  }

  function applySnapshots(snaps) {
    for (const [sym, snap] of Object.entries(snaps || {})) applySnapshot(sym, snap);
  }

  const alerts = [];
  function pushAlert(alert) {
    alerts.unshift(alert);
    if (alerts.length > 100) alerts.pop();
    renderAlerts();
  }

  function renderAlerts() {
    alertsCountEl.textContent = alerts.length;
    alertsListEl.innerHTML = '';
    for (const a of alerts.slice(0, 30)) {
      const li = document.createElement('li');
      const sev = a.severity || 'info';
      const extra = sev === 'signal-entry' ? ' alert-signal-entry'
                  : sev === 'signal-exit' ? ' alert-signal-exit'
                  : sev === 'signal' ? ' alert-signal' : '';
      li.className = `alert alert-${sev}${extra}`;
      const link = a.data?.url
        ? `<a href="${a.data.url}" target="_blank" rel="noopener">abrir ↗</a>`
        : '';
      li.innerHTML = `
        <div class="alert-head">
          <span class="alert-sym">${a.symbol}</span>
          <span class="alert-time">${relTime(a.ts)}</span>
        </div>
        <div class="alert-msg">${a.message}</div>
        ${link ? `<div class="alert-meta">${link}</div>` : ''}
      `;
      alertsListEl.appendChild(li);
    }
  }

  function setConn(state, label) {
    connEl.className = `conn-pill conn-${state}`;
    connEl.textContent = label;
  }

  try {
    renderWatchlistChips();
    buildHeatmap();
    dbg('heatmap built');
    buildCards();
    dbg('cards built (' + cards.size + ')');
  } catch (err) {
    dbg('FAIL building UI: ' + err.message);
    return;
  }

  setInterval(renderAlerts, 5000);

  const mbBanner = document.getElementById('marketBanner');
  function updateCountdown() {
    if (!mbBanner) return;
    const state = mbBanner.dataset.state;
    const target = state === 'open'
      ? new Date(mbBanner.dataset.nextClose)
      : new Date(mbBanner.dataset.nextOpen);
    const ms = target.getTime() - Date.now();
    const el = document.getElementById('mbCountdown');
    if (!el) return;
    if (!Number.isFinite(target.getTime()) || ms <= 0) {
      el.textContent = '—';
      return;
    }
    const totalSec = Math.floor(ms / 1000);
    const days = Math.floor(totalSec / 86400);
    const hours = Math.floor((totalSec % 86400) / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    el.textContent = days > 0
      ? `${days}d ${hours}h ${mins}m`
      : `${String(hours).padStart(2,'0')}:${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
  }
  updateCountdown();
  setInterval(updateCountdown, 1000);

  dbg('opening SSE /live/stream');
  const es = new EventSource('/live/stream');
  es.onopen = () => dbg('SSE open');
  es.addEventListener('hello', (ev) => {
    dbg('hello received');
    const data = JSON.parse(ev.data);
    if (data.strategy) {
      strategyCfg = data.strategy.cfg || strategyCfg;
      strategyStats = data.strategy.stats || strategyStats;
      if (Number.isFinite(data.strategy.bankroll)) strategyBankroll = data.strategy.bankroll;
      openPositions.clear();
      for (const [sym, pos] of Object.entries(data.strategy.open || {})) {
        openPositions.set(sym, pos);
      }
    }
    applySnapshots(data.snapshots || {});
    for (const a of (data.alerts || []).slice().reverse()) pushAlert(a);
    renderStats();
    setConn(data.feedConnected ? 'ok' : 'idle', data.feedConnected ? 'feed conectado' : 'esperando feed…');
  });
  es.addEventListener('snapshot', (ev) => {
    const data = JSON.parse(ev.data);
    applySnapshots(data.snapshots || {});
  });
  es.addEventListener('alert', (ev) => {
    pushAlert(JSON.parse(ev.data));
  });
  es.addEventListener('filing', () => {});
  es.addEventListener('signal', (ev) => {
    const sig = JSON.parse(ev.data);
    dbg('signal: ' + sig.type + ' ' + sig.symbol);
    if (sig.type === 'ENTRY' || sig.type === 'IMPORT') {
      openPositions.set(sig.symbol, sig.position);
      renderPosition(sig.symbol);
      pushAlert({
        id: 'sig-' + sig.ts,
        symbol: sig.symbol,
        severity: 'signal-entry',
        message: sig.message,
        ts: sig.ts,
      });
      const c = cards.get(sig.symbol);
      if (c) {
        c.card.classList.add('signal-flash');
        setTimeout(() => c.card.classList.remove('signal-flash'), 1500);
      }
      tryBeep();
    } else if (sig.type === 'BREAKEVEN') {
      const pos = openPositions.get(sig.symbol);
      if (pos) {
        pos.stop = sig.position.stop;
        pos.beActive = true;
        renderPosition(sig.symbol);
      }
      pushAlert({
        id: 'sig-' + sig.ts,
        symbol: sig.symbol,
        severity: 'signal',
        message: sig.message,
        ts: sig.ts,
      });
    } else if (sig.type === 'EXIT') {
      openPositions.delete(sig.symbol);
      strategyStats.trades = (strategyStats.trades || 0) + 1;
      if (sig.position.pnl > 0) strategyStats.wins = (strategyStats.wins || 0) + 1;
      else if (sig.position.pnl < 0) strategyStats.losses = (strategyStats.losses || 0) + 1;
      strategyStats.totalPnl = (strategyStats.totalPnl || 0) + sig.position.pnl;
      strategyStats.winRate = strategyStats.trades > 0
        ? +(strategyStats.wins / strategyStats.trades * 100).toFixed(1) : null;
      strategyBankroll = +(strategyBankroll + (sig.position.pnl || 0)).toFixed(2);
      flashExit(sig.symbol, sig);
      pushAlert({
        id: 'sig-' + sig.ts,
        symbol: sig.symbol,
        severity: 'signal-exit',
        message: sig.message,
        ts: sig.ts,
      });
      tryBeep();
    }
    renderStats();
  });

  let audioCtx = null;
  function tryBeep() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.connect(g); g.connect(audioCtx.destination);
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.15, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.3);
      o.start();
      o.stop(audioCtx.currentTime + 0.3);
    } catch {}
  }
  es.addEventListener('status', (ev) => {
    const s = JSON.parse(ev.data);
    dbg('status[' + s.source + ']: ' + s.state + (s.message ? ' — ' + s.message : ''));
    if (s.source === 'feed') {
      if (s.state === 'connected') setConn('ok', 'feed conectado');
      else if (s.state === 'connecting') setConn('idle', 'conectando…');
      else if (s.state === 'no-key') setConn('err', 'falta FINNHUB_API_KEY');
      else if (s.state === 'disconnected') setConn('err', 'desconectado · reintentando');
      else if (s.state === 'error') setConn('err', 'error: ' + (s.message || ''));
    }
  });
  es.onerror = (e) => {
    dbg('SSE error · readyState=' + es.readyState);
    setConn('err', 'sin stream');
  };

  // -------- Correlación vs SPY/QQQ --------
  const corrPanel = document.getElementById('correlationPanel');
  const corrDaysSel = document.getElementById('corrDays');
  const corrRefreshBtn = document.getElementById('corrRefresh');
  const cpSummary = document.getElementById('cpSummary');
  const cpBenchmarks = document.getElementById('cpBenchmarks');
  const cpTickerRows = document.getElementById('cpTickerRows');

  function fmtPctSigned(n, digits = 2) {
    if (n == null || !Number.isFinite(n)) return '—';
    return (n > 0 ? '+' : '') + (n * 100).toFixed(digits) + '%';
  }
  function fmtFixed(n, digits = 3) {
    if (n == null || !Number.isFinite(n)) return '—';
    return n.toFixed(digits);
  }
  function corrLabel(c) {
    if (c == null) return 'sin datos';
    const a = Math.abs(c);
    if (a < 0.2) return 'casi nula';
    if (a < 0.4) return 'baja';
    if (a < 0.6) return 'moderada';
    if (a < 0.8) return 'alta';
    return 'muy alta';
  }

  async function loadCorrelation() {
    if (!corrPanel) return;
    const days = corrDaysSel ? corrDaysSel.value : '30';
    cpSummary.textContent = 'cargando…';
    cpBenchmarks.innerHTML = '';
    cpTickerRows.innerHTML = '';
    try {
      const res = await fetch('/live/correlation?days=' + encodeURIComponent(days));
      const data = await res.json();
      if (data.error) {
        cpSummary.innerHTML = '<em>' + data.error + '</em>';
        return;
      }
      const p = data.portfolio;
      cpSummary.innerHTML =
        '<div><strong>Cartera ' + (p.cumulative >= 0 ? '+' : '') + (p.cumulative * 100).toFixed(2) + '%</strong> en ' + data.observations + 'd · ' +
        '<span class="muted-sm">vol diaria ' + (p.vol_daily * 100).toFixed(2) + '% · ventana ' + data.date_from + ' → ' + data.date_to + '</span></div>';

      cpBenchmarks.innerHTML = '';
      for (const b of Object.keys(data.benchmarks)) {
        const x = data.benchmarks[b];
        if (x.error) {
          cpBenchmarks.insertAdjacentHTML('beforeend', `<div class="cp-bench"><h4>${b}</h4><em>${x.error}</em></div>`);
          continue;
        }
        const corr = x.correlation;
        const corrClass = corr == null ? '' : (Math.abs(corr) > 0.6 ? 'high' : Math.abs(corr) > 0.3 ? 'mid' : 'low');
        cpBenchmarks.insertAdjacentHTML('beforeend', `
          <div class="cp-bench cp-${corrClass}">
            <h4>vs ${b} <small>${(x.cumulative_return >= 0 ? '+' : '') + (x.cumulative_return * 100).toFixed(2)}%</small></h4>
            <div class="cp-num"><span>corr</span><strong>${fmtFixed(corr)}</strong><em>${corrLabel(corr)}</em></div>
            <div class="cp-num"><span>β</span><strong>${fmtFixed(x.beta)}</strong></div>
            <div class="cp-bar">
              <div class="cp-bar-mkt" style="width:${x.market_explained_pct || 0}%" title="${x.market_explained_pct || 0}% mercado"></div>
            </div>
            <div class="cp-bar-legend">
              <span>mercado: <strong>${x.market_explained_pct ?? 0}%</strong></span>
              <span>stock-specific: <strong>${x.stock_specific_pct ?? 0}%</strong></span>
            </div>
          </div>
        `);
      }

      for (const t of data.per_ticker) {
        cpTickerRows.insertAdjacentHTML('beforeend', `
          <tr>
            <td><strong>${t.ticker}</strong></td>
            <td class="num">${t.weight.toFixed(1)}%</td>
            <td class="num ${t.cumulative >= 0 ? 'pos' : 'neg'}">${fmtPctSigned(t.cumulative)}</td>
            <td class="num">${fmtFixed(t.corr_SPY)}</td>
            <td class="num">${fmtFixed(t.beta_SPY)}</td>
            <td class="num">${fmtFixed(t.corr_QQQ)}</td>
            <td class="num">${fmtFixed(t.beta_QQQ)}</td>
          </tr>
        `);
      }
      corrPanel.dataset.loaded = '1';
    } catch (err) {
      cpSummary.innerHTML = '<em>Error: ' + err.message + '</em>';
    }
  }

  if (corrRefreshBtn) corrRefreshBtn.addEventListener('click', loadCorrelation);
  if (corrDaysSel) corrDaysSel.addEventListener('change', loadCorrelation);
  loadCorrelation();

  // -------- Agente ML standalone --------
  const mlPanel = document.getElementById('mlPanel');
  const mlVersionEl = document.getElementById('mlVersion');
  const mlThresholdEl = document.getElementById('mlThreshold');
  const mlOpenCountEl = document.getElementById('mlOpenCount');
  const mlTradesCountEl = document.getElementById('mlTradesCount');
  const mlWinRateEl = document.getElementById('mlWinRate');
  const mlTotalPnlEl = document.getElementById('mlTotalPnl');
  const mlLastCycleEl = document.getElementById('mlLastCycle');
  const mlOpenListEl = document.getElementById('mlOpenList');
  const mlTradesListEl = document.getElementById('mlTradesList');
  const mlRefreshBtn = document.getElementById('mlRefresh');

  const mlOpenPositions = new Map();
  const mlTrades = [];
  let mlStats = { trades: 0, wins: 0, winRate: null, totalPnl: 0 };
  let mlCfg = null;

  function renderMlStats() {
    if (!mlPanel) return;
    mlOpenCountEl.textContent = mlOpenPositions.size;
    mlTradesCountEl.textContent = mlStats.trades || 0;
    mlWinRateEl.textContent = mlStats.winRate != null ? mlStats.winRate + '%' : '—';
    const pnl = mlStats.totalPnl || 0;
    const sign = pnl >= 0 ? '+' : '';
    mlTotalPnlEl.textContent = sign + '$' + pnl.toFixed(2);
    mlTotalPnlEl.className = pnl > 0 ? 'up' : pnl < 0 ? 'down' : 'flat';
  }

  function renderMlOpen() {
    if (!mlOpenListEl) return;
    if (mlOpenPositions.size === 0) {
      mlOpenListEl.innerHTML = '<li class="muted-sm">sin posiciones</li>';
      return;
    }
    const items = [];
    for (const [sym, p] of mlOpenPositions) {
      const probPct = p.prob != null ? (p.prob * 100).toFixed(1) + '%' : '—';
      items.push(
        `<li class="ml-pos">
          <div><strong>${sym}</strong> @ $${Number(p.entry).toFixed(2)}<span class="muted-sm"> · prob ${probPct}</span></div>
          <div class="muted-sm">target $${Number(p.target).toFixed(2)} (+${Number(p.target_pct).toFixed(2)}%) · stop $${Number(p.stop).toFixed(2)} (-${Number(p.stop_pct).toFixed(2)}%)</div>
        </li>`
      );
    }
    mlOpenListEl.innerHTML = items.join('');
  }

  function renderMlTrades() {
    if (!mlTradesListEl) return;
    if (mlTrades.length === 0) {
      mlTradesListEl.innerHTML = '<li class="muted-sm">sin trades</li>';
      return;
    }
    const items = mlTrades.slice(0, 20).map(t => {
      const pnl = Number(t.pnl_usd) || 0;
      const sign = pnl >= 0 ? '+' : '';
      const cls = pnl > 0 ? 'up' : pnl < 0 ? 'down' : 'flat';
      const at = t.exit_ts ? new Date(t.exit_ts).toLocaleTimeString() : '';
      return `<li class="ml-trade">
        <div><strong>${t.symbol}</strong> <span class="${cls}">${sign}$${pnl.toFixed(2)}</span> <span class="muted-sm">${t.outcome || ''} · ${(Number(t.net_pct)||0).toFixed(2)}%</span></div>
        <div class="muted-sm">$${Number(t.entry).toFixed(2)} → $${Number(t.exit).toFixed(2)} · ${t.reason || ''} · ${at}</div>
      </li>`;
    });
    mlTradesListEl.innerHTML = items.join('');
  }

  async function loadMlState() {
    if (!mlPanel) return;
    try {
      const res = await fetch('/live/ml/state');
      const data = await res.json();
      mlCfg = data.cfg || null;
      if (data.modelMeta) {
        mlVersionEl.textContent = (data.modelMeta.version || 'v?');
        if (mlCfg) mlVersionEl.textContent += ' · cap $' + mlCfg.capitalUsd + ' · max ' + mlCfg.maxOpen;
      }
      if (data.threshold != null) {
        mlThresholdEl.textContent = 'thr ' + Number(data.threshold).toFixed(3);
      }
      mlOpenPositions.clear();
      for (const [sym, pos] of Object.entries(data.open || {})) mlOpenPositions.set(sym, pos);
      if (data.stats) {
        mlStats = {
          trades: data.stats.trades || 0,
          wins: data.stats.wins || 0,
          winRate: data.stats.winRate,
          totalPnl: data.stats.totalPnl || 0,
        };
      }
      if (data.lastCycleAt) {
        const ago = Math.round((Date.now() - data.lastCycleAt) / 1000);
        const reason = data.lastCycleResult?.reason || (data.lastCycleResult?.evaluated != null ? 'evaluated ' + data.lastCycleResult.evaluated : 'ok');
        mlLastCycleEl.textContent = 'hace ' + ago + 's · ' + reason;
      }
      renderMlStats();
      renderMlOpen();
      mlPanel.dataset.loaded = '1';
    } catch (err) {
      dbg('ml/state error: ' + err.message);
    }
  }

  async function loadMlTrades() {
    if (!mlPanel) return;
    try {
      const res = await fetch('/live/ml/trades?limit=30');
      const data = await res.json();
      mlTrades.length = 0;
      for (const t of (data.trades || [])) mlTrades.push(t);
      renderMlTrades();
    } catch (err) {
      dbg('ml/trades error: ' + err.message);
    }
  }

  es.addEventListener('ml_signal', (ev) => {
    const sig = JSON.parse(ev.data);
    dbg('ml_signal: ' + sig.type + ' ' + sig.symbol);
    if (sig.type === 'ENTRY' && sig.position) {
      mlOpenPositions.set(sig.symbol, sig.position);
      pushAlert({
        id: 'ml-' + sig.ts,
        symbol: sig.symbol,
        severity: 'signal-entry',
        message: sig.message,
        ts: sig.ts,
      });
      tryBeep();
    } else if (sig.type === 'EXIT' && sig.position) {
      mlOpenPositions.delete(sig.symbol);
      const p = sig.position;
      mlTrades.unshift({
        symbol: sig.symbol,
        entry: p.entry, exit: p.exit,
        outcome: p.outcome, net_pct: p.net_pct,
        pnl_usd: p.pnl_usd, reason: sig.reason,
        exit_ts: sig.ts,
      });
      if (mlTrades.length > 50) mlTrades.length = 50;
      mlStats.trades = (mlStats.trades || 0) + 1;
      if ((p.net_pct || 0) > 0) mlStats.wins = (mlStats.wins || 0) + 1;
      mlStats.totalPnl = (mlStats.totalPnl || 0) + (p.pnl_usd || 0);
      mlStats.winRate = mlStats.trades > 0 ? +(mlStats.wins / mlStats.trades * 100).toFixed(1) : null;
      pushAlert({
        id: 'ml-' + sig.ts,
        symbol: sig.symbol,
        severity: 'signal-exit',
        message: sig.message,
        ts: sig.ts,
      });
      tryBeep();
      renderMlTrades();
    }
    renderMlStats();
    renderMlOpen();
  });

  if (mlRefreshBtn) mlRefreshBtn.addEventListener('click', () => { loadMlState(); loadMlTrades(); });
  loadMlState();
  loadMlTrades();
  setInterval(loadMlState, 30000);  // refresca el lastCycle indicator

  // -------- Catalyst Radar (eventos fundamentales) --------
  const catPanel = document.getElementById('catalystPanel');
  const catRowsEl = document.getElementById('catRows');
  const catStatusEl = document.getElementById('catStatus');
  const catRefreshBtn = document.getElementById('catRefresh');

  function esc(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g,
      m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }
  function sentDot(s) { return s === 'bullish' ? '🟢' : s === 'bearish' ? '🔴' : '⚪'; }

  function renderCatalystRow(item) {
    let earn = '<span class="muted-sm">—</span>';
    if (item.nextEarnings) {
      const d = item.nextEarnings.days_to;
      const cls = d <= 7 ? ' cat-soon' : d <= 21 ? ' cat-near' : '';
      earn = `<span class="cat-earn${cls}">${item.nextEarnings.date} · <strong>${d}d</strong></span>`;
    }
    let reco = '<span class="muted-sm">—</span>';
    if (item.reco && item.reco.latest) {
      const L = item.reco.latest;
      const total = (L.strongBuy + L.buy + L.hold + L.sell + L.strongSell) || 1;
      const bull = Math.round((L.strongBuy + L.buy) / total * 100);
      const cls = item.reco.sentiment === 'bullish' ? 'up' : item.reco.sentiment === 'bearish' ? 'down' : 'flat';
      reco = `<span class="cat-reco ${cls}" title="SB${L.strongBuy}/B${L.buy}/H${L.hold}/S${L.sell}/SS${L.strongSell} · score ${item.reco.score}">${bull}% bull <span class="muted-sm">(${L.strongBuy + L.buy}/${total})</span></span>`;
    }
    let rating = '<span class="muted-sm">sin acciones recientes</span>';
    if (item.ratings && item.ratings.length) {
      const r = item.ratings[0];
      const firm = r.firm ? `<strong>${esc(r.firm)}</strong> · ` : '';
      const link = r.url ? ` <a href="${esc(r.url)}" target="_blank" rel="noopener">↗</a>` : '';
      const more = item.ratings.length > 1 ? ` · <span class="muted-sm">+${item.ratings.length - 1} más</span>` : '';
      rating = `<div class="cat-rating cat-${r.sentiment || 'neutral'}">${sentDot(r.sentiment)} ${firm}<span title="${esc(r.headline)}">${esc((r.headline || '').slice(0, 78))}</span>${link}</div>
                <div class="muted-sm">${esc(r.event_date)}${more}</div>`;
    }
    const thesis = item.thesis
      ? ` <span class="cat-thesis-dot" title="${esc((item.thesis.headline || '') + (item.thesis.detail ? ' — ' + item.thesis.detail : ''))}">💡</span>`
      : '';
    return `<tr>
      <td><strong>${esc(item.ticker)}</strong>${thesis}</td>
      <td>${earn}</td>
      <td class="num">${reco}</td>
      <td>${rating}</td>
    </tr>`;
  }

  async function loadCatalysts() {
    if (!catPanel) return;
    try {
      const res = await fetch('/live/catalysts');
      const data = await res.json();
      const radar = data.radar || [];
      catRowsEl.innerHTML = radar.map(renderCatalystRow).join('') ||
        '<tr><td colspan="4" class="muted-sm">sin datos · corré scripts/backfill_catalysts.js</td></tr>';
      if (data.state) {
        const st = data.state;
        const prem = (st.premiumBlocked || []).length ? ` · premium: ${st.premiumBlocked.join(',')}` : '';
        catStatusEl.textContent = `${st.stats?.inserts ?? 0} nuevos · ${st.running ? 'activo' : (st.hasKey ? 'idle' : 'sin API key')}${prem}`;
      }
      catPanel.dataset.loaded = '1';
    } catch (err) {
      dbg('catalysts error: ' + err.message);
    }
  }

  let catRefreshTimer = null;
  es.addEventListener('catalyst', (ev) => {
    try { const c = JSON.parse(ev.data); dbg('catalyst: ' + c.ticker + ' ' + c.type); } catch {}
    if (catRefreshTimer) return;             // debounce: varios catalysts llegan juntos
    catRefreshTimer = setTimeout(() => { catRefreshTimer = null; loadCatalysts(); }, 1500);
  });
  if (catRefreshBtn) catRefreshBtn.addEventListener('click', loadCatalysts);
  loadCatalysts();
  setInterval(loadCatalysts, 5 * 60 * 1000);
})();
