const crypto = require('node:crypto');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function ensureToken(req) {
  if (!req.session) return null;
  if (!req.session.csrf) {
    req.session.csrf = crypto.randomBytes(24).toString('base64url');
  }
  return req.session.csrf;
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Middleware:
//  - Asegura un token en la sesión (lazy).
//  - Lo expone como `res.locals.csrfToken` para usar en EJS.
//  - En métodos no-safe, verifica que el form/header traiga el token.
function csrfMiddleware(req, res, next) {
  const token = ensureToken(req);
  res.locals.csrfToken = token;
  res.locals.csrfInput = token
    ? `<input type="hidden" name="_csrf" value="${token}" />`
    : '';

  if (SAFE_METHODS.has(req.method)) return next();

  const submitted = (req.body && req.body._csrf)
    || req.get('x-csrf-token')
    || req.get('csrf-token');

  if (!token || !timingSafeEqualStr(token, submitted)) {
    res.status(403);
    if (req.accepts('html')) {
      return res.render('error', {
        title: 'CSRF',
        error: { message: 'Token CSRF inválido o ausente. Refresca la página e intentá de nuevo.' },
      });
    }
    return res.json({ error: 'csrf_invalid' });
  }
  next();
}

module.exports = { csrfMiddleware, ensureToken };
