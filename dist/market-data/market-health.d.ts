import { IExchangeClient } from '../exchanges/exchange.interface.js';
export declare class MarketHealth {
    private binanceClient;
    private bybitClient;
    private maxClockDriftMs;
    private maxStaleMs;
    constructor(binanceClient: IExchangeClient, bybitClient: IExchangeClient, maxClockDriftMs?: number, maxStaleMs?: number);
    checkClockSync(): Promise<{
        binanceDriftMs: number;
        bybitDriftMs: number;
        isHealthy: boolean;
    }>;
    assertFreshness(timestampMs: number, source: string): void;
}
//# sourceMappingURL=market-health.d.ts.map