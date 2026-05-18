const express = require('express');
const router = express.Router();
const db = require('../lib/db');
const mlClient = require('../lib/mlClient');

router.get('/healthz', async (req, res) => {
  const out = { status: 'ok', checks: {} };

  try {
    db.prepare('SELECT 1 AS ok').get();
    out.checks.db = { ok: true };
  } catch (err) {
    out.checks.db = { ok: false, error: err.message };
    out.status = 'degraded';
  }

  if (mlClient.ENABLED) {
    const ml = await mlClient.health();
    out.checks.ml = ml && ml.ok ? { ok: true, version: ml.version } : { ok: false, error: ml?.error || 'unreachable' };
    if (!out.checks.ml.ok) out.status = out.status === 'ok' ? 'degraded' : out.status;
  } else {
    out.checks.ml = { ok: true, disabled: true };
  }

  const code = out.checks.db.ok ? 200 : 503;
  res.status(code).json(out);
});

module.exports = router;
