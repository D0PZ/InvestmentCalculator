const db = require('./db');

function getPriceCache() {
  const rows = db.prepare(`SELECT ticker, market_price, fx_to_clp, updated_at FROM positions`).all();
  const out = new Map();
  for (const r of rows) out.set(r.ticker, r);
  return out;
}

function ensurePriceCacheRow(ticker, price, fx) {
  const existing = db.prepare(`SELECT id FROM positions WHERE ticker=?`).get(ticker);
  if (existing) {
    db.prepare(
      `UPDATE positions SET market_price=?, fx_to_clp=?, updated_at=datetime('now') WHERE id=?`
    ).run(price, fx, existing.id);
    return existing.id;
  }
  const r = db.prepare(
    `INSERT INTO positions (ticker, shares, avg_cost, market_price, currency, fx_to_clp)
     VALUES (?, 0, ?, ?, 'USD', ?)`
  ).run(ticker, price, price, fx);
  return r.lastInsertRowid;
}

function netPositionsFromTrades() {
  return db.prepare(`
    SELECT ticker,
           SUM(CASE WHEN side='BUY' THEN shares ELSE 0 END) AS bought,
           SUM(CASE WHEN side='SELL' THEN shares ELSE 0 END) AS sold,
           SUM(CASE WHEN side='BUY' THEN shares*price_usd ELSE 0 END) AS cost_usd_buys,
           SUM(CASE WHEN side='BUY' THEN shares*price_usd*COALESCE(fx_clp,0) ELSE 0 END) AS cost_clp_buys,
           SUM(CASE WHEN side='BUY' AND fx_clp IS NOT NULL THEN shares ELSE 0 END) AS shares_with_fx,
           MIN(CASE WHEN side='BUY' THEN trade_date END) AS first_buy_date,
           COUNT(*) AS trade_count
    FROM trades
    GROUP BY ticker
    HAVING bought - sold > 0.000001
  `).all().map(r => {
    const bought = Number(r.bought) || 0;
    const sold = Number(r.sold) || 0;
    const shares = bought - sold;
    const costUsdBuys = Number(r.cost_usd_buys) || 0;
    const avgCost = bought > 0 ? costUsdBuys / bought : 0;
    const fxShares = Number(r.shares_with_fx) || 0;
    const costClpBuys = Number(r.cost_clp_buys) || 0;
    const avgFx = fxShares > 0 ? (costClpBuys / costUsdBuys) * (bought / fxShares) : null;
    return {
      ticker: r.ticker,
      shares: +shares.toFixed(8),
      avg_cost: +avgCost.toFixed(4),
      cost_usd: +(shares * avgCost).toFixed(2),
      avg_fx: avgFx,
      first_buy_date: r.first_buy_date,
      trade_count: r.trade_count,
    };
  });
}

function getPortfolioSummary() {
  return netPositionsFromTrades();
}

module.exports = {
  netPositionsFromTrades,
  getPriceCache,
  ensurePriceCacheRow,
  getPortfolioSummary,
};
