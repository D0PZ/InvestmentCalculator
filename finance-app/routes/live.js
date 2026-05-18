const express = require('express');
const router = express.Router();
const { getLiveFeed, parseWatchlist } = require('../lib/liveFeed');
const { getCandleEngine } = require('../lib/candleEngine');
const { getEdgarStream } = require('../lib/edgarStream');
const { getAlertEngine } = require('../lib/alertEngine');
const { getStrategyEngine } = require('../lib/strategyEngine');
const { getMLStandaloneEngine } = require('../lib/mlStandaloneEngine');
const { loadRacionalPositions } = require('../lib/racionalImporter');
const { fetchHistory, fetchQuotes } = require('../lib/market');
const { getMarketState } = require('../lib/marketHours');
const { netPositionsFromTrades } = require('../lib/portfolio');
const { computePortfolioCorrelation } = require('../lib/correlation');
const minuteBars = require('../lib/minuteBars');
const mlClient = require('../lib/mlClient');
const log = require('../lib/logger').child('live');

const SNAPSHOT_FLUSH_MS = 250;

let bootstrapped = false;
const feed = getLiveFeed();
const candleEngine = getCandleEngine();
const edgar = getEdgarStream({ watchlist: feed.watchlist });
const alertEngine = getAlertEngine();
const strategy = getStrategyEngine();
const mlStandalone = getMLStandaloneEngine();

const sseClients = new Set();
const pendingSnapshots = new Map();
let flushTimer = null;

function broadcast(event, payload) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  const dead = [];
  for (const res of sseClients) {
    try { res.write(data); } catch { dead.push(res); }
  }
  for (const res of dead) sseClients.delete(res);
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (pendingSnapshots.size === 0) return;
    const out = {};
    for (const [sym, snap] of pendingSnapshots) out[sym] = snap;
    pendingSnapshots.clear();
    broadcast('snapshot', { snapshots: out });
  }, SNAPSHOT_FLUSH_MS);
}

async function bootstrap() {
  if (bootstrapped) return;
  bootstrapped = true;

  log.info({
    finnhubKey: !!process.env.FINNHUB_API_KEY,
    envWatchlist: process.env.LIVE_WATCHLIST,
    resolvedWatchlist: feed.watchlist,
  }, 'bootstrap');

  candleEngine.bindFeed(feed);
  alertEngine.bind({ candleEngine, edgarStream: edgar });
  strategy.bind({ candleEngine });
  minuteBars.bindCandleEngine(candleEngine);

  mlClient.probeOnBoot().catch(err => log.error({ err }, 'mlClient probe failed'));

  strategy.on('signal', (sig) => {
    log.info({ type: sig.type, symbol: sig.symbol, msg: sig.message }, 'strategy signal');
    broadcast('signal', sig);
  });

  mlStandalone.bind({ candleEngine, watchlist: feed.watchlist }).catch(e => {
    log.error({ err: e }, 'mlStandalone bind failed');
  });
  mlStandalone.on('signal', (sig) => {
    log.info({ type: sig.type, symbol: sig.symbol, msg: sig.message }, 'ml signal');
    broadcast('ml_signal', sig);
  });

  try {
    const imp = await loadRacionalPositions();
    if (imp.positions.length > 0) {
      const symbolsToAdd = imp.positions
        .map(p => p.symbol)
        .filter(s => !feed.watchlist.includes(s));
      if (symbolsToAdd.length > 0) {
        const newWatchlist = [...feed.watchlist, ...symbolsToAdd];
        feed.setWatchlist(newWatchlist);
        edgar.setWatchlist(newWatchlist);
        log.info({ added: symbolsToAdd }, 'watchlist ampliada por racional.txt');
        loadReferenceData(symbolsToAdd).catch(() => {});
      }
      log.info({ tracked: imp.positions.map(p => p.symbol) }, 'racional.txt tracked');
    } else if (imp.buys === 0 && imp.sells === 0) {
      log.info('racional.txt vacío o sin transacciones reconocidas');
    }
  } catch (err) {
    log.error({ err }, 'racional import failed');
  }

  feed.on('status', (s) => {
    log.info({ state: s.state, msg: s.message || s.reason }, 'feed status');
    broadcast('status', { source: 'feed', ...s });
  });
  edgar.on('status', (s) => {
    log.info({ state: s.state, msg: s.message }, 'edgar status');
    broadcast('status', { source: 'edgar', ...s });
  });
  edgar.on('filing', (f) => {
    log.info({ symbol: f.symbol, title: f.title }, 'edgar filing');
    broadcast('filing', f);
  });

  let lastTickLogAt = 0;
  feed.on('tick', (t) => {
    if (Date.now() - lastTickLogAt > 5000) {
      lastTickLogAt = Date.now();
      log.debug({ symbol: t.symbol, price: t.price, ts: t.ts }, 'tick');
    }
  });

  candleEngine.on('update', ({ symbol, snapshot }) => {
    pendingSnapshots.set(symbol, snapshot);
    scheduleFlush();
  });

  alertEngine.on('alert', (alert) => broadcast('alert', alert));

  edgar.setWatchlist(feed.watchlist);
  edgar.start();
  feed.start();

  loadReferenceData(feed.watchlist).catch(err => log.error({ err }, 'reference data load failed'));
}

async function loadReferenceData(symbols) {
  const today = new Date();
  const from = new Date(today.getTime() - 45 * 24 * 60 * 60 * 1000);
  const fromISO = from.toISOString().slice(0, 10);
  const toISO = today.toISOString().slice(0, 10);

  for (const symbol of symbols) {
    try {
      const hist = await fetchHistory(symbol, fromISO, toISO);
      if (hist.length >= 2) {
        const prevClose = hist[hist.length - 1].close;
        candleEngine.setReferenceData(symbol, { prevClose });
      }
    } catch (err) {
      log.warn({ symbol, err: err.message }, 'history load failed');
    }
  }

  try {
    const quotes = await fetchQuotes(symbols);
    for (const [sym, q] of Object.entries(quotes)) {
      candleEngine.setReferenceData(sym, { prevClose: q.previousClose });
    }
  } catch (err) {
    log.warn({ err: err.message }, 'quotes prime failed');
  }
}

router.get('/', async (req, res) => {
  await bootstrap();
  res.render('live', {
    title: 'Live',
    watchlist: feed.watchlist,
    feedReady: !!process.env.FINNHUB_API_KEY,
    market: getMarketState(),
  });
});

router.get('/state', async (req, res) => {
  await bootstrap();
  res.json({
    watchlist: feed.watchlist,
    snapshots: candleEngine.snapshots(),
    alerts: alertEngine.getRecent(50),
    feedConnected: feed.connected,
    strategy: strategy.state(),
    mlStandalone: mlStandalone.state(),
    mlClient: mlClient.getHealthState(),
    market: getMarketState(),
  });
});

router.get('/ml/state', async (req, res) => {
  await bootstrap();
  res.json(mlStandalone.state());
});

router.get('/ml/trades', async (req, res) => {
  await bootstrap();
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const db = require('../lib/db');
  const trades = db.prepare(
    `SELECT * FROM ml_trades ORDER BY exit_ts DESC LIMIT ?`
  ).all(limit);
  res.json({ trades });
});

router.get('/ml/signals', async (req, res) => {
  await bootstrap();
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const db = require('../lib/db');
  const signals = db.prepare(
    `SELECT * FROM ml_signals ORDER BY ts DESC LIMIT ?`
  ).all(limit);
  res.json({ signals });
});

router.get('/stream', async (req, res) => {
  log.debug({ ip: req.ip }, 'SSE client connecting');
  await bootstrap();
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  res.write(`retry: 3000\n\n`);
  res.write(`event: hello\ndata: ${JSON.stringify({
    watchlist: feed.watchlist,
    snapshots: candleEngine.snapshots(),
    alerts: alertEngine.getRecent(50),
    feedConnected: feed.connected,
    market: getMarketState(),
    strategy: strategy.state(),
  })}\n\n`);

  sseClients.add(res);
  log.debug({ total: sseClients.size, feedConnected: feed.connected }, 'SSE client added');

  let cleanedUp = false;
  let ping = null;
  const cleanup = (reason) => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (ping) clearInterval(ping);
    sseClients.delete(res);
    log.debug({ reason, remaining: sseClients.size }, 'SSE client cleanup');
  };

  ping = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch (err) {
      cleanup('ping write failed: ' + err.message);
    }
  }, 15000);

  req.on('close', () => cleanup('req close'));
  req.on('error', (err) => cleanup('req error: ' + err.message));
  res.on('error', (err) => cleanup('res error: ' + err.message));
});

router.get('/correlation', async (req, res) => {
  await bootstrap();
  const days = Math.max(7, Math.min(180, Number(req.query.days) || 30));
  const positions = netPositionsFromTrades();
  if (positions.length === 0) {
    return res.json({ error: 'no tienes posiciones abiertas', benchmarks: {}, per_ticker: [] });
  }
  try {
    const result = await computePortfolioCorrelation({ positions, benchmarks: ['SPY', 'QQQ'], days });
    res.json(result);
  } catch (err) {
    log.error({ err }, 'correlation failed');
    res.status(500).json({ error: err.message });
  }
});

router.post('/watchlist', express.json(), async (req, res) => {
  await bootstrap();
  const list = parseWatchlist(req.body?.watchlist || '');
  if (list.length === 0) return res.status(400).json({ error: 'empty watchlist' });
  feed.setWatchlist(list);
  edgar.setWatchlist(list);
  loadReferenceData(list).catch(() => {});
  res.json({ watchlist: feed.watchlist });
});

module.exports = router;
