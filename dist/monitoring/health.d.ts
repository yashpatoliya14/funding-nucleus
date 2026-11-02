import { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { IExchangeClient } from '../exchanges/exchange.interface.js';
import { CircuitBreaker } from '../risk/circuit-breaker.js';
import { MarketHealth } from '../market-data/market-health.js';
export interface HealthReport {
    status: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY';
    dbIntegrity: boolean;
    circuitBreakerTripped: boolean;
    clockSyncHealthy: boolean;
    binancePingMs: number;
    bybitPingMs: number;
    uptimeSeconds: number;
    memoryUsageMb: number;
    timestamp: string;
}
export declare class SystemHealth {
    private db;
    private binanceClient;
    private bybitClient;
    private circuitBreaker;
    private marketHealth;
    private startTime;
    constructor(db: BetterSqliteDatabase, binanceClient: IExchangeClient, bybitClient: IExchangeClient, circuitBreaker: CircuitBreaker, marketHealth: MarketHealth);
    checkHealth(): Promise<HealthReport>;
}
//# sourceMappingURL=health.d.ts.map