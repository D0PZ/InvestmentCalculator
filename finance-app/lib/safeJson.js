// Serializa un valor como JSON apto para embeber dentro de <script>.
// Escapa:
//  - "<" y ">" para que un valor con "</script>" no cierre el tag prematuramente.
//  - U+2028 / U+2029, que JS trata como line terminators y rompen el parse JS.
const UNSAFE_RE = /[<>\u2028\u2029]/g;
const MAP = {
  "<": "\\u003c",
  ">": "\\u003e",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

function safeJson(value) {
  return JSON.stringify(value).replace(UNSAFE_RE, (c) => MAP[c]);
}

module.exports = { safeJson };
