import { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { DailySummaryRepository } from '../persistence/repositories.js';
export interface PerformanceMetrics {
    totalTrades: number;
    completedTrades: number;
    failedTrades: number;
    totalNetPnlUsd: string;
    totalFundingPnlUsd: string;
    totalFeesUsd: string;
    todayTradeCount: number;
    todayNetPnlUsd: string;
}
export declare class MetricsCollector {
    private db;
    private dailyRepo;
    constructor(db: BetterSqliteDatabase, dailyRepo: DailySummaryRepository);
    getMetrics(): PerformanceMetrics;
}
//# sourceMappingURL=metrics.d.ts.map