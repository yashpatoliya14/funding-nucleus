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

export class SystemHealth {
  private startTime = Date.now();

  constructor(
    private db: BetterSqliteDatabase,
    private binanceClient: IExchangeClient,
    private bybitClient: IExchangeClient,
    private circuitBreaker: CircuitBreaker,
    private marketHealth: MarketHealth
  ) {}

  async checkHealth(): Promise<HealthReport> {
    // 1. DB Integrity check
    let dbIntegrity = false;
    try {
      const row: any = this.db.prepare('PRAGMA integrity_check').get();
      dbIntegrity = row && (row.integrity_check === 'ok' || Object.values(row)[0] === 'ok');
    } catch {
      dbIntegrity = false;
    }

    // 2. Clock sync check
    let clockSyncHealthy = false;
    let bPing = 0;
    let byPing = 0;

    try {
      const t0 = Date.now();
      const clockRes = await this.marketHealth.checkClockSync();
      const totalTime = Date.now() - t0;
      bPing = Math.floor(totalTime / 2);
      byPing = Math.floor(totalTime / 2);
      clockSyncHealthy = clockRes.isHealthy;
    } catch {
      clockSyncHealthy = false;
    }

    const cbTripped = this.circuitBreaker.isTripped();
    const mem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);

    let status: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' = 'HEALTHY';
    if (!dbIntegrity || cbTripped) {
      status = 'UNHEALTHY';
    } else if (!clockSyncHealthy) {
      status = 'DEGRADED';
    }

    return {
      status,
      dbIntegrity,
      circuitBreakerTripped: cbTripped,
      clockSyncHealthy,
      binancePingMs: bPing,
      bybitPingMs: byPing,
      uptimeSeconds: uptime,
      memoryUsageMb: mem,
      timestamp: new Date().toISOString(),
    };
  }
}
