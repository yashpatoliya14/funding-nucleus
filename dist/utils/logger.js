import pino from 'pino';
const sensitiveKeys = ['apiKey', 'apiSecret', 'secret', 'signature', 'X-BAPI-SIGN', 'X-MBX-APIKEY', 'telegramBotToken'];
export function createLogger(logLevel = 'info') {
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
export const logger = createLogger(process.env['LOG_LEVEL'] || 'info');
//# sourceMappingURL=logger.js.map