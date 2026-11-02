export declare class FundingBotError extends Error {
    readonly details?: unknown;
    constructor(message: string, details?: unknown);
}
export declare class ExchangeApiError extends FundingBotError {
    readonly exchange: 'binance' | 'bybit';
    readonly statusCode?: number | undefined;
    readonly errorCode?: string | number | undefined;
    constructor(exchange: 'binance' | 'bybit', message: string, statusCode?: number | undefined, errorCode?: string | number | undefined, details?: unknown);
}
export declare class InsufficientMarginError extends FundingBotError {
    readonly exchange: 'binance' | 'bybit';
    constructor(exchange: 'binance' | 'bybit', message: string, details?: unknown);
}
export declare class SlippageExceededError extends FundingBotError {
    readonly actualBps: number;
    readonly maxBps: number;
    constructor(message: string, actualBps: number, maxBps: number);
}
export declare class StaleDataError extends FundingBotError {
    readonly source: string;
    readonly ageMs: number;
    readonly maxAgeMs: number;
    constructor(source: string, ageMs: number, maxAgeMs: number);
}
export declare class RiskLimitViolationError extends FundingBotError {
    readonly rule: string;
    constructor(rule: string, message: string, details?: unknown);
}
export declare class RecoveryFailedError extends FundingBotError {
    readonly tradeId: string;
    constructor(message: string, tradeId: string, details?: unknown);
}
export declare class UnhedgedTimeoutError extends FundingBotError {
    readonly tradeId: string;
    readonly elapsedSeconds: number;
    readonly maxSeconds: number;
    constructor(tradeId: string, elapsedSeconds: number, maxSeconds: number);
}
export declare class StateMachineError extends FundingBotError {
    readonly fromState: string;
    readonly toState: string;
    constructor(message: string, fromState: string, toState: string);
}
//# sourceMappingURL=errors.d.ts.map