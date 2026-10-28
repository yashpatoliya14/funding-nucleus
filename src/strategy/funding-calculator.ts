import { Decimal, toDecimal } from '../utils/decimal.js';
import { TradeDirection } from '../persistence/models.js';

export interface FundingCashFlowResult {
  direction: TradeDirection;
  binanceFundingCashFlow: Decimal;
  bybitFundingCashFlow: Decimal;
  netFundingCashFlow: Decimal;
}

export class FundingCalculator {
  /**
   * Calculates the expected funding cash flow for both legs.
   *
   * Conventional rule for linear USDT contracts:
   * Long position cash flow  = - funding_rate * position_notional
   * Short position cash flow = + funding_rate * position_notional
   *
   * @param binanceRate Binance funding rate (e.g. 0.0003 for 0.03%)
   * @param bybitRate Bybit funding rate (e.g. 0.0001 for 0.01%)
   * @param binanceNotionalUsd Intended USD notional on Binance
   * @param bybitNotionalUsd Intended USD notional on Bybit
   */
  static calculateCashFlow(
    binanceRate: Decimal | string | number,
    bybitRate: Decimal | string | number,
    binanceNotionalUsd: Decimal | string | number,
    bybitNotionalUsd: Decimal | string | number
  ): FundingCashFlowResult {
    const bRate = toDecimal(binanceRate);
    const byRate = toDecimal(bybitRate);
    const bNotional = toDecimal(binanceNotionalUsd);
    const byNotional = toDecimal(bybitNotionalUsd);

    const diff = bRate.minus(byRate);

    let direction: TradeDirection;
    let bCashFlow: Decimal;
    let byCashFlow: Decimal;

    if (diff.greaterThanOrEqualTo('0')) {
      // Binance funding is higher -> Short Binance, Long Bybit
      direction = 'SHORT_BINANCE_LONG_BYBIT';
      // Short receives funding if positive (+bRate * notional)
      bCashFlow = bRate.times(bNotional);
      // Long pays funding if positive (-byRate * notional)
      byCashFlow = byRate.negated().times(byNotional);
    } else {
      // Bybit funding is higher -> Long Binance, Short Bybit
      direction = 'LONG_BINANCE_SHORT_BYBIT';
      // Long pays funding if positive (-bRate * notional)
      bCashFlow = bRate.negated().times(bNotional);
      // Short receives funding if positive (+byRate * notional)
      byCashFlow = byRate.times(byNotional);
    }

    const netCashFlow = bCashFlow.plus(byCashFlow);

    return {
      direction,
      binanceFundingCashFlow: bCashFlow,
      bybitFundingCashFlow: byCashFlow,
      netFundingCashFlow: netCashFlow,
    };
  }
}
