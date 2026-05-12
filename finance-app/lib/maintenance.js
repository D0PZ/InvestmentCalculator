const db = require('./db');

const DEFAULT_RETENTION_DAYS = 90;
const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000;

function cutoffTs(days = DEFAULT_RETENTION_DAYS) {
  return Date.now() - days * 86400000;
}

function pruneSignals(days = DEFAULT_RETENTION_DAYS) {
  const ts = cutoffTs(days);
  const r = db.prepare(`DELETE FROM signals WHERE ts < ?`).run(ts);
  return r.changes;
}

function pruneAlerts(days = DEFAULT_RETENTION_DAYS) {
  const ts = cutoffTs(days);
  const r = db.prepare(`DELETE FROM alerts WHERE ts < ?`).run(ts);
  return r.changes;
}

function pruneFxRates(days = 730) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const r = db.prepare(`DELETE FROM fx_rates WHERE date < ?`).run(cutoff);
  return r.changes;
}

function runOnce(days = DEFAULT_RETENTION_DAYS) {
  const started = Date.now();
  const signals = pruneSignals(days);
  const alerts = pruneAlerts(days);
  const fx = pruneFxRates(730);
  const elapsed = Date.now() - started;
  const result = { signals, alerts, fx, elapsed_ms: elapsed };
  if (signals + alerts + fx > 0) {
    console.log(`[maintenance] pruned signals=${signals} alerts=${alerts} fx=${fx} in ${elapsed}ms`);
  }
  return result;
}

let timer = null;
function startScheduler({ days = DEFAULT_RETENTION_DAYS, intervalMs = RUN_INTERVAL_MS } = {}) {
  if (timer) return;
  try { runOnce(days); } catch (e) { console.error('[maintenance] initial run failed:', e.message); }
  timer = setInterval(() => {
    try { runOnce(days); } catch (e) { console.error('[maintenance] scheduled run failed:', e.message); }
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
}

function stopScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  runOnce,
  pruneSignals,
  pruneAlerts,
  pruneFxRates,
  startScheduler,
  stopScheduler,
  DEFAULT_RETENTION_DAYS,
};
