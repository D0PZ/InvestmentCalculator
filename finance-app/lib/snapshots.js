const db = require('./db');
const { todayISO } = require('./format');

function todaySnapshotExists(table = 'portfolio_snapshots') {
  return !!db.prepare(`SELECT 1 FROM ${table} WHERE date=?`).get(todayISO());
}

function recordPortfolioSnapshot() {
  const today = todayISO();
  const positions = db.prepare(`SELECT * FROM positions`).all();
  let value = 0, cost = 0;
  for (const p of positions) {
    value += p.shares * p.market_price * p.fx_to_clp;
    cost += p.shares * p.avg_cost * p.fx_to_clp;
  }
  db.prepare(
    `INSERT INTO portfolio_snapshots (date, value_clp, cost_clp, fx, positions_json)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       value_clp=excluded.value_clp, cost_clp=excluded.cost_clp,
       fx=excluded.fx, positions_json=excluded.positions_json`
  ).run(
    today,
    Math.round(value),
    Math.round(cost),
    positions[0]?.fx_to_clp || 0,
    JSON.stringify(positions.map(p => ({ ticker: p.ticker, shares: p.shares, market_price: p.market_price, avg_cost: p.avg_cost, fx_to_clp: p.fx_to_clp })))
  );
  return { date: today, value, cost };
}

function recordPatrimonySnapshot() {
  const today = todayISO();
  const accounts = db.prepare(`SELECT * FROM accounts`).all();
  const positions = db.prepare(`SELECT * FROM positions`).all();

  const cash = accounts.filter(a => a.type !== 'credit').reduce((s, a) => s + (a.balance || 0), 0);
  const debt = accounts.filter(a => a.type === 'credit').reduce((s, a) => s + (a.credit_used || 0), 0);
  const investments = positions.reduce((s, p) => s + (p.shares * p.market_price * p.fx_to_clp), 0);
  const total = cash + investments - debt;

  db.prepare(
    `INSERT INTO patrimony_snapshots (date, cash_clp, investments_clp, debt_clp, total_clp)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       cash_clp=excluded.cash_clp, investments_clp=excluded.investments_clp,
       debt_clp=excluded.debt_clp, total_clp=excluded.total_clp`
  ).run(today, Math.round(cash), Math.round(investments), Math.round(debt), Math.round(total));

  return { date: today, cash, investments, debt, total };
}

function ensureTodaySnapshots() {
  recordPortfolioSnapshot();
  recordPatrimonySnapshot();
}

function getSnapshotOnOrBefore(table, dateISO) {
  return db.prepare(`SELECT * FROM ${table} WHERE date<=? ORDER BY date DESC LIMIT 1`).get(dateISO);
}

function monthStart(yyyymm) {
  return `${yyyymm}-01`;
}

function yearStart(yyyymm) {
  return `${yyyymm.slice(0, 4)}-01-01`;
}

module.exports = {
  recordPortfolioSnapshot,
  recordPatrimonySnapshot,
  ensureTodaySnapshots,
  getSnapshotOnOrBefore,
  monthStart,
  yearStart,
  todaySnapshotExists,
};
