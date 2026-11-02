import { sleep } from '../utils/time.js';
import { logger } from '../utils/logger.js';
export class RateLimiter {
    tokens;
    lastRefillMs;
    maxTokens;
    refillRatePerMs;
    constructor(options) {
        this.maxTokens = options.maxRequests;
        this.tokens = options.maxRequests;
        this.refillRatePerMs = options.maxRequests / options.intervalMs;
        this.lastRefillMs = Date.now();
    }
    refill() {
        const now = Date.now();
        const elapsed = now - this.lastRefillMs;
        this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRatePerMs);
        this.lastRefillMs = now;
    }
    async acquire(cost = 1) {
        while (true) {
            this.refill();
            if (this.tokens >= cost) {
                this.tokens -= cost;
                return;
            }
            const waitMs = Math.ceil((cost - this.tokens) / this.refillRatePerMs);
            await sleep(Math.max(10, waitMs));
        }
    }
    async executeWithRetry(fn, maxRetries = 3, baseDelayMs = 200) {
        let attempt = 0;
        while (attempt < maxRetries) {
            try {
                await this.acquire();
                return await fn();
            }
            catch (err) {
                attempt++;
                const isRateLimit = err?.statusCode === 429 || err?.statusCode === 418;
                if (!isRateLimit && attempt >= maxRetries) {
                    throw err;
                }
                const jitter = Math.random() * 100;
                const delay = (isRateLimit ? 1000 : baseDelayMs) * Math.pow(2, attempt) + jitter;
                logger.warn({ attempt, delay, err: err?.message }, 'Retrying request after rate limit or transient error');
                await sleep(delay);
            }
        }
        return fn();
    }
}
//# sourceMappingURL=rate-limiter.js.map