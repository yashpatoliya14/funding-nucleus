import pino from 'pino';

const sensitiveKeys = ['apiKey', 'apiSecret', 'secret', 'signature', 'X-BAPI-SIGN', 'X-MBX-APIKEY', 'telegramBotToken'];

export function createLogger(logLevel: string = 'info') {
  return pino({
    level: logLevel.toLowerCase(),
    redact: {
      paths: sensitiveKeys.flatMap((k) => [k, `*.${k}`, `*.*.${k}`]),
      censor: '[REDACTED]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
}

export type Logger = pino.Logger;
export const logger = createLogger(process.env['LOG_LEVEL'] || 'info');
