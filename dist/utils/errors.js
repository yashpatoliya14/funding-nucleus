export class FundingBotError extends Error {
    details;
    constructor(message, details) {
        super(message);
        this.details = details;
        this.name = 'FundingBotError';
    }
}
export class ExchangeApiError extends FundingBotError {
    exchange;
    statusCode;
    errorCode;
    constructor(exchange, message, statusCode, errorCode, details) {
        super(`[${exchange.toUpperCase()}] API Error (${errorCode ?? statusCode ?? 'unknown'}): ${message}`, details);
        this.exchange = exchange;
        this.statusCode = statusCode;
        this.errorCode = errorCode;
        this.name = 'ExchangeApiError';
    }
}
export class InsufficientMarginError extends FundingBotError {
    exchange;
    constructor(exchange, message, details) {
        super(`[${exchange.toUpperCase()}] Insufficient margin: ${message}`, details);
        this.exchange = exchange;
        this.name = 'InsufficientMarginError';
    }
}
export class SlippageExceededError extends FundingBotError {
    actualBps;
    maxBps;
    constructor(message, actualBps, maxBps) {
        super(`Slippage limit exceeded: ${actualBps} bps > ${maxBps} bps. ${message}`);
        this.actualBps = actualBps;
        this.maxBps = maxBps;
        this.name = 'SlippageExceededError';
    }
}
export class StaleDataError extends FundingBotError {
    source;
    ageMs;
    maxAgeMs;
    constructor(source, ageMs, maxAgeMs) {
        super(`Stale data detected from ${source}: ${ageMs}ms old (max allowed: ${maxAgeMs}ms)`);
        this.source = source;
        this.ageMs = ageMs;
        this.maxAgeMs = maxAgeMs;
        this.name = 'StaleDataError';
    }
}
export class RiskLimitViolationError extends FundingBotError {
    rule;
    constructor(rule, message, details) {
        super(`Risk limit violation [${rule}]: ${message}`, details);
        this.rule = rule;
        this.name = 'RiskLimitViolationError';
    }
}
export class RecoveryFailedError extends FundingBotError {
    tradeId;
    constructor(message, tradeId, details) {
        super(`Hedge recovery failed for trade ${tradeId}: ${message}`, details);
        this.tradeId = tradeId;
        this.name = 'RecoveryFailedError';
    }
}
export class UnhedgedTimeoutError extends FundingBotError {
    tradeId;
    elapsedSeconds;
    maxSeconds;
    constructor(tradeId, elapsedSeconds, maxSeconds) {
        super(`Unhedged exposure timeout for trade ${tradeId}: ${elapsedSeconds}s > ${maxSeconds}s`);
        this.tradeId = tradeId;
        this.elapsedSeconds = elapsedSeconds;
        this.maxSeconds = maxSeconds;
        this.name = 'UnhedgedTimeoutError';
    }
}
export class StateMachineError extends FundingBotError {
    fromState;
    toState;
    constructor(message, fromState, toState) {
        super(`Invalid state transition from ${fromState} to ${toState}: ${message}`);
        this.fromState = fromState;
        this.toState = toState;
        this.name = 'StateMachineError';
    }
}
//# sourceMappingURL=errors.js.map