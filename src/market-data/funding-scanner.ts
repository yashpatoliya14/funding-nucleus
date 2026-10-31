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
  fundingDiffPct: Decimal; // (binanceRate - bybitRate) * 100
  fundingDirection: 'SHORT_BINANCE_LONG_BYBIT' | 'LONG_BINANCE_SHORT_BYBIT';
  binanceFundingTimeMs: number;
  bybitFundingTimeMs: number;
  targetFundingTimeMs: number;
  binanceMarkPrice: Decimal;
  bybitMarkPrice: Decimal;
  isAligned: boolean;
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
        continue;
      }

      const isAligned = areFundingTimesAligned(bRate.fundingTimeMs, byRate.fundingTimeMs, this.alignmentToleranceSec);

      if (this.requireAligned && !isAligned) {
        continue;
      }

      // Difference = Binance rate - Bybit rate
      const diff = bRate.fundingRate.minus(byRate.fundingRate);
      const diffPct = diff.times('100'); // Convert to percentage

      // Direction logic:
      // If Binance funding is higher -> Short Binance, Long Bybit
      // If Bybit funding is higher -> Long Binance, Short Bybit
      const direction = diff.greaterThanOrEqualTo('0')
        ? 'SHORT_BINANCE_LONG_BYBIT'
        : 'LONG_BINANCE_SHORT_BYBIT';

      opportunities.push({
        mapping,
        binanceRate: bRate.fundingRate,
        bybitRate: byRate.fundingRate,
        fundingDiffPct: diffPct.abs(),
        fundingDirection: direction,
        binanceFundingTimeMs: bRate.fundingTimeMs,
        bybitFundingTimeMs: byRate.fundingTimeMs,
        targetFundingTimeMs: Math.min(bRate.fundingTimeMs, byRate.fundingTimeMs),
        binanceMarkPrice: bRate.markPrice,
        bybitMarkPrice: byRate.markPrice,
        isAligned,
      });
    }

    // Sort opportunities descending by funding difference percentage
    opportunities.sort((a, b) => b.fundingDiffPct.comparedTo(a.fundingDiffPct));
    return opportunities;
  }
}
