require('dotenv').config();
const db = require('./lib/db');

console.log('🌱 Seeding initial data...');

const txCount = db.prepare(`SELECT COUNT(*) AS c FROM accounts`).get().c;
if (txCount > 0) {
  console.log('⚠️  Data already exists. Skipping seed (delete data/finance.db to reset).');
  process.exit(0);
}

const insertAccount = db.prepare(
  `INSERT INTO accounts (name, type, balance, credit_limit, credit_used, notes)
   VALUES (?, ?, ?, ?, ?, ?)`
);

insertAccount.run('Tenpo', 'digital', 83434, null, null, 'Cuenta digital');
insertAccount.run('Falabella CMR', 'credit', 0, 1528000, 1000238, 'Cupo total = disponible 528.762 + utilizado 1.000.238');
insertAccount.run('Débito Falabella', 'debit', 209239, null, null, 'Saldo del mes');
insertAccount.run('Amipass', 'benefit', 113116, null, null, 'Almuerzos 6k–12k típicos');

const insertSub = db.prepare(
  `INSERT INTO subscriptions (name, amount_total, installments, cycle, monthly_cost, started_on, notes)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);

insertSub.run('Gym', 342000, 12, 'installment', Math.round(342000/12), null, '12 cuotas');
insertSub.run('Claude', 110348, 1, 'monthly', 110348, null, 'Mensual');
insertSub.run('Plan Racional Anual', 65940, 12, 'annual', Math.round(65940/12), null, 'Anual dividido en 12');
insertSub.run('AWS Lightsail', 21430, 1, 'monthly', 21430, null, '2 hosts');

const today = new Date().toISOString().slice(0, 10);
const insertTx = db.prepare(
  `INSERT INTO transactions (kind, amount, category, description, occurred_on)
   VALUES (?, ?, ?, ?, ?)`
);
insertTx.run('income', 1454995, 'sueldo', 'Sueldo mensual', today);
insertTx.run('expense', 1093550, 'pago crédito', 'Pago CMR del mes', today);

console.log('✅ Seeded accounts, subscriptions, and initial transactions.');
console.log('   Run: npm start');
