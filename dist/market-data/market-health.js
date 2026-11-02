import { StaleDataError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
export class MarketHealth {
    binanceClient;
    bybitClient;
    maxClockDriftMs;
    maxStaleMs;
    constructor(binanceClient, bybitClient, maxClockDriftMs = 2000, maxStaleMs = 15000) {
        this.binanceClient = binanceClient;
        this.bybitClient = bybitClient;
        this.maxClockDriftMs = maxClockDriftMs;
        this.maxStaleMs = maxStaleMs;
    }
    async checkClockSync() {
        const localBefore = Date.now();
        const [binanceTime, bybitTime] = await Promise.all([
            this.binanceClient.getServerTime(),
            this.bybitClient.getServerTime(),
        ]);
        const localNow = Date.now();
        const localMid = Math.floor((localBefore + localNow) / 2);
        const binanceDrift = Math.abs(binanceTime - localMid);
        const bybitDrift = Math.abs(bybitTime - localMid);
        const isHealthy = binanceDrift <= this.maxClockDriftMs && bybitDrift <= this.maxClockDriftMs;
        if (!isHealthy) {
            logger.warn({ binanceDrift, bybitDrift, maxAllowed: this.maxClockDriftMs }, 'Exchange clock drift exceeds safe threshold');
        }
        return {
            binanceDriftMs: binanceDrift,
            bybitDriftMs: bybitDrift,
            isHealthy,
        };
    }
    assertFreshness(timestampMs, source) {
        const now = Date.now();
        const ageMs = now - timestampMs;
        if (ageMs > this.maxStaleMs) {
            throw new StaleDataError(source, ageMs, this.maxStaleMs);
        }
    }
}
//# sourceMappingURL=market-health.js.map