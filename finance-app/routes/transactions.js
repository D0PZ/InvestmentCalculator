const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { todayISO } = require('../lib/format');

router.get('/', (req, res) => {
  const rows = db.prepare(
    `SELECT t.*, a.name AS account_name FROM transactions t
     LEFT JOIN accounts a ON a.id = t.account_id
     ORDER BY occurred_on DESC, t.id DESC LIMIT 200`
  ).all();
  const accounts = db.prepare(`SELECT * FROM accounts ORDER BY name`).all();
  res.render('transactions', { rows, accounts, today: todayISO(), title: 'Movimientos' });
});

router.post('/', (req, res) => {
  const { kind, amount, category, description, account_id, occurred_on } = req.body;
  db.prepare(
    `INSERT INTO transactions (kind, amount, category, description, account_id, occurred_on)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    kind,
    Math.round(Number(amount)),
    category || null,
    description || null,
    account_id ? Number(account_id) : null,
    occurred_on || todayISO()
  );

  if (account_id) {
    const acc = db.prepare(`SELECT * FROM accounts WHERE id=?`).get(Number(account_id));
    if (acc) {
      const delta = kind === 'income' ? Math.round(Number(amount)) : -Math.round(Number(amount));
      if (acc.type === 'credit') {
        db.prepare(`UPDATE accounts SET credit_used = COALESCE(credit_used,0) + ?, updated_at=datetime('now') WHERE id=?`)
          .run(kind === 'expense' ? Math.round(Number(amount)) : -Math.round(Number(amount)), acc.id);
      } else {
        db.prepare(`UPDATE accounts SET balance = balance + ?, updated_at=datetime('now') WHERE id=?`)
          .run(delta, acc.id);
      }
    }
  }

  res.redirect('/transactions');
});

router.post('/:id/delete', (req, res) => {
  db.prepare(`DELETE FROM transactions WHERE id=?`).run(Number(req.params.id));
  res.redirect('/transactions');
});

module.exports = router;
