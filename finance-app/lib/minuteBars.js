const db = require('./db');

const UPSERT_STMT = db.prepare(`
  INSERT INTO minute_bars (ticker, ts, open, high, low, close, volume, source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(ticker, ts) DO UPDATE SET
    open=excluded.open,
    high=excluded.high,
    low=excluded.low,
    close=excluded.close,
    volume=excluded.volume,
    source=excluded.source
`);

function upsertBar(ticker, bar, source = 'finnhub') {
  if (!ticker || !bar || !Number.isFinite(bar.t)) return;
  UPSERT_STMT.run(
    ticker,
    Math.floor(bar.t),
    Number(bar.o) || 0,
    Number(bar.h) || 0,
    Number(bar.l) || 0,
    Number(bar.c) || 0,
    Math.floor(Number(bar.v) || 0),
    source,
  );
}

function upsertBatch(ticker, bars, source = 'yahoo') {
  let inserted = 0;
  for (const b of bars || []) {
    if (!Number.isFinite(b.t) || !Number.isFinite(b.c)) continue;
    UPSERT_STMT.run(
      ticker,
      Math.floor(b.t),
      Number(b.o ?? b.c),
      Number(b.h ?? b.c),
      Number(b.l ?? b.c),
      Number(b.c),
      Math.floor(Number(b.v) || 0),
      source,
    );
    inserted++;
  }
  return inserted;
}

function rangeForTicker(ticker, fromTs, toTs) {
  return db.prepare(
    `SELECT ts, open, high, low, close, volume FROM minute_bars
     WHERE ticker=? AND ts BETWEEN ? AND ? ORDER BY ts`
  ).all(ticker, fromTs, toTs);
}

function recentBars(ticker, n = 120, beforeTs = null) {
  const rows = beforeTs
    ? db.prepare(
        `SELECT ts, open, high, low, close, volume FROM minute_bars
         WHERE ticker=? AND ts<=? ORDER BY ts DESC LIMIT ?`
      ).all(ticker, beforeTs, n)
    : db.prepare(
        `SELECT ts, open, high, low, close, volume FROM minute_bars
         WHERE ticker=? ORDER BY ts DESC LIMIT ?`
      ).all(ticker, n);
  return rows.reverse();
}

function statsByTicker() {
  return db.prepare(`
    SELECT ticker,
           COUNT(*) AS n_bars,
           MIN(ts) AS first_ts,
           MAX(ts) AS last_ts,
           SUM(CASE WHEN source='finnhub' THEN 1 ELSE 0 END) AS live_bars,
           SUM(CASE WHEN source!='finnhub' THEN 1 ELSE 0 END) AS backfilled_bars
    FROM minute_bars
    GROUP BY ticker
    ORDER BY ticker
  `).all();
}

function bindCandleEngine(candleEngine) {
  if (!candleEngine || candleEngine._minuteBarsBound) return;
  candleEngine._minuteBarsBound = true;
  candleEngine.on('update', ({ symbol, snapshot }) => {
    const last = snapshot.candles1m?.[snapshot.candles1m.length - 1];
    if (last) upsertBar(symbol, last, 'finnhub');
  });
}

module.exports = {
  upsertBar,
  upsertBatch,
  rangeForTicker,
  recentBars,
  statsByTicker,
  bindCandleEngine,
};
