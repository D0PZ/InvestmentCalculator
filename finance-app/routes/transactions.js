const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const accounts = require('../lib/repositories/accountRepository');
const { todayISO } = require('../lib/format');
const {
  ValidationError, TX_KINDS,
  requireEnum, requireInt, optionalInt, optionalString, optionalISODate,
} = require('../lib/validators');

function parseTransaction(body) {
  return {
    kind: requireEnum(body.kind, 'kind', TX_KINDS),
    amount: requireInt(body.amount, 'amount', { min: -1e12, max: 1e12 }),
    category: optionalString(body.category, 'category', { max: 60 }),
    description: optionalString(body.description, 'description', { max: 200 }),
    account_id: optionalInt(body.account_id, 'account_id', { min: 1 }),
    occurred_on: optionalISODate(body.occurred_on, 'occurred_on') || todayISO(),
  };
}

function flashAndBack(req, res, err) {
  if (req.session) req.session.flash = { type: 'bad', text: err.message };
  res.redirect('/transactions');
}

router.get('/', (req, res) => {
  const { category, kind } = req.query;
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '';
  let sql = `SELECT t.*, a.name AS account_name FROM transactions t
             LEFT JOIN accounts a ON a.id = t.account_id WHERE 1=1`;
  const params = [];
  if (category) { sql += ` AND t.category = ?`; params.push(category); }
  if (kind) { sql += ` AND t.kind = ?`; params.push(kind); }
  if (q) { sql += ` AND (t.description LIKE ? OR t.category LIKE ?)`; params.push(`%${q}%`, `%${q}%`); }
  sql += ` ORDER BY occurred_on DESC, t.id DESC LIMIT 200`;

  const rows = db.prepare(sql).all(...params);
  const categories = db.prepare(
    `SELECT DISTINCT category FROM transactions WHERE category IS NOT NULL AND category!='' ORDER BY category`
  ).all().map(r => r.category);

  const flash = req.session?.flash || null;
  if (req.session) req.session.flash = null;

  res.render('transactions', {
    rows,
    accounts: accounts.listByName(),
    categories,
    today: todayISO(),
    filters: { category: category || '', kind: kind || '', q },
    flash,
    title: 'Movimientos',
  });
});

router.post('/', (req, res) => {
  let parsed;
  try { parsed = parseTransaction(req.body); }
  catch (e) {
    if (e instanceof ValidationError) return flashAndBack(req, res, e);
    throw e;
  }
  db.prepare(
    `INSERT INTO transactions (kind, amount, category, description, account_id, occurred_on)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(parsed.kind, parsed.amount, parsed.category, parsed.description, parsed.account_id, parsed.occurred_on);

  accounts.applyMovement(parsed.account_id, parsed.kind, parsed.amount, 1);
  res.redirect('/transactions');
});

router.get('/:id/edit', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.redirect('/transactions');
  const tx = db.prepare(`SELECT * FROM transactions WHERE id=?`).get(id);
  if (!tx) return res.redirect('/transactions');
  res.render('transaction_edit', { tx, accounts: accounts.listByName(), title: 'Editar movimiento' });
});

router.post('/:id/update', (req, res) => {
  let id, parsed;
  try {
    id = requireInt(req.params.id, 'id', { min: 1 });
    parsed = parseTransaction(req.body);
  } catch (e) {
    if (e instanceof ValidationError) return flashAndBack(req, res, e);
    throw e;
  }
  const old = db.prepare(`SELECT * FROM transactions WHERE id=?`).get(id);
  if (!old) return res.redirect('/transactions');

  accounts.applyMovement(old.account_id, old.kind, old.amount, -1);

  db.prepare(
    `UPDATE transactions SET kind=?, amount=?, category=?, description=?, account_id=?, occurred_on=? WHERE id=?`
  ).run(parsed.kind, parsed.amount, parsed.category, parsed.description, parsed.account_id, parsed.occurred_on, id);

  accounts.applyMovement(parsed.account_id, parsed.kind, parsed.amount, 1);
  res.redirect('/transactions');
});

router.post('/:id/delete', (req, res) => {
  let id;
  try { id = requireInt(req.params.id, 'id', { min: 1 }); }
  catch (e) {
    if (e instanceof ValidationError) return flashAndBack(req, res, e);
    throw e;
  }
  const old = db.prepare(`SELECT * FROM transactions WHERE id=?`).get(id);
  if (old) accounts.applyMovement(old.account_id, old.kind, old.amount, -1);
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
