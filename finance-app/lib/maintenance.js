const db = require('./db');
const log = require('./logger').child('maintenance');

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
  try { db.optimize(); } catch (e) { log.warn({ err: e.message }, 'optimize failed'); }
  const elapsed = Date.now() - started;
  const result = { signals, alerts, fx, elapsed_ms: elapsed };
  if (signals + alerts + fx > 0) {
    log.info({ signals, alerts, fx, elapsedMs: elapsed }, 'pruned + optimized');
  }
  return result;
}

let timer = null;
function startScheduler({ days = DEFAULT_RETENTION_DAYS, intervalMs = RUN_INTERVAL_MS } = {}) {
  if (timer) return;
  try { runOnce(days); } catch (e) { log.error({ err: e }, 'initial run failed'); }
  timer = setInterval(() => {
    try { runOnce(days); } catch (e) { log.error({ err: e }, 'scheduled run failed'); }
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
