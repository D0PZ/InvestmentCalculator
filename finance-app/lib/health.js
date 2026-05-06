const db = require('./db');
const { monthRange, currentYYYYMM } = require('./format');

function computeHealth(yyyymm = currentYYYYMM()) {
  const { start, end } = monthRange(yyyymm);

  const income = db.prepare(
    `SELECT COALESCE(SUM(amount),0) AS total FROM transactions
     WHERE kind='income' AND occurred_on BETWEEN ? AND ?`
  ).get(start, end).total;

  const expenses = db.prepare(
    `SELECT COALESCE(SUM(amount),0) AS total FROM transactions
     WHERE kind='expense' AND occurred_on BETWEEN ? AND ?`
  ).get(start, end).total;

  const subsMonthly = db.prepare(
    `SELECT COALESCE(SUM(monthly_cost),0) AS total FROM subscriptions WHERE active=1`
  ).get().total;

  const accounts = db.prepare(`SELECT * FROM accounts`).all();
  const liquidCash = accounts
    .filter(a => a.type !== 'credit')
    .reduce((s, a) => s + (a.balance || 0), 0);

  const creditCards = accounts.filter(a => a.type === 'credit');
  const creditUsedTotal = creditCards.reduce((s, a) => s + (a.credit_used || 0), 0);
  const creditLimitTotal = creditCards.reduce((s, a) => s + (a.credit_limit || 0), 0);
  const creditUsagePct = creditLimitTotal ? (creditUsedTotal / creditLimitTotal) : 0;

  const positions = db.prepare(`SELECT * FROM positions`).all();
  const investmentsCLP = positions.reduce(
    (s, p) => s + (p.shares * p.market_price * p.fx_to_clp), 0
  );

  const netCashFlow = income - expenses;
  const projectedFreeCash = liquidCash + netCashFlow - subsMonthly;
  const totalPatrimony = liquidCash + investmentsCLP - creditUsedTotal;

  const savingsCapacity = Math.max(0, income - expenses - subsMonthly);
  const savingsRate = income ? (savingsCapacity / income) : 0;

  const racionalGoalMin = 500_000;
  const racionalGoalMax = 1_000_000;
  let racionalSuggested = 0;
  if (savingsCapacity >= racionalGoalMax) racionalSuggested = racionalGoalMax;
  else if (savingsCapacity >= racionalGoalMin) racionalSuggested = Math.round(savingsCapacity * 0.8 / 10000) * 10000;
  else racionalSuggested = Math.max(0, Math.round(savingsCapacity * 0.5 / 10000) * 10000);

  const tips = buildTips({
    creditUsagePct, savingsCapacity, racionalSuggested, racionalGoalMin,
    expenses, income, subsMonthly, projectedFreeCash, liquidCash
  });

  let score = 100;
  if (creditUsagePct > 0.7) score -= 25;
  else if (creditUsagePct > 0.5) score -= 10;
  if (savingsRate < 0.1) score -= 25;
  else if (savingsRate < 0.2) score -= 10;
  if (netCashFlow < 0) score -= 20;
  if (projectedFreeCash < 0) score -= 15;
  score = Math.max(0, Math.min(100, score));

  return {
    yyyymm, start, end,
    income, expenses, subsMonthly, netCashFlow,
    liquidCash, creditUsedTotal, creditLimitTotal, creditUsagePct,
    investmentsCLP, totalPatrimony, projectedFreeCash,
    savingsCapacity, savingsRate, racionalSuggested,
    racionalGoalMin, racionalGoalMax,
    score, tips,
    accounts, positions
  };
}

function buildTips(s) {
  const tips = [];

  if (s.creditUsagePct > 0.7) {
    tips.push({
      level: 'danger',
      title: 'Uso de crédito alto',
      body: `Tu CMR está al ${(s.creditUsagePct*100).toFixed(0)}% del cupo. Prioriza pagar antes de cargar gastos nuevos para evitar intereses y bajar tu utilización.`
    });
  } else if (s.creditUsagePct > 0.5) {
    tips.push({
      level: 'warn',
      title: 'Crédito sobre 50%',
      body: 'Cuidado con cargar más gastos al CMR este mes. Mantenlo bajo 50% mejora salud financiera y deja margen para imprevistos.'
    });
  }

  if (s.projectedFreeCash < 0) {
    tips.push({
      level: 'danger',
      title: 'Flujo proyectado negativo',
      body: `Después de gastos y suscripciones quedarías con flujo negativo. Recorta gastos variables o difiere algún gasto no esencial.`
    });
  }

  if (s.savingsCapacity >= s.racionalGoalMin) {
    tips.push({
      level: 'good',
      title: `Aporte a Racional sugerido: $${s.racionalSuggested.toLocaleString('es-CL')}`,
      body: `Tienes capacidad de ahorro suficiente para aportar dentro de tu meta (500k–1M). Programa la transferencia ni bien recibas el sueldo.`
    });
  } else if (s.savingsCapacity > 0) {
    tips.push({
      level: 'warn',
      title: 'Mes ajustado para Racional',
      body: `Tu capacidad de ahorro (${s.savingsCapacity.toLocaleString('es-CL')}) está bajo la meta mínima de 500k. Considera un aporte parcial de $${s.racionalSuggested.toLocaleString('es-CL')} y revisa gastos variables.`
    });
  } else {
    tips.push({
      level: 'danger',
      title: 'Sin capacidad de ahorro este mes',
      body: 'Los gastos + suscripciones igualan o superan tus ingresos. Identifica suscripciones a pausar o gastos a recortar antes de pensar en aportes.'
    });
  }

  if (s.subsMonthly > s.income * 0.15) {
    tips.push({
      level: 'warn',
      title: 'Suscripciones sobre 15% del sueldo',
      body: `Estás gastando $${s.subsMonthly.toLocaleString('es-CL')}/mes en suscripciones. Audita cuáles usas activamente y cancela las que no aporten valor.`
    });
  }

  return tips;
}

module.exports = { computeHealth };
