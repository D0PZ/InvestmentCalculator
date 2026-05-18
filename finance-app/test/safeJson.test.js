const test = require('node:test');
const assert = require('node:assert/strict');
const { safeJson } = require('../lib/safeJson');

test('safeJson escapa "<" para no cerrar script tag', () => {
  const s = safeJson({ x: '</script>' });
  assert.ok(!s.includes('</script>'), 'no debe contener </script> literal');
  assert.ok(s.includes('\\u003c'), 'debe contener \\u003c');
});

test('safeJson roundtrip: JSON.parse recupera el valor original', () => {
  const original = { a: 1, name: '</script><b>', list: ['x', 'y'] };
  const out = safeJson(original);
  assert.deepEqual(JSON.parse(out), original);
});

test('safeJson escapa U+2028 y U+2029', () => {
  const original = { sep: 'a b c' };
  const out = safeJson(original);
  // En el output no debe aparecer el char raw.
  assert.ok(!out.includes(' '));
  assert.ok(!out.includes(' '));
  // Roundtrip OK.
  assert.deepEqual(JSON.parse(out), original);
});

test('safeJson maneja valores primitivos', () => {
  assert.equal(safeJson(42), '42');
  assert.equal(safeJson(null), 'null');
  assert.equal(safeJson('hola'), '"hola"');
});
