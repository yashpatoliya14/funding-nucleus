import { logger } from '../utils/logger.js';
export class CircuitBreaker {
    riskRepo;
    state = 'CLOSED';
    tripReason = null;
    consecutiveFailures = 0;
    maxConsecutiveFailures = 2;
    constructor(riskRepo) {
        this.riskRepo = riskRepo;
    }
    isTripped() {
        return this.state === 'OPEN';
    }
    getReason() {
        return this.tripReason;
    }
    trip(reason, tradeId) {
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
    recordSuccess() {
        this.consecutiveFailures = 0;
    }
    recordFailure(reason, tradeId) {
        this.consecutiveFailures++;
        logger.warn({ count: this.consecutiveFailures, max: this.maxConsecutiveFailures, reason }, 'Recorded execution failure');
        if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
            this.trip(`Exceeded maximum consecutive execution failures (${this.consecutiveFailures})`, tradeId);
        }
    }
    reset() {
        this.state = 'CLOSED';
        this.tripReason = null;
        this.consecutiveFailures = 0;
        logger.info('Circuit breaker manually reset to CLOSED');
    }
}
//# sourceMappingURL=circuit-breaker.js.map