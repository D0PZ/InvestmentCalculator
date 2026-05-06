const fs = require('fs');
const path = require('path');
const db = require('./db');
const { fetchQuotes, fetchUSDCLP } = require('./market');

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
  let fx = null;
  try {
    [quotes, fx] = await Promise.all([fetchQuotes(tickers), fetchUSDCLP()]);
  } catch (e) {
    console.error('Yahoo fetch failed:', e.message);
  }
  const fxRate = fx || 950;

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
  const positions = db.prepare(`SELECT * FROM positions`).all();
  if (positions.length === 0) return { refreshed: 0, message: 'sin posiciones' };

  const tickers = [...new Set(positions.map(p => p.ticker))];
  const [quotes, fx] = await Promise.all([fetchQuotes(tickers), fetchUSDCLP()]);
  const fxRate = fx || positions[0].fx_to_clp || 950;

  const update = db.prepare(
    `UPDATE positions SET market_price=?, fx_to_clp=?, updated_at=datetime('now') WHERE id=?`
  );

  let refreshed = 0;
  for (const p of positions) {
    const q = quotes[p.ticker];
    if (q?.price) {
      update.run(q.price, fxRate, p.id);
      refreshed++;
    }
  }

  return { refreshed, fx: fxRate, total: positions.length };
}

module.exports = { syncFromStockScorer, refreshPrices, readStockScorerPositions };
