import { CommissionRates, OrderBook } from '../exchanges/types.js';
import { Decimal } from '../utils/decimal.js';
import { TradeDirection } from '../persistence/models.js';
export interface ProfitabilityInput {
    binanceRate: Decimal;
    bybitRate: Decimal;
    binanceNotionalUsd: Decimal;
    bybitNotionalUsd: Decimal;
    binanceQuantity: Decimal;
    bybitQuantity: Decimal;
    binanceCommission: CommissionRates;
    bybitCommission: CommissionRates;
    binanceOrderBook: OrderBook;
    bybitOrderBook: OrderBook;
    riskBufferUsd: Decimal;
}
export interface ProfitabilityResult {
    direction: TradeDirection;
    expectedFundingCashFlowBinance: Decimal;
    expectedFundingCashFlowBybit: Decimal;
    netFundingCashFlow: Decimal;
    estimatedEntryFees: Decimal;
    estimatedExitFees: Decimal;
    estimatedEntrySlippageUsd: Decimal;
    estimatedExitSlippageUsd: Decimal;
    riskBufferUsd: Decimal;
    expectedNetProfitUsd: Decimal;
    isProfitable: boolean;
    rejectionReason?: string;
}
export declare class ProfitabilityEngine {
    static evaluate(input: ProfitabilityInput, minNetProfitUsd: Decimal): ProfitabilityResult;
}
//# sourceMappingURL=profitability-engine.d.ts.map