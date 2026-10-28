export class FundingBotError extends Error {
  constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'FundingBotError';
  }
}

export class ExchangeApiError extends FundingBotError {
  constructor(
    public readonly exchange: 'binance' | 'bybit',
    message: string,
    public readonly statusCode?: number,
    public readonly errorCode?: string | number,
    details?: unknown
  ) {
    super(`[${exchange.toUpperCase()}] API Error (${errorCode ?? statusCode ?? 'unknown'}): ${message}`, details);
    this.name = 'ExchangeApiError';
  }
}

export class InsufficientMarginError extends FundingBotError {
  constructor(public readonly exchange: 'binance' | 'bybit', message: string, details?: unknown) {
    super(`[${exchange.toUpperCase()}] Insufficient margin: ${message}`, details);
    this.name = 'InsufficientMarginError';
  }
}

export class SlippageExceededError extends FundingBotError {
  constructor(message: string, public readonly actualBps: number, public readonly maxBps: number) {
    super(`Slippage limit exceeded: ${actualBps} bps > ${maxBps} bps. ${message}`);
    this.name = 'SlippageExceededError';
  }
}

export class StaleDataError extends FundingBotError {
  constructor(public readonly source: string, public readonly ageMs: number, public readonly maxAgeMs: number) {
    super(`Stale data detected from ${source}: ${ageMs}ms old (max allowed: ${maxAgeMs}ms)`);
    this.name = 'StaleDataError';
  }
}

export class RiskLimitViolationError extends FundingBotError {
  constructor(public readonly rule: string, message: string, details?: unknown) {
    super(`Risk limit violation [${rule}]: ${message}`, details);
    this.name = 'RiskLimitViolationError';
  }
}

export class RecoveryFailedError extends FundingBotError {
  constructor(message: string, public readonly tradeId: string, details?: unknown) {
    super(`Hedge recovery failed for trade ${tradeId}: ${message}`, details);
    this.name = 'RecoveryFailedError';
  }
}

export class UnhedgedTimeoutError extends FundingBotError {
  constructor(public readonly tradeId: string, public readonly elapsedSeconds: number, public readonly maxSeconds: number) {
    super(`Unhedged exposure timeout for trade ${tradeId}: ${elapsedSeconds}s > ${maxSeconds}s`);
    this.name = 'UnhedgedTimeoutError';
  }
}

export class StateMachineError extends FundingBotError {
  constructor(message: string, public readonly fromState: string, public readonly toState: string) {
    super(`Invalid state transition from ${fromState} to ${toState}: ${message}`);
    this.name = 'StateMachineError';
  }
}
