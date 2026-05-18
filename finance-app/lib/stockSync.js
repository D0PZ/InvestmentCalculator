const db = require('./db');
const { fetchQuotes } = require('./market');
const { getCurrentFX } = require('./fx');
const { ensurePriceCacheRow } = require('./portfolio');

async function refreshPrices() {
  const fromPositions = db.prepare(`SELECT DISTINCT ticker FROM positions`).all().map(r => r.ticker);
  const fromTrades = db.prepare(`
    SELECT ticker FROM trades
    GROUP BY ticker
    HAVING SUM(CASE WHEN side='BUY' THEN shares ELSE -shares END) > 0.000001
  `).all().map(r => r.ticker);
  const tickers = [...new Set([...fromPositions, ...fromTrades])];
  if (tickers.length === 0) return { refreshed: 0, message: 'sin posiciones ni trades' };

  const [quotes, fx] = await Promise.all([fetchQuotes(tickers), getCurrentFX({ force: true })]);
  const fxRate = fx.rate || 950;

  let refreshed = 0;
  for (const t of tickers) {
    const q = quotes[t];
    if (q?.price) {
      ensurePriceCacheRow(t, q.price, fxRate);
      refreshed++;
    }
  }

  return { refreshed, fx: fxRate, total: tickers.length };
}

module.exports = { refreshPrices };
