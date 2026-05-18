const express = require('express');
const router = express.Router();
const accounts = require('../lib/repositories/accountRepository');
const {
  ValidationError, ACCOUNT_TYPES,
  requireString, optionalString, requireEnum, requireInt, optionalInt,
} = require('../lib/validators');

function parseCreate(body) {
  return {
    name: requireString(body.name, 'name', { max: 60 }),
    type: requireEnum(body.type, 'type', ACCOUNT_TYPES),
    balance: requireInt(body.balance, 'balance', { min: -1e12, max: 1e12 }),
    credit_limit: optionalInt(body.credit_limit, 'credit_limit', { min: 0, max: 1e12 }),
    credit_used: optionalInt(body.credit_used, 'credit_used', { min: 0, max: 1e12 }),
    notes: optionalString(body.notes, 'notes', { max: 500 }),
  };
}

function parseUpdate(body) {
  return {
    balance: requireInt(body.balance, 'balance', { min: -1e12, max: 1e12 }),
    credit_limit: optionalInt(body.credit_limit, 'credit_limit', { min: 0, max: 1e12 }),
    credit_used: optionalInt(body.credit_used, 'credit_used', { min: 0, max: 1e12 }),
    notes: optionalString(body.notes, 'notes', { max: 500 }),
  };
}

function flashAndBack(req, res, err) {
  if (req.session) req.session.flash = { type: 'bad', text: err.message };
  res.redirect('/accounts');
}

router.get('/', (req, res) => {
  const flash = req.session?.flash || null;
  if (req.session) req.session.flash = null;
  res.render('accounts', { accounts: accounts.listByTypeAndName(), title: 'Cuentas', flash });
});

router.post('/', (req, res) => {
  try {
    accounts.create(parseCreate(req.body));
  } catch (e) {
    if (e instanceof ValidationError) return flashAndBack(req, res, e);
    throw e;
  }
  res.redirect('/accounts');
});

router.post('/:id/update', (req, res) => {
  try {
    const id = requireInt(req.params.id, 'id', { min: 1 });
    accounts.updateMeta(id, parseUpdate(req.body));
  } catch (e) {
    if (e instanceof ValidationError) return flashAndBack(req, res, e);
    throw e;
  }
  res.redirect('/accounts');
});

router.post('/:id/delete', (req, res) => {
  try {
    const id = requireInt(req.params.id, 'id', { min: 1 });
    accounts.deleteById(id);
  } catch (e) {
    if (e instanceof ValidationError) return flashAndBack(req, res, e);
    throw e;
  }
  res.redirect('/accounts');
});

module.exports = router;
