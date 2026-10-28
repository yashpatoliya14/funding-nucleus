import { CommissionRates, OrderBook } from '../exchanges/types.js';
import { FundingCalculator } from './funding-calculator.js';
import { OrderBookManager } from '../market-data/orderbook-manager.js';
import { Decimal, toDecimal } from '../utils/decimal.js';
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

export class ProfitabilityEngine {
  static evaluate(input: ProfitabilityInput, minNetProfitUsd: Decimal): ProfitabilityResult {
    // 1. Funding cash flows
    const fundingFlow = FundingCalculator.calculateCashFlow(
      input.binanceRate,
      input.bybitRate,
      input.binanceNotionalUsd,
      input.bybitNotionalUsd
    );

    // Direction dictates sides
    // SHORT_BINANCE_LONG_BYBIT: Binance Entry = SELL, Bybit Entry = BUY
    // LONG_BINANCE_SHORT_BYBIT:  Binance Entry = BUY,  Bybit Entry = SELL
    const binanceEntrySide = fundingFlow.direction === 'SHORT_BINANCE_LONG_BYBIT' ? 'SELL' : 'BUY';
    const bybitEntrySide = fundingFlow.direction === 'SHORT_BINANCE_LONG_BYBIT' ? 'BUY' : 'SELL';
    const binanceExitSide = binanceEntrySide === 'BUY' ? 'SELL' : 'BUY';
    const bybitExitSide = bybitEntrySide === 'BUY' ? 'SELL' : 'BUY';

    // 2. Entry fees (taker rate applied to intended notional)
    const binanceEntryFee = input.binanceNotionalUsd.times(input.binanceCommission.takerRate);
    const bybitEntryFee = input.bybitNotionalUsd.times(input.bybitCommission.takerRate);
    const totalEntryFees = binanceEntryFee.plus(bybitEntryFee);

    // 3. Exit fees (taker rate applied to expected exit notional)
    const binanceExitFee = input.binanceNotionalUsd.times(input.binanceCommission.takerRate);
    const bybitExitFee = input.bybitNotionalUsd.times(input.bybitCommission.takerRate);
    const totalExitFees = binanceExitFee.plus(bybitExitFee);

    // 4. Slippage estimates from order book
    const bEntryEstimate = OrderBookManager.estimateExecution(
      input.binanceOrderBook,
      binanceEntrySide,
      input.binanceQuantity
    );
    const byEntryEstimate = OrderBookManager.estimateExecution(
      input.bybitOrderBook,
      bybitEntrySide,
      input.bybitQuantity
    );

    if (!bEntryEstimate.isFilled || !byEntryEstimate.isFilled) {
      return {
        direction: fundingFlow.direction,
        expectedFundingCashFlowBinance: fundingFlow.binanceFundingCashFlow,
        expectedFundingCashFlowBybit: fundingFlow.bybitFundingCashFlow,
        netFundingCashFlow: fundingFlow.netFundingCashFlow,
        estimatedEntryFees: totalEntryFees,
        estimatedExitFees: totalExitFees,
        estimatedEntrySlippageUsd: toDecimal('0'),
        estimatedExitSlippageUsd: toDecimal('0'),
        riskBufferUsd: input.riskBufferUsd,
        expectedNetProfitUsd: toDecimal('-999'),
        isProfitable: false,
        rejectionReason: 'Insufficient order book depth to completely fill intended quantity',
      };
    }

    // Convert slippage bps to USD cost: notional * (slippageBps / 10000)
    const bEntrySlippageUsd = input.binanceNotionalUsd.times(bEntryEstimate.slippageBps).dividedBy('10000');
    const byEntrySlippageUsd = input.bybitNotionalUsd.times(byEntryEstimate.slippageBps).dividedBy('10000');
    const totalEntrySlippageUsd = bEntrySlippageUsd.plus(byEntrySlippageUsd);

    // Exit slippage estimate (modeled symmetrically using opposite side depth)
    const bExitEstimate = OrderBookManager.estimateExecution(
      input.binanceOrderBook,
      binanceExitSide,
      input.binanceQuantity
    );
    const byExitEstimate = OrderBookManager.estimateExecution(
      input.bybitOrderBook,
      bybitExitSide,
      input.bybitQuantity
    );

    const bExitSlippageUsd = input.binanceNotionalUsd.times(bExitEstimate.slippageBps).dividedBy('10000');
    const byExitSlippageUsd = input.bybitNotionalUsd.times(byExitEstimate.slippageBps).dividedBy('10000');
    const totalExitSlippageUsd = bExitSlippageUsd.plus(byExitSlippageUsd);

    // 5. Expected Net Profit Formula
    // expected_net_profit = net_funding - entry_fees - exit_fees - entry_slippage - exit_slippage - risk_buffer
    const totalCosts = totalEntryFees
      .plus(totalExitFees)
      .plus(totalEntrySlippageUsd)
      .plus(totalExitSlippageUsd)
      .plus(input.riskBufferUsd);

    const expectedNetProfit = fundingFlow.netFundingCashFlow.minus(totalCosts);
    const isProfitable = expectedNetProfit.greaterThanOrEqualTo(minNetProfitUsd);

    return {
      direction: fundingFlow.direction,
      expectedFundingCashFlowBinance: fundingFlow.binanceFundingCashFlow,
      expectedFundingCashFlowBybit: fundingFlow.bybitFundingCashFlow,
      netFundingCashFlow: fundingFlow.netFundingCashFlow,
      estimatedEntryFees: totalEntryFees,
      estimatedExitFees: totalExitFees,
      estimatedEntrySlippageUsd: totalEntrySlippageUsd,
      estimatedExitSlippageUsd: totalExitSlippageUsd,
      riskBufferUsd: input.riskBufferUsd,
      expectedNetProfitUsd: expectedNetProfit,
      isProfitable,
      rejectionReason: isProfitable
        ? undefined
        : `Expected net profit $${expectedNetProfit.toFixed(4)} is below minimum required $${minNetProfitUsd.toFixed(4)}`,
    };
  }
}
