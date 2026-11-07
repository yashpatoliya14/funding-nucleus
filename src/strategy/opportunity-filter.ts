import { IExchangeClient } from '../exchanges/exchange.interface.js';
import { InstrumentInfo, AccountBalance } from '../exchanges/types.js';
import { ScannedOpportunity } from '../market-data/funding-scanner.js';
import { PositionSizer, SizingResult } from './position-sizing.js';
import { ProfitabilityEngine, ProfitabilityResult } from './profitability-engine.js';
import { AppConfig } from '../config/schema.js';
import { Decimal, toDecimal } from '../utils/decimal.js';
import { logger } from '../utils/logger.js';
import { FundingHistoryService, SevenDayFundingStats } from '../analytics/funding-history.service.js';

export interface EvaluatedOpportunity {
  opportunity: ScannedOpportunity;
  sizing: SizingResult;
  profitability: ProfitabilityResult;
  isApproved: boolean;
  rejectionReason?: string;
  sevenDayStats?: SevenDayFundingStats | null;
  carryPotentialScore?: number;
}

export class OpportunityFilter {
  private cachedBinanceInsts: InstrumentInfo[] = [];
  private cachedBybitInsts: InstrumentInfo[] = [];
  private instsCachedAt: number = 0;
  private readonly INST_CACHE_TTL_MS = 5 * 60 * 1000;

  private cachedBinanceBalances: AccountBalance[] = [];
  private cachedBybitBalances: AccountBalance[] = [];
  private balancesCachedAt: number = 0;
  private readonly BALANCES_CACHE_TTL_MS = 10 * 1000;

  constructor(
    private binanceClient: IExchangeClient,
    private bybitClient: IExchangeClient,
    private config: AppConfig,
    private historyService?: FundingHistoryService
  ) {}

  async evaluateOpportunity(opp: ScannedOpportunity): Promise<EvaluatedOpportunity> {
    const symbol = opp.mapping.normalized_symbol;

    // Check minimum funding edge requirement
    const minEdge = toDecimal(this.config.strategy.minimum_funding_edge_pct);
    if (opp.fundingDiffPct.lessThan(minEdge)) {
      return {
        opportunity: opp,
        sizing: {} as any,
        profitability: {} as any,
        isApproved: false,
        rejectionReason: `Funding edge ${opp.fundingDiffPct.toFixed(4)}% is below minimum required ${minEdge.toFixed(4)}%`,
      };
    }

    try {
      const now = Date.now();

      // 1. Refresh or reuse cached instrument specifications (avoids 40-weight API calls on every candidate)
      let binanceInsts = this.cachedBinanceInsts;
      let bybitInsts = this.cachedBybitInsts;
      if (!binanceInsts.length || !bybitInsts.length || now - this.instsCachedAt > this.INST_CACHE_TTL_MS) {
        const [bI, byI] = await Promise.all([
          this.binanceClient.getInstruments().catch(() => this.cachedBinanceInsts),
          this.bybitClient.getInstruments().catch(() => this.cachedBybitInsts),
        ]);
        if (bI?.length) {
          this.cachedBinanceInsts = bI;
          binanceInsts = bI;
        }
        if (byI?.length) {
          this.cachedBybitInsts = byI;
          bybitInsts = byI;
        }
        this.instsCachedAt = now;
      }

      // 2. Refresh or reuse cached balances
      let binanceBalances = this.cachedBinanceBalances;
      let bybitBalances = this.cachedBybitBalances;
      if (!binanceBalances.length || !bybitBalances.length || now - this.balancesCachedAt > this.BALANCES_CACHE_TTL_MS) {
        const [bB, byB] = await Promise.all([
          this.binanceClient.getBalances().catch(() => this.cachedBinanceBalances),
          this.bybitClient.getBalances().catch(() => this.cachedBybitBalances),
        ]);
        if (bB?.length) {
          this.cachedBinanceBalances = bB;
          binanceBalances = bB;
        }
        if (byB?.length) {
          this.cachedBybitBalances = byB;
          bybitBalances = byB;
        }
        this.balancesCachedAt = now;
      }

      // 3. Fetch order books and commission rates (with safe fallback for commission rates)
      const [binanceBook, bybitBook, binanceCommission, bybitCommission] = await Promise.all([
        this.binanceClient.getOrderBook(opp.mapping.binance_symbol, 50),
        this.bybitClient.getOrderBook(opp.mapping.bybit_symbol, 50),
        this.binanceClient.getCommissionRates(opp.mapping.binance_symbol).catch(() => ({
          exchange: 'binance' as const,
          symbol: opp.mapping.binance_symbol,
          makerRate: toDecimal('0.0002'),
          takerRate: toDecimal('0.0005'),
        })),
        this.bybitClient.getCommissionRates(opp.mapping.bybit_symbol).catch(() => ({
          exchange: 'bybit' as const,
          symbol: opp.mapping.bybit_symbol,
          makerRate: toDecimal('0.0002'),
          takerRate: toDecimal('0.00055'),
        })),
      ]);

      const bInst = binanceInsts.find((i) => i.symbol === opp.mapping.binance_symbol);
      const byInst = bybitInsts.find((i) => i.symbol === opp.mapping.bybit_symbol);

      if (!bInst || !byInst) {
        return {
          opportunity: opp,
          sizing: {} as any,
          profitability: {} as any,
          isApproved: false,
          rejectionReason: 'Contract specification not found for matched symbols',
        };
      }

      // 1b. Orderbook bid-ask spread & liquidity check (reject completely illiquid or blown-out order books)
      const maxBookSpreadPct = this.config.strategy.max_orderbook_spread_pct ?? 0.80;
      const bBid = binanceBook.bids[0]?.price;
      const bAsk = binanceBook.asks[0]?.price;
      const byBid = bybitBook.bids[0]?.price;
      const byAsk = bybitBook.asks[0]?.price;

      if (bBid && bAsk && !bBid.isZero()) {
        const bSpreadPct = bAsk.minus(bBid).dividedBy(bBid).times(100).toNumber();
        if (bSpreadPct > maxBookSpreadPct) {
          return {
            opportunity: opp,
            sizing: {} as any,
            profitability: {} as any,
            isApproved: false,
            rejectionReason: `Binance order book spread ${bSpreadPct.toFixed(3)}% is too wide (> ${maxBookSpreadPct}%)`,
          };
        }
      }

      if (byBid && byAsk && !byBid.isZero()) {
        const bySpreadPct = byAsk.minus(byBid).dividedBy(byBid).times(100).toNumber();
        if (bySpreadPct > maxBookSpreadPct) {
          return {
            opportunity: opp,
            sizing: {} as any,
            profitability: {} as any,
            isApproved: false,
            rejectionReason: `Bybit order book spread ${bySpreadPct.toFixed(3)}% is too wide (> ${maxBookSpreadPct}%)`,
          };
        }
      }

      // 1c. Flash Mirage & Rate Stability Filter (Item 7: Filter out flash liquidation mirages)
      let stats: SevenDayFundingStats | null = null;
      let carryScore = 50;

      if (this.historyService) {
        try {
          stats = await this.historyService.getSevenDayFundingHistory(
            opp.mapping.binance_symbol,
            opp.mapping.bybit_symbol,
            symbol
          );
          if (stats && stats.settlementCount >= 3) {
            carryScore = stats.consistencyScorePct;

            if (this.config.strategy.flash_mirage_filter_enabled) {
              const minConsistency = this.config.strategy.min_historical_consistency_pct ?? 30.0;
              if (stats.consistencyScorePct < minConsistency && stats.settlementCount >= 6) {
                return {
                  opportunity: opp,
                  sizing: {} as any,
                  profitability: {} as any,
                  isApproved: false,
                  rejectionReason: `Flash rate mirage: low 7-day edge consistency (${stats.consistencyScorePct.toFixed(1)}% < ${minConsistency}%)`,
                };
              }
            }
          }
        } catch (histErr: any) {
          logger.debug({ symbol, err: histErr?.message }, 'Could not retrieve 7-day stats for stability check, proceeding with live rates');
        }
      }

      // 2. Query dynamic maximum leverage for this specific coin directly from both exchanges
      let bMaxLev = bInst.maxLeverage || 20;
      let byMaxLev = byInst.maxLeverage || 25;

      const [liveBLev, liveByLev] = await Promise.allSettled([
        this.binanceClient.getMaxLeverage ? this.binanceClient.getMaxLeverage(opp.mapping.binance_symbol) : Promise.resolve(bMaxLev),
        this.bybitClient.getMaxLeverage ? this.bybitClient.getMaxLeverage(opp.mapping.bybit_symbol) : Promise.resolve(byMaxLev),
      ]);

      if (liveBLev.status === 'fulfilled' && liveBLev.value > 0) {
        bMaxLev = liveBLev.value;
      }
      if (liveByLev.status === 'fulfilled' && liveByLev.value > 0) {
        byMaxLev = liveByLev.value;
      }

      const dynamicBInst = { ...bInst, maxLeverage: bMaxLev };
      const dynamicByInst = { ...byInst, maxLeverage: byMaxLev };

      // Common maximum leverage determined dynamically from both exchanges for this specific coin
      const effectiveLeverage = Math.min(
        dynamicBInst.maxLeverage,
        dynamicByInst.maxLeverage,
        this.config.risk.default_leverage_cap || 100
      );

      // Sizing is dynamically driven by your desired USDT margin:
      // Target Notional = Margin (default $10) * Common Maximum Dynamic Leverage
      const marginPerLeg = toDecimal(this.config.risk.trade_margin_per_leg_usd || 10);
      const targetNotional = marginPerLeg.times(effectiveLeverage);

      // Position sizing using the dynamic common leverage min(Binance coin max, Bybit coin max)
      const sizing = PositionSizer.calculateSizing(
        targetNotional,
        opp.binanceMarkPrice,
        opp.bybitMarkPrice,
        dynamicBInst,
        dynamicByInst,
        this.config.risk.default_leverage_cap || 100,
        this.config.execution.maximum_notional_mismatch_pct
      );

      // 3. Margin availability check
      const bUsdtBal = binanceBalances.find((b) => b.asset === 'USDT')?.availableBalance ?? toDecimal('0');
      const byUsdtBal = bybitBalances.find((b) => b.asset === 'USDT')?.availableBalance ?? toDecimal('0');

      const bRequiredMargin = sizing.binanceActualNotionalUsd.dividedBy(sizing.appliedLeverage);
      const byRequiredMargin = sizing.bybitActualNotionalUsd.dividedBy(sizing.appliedLeverage);

      if (bUsdtBal.lessThan(bRequiredMargin)) {
        return {
          opportunity: opp,
          sizing,
          profitability: {} as any,
          isApproved: false,
          rejectionReason: `Binance available margin $${bUsdtBal.toFixed(2)} is less than required $${bRequiredMargin.toFixed(2)}`,
        };
      }

      if (byUsdtBal.lessThan(byRequiredMargin)) {
        return {
          opportunity: opp,
          sizing,
          profitability: {} as any,
          isApproved: false,
          rejectionReason: `Bybit available margin $${byUsdtBal.toFixed(2)} is less than required $${byRequiredMargin.toFixed(2)}`,
        };
      }

      // 4. Profitability calculation
      // Pass maker-taker hybrid flag and carry cycles (default 2 in carry mode) to properly evaluate net edge
      const profitability = ProfitabilityEngine.evaluate(
        {
          binanceRate: opp.binanceRate,
          bybitRate: opp.bybitRate,
          binanceNotionalUsd: sizing.binanceActualNotionalUsd,
          bybitNotionalUsd: sizing.bybitActualNotionalUsd,
          binanceQuantity: sizing.binanceQuantity,
          bybitQuantity: sizing.bybitQuantity,
          binanceCommission,
          bybitCommission,
          binanceOrderBook: binanceBook,
          bybitOrderBook: bybitBook,
          riskBufferUsd: toDecimal(this.config.strategy.risk_buffer_usd),
          makerTakerHybridEnabled: false,
          expectedHoldingCycles: this.config.strategy.cumulative_carry_enabled ? 2 : 1,
        },
        toDecimal(this.config.strategy.minimum_net_profit_usd)
      );

      if (!profitability.isProfitable || profitability.expectedNetProfitUsd.lessThanOrEqualTo(0)) {
        return {
          opportunity: opp,
          sizing,
          profitability,
          isApproved: false,
          rejectionReason: profitability.expectedNetProfitUsd.lessThanOrEqualTo(0)
            ? `Expected net profit ($${profitability.expectedNetProfitUsd.toFixed(4)}) is negative or zero`
            : (profitability.rejectionReason || 'Profit below threshold'),
        };
      }

      return {
        opportunity: opp,
        sizing,
        profitability,
        isApproved: true,
        sevenDayStats: stats,
        carryPotentialScore: carryScore,
      };
    } catch (err: any) {
      logger.warn({ err: err?.message, symbol }, 'Opportunity evaluation failed');
      return {
        opportunity: opp,
        sizing: {} as any,
        profitability: {} as any,
        isApproved: false,
        rejectionReason: err?.message || 'Unknown evaluation error',
      };
    }
  }
}
