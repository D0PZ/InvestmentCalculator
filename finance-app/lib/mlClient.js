const log = require('./logger').child('mlClient');

const ML_URL = process.env.ML_PREDICT_URL || 'http://127.0.0.1:8001';
const ML_TIMEOUT_MS = Number(process.env.ML_PREDICT_TIMEOUT_MS) || 2500;
const ENABLED = (process.env.ML_PREDICT_ENABLED || 'true').toLowerCase() !== 'false';
const BOOT_RETRY_MS = Number(process.env.ML_PREDICT_BOOT_RETRY_MS) || 30_000;

let healthState = { ok: false, lastChecked: 0, lastError: null };

async function withTimeout(promise, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await promise(ctrl.signal); } finally { clearTimeout(t); }
}

async function health() {
  if (!ENABLED) return { ok: false, disabled: true };
  try {
    const res = await withTimeout((signal) => fetch(`${ML_URL}/health`, { signal }), ML_TIMEOUT_MS);
    const body = await res.json();
    healthState = { ok: !!body.ok, lastChecked: Date.now(), lastError: null };
    return body;
  } catch (err) {
    healthState = { ok: false, lastChecked: Date.now(), lastError: err.message };
    return { ok: false, error: err.message };
  }
}

async function predict({ symbol, bars }) {
  if (!ENABLED) return null;
  if (!Array.isArray(bars) || bars.length < 60) return null;
  try {
    const res = await withTimeout((signal) => fetch(`${ML_URL}/predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, bars }),
      signal,
    }), ML_TIMEOUT_MS);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: text };
    }
    return await res.json();
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function signalsBatch({ tickers, threshold = null, lookbackBars = 120, onlyPassing = true } = {}) {
  if (!ENABLED) return null;
  if (!Array.isArray(tickers) || tickers.length === 0) return null;
  try {
    const res = await withTimeout((signal) => fetch(`${ML_URL}/signals_batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tickers,
        threshold,
        lookback_bars: lookbackBars,
        only_passing: onlyPassing,
      }),
      signal,
    }), ML_TIMEOUT_MS * 4);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: text };
    }
    return await res.json();
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function getHealthState() { return { ...healthState }; }

async function probeOnBoot({ attempts = 2 } = {}) {
  if (!ENABLED) {
    log.info({ url: ML_URL }, 'ML predict service disabled by env');
    return { ok: false, disabled: true };
  }
  for (let i = 1; i <= attempts; i++) {
    const r = await health();
    if (r && r.ok) {
      log.info({ url: ML_URL, version: r.version }, 'ML predict service reachable');
      return r;
    }
    if (i < attempts) await new Promise(res => setTimeout(res, 1000));
  }
  log.warn({
    url: ML_URL,
    error: healthState.lastError,
    retryHint: `set ML_PREDICT_ENABLED=false to silence, or start the Python service (see agent/README.md). Will retry per-call.`,
  }, 'ML predict service unreachable at boot');
  return { ok: false, error: healthState.lastError };
}

module.exports = { predict, signalsBatch, health, getHealthState, probeOnBoot, ML_URL, ENABLED };
