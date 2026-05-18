const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Apunta la DB a un archivo temporal ANTES de require('../lib/db').
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-test-'));
process.env.DB_PATH = path.join(TMP, 'test.db');

const accounts = require('../lib/repositories/accountRepository');

test.after(() => {
  // Cleanup del tmp dir
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

test('create + findById', () => {
  const info = accounts.create({
    name: 'Test Debit',
    type: 'debit',
    balance: 100000,
    credit_limit: null,
    credit_used: null,
    notes: 'nota',
  });
  const id = Number(info.lastInsertRowid);
  const found = accounts.findById(id);
  assert.equal(found.name, 'Test Debit');
  assert.equal(found.type, 'debit');
  assert.equal(found.balance, 100000);
});

test('applyMovement en débito: expense -> balance baja', () => {
  const info = accounts.create({ name: 'Debit2', type: 'debit', balance: 50000 });
  const id = Number(info.lastInsertRowid);
  accounts.applyMovement(id, 'expense', 10000, 1);
  assert.equal(accounts.findById(id).balance, 40000);
});

test('applyMovement en débito: income -> balance sube', () => {
  const info = accounts.create({ name: 'Debit3', type: 'debit', balance: 50000 });
  const id = Number(info.lastInsertRowid);
  accounts.applyMovement(id, 'income', 5000, 1);
  assert.equal(accounts.findById(id).balance, 55000);
});

test('applyMovement con sign=-1 revierte el efecto', () => {
  const info = accounts.create({ name: 'Debit4', type: 'debit', balance: 100000 });
  const id = Number(info.lastInsertRowid);
  accounts.applyMovement(id, 'expense', 10000, 1);
  assert.equal(accounts.findById(id).balance, 90000);
  accounts.applyMovement(id, 'expense', 10000, -1);
  assert.equal(accounts.findById(id).balance, 100000);
});

test('applyMovement en crédito: expense -> credit_used sube', () => {
  const info = accounts.create({
    name: 'CMR', type: 'credit', balance: 0, credit_limit: 500000, credit_used: 0,
  });
  const id = Number(info.lastInsertRowid);
  accounts.applyMovement(id, 'expense', 25000, 1);
  assert.equal(accounts.findById(id).credit_used, 25000);
});

test('applyMovement en crédito: income (pago tarjeta) -> credit_used baja', () => {
  const info = accounts.create({
    name: 'CMR2', type: 'credit', balance: 0, credit_limit: 500000, credit_used: 100000,
  });
  const id = Number(info.lastInsertRowid);
  accounts.applyMovement(id, 'income', 30000, 1);
  assert.equal(accounts.findById(id).credit_used, 70000);
});

test('applyMovement con id null/inexistente no rompe', () => {
  assert.doesNotThrow(() => accounts.applyMovement(null, 'expense', 1000, 1));
  assert.doesNotThrow(() => accounts.applyMovement(999999, 'expense', 1000, 1));
});

test('listByName devuelve cuentas ordenadas', () => {
  const all = accounts.listByName();
  assert.ok(Array.isArray(all));
  const names = all.map(a => a.name);
  const sorted = [...names].sort();
  assert.deepEqual(names, sorted);
});

test('deleteById elimina la cuenta', () => {
  const info = accounts.create({ name: 'Throwaway', type: 'debit', balance: 0 });
  const id = Number(info.lastInsertRowid);
  assert.ok(accounts.findById(id));
  accounts.deleteById(id);
  assert.equal(accounts.findById(id), undefined);
});
