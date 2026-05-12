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
  let strategyCfg = { capitalUSD: 100, stopPct: 0.8, targetPct: 2.0 };

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
    if (!pnlEl) return;
    const p = strategyStats.totalPnl || 0;
    const sign = p >= 0 ? '+' : '';
    pnlEl.textContent = `${sign}$${p.toFixed(2)}`;
    pnlEl.className = p > 0 ? 'up' : p < 0 ? 'down' : 'flat';
    tradesEl.textContent = strategyStats.trades || 0;
    wrEl.textContent = strategyStats.winRate != null ? strategyStats.winRate + '%' : '—';
    openEl.textContent = openPositions.size;
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
        ? `<a href="${a.data.url}" target="_blank" rel="noopener">abrir filing ↗</a>`
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
      openPositions.clear();
      for (const [sym, pos] of Object.entries(data.strategy.open || {})) {
        openPositions.set(sym, pos);
      }
      const capEl = document.querySelector('.sb-item:nth-child(2) strong');
      if (capEl) capEl.textContent = `$${strategyCfg.capitalUSD} USD`;
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
})();
