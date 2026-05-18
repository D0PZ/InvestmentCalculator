const test = require('node:test');
const assert = require('node:assert/strict');
const v = require('../lib/validators');

test('requireString rechaza vacío y tipos no string', () => {
  assert.throws(() => v.requireString('', 'x'), v.ValidationError);
  assert.throws(() => v.requireString(null, 'x'), v.ValidationError);
  assert.throws(() => v.requireString(42, 'x'), v.ValidationError);
});

test('requireString trimea y respeta max', () => {
  assert.equal(v.requireString('  hola  ', 'x'), 'hola');
  assert.throws(() => v.requireString('a'.repeat(201), 'x', { max: 200 }), v.ValidationError);
});

test('requireEnum acepta solo valores del set', () => {
  assert.equal(v.requireEnum('expense', 'kind', v.TX_KINDS), 'expense');
  assert.throws(() => v.requireEnum('hacked', 'kind', v.TX_KINDS), v.ValidationError);
});

test('requireInt redondea y respeta min/max', () => {
  assert.equal(v.requireInt('42.7', 'x'), 43);
  assert.throws(() => v.requireInt('abc', 'x'), v.ValidationError);
  assert.throws(() => v.requireInt('5', 'x', { max: 4 }), v.ValidationError);
  assert.throws(() => v.requireInt('-1', 'x', { min: 0 }), v.ValidationError);
});

test('tickerSymbol normaliza mayúsculas y valida formato', () => {
  assert.equal(v.tickerSymbol('msft'), 'MSFT');
  assert.equal(v.tickerSymbol('BRK.B'), 'BRK.B');
  assert.throws(() => v.tickerSymbol('TOO_LONG_TICKER'), v.ValidationError);
  assert.throws(() => v.tickerSymbol('A1B'), v.ValidationError);
  assert.throws(() => v.tickerSymbol(''), v.ValidationError);
});

test('optionalISODate acepta YYYY-MM-DD y datetime-local', () => {
  assert.equal(v.optionalISODate('2026-05-14', 'd'), '2026-05-14');
  assert.equal(v.optionalISODate('2026-05-14T10:30', 'd'), '2026-05-14T10:30');
  assert.equal(v.optionalISODate('', 'd'), null);
  assert.throws(() => v.optionalISODate('14/05/2026', 'd'), v.ValidationError);
});
