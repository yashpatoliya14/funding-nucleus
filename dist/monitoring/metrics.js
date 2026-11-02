import { toDecimal } from '../utils/decimal.js';
export class MetricsCollector {
    db;
    dailyRepo;
    constructor(db, dailyRepo) {
        this.db = db;
        this.dailyRepo = dailyRepo;
    }
    getMetrics() {
        const totalRow = this.db
            .prepare(`
        SELECT 
          COUNT(*) as totalTrades,
          SUM(CASE WHEN state = 'COMPLETED' THEN 1 ELSE 0 END) as completedTrades,
          SUM(CASE WHEN state = 'FAILED' THEN 1 ELSE 0 END) as failedTrades
        FROM trades
      `)
            .get() || {};
        const summaryRows = this.db
            .prepare('SELECT net_pnl_usd, total_funding_pnl_usd, total_fees_usd FROM daily_summaries')
            .all();
        let totalNetPnl = toDecimal('0');
        let totalFunding = toDecimal('0');
        let totalFees = toDecimal('0');
        for (const r of summaryRows) {
            totalNetPnl = totalNetPnl.plus(toDecimal(r.net_pnl_usd || '0'));
            totalFunding = totalFunding.plus(toDecimal(r.total_funding_pnl_usd || '0'));
            totalFees = totalFees.plus(toDecimal(r.total_fees_usd || '0'));
        }
        const todaySummary = this.dailyRepo.getOrCreateToday();
        return {
            totalTrades: Number(totalRow.totalTrades || 0),
            completedTrades: Number(totalRow.completedTrades || 0),
            failedTrades: Number(totalRow.failedTrades || 0),
            totalNetPnlUsd: totalNetPnl.toFixed(4),
            totalFundingPnlUsd: totalFunding.toFixed(4),
            totalFeesUsd: totalFees.toFixed(4),
            todayTradeCount: todaySummary.trade_count,
            todayNetPnlUsd: todaySummary.net_pnl_usd,
        };
    }
}
//# sourceMappingURL=metrics.js.map