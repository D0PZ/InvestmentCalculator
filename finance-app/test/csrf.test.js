const test = require('node:test');
const assert = require('node:assert/strict');
const { csrfMiddleware } = require('../lib/csrf');

function makeRes() {
  const res = {
    statusCode: 200,
    locals: {},
    headersSent: false,
    _json: null,
    _rendered: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this._json = o; return this; },
    render(view, data) { this._rendered = { view, data }; return this; },
    accepts() { return false; }, // forzar JSON path por simplicidad
  };
  return res;
}

test('GET pasa sin token y expone csrfToken/csrfInput', () => {
  const req = { method: 'GET', session: {}, body: {}, get: () => null };
  const res = makeRes();
  res.accepts = () => false;
  let nextCalled = false;
  csrfMiddleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.ok(req.session.csrf, 'token persistido en session');
  assert.equal(res.locals.csrfToken, req.session.csrf);
  assert.ok(res.locals.csrfInput.includes(req.session.csrf));
});

test('POST sin token devuelve 403', () => {
  const req = { method: 'POST', session: { csrf: 'abc123' }, body: {}, get: () => null, accepts: () => false };
  const res = makeRes();
  let nextCalled = false;
  csrfMiddleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('POST con token correcto pasa', () => {
  const req = {
    method: 'POST',
    session: { csrf: 'abc123' },
    body: { _csrf: 'abc123' },
    get: () => null,
    accepts: () => false,
  };
  const res = makeRes();
  let nextCalled = false;
  csrfMiddleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('POST con token incorrecto devuelve 403', () => {
  const req = {
    method: 'POST',
    session: { csrf: 'abc123' },
    body: { _csrf: 'wrong-token-of-same-len' },
    get: () => null,
    accepts: () => false,
  };
  const res = makeRes();
  let nextCalled = false;
  csrfMiddleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('POST con token vía header x-csrf-token funciona', () => {
  const headers = { 'x-csrf-token': 'tok-from-header' };
  const req = {
    method: 'POST',
    session: { csrf: 'tok-from-header' },
    body: {},
    get(name) { return headers[name.toLowerCase()]; },
    accepts: () => false,
  };
  const res = makeRes();
  let nextCalled = false;
  csrfMiddleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});
