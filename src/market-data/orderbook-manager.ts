import { OrderBook, OrderBookLevel } from '../exchanges/types.js';
import { OrderSide } from '../persistence/models.js';
import { Decimal, toDecimal } from '../utils/decimal.js';

export interface DepthExecutionEstimate {
  vwapPrice: Decimal;
  bestPrice: Decimal;
  slippageBps: Decimal; // in basis points (1 bp = 0.01%)
  totalCostUsd: Decimal;
  isFilled: boolean;
  unfilledQty: Decimal;
}

export class OrderBookManager {
  static estimateExecution(book: OrderBook, side: OrderSide, quantity: Decimal): DepthExecutionEstimate {
    const levels: OrderBookLevel[] = side === 'BUY' ? book.asks : book.bids;

    if (levels.length === 0 || quantity.isZero()) {
      return {
        vwapPrice: toDecimal('0'),
        bestPrice: toDecimal('0'),
        slippageBps: toDecimal('0'),
        totalCostUsd: toDecimal('0'),
        isFilled: false,
        unfilledQty: quantity,
      };
    }

    const bestPrice = levels[0]!.price;
    let remainingQty = quantity;
    let accumulatedCost = toDecimal('0');
    let filledQty = toDecimal('0');

    for (const level of levels) {
      if (remainingQty.isZero()) break;
      const takeQty = Decimal.min(remainingQty, level.quantity);
      accumulatedCost = accumulatedCost.plus(takeQty.times(level.price));
      filledQty = filledQty.plus(takeQty);
      remainingQty = remainingQty.minus(takeQty);
    }

    const isFilled = remainingQty.isZero();
    const vwapPrice = filledQty.isPositive() ? accumulatedCost.dividedBy(filledQty) : bestPrice;

    // Slippage formula:
    // For BUY: (vwap - bestAsk) / bestAsk * 10000
    // For SELL: (bestBid - vwap) / bestBid * 10000
    let slippageBps = toDecimal('0');
    if (!bestPrice.isZero()) {
      if (side === 'BUY') {
        slippageBps = vwapPrice.minus(bestPrice).dividedBy(bestPrice).times('10000');
      } else {
        slippageBps = bestPrice.minus(vwapPrice).dividedBy(bestPrice).times('10000');
      }
    }

    return {
      vwapPrice,
      bestPrice,
      slippageBps: Decimal.max(toDecimal('0'), slippageBps),
      totalCostUsd: accumulatedCost,
      isFilled,
      unfilledQty: remainingQty,
    };
  }
}
