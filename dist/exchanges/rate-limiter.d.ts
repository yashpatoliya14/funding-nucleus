export interface RateLimiterOptions {
    maxRequests: number;
    intervalMs: number;
}
export declare class RateLimiter {
    private tokens;
    private lastRefillMs;
    private readonly maxTokens;
    private readonly refillRatePerMs;
    constructor(options: RateLimiterOptions);
    private refill;
    acquire(cost?: number): Promise<void>;
    executeWithRetry<T>(fn: () => Promise<T>, maxRetries?: number, baseDelayMs?: number): Promise<T>;
}
//# sourceMappingURL=rate-limiter.d.ts.map