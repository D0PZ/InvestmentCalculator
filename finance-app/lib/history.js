const db = require('./db');
const { fetchHistory } = require('./market');

async function fetchHistoricalRange(ticker, fromISO, toISO) {
  return fetchHistory(ticker, fromISO, toISO);
}

function readCachedPrice(ticker, date) {
  return db.prepare(`SELECT close FROM price_history WHERE ticker=? AND date=?`).get(ticker, date)?.close ?? null;
}

function readCachedRange(ticker, fromISO, toISO) {
  return db.prepare(
    `SELECT date, close FROM price_history WHERE ticker=? AND date BETWEEN ? AND ? ORDER BY date`
  ).all(ticker, fromISO, toISO);
}

function writeCachedPrices(ticker, rows) {
  const stmt = db.prepare(
    `INSERT INTO price_history (ticker, date, close) VALUES (?, ?, ?)
     ON CONFLICT(ticker, date) DO UPDATE SET close=excluded.close`
  );
  for (const r of rows) stmt.run(ticker, r.date, r.close);
}

async function getPriceOnOrBefore(ticker, dateISO) {
  const cached = db.prepare(
    `SELECT date, close FROM price_history WHERE ticker=? AND date<=? ORDER BY date DESC LIMIT 1`
  ).get(ticker, dateISO);
  if (cached) {
    const ageDays = (new Date(dateISO).getTime() - new Date(cached.date).getTime()) / 86400000;
    if (ageDays <= 4) return cached;
  }

  const fromISO = new Date(new Date(dateISO).getTime() - 14 * 86400000).toISOString().slice(0, 10);
  const rows = await fetchHistoricalRange(ticker, fromISO, dateISO);
  if (rows.length > 0) {
    writeCachedPrices(ticker, rows);
    return rows[rows.length - 1];
  }
  return cached || null;
}

async function getPortfolioValueAt(positions, dateISO, currentFX) {
  if (!positions || positions.length === 0) return 0;
  let total = 0;
  for (const p of positions) {
    const px = await getPriceOnOrBefore(p.ticker, dateISO);
    if (px) total += p.shares * px.close * (currentFX || p.fx_to_clp);
  }
  return total;
}

module.exports = { fetchHistoricalRange, getPriceOnOrBefore, getPortfolioValueAt, readCachedRange };
