import { OrderBook } from '../exchanges/types.js';
import { OrderSide } from '../persistence/models.js';
import { Decimal } from '../utils/decimal.js';
export interface DepthExecutionEstimate {
    vwapPrice: Decimal;
    bestPrice: Decimal;
    slippageBps: Decimal;
    totalCostUsd: Decimal;
    isFilled: boolean;
    unfilledQty: Decimal;
}
export declare class OrderBookManager {
    static estimateExecution(book: OrderBook, side: OrderSide, quantity: Decimal): DepthExecutionEstimate;
}
//# sourceMappingURL=orderbook-manager.d.ts.map