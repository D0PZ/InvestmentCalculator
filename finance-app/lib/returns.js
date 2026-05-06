const db = require('./db');
const { getPriceOnOrBefore, getPortfolioValueAt } = require('./history');
const { getSnapshotOnOrBefore, monthStart, yearStart } = require('./snapshots');
const { todayISO, currentYYYYMM } = require('./format');

function pctChange(current, base) {
  if (!base || base === 0) return null;
  return (current - base) / base;
}

async function computePositionReturns(currentFX) {
  const positions = db.prepare(`SELECT * FROM positions ORDER BY ticker`).all();
  const today = todayISO();
  const monthStartISO = monthStart(currentYYYYMM());
  const yearStartISO = yearStart(currentYYYYMM());

  const out = [];
  for (const p of positions) {
    const valueNow = p.shares * p.market_price * p.fx_to_clp;
    const costBasis = p.shares * p.avg_cost * p.fx_to_clp;
    const totalRet = pctChange(p.market_price, p.avg_cost);

    const monthPx = await getPriceOnOrBefore(p.ticker, monthStartISO);
    const yearPx = await getPriceOnOrBefore(p.ticker, yearStartISO);

    const monthRet = monthPx ? pctChange(p.market_price, monthPx.close) : null;
    const yearRet = yearPx ? pctChange(p.market_price, yearPx.close) : null;

    out.push({
      ...p,
      value_clp: valueNow,
      cost_clp: costBasis,
      pl_clp: valueNow - costBasis,
      total_return: totalRet,
      month_return: monthRet,
      year_return: yearRet,
      month_ref_date: monthPx?.date || null,
      year_ref_date: yearPx?.date || null,
    });
  }
  return out;
}

async function computePortfolioReturns(currentFX) {
  const positions = db.prepare(`SELECT * FROM positions`).all();
  const valueNow = positions.reduce((s, p) => s + p.shares * p.market_price * p.fx_to_clp, 0);
  const costBasis = positions.reduce((s, p) => s + p.shares * p.avg_cost * p.fx_to_clp, 0);

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
