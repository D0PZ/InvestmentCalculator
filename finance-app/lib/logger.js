const pino = require('pino');

const isProd = process.env.NODE_ENV === 'production';
const level = process.env.LOG_LEVEL || (isProd ? 'info' : 'debug');

const logger = pino({
  level,
  base: { pid: process.pid },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Serializers globales: cualquier campo "req"/"res"/"err" en un log es comprimido
  // a algo legible en lugar de dumpear todo el socket de Express.
  serializers: {
    req: (req) => req && { method: req.method, url: req.url },
    res: (res) => res && { statusCode: res.statusCode },
    err: (err) => err && {
      type: err.constructor?.name,
      message: err.message,
      stack: err.stack,
      ...(err.code ? { code: err.code } : {}),
    },
  },
  ...(isProd ? {} : {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss.l',
        ignore: 'pid,hostname',
        singleLine: true,
      },
    },
  }),
});

// Convenience: log.child('component') as a positional shortcut over pino's object API.
const baseChild = logger.child.bind(logger);
logger.child = (binding) => {
  if (typeof binding === 'string') return baseChild({ component: binding });
  return baseChild(binding);
};

module.exports = logger;
