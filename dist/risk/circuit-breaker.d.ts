import { RiskEventRepository } from '../persistence/repositories.js';
export type CircuitBreakerState = 'CLOSED' | 'OPEN';
export declare class CircuitBreaker {
    private riskRepo;
    private state;
    private tripReason;
    private consecutiveFailures;
    private readonly maxConsecutiveFailures;
    constructor(riskRepo: RiskEventRepository);
    isTripped(): boolean;
    getReason(): string | null;
    trip(reason: string, tradeId?: string): void;
    recordSuccess(): void;
    recordFailure(reason: string, tradeId?: string): void;
    reset(): void;
}
//# sourceMappingURL=circuit-breaker.d.ts.map