import { IExchangeClient } from '../exchanges/exchange.interface.js';
import { ScannedOpportunity } from '../market-data/funding-scanner.js';
import { PositionSizer, SizingResult } from './position-sizing.js';
import { ProfitabilityEngine, ProfitabilityResult } from './profitability-engine.js';
import { AppConfig } from '../config/schema.js';
import { Decimal, toDecimal } from '../utils/decimal.js';
import { logger } from '../utils/logger.js';

export interface EvaluatedOpportunity {
  opportunity: ScannedOpportunity;
  sizing: SizingResult;
  profitability: ProfitabilityResult;
  isApproved: boolean;
  rejectionReason?: string;
}

export class OpportunityFilter {
  constructor(
    private binanceClient: IExchangeClient,
    private bybitClient: IExchangeClient,
    private config: AppConfig
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
      // 1. Fetch current order books and commission rates concurrently
      const [binanceBook, bybitBook, binanceCommission, bybitCommission, binanceBalances, bybitBalances, binanceInsts, bybitInsts] = await Promise.all([
        this.binanceClient.getOrderBook(opp.mapping.binance_symbol),
        this.bybitClient.getOrderBook(opp.mapping.bybit_symbol),
        this.binanceClient.getCommissionRates(opp.mapping.binance_symbol),
        this.bybitClient.getCommissionRates(opp.mapping.bybit_symbol),
        this.binanceClient.getBalances(),
        this.bybitClient.getBalances(),
        this.binanceClient.getInstruments(),
        this.bybitClient.getInstruments(),
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

      // 2. Position sizing
      const targetNotional = toDecimal(this.config.risk.maximum_notional_per_leg_usd);
      const sizing = PositionSizer.calculateSizing(
        targetNotional,
        opp.binanceMarkPrice,
        opp.bybitMarkPrice,
        bInst,
        byInst,
        this.config.risk.default_leverage_cap,
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
        },
        toDecimal(this.config.strategy.minimum_net_profit_usd)
      );

      if (!profitability.isProfitable) {
        return {
          opportunity: opp,
          sizing,
          profitability,
          isApproved: false,
          rejectionReason: profitability.rejectionReason,
        };
      }

      return {
        opportunity: opp,
        sizing,
        profitability,
        isApproved: true,
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
