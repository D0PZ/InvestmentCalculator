function clp(value) {
  const n = Math.round(Number(value) || 0);
  return '$' + n.toLocaleString('es-CL');
}

function pct(value, total) {
  if (!total) return '0%';
  return ((value / total) * 100).toFixed(1) + '%';
}

function pctFromRatio(ratio, decimals = 2) {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  const sign = ratio >= 0 ? '+' : '';
  return sign + (ratio * 100).toFixed(decimals) + '%';
}

function signedClp(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const sign = value >= 0 ? '+' : '−';
  const n = Math.abs(Math.round(value));
  return sign + '$' + n.toLocaleString('es-CL');
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function monthRange(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number);
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const endDate = new Date(y, m, 0);
  const end = endDate.toISOString().slice(0, 10);
  return { start, end };
}

function currentYYYYMM() {
  return new Date().toISOString().slice(0, 7);
}

module.exports = { clp, pct, pctFromRatio, signedClp, todayISO, monthRange, currentYYYYMM };
