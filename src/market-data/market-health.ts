import { IExchangeClient } from '../exchanges/exchange.interface.js';
import { StaleDataError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export class MarketHealth {
  constructor(
    private binanceClient: IExchangeClient,
    private bybitClient: IExchangeClient,
    private maxClockDriftMs: number = 2000,
    private maxStaleMs: number = 15000
  ) {}

  async checkClockSync(): Promise<{ binanceDriftMs: number; bybitDriftMs: number; isHealthy: boolean }> {
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

  assertFreshness(timestampMs: number, source: string): void {
    const now = Date.now();
    const ageMs = now - timestampMs;
    if (ageMs > this.maxStaleMs) {
      throw new StaleDataError(source, ageMs, this.maxStaleMs);
    }
  }
}
