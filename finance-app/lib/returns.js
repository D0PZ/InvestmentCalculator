const db = require('./db');
const { getPriceOnOrBefore, getPortfolioValueAt } = require('./history');
const { getSnapshotOnOrBefore, monthStart, yearStart } = require('./snapshots');
const { todayISO, currentYYYYMM } = require('./format');
const { netPositionsFromTrades, getPriceCache } = require('./portfolio');

function pctChange(current, base) {
  if (!base || base === 0) return null;
  return (current - base) / base;
}

async function computePositionReturns(currentFX) {
  const positions = netPositionsFromTrades();
  const priceCache = getPriceCache();
  const monthStartISO = monthStart(currentYYYYMM());
  const yearStartISO = yearStart(currentYYYYMM());
  const fxNow = Number(currentFX) > 0 ? Number(currentFX) : null;

  const out = [];
  for (const p of positions) {
    const cache = priceCache.get(p.ticker);
    const marketPrice = cache?.market_price ?? p.avg_cost;
    const fxValue = fxNow ?? cache?.fx_to_clp ?? p.avg_fx ?? 1;
    const fxCost = p.avg_fx ?? cache?.fx_to_clp ?? fxValue;

    const valueNow = p.shares * marketPrice * fxValue;
    const costBasis = p.shares * p.avg_cost * fxCost;
    const totalRet = pctChange(marketPrice, p.avg_cost);

    const monthPx = await getPriceOnOrBefore(p.ticker, monthStartISO);
    const yearPx = await getPriceOnOrBefore(p.ticker, yearStartISO);

    const monthRet = monthPx ? pctChange(marketPrice, monthPx.close) : null;
    const yearRet = yearPx ? pctChange(marketPrice, yearPx.close) : null;

    out.push({
      id: cache?.id ?? null,
      ticker: p.ticker,
      shares: p.shares,
      avg_cost: p.avg_cost,
      market_price: marketPrice,
      fx_to_clp: fxValue,
      fx_cost: fxCost,
      trade_count: p.trade_count,
      first_buy_date: p.first_buy_date,
      value_clp: valueNow,
      cost_clp: costBasis,
      pl_clp: valueNow - costBasis,
      total_return: totalRet,
      month_return: monthRet,
      year_return: yearRet,
      month_ref_date: monthPx?.date || null,
      year_ref_date: yearPx?.date || null,
      price_cached_at: cache?.updated_at || null,
    });
  }
  return out;
}

async function computePortfolioReturns(currentFX) {
  const positions = netPositionsFromTrades();
  const priceCache = getPriceCache();
  const fxNow = Number(currentFX) > 0 ? Number(currentFX) : 1;
  const valueNow = positions.reduce((s, p) => {
    const px = priceCache.get(p.ticker)?.market_price ?? p.avg_cost;
    return s + p.shares * px * fxNow;
  }, 0);
  const costBasis = positions.reduce((s, p) => {
    const fxCost = p.avg_fx ?? priceCache.get(p.ticker)?.fx_to_clp ?? fxNow;
    return s + p.shares * p.avg_cost * fxCost;
  }, 0);

  const monthSnapshot = getSnapshotOnOrBefore('portfolio_snapshots', monthStart(currentYYYYMM()));
  const yearSnapshot = getSnapshotOnOrBefore('portfolio_snapshots', yearStart(currentYYYYMM()));

  let monthBaseline = monthSnapshot?.value_clp ?? null;
  let yearBaseline = yearSnapshot?.value_clp ?? null;
  let monthApprox = false, yearApprox = false;

  if (monthBaseline === null) {
    monthBaseline = await getPortfolioValueAt(positions, monthStart(currentYYYYMM()), currentFX);
    monthApprox = true;
  }
  if (yearBaseline === null) {
    yearBaseline = await getPortfolioValueAt(positions, yearStart(currentYYYYMM()), currentFX);
    yearApprox = true;
  }

  return {
    value_clp: valueNow,
    cost_clp: costBasis,
    pl_clp: valueNow - costBasis,
    total_return: pctChange(valueNow, costBasis),
    month_return: pctChange(valueNow, monthBaseline),
    year_return: pctChange(valueNow, yearBaseline),
    month_baseline: monthBaseline,
    year_baseline: yearBaseline,
    month_approx: monthApprox,
    year_approx: yearApprox,
  };
}

function computePatrimonyReturns(today = todayISO()) {
  const monthSnap = getSnapshotOnOrBefore('patrimony_snapshots', monthStart(today.slice(0, 7)));
  const yearSnap = getSnapshotOnOrBefore('patrimony_snapshots', yearStart(today.slice(0, 7)));
  const todaySnap = getSnapshotOnOrBefore('patrimony_snapshots', today);

  if (!todaySnap) return null;
  return {
    today: todaySnap.total_clp,
    month_baseline: monthSnap?.total_clp ?? null,
    year_baseline: yearSnap?.total_clp ?? null,
    month_return: monthSnap ? pctChange(todaySnap.total_clp, monthSnap.total_clp) : null,
    year_return: yearSnap ? pctChange(todaySnap.total_clp, yearSnap.total_clp) : null,
    month_delta: monthSnap ? todaySnap.total_clp - monthSnap.total_clp : null,
    year_delta: yearSnap ? todaySnap.total_clp - yearSnap.total_clp : null,
  };
}

module.exports = { computePositionReturns, computePortfolioReturns, computePatrimonyReturns, pctChange };
