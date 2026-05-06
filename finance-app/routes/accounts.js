const express = require('express');
const router = express.Router();
const db = require('../lib/db');

router.get('/', (req, res) => {
  const accounts = db.prepare(`SELECT * FROM accounts ORDER BY type, name`).all();
  res.render('accounts', { accounts, title: 'Cuentas' });
});

router.post('/', (req, res) => {
  const { name, type, balance, credit_limit, credit_used, notes } = req.body;
  db.prepare(
    `INSERT INTO accounts (name, type, balance, credit_limit, credit_used, notes)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    name, type,
    Math.round(Number(balance) || 0),
    credit_limit ? Math.round(Number(credit_limit)) : null,
    credit_used ? Math.round(Number(credit_used)) : null,
    notes || null
  );
  res.redirect('/accounts');
});

router.post('/:id/update', (req, res) => {
  const { balance, credit_limit, credit_used, notes } = req.body;
  db.prepare(
    `UPDATE accounts SET balance=?, credit_limit=?, credit_used=?, notes=?, updated_at=datetime('now') WHERE id=?`
  ).run(
    Math.round(Number(balance) || 0),
    credit_limit ? Math.round(Number(credit_limit)) : null,
    credit_used ? Math.round(Number(credit_used)) : null,
    notes || null,
    Number(req.params.id)
  );
  res.redirect('/accounts');
});

router.post('/:id/delete', (req, res) => {
  db.prepare(`DELETE FROM accounts WHERE id=?`).run(Number(req.params.id));
  res.redirect('/accounts');
});

module.exports = router;
