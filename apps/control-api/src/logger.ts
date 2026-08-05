import { pino, type Logger } from 'pino';

/**
 * Paths that pino removes from every log record before serialisation.
 *
 * This is a backstop, not the primary defence — the code deliberately never
 * puts a secret into a log call in the first place. But logging is exactly the
 * place where an innocent `log.info({ user })` starts leaking a hash six months
 * from now, so the redactor covers the shapes that could plausibly appear.
 */
const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  'passwordHash',
  '*.passwordHash',
  'password_hash',
  '*.password_hash',
  'secret',
  '*.secret',
  'token',
  '*.token',
  'csrfToken',
  '*.csrfToken',
  'sessionToken',
  '*.sessionToken',
  'encryptionKey',
  '*.encryptionKey',
  'botToken',
  '*.botToken',
  'connectionString',
  '*.connectionString',
];

export function createLogger(level: string, env: string): Logger {
  return pino({
    level,
    // Structured JSON in production so the Docker log driver can rotate and
    // downstream tooling can parse; pretty output is intentionally not wired in
    // for production to avoid a dependency in the runtime image.
    ...(env === 'development' ? { transport: { target: 'pino/file', options: { destination: 1 } } } : {}),
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: { service: 'control-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    serializers: {
      // Log only what is needed to correlate a request; never the body.
      req(req: { method?: string; url?: string; id?: string }) {
        return { method: req.method, url: req.url, id: req.id };
      },
      res(res: { statusCode?: number }) {
        return { statusCode: res.statusCode };
      },
    },
  });
}

export type { Logger };
