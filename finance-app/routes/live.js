const express = require('express');
const router = express.Router();
const { getLiveFeed, parseWatchlist } = require('../lib/liveFeed');
const { getCandleEngine } = require('../lib/candleEngine');
const { getEdgarStream } = require('../lib/edgarStream');
const { getAlertEngine } = require('../lib/alertEngine');
const { getStrategyEngine } = require('../lib/strategyEngine');
const { loadRacionalPositions } = require('../lib/racionalImporter');
const { fetchHistory, fetchQuotes } = require('../lib/market');
const { getMarketState } = require('../lib/marketHours');

const SNAPSHOT_FLUSH_MS = 250;

let bootstrapped = false;
const feed = getLiveFeed();
const candleEngine = getCandleEngine();
const edgar = getEdgarStream({ watchlist: feed.watchlist });
const alertEngine = getAlertEngine();
const strategy = getStrategyEngine();

const sseClients = new Set();
const pendingSnapshots = new Map();
let flushTimer = null;

function broadcast(event, payload) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch {}
  }
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

  console.log('[live/bootstrap] FINNHUB_API_KEY set:', !!process.env.FINNHUB_API_KEY,
    '| LIVE_WATCHLIST env:', JSON.stringify(process.env.LIVE_WATCHLIST),
    '| resolved watchlist:', JSON.stringify(feed.watchlist));

  candleEngine.bindFeed(feed);
  alertEngine.bind({ candleEngine, edgarStream: edgar });
  strategy.bind({ candleEngine });

  strategy.on('signal', (sig) => {
    console.log('[live/signal]', sig.type, sig.symbol, sig.message);
    broadcast('signal', sig);
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
        console.log(`[live/import] watchlist ampliada con ${symbolsToAdd.join(', ')}`);
        loadReferenceData(symbolsToAdd).catch(() => {});
      }
      const loaded = strategy.loadPositionsBulk(imp.positions);
      console.log(`[live/import] cargadas ${loaded.length} posiciones (compras: ${imp.buys}, ventas: ${imp.sells}, fx-resuelto: ${imp.withFx || 0})`);
    } else if (imp.buys === 0 && imp.sells === 0) {
      console.log('[live/import] racional.txt vacío o sin transacciones reconocidas');
    } else {
      console.log(`[live/import] sin posiciones netas (${imp.buys} compras / ${imp.sells} ventas se anularon)`);
    }
  } catch (err) {
    console.error('[live/import] error:', err.message);
  }

  feed.on('status', (s) => {
    console.log('[live/feed]', s.state, s.message || s.reason || '');
    broadcast('status', { source: 'feed', ...s });
  });
  edgar.on('status', (s) => {
    console.log('[live/edgar]', s.state, s.message || '');
    broadcast('status', { source: 'edgar', ...s });
  });
  edgar.on('filing', (f) => {
    console.log('[live/filing]', f.symbol, f.title);
    broadcast('filing', f);
  });

  let lastTickLogAt = 0;
  feed.on('tick', (t) => {
    if (Date.now() - lastTickLogAt > 5000) {
      lastTickLogAt = Date.now();
      console.log('[live/tick]', t.symbol, t.price, '@', new Date(t.ts).toISOString());
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

  loadReferenceData(feed.watchlist).catch(err => console.error('reference data load failed', err));
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
      console.error(`history load failed for ${symbol}`, err.message);
    }
  }

  try {
    const quotes = await fetchQuotes(symbols);
    for (const [sym, q] of Object.entries(quotes)) {
      candleEngine.setReferenceData(sym, { prevClose: q.previousClose });
    }
  } catch (err) {
    console.error('quotes prime failed', err.message);
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
    market: getMarketState(),
  });
});

router.get('/stream', async (req, res) => {
  console.log('[live/stream] SSE client connecting from', req.ip);
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
  console.log('[live/stream] SSE client added (total now:', sseClients.size, ', feed.connected:', feed.connected, ')');
  const ping = setInterval(() => {
    try { res.write(`: ping ${Date.now()}\n\n`); } catch {}
  }, 15000);

  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
    console.log('[live/stream] SSE client closed (remaining:', sseClients.size, ')');
  });
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
