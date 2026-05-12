const fs = require('fs');
const path = require('path');
const db = require('./db');
const { fetchQuotes } = require('./market');
const { getCurrentFX } = require('./fx');
const { ensurePriceCacheRow } = require('./portfolio');

const POSITIONS_JSON = path.join(__dirname, '..', 'stock_scorer', 'positions.json');

function readStockScorerPositions() {
  if (!fs.existsSync(POSITIONS_JSON)) return [];
  try {
    return JSON.parse(fs.readFileSync(POSITIONS_JSON, 'utf-8'));
  } catch (e) {
    console.error('Error parsing positions.json:', e.message);
    return [];
  }
}

async function syncFromStockScorer() {
  const external = readStockScorerPositions();
  if (external.length === 0) return { imported: 0, updated: 0, message: 'positions.json vacío o no encontrado' };

  const tickers = [...new Set(external.map(p => p.ticker))];
  let quotes = {};
  let fxRate = 950;
  try {
    const [q, fx] = await Promise.all([fetchQuotes(tickers), getCurrentFX({ force: true })]);
    quotes = q;
    fxRate = fx.rate;
  } catch (e) {
    console.error('Yahoo fetch failed:', e.message);
  }

  let imported = 0, updated = 0;
  const upsert = db.prepare(`SELECT id FROM positions WHERE ticker=?`);
  const insert = db.prepare(
    `INSERT INTO positions (ticker, shares, avg_cost, market_price, currency, fx_to_clp)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const update = db.prepare(
    `UPDATE positions SET shares=?, avg_cost=?, market_price=?, currency=?, fx_to_clp=?, updated_at=datetime('now') WHERE id=?`
  );

  for (const p of external) {
    const q = quotes[p.ticker];
    const price = q?.price ?? p.entry_price;
    const currency = q?.currency || 'USD';
    const existing = upsert.get(p.ticker);
    if (existing) {
      update.run(p.shares, p.entry_price, price, currency, fxRate, existing.id);
      updated++;
    } else {
      insert.run(p.ticker, p.shares, p.entry_price, price, currency, fxRate);
      imported++;
    }
  }

  return { imported, updated, fx: fxRate, quoted: Object.keys(quotes).length, total: external.length };
}

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

module.exports = { syncFromStockScorer, refreshPrices, readStockScorerPositions };
