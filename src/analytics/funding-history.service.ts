import { request } from 'undici';
import { logger } from '../utils/logger.js';

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
  consistencyScorePct: number; // % of settlements favoring dominant direction
  dominantDirection: 'SHORT_BINANCE_LONG_BYBIT' | 'LONG_BINANCE_SHORT_BYBIT';
  hasStrongArbitrageEdge: boolean;
}

interface CacheEntry {
  stats: SevenDayFundingStats;
  fetchedAt: number;
}

export class FundingHistoryService {
  private cache = new Map<string, CacheEntry>();
  private readonly CACHE_TTL_MS = 3 * 60 * 1000; // 3-minute in-memory cache

  /**
   * Fetches the last 7 days of historical funding rates from Binance and Bybit,
   * aligns their settlement epochs, and computes cumulative yield and edge consistency.
   */
  async getSevenDayFundingHistory(
    binanceSymbol: string,
    bybitSymbol: string,
    normalizedSymbol?: string
  ): Promise<SevenDayFundingStats> {
    const cacheKey = `${binanceSymbol}_${bybitSymbol}`;
    const cached = this.cache.get(cacheKey);
    const now = Date.now();

    if (cached && now - cached.fetchedAt < this.CACHE_TTL_MS) {
      return cached.stats;
    }

    try {
      // 7 days @ 8h interval = 21 settlements, @ 4h = 42 settlements -> limit 45 covers full 7 days
      const [binanceData, bybitData] = await Promise.all([
        this.fetchBinanceFundingHistory(binanceSymbol, 45),
        this.fetchBybitFundingHistory(bybitSymbol, 45),
      ]);

      const alignedPoints: HistoricalFundingPoint[] = [];
      const bSorted = [...binanceData].sort((a, b) => a.fundingTime - b.fundingTime);
      const byList = [...bybitData];

      let runningCumulativeYield = 0;
      let shortBiCount = 0;
      let longBiCount = 0;

      for (const bItem of bSorted) {
        // Find matching Bybit settlement within +/- 15 minutes (900,000ms)
        const match = byList.find(
          (by) => Math.abs(by.fundingRateTimestamp - bItem.fundingTime) <= 15 * 60 * 1000
        );

        if (!match) continue;

        const bRatePct = parseFloat(bItem.fundingRate) * 100;
        const byRatePct = parseFloat(match.fundingRate) * 100;
        const diff = bRatePct - byRatePct;
        const spreadPct = Math.abs(diff);

        const direction =
          diff >= 0
            ? ('SHORT_BINANCE_LONG_BYBIT' as const)
            : ('LONG_BINANCE_SHORT_BYBIT' as const);

        if (direction === 'SHORT_BINANCE_LONG_BYBIT') shortBiCount++;
        else longBiCount++;

        runningCumulativeYield += spreadPct;

        alignedPoints.push({
          timestampMs: bItem.fundingTime,
          timeIso: new Date(bItem.fundingTime).toISOString(),
          binanceRatePct: parseFloat(bRatePct.toFixed(4)),
          bybitRatePct: parseFloat(byRatePct.toFixed(4)),
          spreadPct: parseFloat(spreadPct.toFixed(4)),
          direction,
          cumulativeYieldPct: parseFloat(runningCumulativeYield.toFixed(4)),
        });
      }

      const settlementCount = alignedPoints.length;
      const cumulativeReturnPct = parseFloat(runningCumulativeYield.toFixed(4));
      const averageSpreadPct =
        settlementCount > 0 ? parseFloat((cumulativeReturnPct / settlementCount).toFixed(4)) : 0;
      const annualizedAprPct = parseFloat((averageSpreadPct * 3 * 365).toFixed(1));

      const dominantDirection =
        shortBiCount >= longBiCount
          ? ('SHORT_BINANCE_LONG_BYBIT' as const)
          : ('LONG_BINANCE_SHORT_BYBIT' as const);

      const dominantCount = Math.max(shortBiCount, longBiCount);
      const consistencyScorePct =
        settlementCount > 0 ? Math.round((dominantCount / settlementCount) * 100) : 0;

      // Has strong arbitrage edge if 7d cumulative yield >= 0.3% and consistency >= 60%
      const hasStrongArbitrageEdge = cumulativeReturnPct >= 0.3 && consistencyScorePct >= 60;

      const stats: SevenDayFundingStats = {
        symbol: binanceSymbol,
        normalizedSymbol: normalizedSymbol || binanceSymbol.replace(/USDT$/, ''),
        dataPoints: alignedPoints,
        settlementCount,
        cumulativeReturnPct,
        averageSpreadPct,
        annualizedAprPct,
        consistencyScorePct,
        dominantDirection,
        hasStrongArbitrageEdge,
      };

      this.cache.set(cacheKey, { stats, fetchedAt: now });
      return stats;
    } catch (err: any) {
      logger.warn({ symbol: binanceSymbol, err: err?.message }, 'Failed to fetch 7-day funding history');
      return {
        symbol: binanceSymbol,
        normalizedSymbol: normalizedSymbol || binanceSymbol.replace(/USDT$/, ''),
        dataPoints: [],
        settlementCount: 0,
        cumulativeReturnPct: 0,
        averageSpreadPct: 0,
        annualizedAprPct: 0,
        consistencyScorePct: 0,
        dominantDirection: 'SHORT_BINANCE_LONG_BYBIT',
        hasStrongArbitrageEdge: false,
      };
    }
  }

  private async fetchBinanceFundingHistory(
    symbol: string,
    limit: number = 45
  ): Promise<Array<{ fundingTime: number; fundingRate: string }>> {
    const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=${limit}`;
    const res = await request(url, { method: 'GET', headers: { Accept: 'application/json' } });
    if (res.statusCode !== 200) {
      throw new Error(`Binance fundingRate HTTP ${res.statusCode}`);
    }
    const data: any = await res.body.json();
    return Array.isArray(data)
      ? data.map((d: any) => ({
          fundingTime: Number(d.fundingTime),
          fundingRate: String(d.fundingRate || '0'),
        }))
      : [];
  }

  private async fetchBybitFundingHistory(
    symbol: string,
    limit: number = 45
  ): Promise<Array<{ fundingRateTimestamp: number; fundingRate: string }>> {
    const url = `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${symbol}&limit=${limit}`;
    const res = await request(url, { method: 'GET', headers: { Accept: 'application/json' } });
    if (res.statusCode !== 200) {
      throw new Error(`Bybit funding history HTTP ${res.statusCode}`);
    }
    const data: any = await res.body.json();
    const list = data?.result?.list;
    return Array.isArray(list)
      ? list.map((d: any) => ({
          fundingRateTimestamp: Number(d.fundingRateTimestamp),
          fundingRate: String(d.fundingRate || '0'),
        }))
      : [];
  }
}

