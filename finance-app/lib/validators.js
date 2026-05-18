// Helpers de validación para inputs de routes POST. Lanzan ValidationError; los routes deciden
// cómo presentarlo al usuario (flash, render con error, JSON 400).

class ValidationError extends Error {
  constructor(msg, field = null) {
    super(msg);
    this.name = 'ValidationError';
    this.field = field;
    this.status = 400;
  }
}

const ACCOUNT_TYPES = new Set(['debit', 'credit', 'digital', 'benefit']);
const TX_KINDS = new Set(['income', 'expense']);
const SUB_CYCLES = new Set(['monthly', 'annual', 'installment']);

function requireString(v, field, { max = 200, min = 1 } = {}) {
  if (typeof v !== 'string') throw new ValidationError(`${field} debe ser texto`, field);
  const t = v.trim();
  if (t.length < min) throw new ValidationError(`${field} es requerido`, field);
  if (t.length > max) throw new ValidationError(`${field} máx ${max} chars`, field);
  return t;
}

function optionalString(v, field, { max = 500 } = {}) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') throw new ValidationError(`${field} debe ser texto`, field);
  const t = v.trim();
  if (t.length === 0) return null;
  if (t.length > max) throw new ValidationError(`${field} máx ${max} chars`, field);
  return t;
}

function requireEnum(v, field, allowed) {
  const s = typeof v === 'string' ? v.trim() : v;
  if (!allowed.has(s)) {
    throw new ValidationError(`${field} inválido (esperado: ${[...allowed].join(', ')})`, field);
  }
  return s;
}

function requireInt(v, field, { min = -Infinity, max = Infinity } = {}) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) throw new ValidationError(`${field} debe ser numérico`, field);
  if (n < min) throw new ValidationError(`${field} mín ${min}`, field);
  if (n > max) throw new ValidationError(`${field} máx ${max}`, field);
  return n;
}

function optionalInt(v, field, opts) {
  if (v == null || v === '') return null;
  return requireInt(v, field, opts);
}

function requireFloat(v, field, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ValidationError(`${field} debe ser numérico`, field);
  if (n < min) throw new ValidationError(`${field} mín ${min}`, field);
  if (n > max) throw new ValidationError(`${field} máx ${max}`, field);
  return n;
}

function optionalISODate(v, field) {
  if (!v) return null;
  if (typeof v !== 'string') throw new ValidationError(`${field} formato inválido`, field);
  // Acepta YYYY-MM-DD y YYYY-MM-DDTHH:MM (datetime-local).
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/.test(v)) {
    throw new ValidationError(`${field} debe ser fecha ISO`, field);
  }
  return v;
}

function tickerSymbol(v, field = 'ticker') {
  const s = requireString(v, field, { max: 10 }).toUpperCase();
  if (!/^[A-Z]{1,6}(?:\.[A-Z]{1,3})?$/.test(s)) {
    throw new ValidationError(`${field} inválido (esperado A-Z hasta 6 chars, opcionalmente .XX)`, field);
  }
  return s;
}

module.exports = {
  ValidationError,
  ACCOUNT_TYPES, TX_KINDS, SUB_CYCLES,
  requireString, optionalString,
  requireEnum,
  requireInt, optionalInt,
  requireFloat,
  optionalISODate,
  tickerSymbol,
};
