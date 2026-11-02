export interface HistoricalFundingPoint {
    timestampMs: number;
    timeIso: string;
    binanceRatePct: number;
    bybitRatePct: number;
    spreadPct: number;
    direction: 'SHORT_BINANCE_LONG_BYBIT' | 'LONG_BINANCE_SHORT_BYBIT';
    cumulativeYieldPct: number;
}
export interface SevenDayFundingStats {
    symbol: string;
    normalizedSymbol: string;
    dataPoints: HistoricalFundingPoint[];
    settlementCount: number;
    cumulativeReturnPct: number;
    averageSpreadPct: number;
    annualizedAprPct: number;
    consistencyScorePct: number;
    dominantDirection: 'SHORT_BINANCE_LONG_BYBIT' | 'LONG_BINANCE_SHORT_BYBIT';
    hasStrongArbitrageEdge: boolean;
}
export declare class FundingHistoryService {
    private cache;
    private readonly CACHE_TTL_MS;
    /**
     * Fetches the last 7 days of historical funding rates from Binance and Bybit,
     * aligns their settlement epochs, and computes cumulative yield and edge consistency.
     */
    getSevenDayFundingHistory(binanceSymbol: string, bybitSymbol: string, normalizedSymbol?: string): Promise<SevenDayFundingStats>;
    private fetchBinanceFundingHistory;
    private fetchBybitFundingHistory;
}
//# sourceMappingURL=funding-history.service.d.ts.map