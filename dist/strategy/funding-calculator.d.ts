import { Decimal } from '../utils/decimal.js';
import { TradeDirection } from '../persistence/models.js';
export interface FundingCashFlowResult {
    direction: TradeDirection;
    binanceFundingCashFlow: Decimal;
    bybitFundingCashFlow: Decimal;
    netFundingCashFlow: Decimal;
}
export declare class FundingCalculator {
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
    static calculateCashFlow(binanceRate: Decimal | string | number, bybitRate: Decimal | string | number, binanceNotionalUsd: Decimal | string | number, bybitNotionalUsd: Decimal | string | number): FundingCashFlowResult;
}
//# sourceMappingURL=funding-calculator.d.ts.map