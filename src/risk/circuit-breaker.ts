import { RiskEventRepository } from '../persistence/repositories.js';
import { logger } from '../utils/logger.js';

export type CircuitBreakerState = 'CLOSED' | 'OPEN';

export class CircuitBreaker {
  private state: CircuitBreakerState = 'CLOSED';
  private tripReason: string | null = null;
  private consecutiveFailures: number = 0;
  private readonly maxConsecutiveFailures: number = 2;

  constructor(private riskRepo: RiskEventRepository) {}

  public isTripped(): boolean {
    return this.state === 'OPEN';
  }

  public getReason(): string | null {
    return this.tripReason;
  }

  public trip(reason: string, tradeId?: string): void {
    this.state = 'OPEN';
    this.tripReason = reason;
    logger.error({ reason, tradeId }, 'CIRCUIT BREAKER TRIPPED! All new trading halted.');

    this.riskRepo.record({
      id: `cb-${Date.now()}`,
      event_type: 'CIRCUIT_BREAKER_TRIPPED',
      rule_name: 'CIRCUIT_BREAKER',
      trade_id: tradeId || null,
      details: JSON.stringify({ reason, timestamp: new Date().toISOString() }),
      timestamp: new Date().toISOString(),
    });
  }

  public recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  public recordFailure(reason: string, tradeId?: string): void {
    this.consecutiveFailures++;
    logger.warn({ count: this.consecutiveFailures, max: this.maxConsecutiveFailures, reason }, 'Recorded execution failure');
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      this.trip(`Exceeded maximum consecutive execution failures (${this.consecutiveFailures})`, tradeId);
    }
  }

  public reset(): void {
    this.state = 'CLOSED';
    this.tripReason = null;
    this.consecutiveFailures = 0;
    logger.info('Circuit breaker manually reset to CLOSED');
  }
}
