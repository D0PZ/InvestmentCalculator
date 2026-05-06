const express = require('express');
const router = express.Router();
const db = require('../lib/db');

router.get('/', (req, res) => {
  const subs = db.prepare(`SELECT * FROM subscriptions ORDER BY active DESC, monthly_cost DESC`).all();
  const total = subs.filter(s => s.active).reduce((a, b) => a + b.monthly_cost, 0);
  res.render('subscriptions', { subs, total, title: 'Suscripciones' });
});

router.post('/', (req, res) => {
  const { name, amount_total, installments, cycle, started_on, notes } = req.body;
  const inst = Math.max(1, Number(installments) || 1);
  const total = Math.round(Number(amount_total));
  let monthly = 0;
  if (cycle === 'monthly') monthly = total;
  else if (cycle === 'annual') monthly = Math.round(total / 12);
  else monthly = Math.round(total / inst);

  db.prepare(
    `INSERT INTO subscriptions (name, amount_total, installments, cycle, monthly_cost, started_on, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(name, total, inst, cycle, monthly, started_on || null, notes || null);
  res.redirect('/subscriptions');
});

router.post('/:id/toggle', (req, res) => {
  db.prepare(`UPDATE subscriptions SET active = 1 - active WHERE id=?`).run(Number(req.params.id));
  res.redirect('/subscriptions');
});

router.post('/:id/delete', (req, res) => {
  db.prepare(`DELETE FROM subscriptions WHERE id=?`).run(Number(req.params.id));
  res.redirect('/subscriptions');
});

module.exports = router;
