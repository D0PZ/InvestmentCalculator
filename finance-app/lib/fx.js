const db = require('./db');
const { fetchUSDCLP } = require('./market');

const STALE_MS = 6 * 60 * 60 * 1000;

function readCached() {
  const row = db.prepare(`SELECT value FROM settings WHERE key='fx_usdclp'`).get();
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

function writeCached(rate) {
  const payload = JSON.stringify({ rate, fetched_at: new Date().toISOString() });
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('fx_usdclp', ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  ).run(payload);
}

function isStale(cached) {
  if (!cached?.fetched_at) return true;
  return (Date.now() - new Date(cached.fetched_at).getTime()) > STALE_MS;
}

async function getCurrentFX({ force = false } = {}) {
  const cached = readCached();
  if (!force && cached && !isStale(cached)) return cached;

  const live = await fetchUSDCLP();
  if (live && live > 0) {
    writeCached(live);
    return { rate: live, fetched_at: new Date().toISOString() };
  }
  return cached || { rate: 950, fetched_at: null, fallback: true };
}

function getCachedFX() {
  return readCached() || { rate: 950, fetched_at: null, fallback: true };
}

module.exports = { getCurrentFX, getCachedFX };
