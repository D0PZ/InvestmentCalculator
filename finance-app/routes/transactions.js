const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const { todayISO } = require('../lib/format');

function applyAccountEffect(accountId, kind, amount, sign) {
  if (!accountId) return;
  const acc = db.prepare(`SELECT * FROM accounts WHERE id=?`).get(Number(accountId));
  if (!acc) return;
  const amt = Math.round(Number(amount));
  if (acc.type === 'credit') {
    const delta = (kind === 'expense' ? amt : -amt) * sign;
    db.prepare(`UPDATE accounts SET credit_used = COALESCE(credit_used,0) + ?, updated_at=datetime('now') WHERE id=?`).run(delta, acc.id);
  } else {
    const delta = (kind === 'income' ? amt : -amt) * sign;
    db.prepare(`UPDATE accounts SET balance = balance + ?, updated_at=datetime('now') WHERE id=?`).run(delta, acc.id);
  }
}

router.get('/', (req, res) => {
  const { category, kind, q } = req.query;
  let sql = `SELECT t.*, a.name AS account_name FROM transactions t
             LEFT JOIN accounts a ON a.id = t.account_id WHERE 1=1`;
  const params = [];
  if (category) { sql += ` AND t.category = ?`; params.push(category); }
  if (kind) { sql += ` AND t.kind = ?`; params.push(kind); }
  if (q) { sql += ` AND (t.description LIKE ? OR t.category LIKE ?)`; params.push(`%${q}%`, `%${q}%`); }
  sql += ` ORDER BY occurred_on DESC, t.id DESC LIMIT 200`;

  const rows = db.prepare(sql).all(...params);
  const accounts = db.prepare(`SELECT * FROM accounts ORDER BY name`).all();
  const categories = db.prepare(
    `SELECT DISTINCT category FROM transactions WHERE category IS NOT NULL AND category!='' ORDER BY category`
  ).all().map(r => r.category);

  res.render('transactions', {
    rows, accounts, categories,
    today: todayISO(),
    filters: { category: category || '', kind: kind || '', q: q || '' },
    title: 'Movimientos',
  });
});

router.post('/', (req, res) => {
  const { kind, amount, category, description, account_id, occurred_on } = req.body;
  const amt = Math.round(Number(amount));
  const result = db.prepare(
    `INSERT INTO transactions (kind, amount, category, description, account_id, occurred_on)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(kind, amt, category || null, description || null, account_id ? Number(account_id) : null, occurred_on || todayISO());

  applyAccountEffect(account_id, kind, amt, 1);
  res.redirect('/transactions');
});

router.get('/:id/edit', (req, res) => {
  const tx = db.prepare(`SELECT * FROM transactions WHERE id=?`).get(Number(req.params.id));
  if (!tx) return res.redirect('/transactions');
  const accounts = db.prepare(`SELECT * FROM accounts ORDER BY name`).all();
  res.render('transaction_edit', { tx, accounts, title: 'Editar movimiento' });
});

router.post('/:id/update', (req, res) => {
  const id = Number(req.params.id);
  const old = db.prepare(`SELECT * FROM transactions WHERE id=?`).get(id);
  if (!old) return res.redirect('/transactions');

  const { kind, amount, category, description, account_id, occurred_on } = req.body;
  const newAmount = Math.round(Number(amount));
  const newAccountId = account_id ? Number(account_id) : null;

  applyAccountEffect(old.account_id, old.kind, old.amount, -1);

  db.prepare(
    `UPDATE transactions SET kind=?, amount=?, category=?, description=?, account_id=?, occurred_on=? WHERE id=?`
  ).run(kind, newAmount, category || null, description || null, newAccountId, occurred_on || old.occurred_on, id);

  applyAccountEffect(newAccountId, kind, newAmount, 1);
  res.redirect('/transactions');
});

router.post('/:id/delete', (req, res) => {
  const id = Number(req.params.id);
  const old = db.prepare(`SELECT * FROM transactions WHERE id=?`).get(id);
  if (old) applyAccountEffect(old.account_id, old.kind, old.amount, -1);
  db.prepare(`DELETE FROM transactions WHERE id=?`).run(id);
  res.redirect('/transactions');
});

router.get('/export.csv', (req, res) => {
  const rows = db.prepare(
    `SELECT t.occurred_on, t.kind, t.category, t.description, a.name AS account, t.amount
     FROM transactions t LEFT JOIN accounts a ON a.id=t.account_id
     ORDER BY occurred_on DESC, t.id DESC`
  ).all();
  const csv = ['fecha,tipo,categoria,descripcion,cuenta,monto']
    .concat(rows.map(r => [
      r.occurred_on, r.kind, r.category || '', (r.description || '').replaceAll(',', ';'),
      r.account || '', r.amount,
    ].join(',')))
    .join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="movimientos-${todayISO()}.csv"`);
  res.send('﻿' + csv);
});

module.exports = router;
