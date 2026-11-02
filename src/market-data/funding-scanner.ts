import { IExchangeClient } from '../exchanges/exchange.interface.js';
import { FundingRateInfo } from '../exchanges/types.js';
import { DbSymbolMapping } from '../persistence/models.js';
import { Decimal, toDecimal } from '../utils/decimal.js';
import { areFundingTimesAligned } from '../utils/time.js';
import { logger } from '../utils/logger.js';

export interface ScannedOpportunity {
  mapping: DbSymbolMapping;
  binanceRate: Decimal;
  bybitRate: Decimal;
  fundingDiffPct: Decimal; // Absolute spread as pct, normalized to the common settlement interval
  fundingDirection: 'SHORT_BINANCE_LONG_BYBIT' | 'LONG_BINANCE_SHORT_BYBIT';
  binanceFundingTimeMs: number;
  bybitFundingTimeMs: number;
  targetFundingTimeMs: number;
  binanceMarkPrice: Decimal;
  bybitMarkPrice: Decimal;
  isAligned: boolean;
  binanceIntervalHours: number;
  bybitIntervalHours: number;
}

export class FundingScanner {
  constructor(
    private binanceClient: IExchangeClient,
    private bybitClient: IExchangeClient,
    private requireAligned: boolean = true,
    private alignmentToleranceSec: number = 60
  ) {}

  async scanOpportunities(activeMappings: DbSymbolMapping[]): Promise<ScannedOpportunity[]> {
    logger.debug({ count: activeMappings.length }, 'Scanning funding rates across exchanges');

    const [binanceRatesList, bybitRatesList] = await Promise.all([
      this.binanceClient.getFundingRates(),
      this.bybitClient.getFundingRates(),
    ]);

    const binanceMap = new Map<string, FundingRateInfo>();
    for (const r of binanceRatesList) {
      binanceMap.set(r.symbol, r);
    }

    const bybitMap = new Map<string, FundingRateInfo>();
    for (const r of bybitRatesList) {
      bybitMap.set(r.symbol, r);
    }

    const opportunities: ScannedOpportunity[] = [];

    for (const mapping of activeMappings) {
      const bRate = binanceMap.get(mapping.binance_symbol);
      const byRate = bybitMap.get(mapping.bybit_symbol);

      if (!bRate || !byRate) {
        continue;
      }

      // User strict requirement: Both exchanges MUST have identical funding interval and aligned settlement time!
      // If Binance is 8h and Bybit is 4h/2h/1h, do not trade.
      const bInterval = bRate.fundingIntervalHours ?? 8;
      const byInterval = byRate.fundingIntervalHours ?? 8;
      if (bInterval !== byInterval) {
        logger.debug(
          { symbol: mapping.normalized_symbol, binanceInterval: bInterval, bybitInterval: byInterval },
          'Skipping symbol: funding intervals differ between exchanges'
        );
        continue;
      }

      const isAligned = areFundingTimesAligned(bRate.fundingTimeMs, byRate.fundingTimeMs, this.alignmentToleranceSec);

      if (this.requireAligned && !isAligned) {
        continue;
      }

      // Difference = Binance rate - Bybit rate (raw rates for this interval)
      const diff = bRate.fundingRate.minus(byRate.fundingRate);
      const diffPct = diff.times('100'); // Convert to percentage

      // Direction logic:
      // If Binance funding is higher -> Short Binance, Long Bybit
      // If Bybit funding is higher -> Long Binance, Short Bybit
      const direction = diff.greaterThanOrEqualTo('0')
        ? 'SHORT_BINANCE_LONG_BYBIT'
        : 'LONG_BINANCE_SHORT_BYBIT';

      // Normalize the spread to 8h-equivalent for fair ranking across different intervals.
      // A 0.1% spread on a 4h interval is worth 0.2% per 8h and should rank higher than 0.15% on 8h.
      const normalizationFactor = toDecimal(8).dividedBy(bInterval);
      const normalizedDiffPct = diffPct.abs().times(normalizationFactor);

      opportunities.push({
        mapping,
        binanceRate: bRate.fundingRate,
        bybitRate: byRate.fundingRate,
        fundingDiffPct: normalizedDiffPct,
        fundingDirection: direction,
        binanceFundingTimeMs: bRate.fundingTimeMs,
        bybitFundingTimeMs: byRate.fundingTimeMs,
        targetFundingTimeMs: Math.min(bRate.fundingTimeMs, byRate.fundingTimeMs),
        binanceMarkPrice: bRate.markPrice,
        bybitMarkPrice: byRate.markPrice,
        isAligned,
        binanceIntervalHours: bInterval,
        bybitIntervalHours: byInterval,
      });
    }

    // Sort opportunities descending by funding difference percentage
    opportunities.sort((a, b) => b.fundingDiffPct.comparedTo(a.fundingDiffPct));
    return opportunities;
  }
}
