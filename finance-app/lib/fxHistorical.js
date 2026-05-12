const db = require('./db');

const COMMON_HEADERS = { 'User-Agent': 'finance-app/1.0 (personal use)' };

function toDMY(isoDate) {
  const [y, m, d] = isoDate.split('-');
  return `${d}-${m}-${y}`;
}

function readCachedRate(isoDate) {
  const row = db.prepare(`SELECT rate FROM fx_rates WHERE date=?`).get(isoDate);
  return row ? Number(row.rate) : null;
}

function writeCachedRate(isoDate, rate, source = 'mindicador.cl') {
  db.prepare(
    `INSERT INTO fx_rates (date, rate, source) VALUES (?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET rate=excluded.rate, source=excluded.source, fetched_at=datetime('now')`
  ).run(isoDate, rate, source);
}

async function fetchUSDCLPForDate(isoDate) {
  const cached = readCachedRate(isoDate);
  if (cached) return cached;

  const url = `https://mindicador.cl/api/dolar/${toDMY(isoDate)}`;
  try {
    const res = await fetch(url, { headers: COMMON_HEADERS });
    if (!res.ok) return null;
    const data = await res.json();
    const valor = data?.serie?.[0]?.valor;
    if (Number.isFinite(valor) && valor > 0) {
      writeCachedRate(isoDate, valor);
      return valor;
    }
  } catch {}
  return null;
}

async function fetchUSDCLPNearest(isoDate, maxBackDays = 5) {
  const direct = await fetchUSDCLPForDate(isoDate);
  if (direct) return { rate: direct, date: isoDate, exact: true };

  const base = new Date(isoDate + 'T12:00:00Z');
  for (let i = 1; i <= maxBackDays; i++) {
    const d = new Date(base.getTime() - i * 86400000);
    const iso = d.toISOString().slice(0, 10);
    const r = await fetchUSDCLPForDate(iso);
    if (r) return { rate: r, date: iso, exact: false };
  }
  return null;
}

function getAllCached() {
  return db.prepare(`SELECT date, rate FROM fx_rates ORDER BY date`).all();
}

module.exports = {
  fetchUSDCLPForDate,
  fetchUSDCLPNearest,
  readCachedRate,
  writeCachedRate,
  getAllCached,
};
