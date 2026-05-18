const db = require('../db');

function listByName() {
  return db.prepare(`SELECT * FROM accounts ORDER BY name`).all();
}

function listByTypeAndName() {
  return db.prepare(`SELECT * FROM accounts ORDER BY type, name`).all();
}

function findById(id) {
  if (!id) return null;
  return db.prepare(`SELECT * FROM accounts WHERE id=?`).get(Number(id));
}

function create({ name, type, balance, credit_limit, credit_used, notes }) {
  return db.prepare(
    `INSERT INTO accounts (name, type, balance, credit_limit, credit_used, notes)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    name, type,
    Math.round(Number(balance) || 0),
    credit_limit ? Math.round(Number(credit_limit)) : null,
    credit_used ? Math.round(Number(credit_used)) : null,
    notes || null,
  );
}

function updateMeta(id, { balance, credit_limit, credit_used, notes }) {
  return db.prepare(
    `UPDATE accounts SET balance=?, credit_limit=?, credit_used=?, notes=?, updated_at=datetime('now') WHERE id=?`
  ).run(
    Math.round(Number(balance) || 0),
    credit_limit ? Math.round(Number(credit_limit)) : null,
    credit_used ? Math.round(Number(credit_used)) : null,
    notes || null,
    Number(id),
  );
}

function deleteById(id) {
  return db.prepare(`DELETE FROM accounts WHERE id=?`).run(Number(id));
}

// Aplica el efecto monetario de un movimiento sobre el balance o credit_used.
// kind: 'income' | 'expense', sign: +1 al aplicar, -1 al revertir.
function applyMovement(accountId, kind, amount, sign = 1) {
  const acc = findById(accountId);
  if (!acc) return;
  const amt = Math.round(Number(amount));
  if (acc.type === 'credit') {
    const delta = (kind === 'expense' ? amt : -amt) * sign;
    db.prepare(
      `UPDATE accounts SET credit_used = COALESCE(credit_used,0) + ?, updated_at=datetime('now') WHERE id=?`
    ).run(delta, acc.id);
  } else {
    const delta = (kind === 'income' ? amt : -amt) * sign;
    db.prepare(
      `UPDATE accounts SET balance = balance + ?, updated_at=datetime('now') WHERE id=?`
    ).run(delta, acc.id);
  }
}

module.exports = {
  listByName,
  listByTypeAndName,
  findById,
  create,
  updateMeta,
  deleteById,
  applyMovement,
};
