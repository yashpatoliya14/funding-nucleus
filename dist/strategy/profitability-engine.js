import { FundingCalculator } from './funding-calculator.js';
import { OrderBookManager } from '../market-data/orderbook-manager.js';
import { toDecimal } from '../utils/decimal.js';
export class ProfitabilityEngine {
    static evaluate(input, minNetProfitUsd) {
        // 1. Funding cash flows
        const fundingFlow = FundingCalculator.calculateCashFlow(input.binanceRate, input.bybitRate, input.binanceNotionalUsd, input.bybitNotionalUsd);
        // Direction dictates sides
        // SHORT_BINANCE_LONG_BYBIT: Binance Entry = SELL, Bybit Entry = BUY
        // LONG_BINANCE_SHORT_BYBIT:  Binance Entry = BUY,  Bybit Entry = SELL
        const binanceEntrySide = fundingFlow.direction === 'SHORT_BINANCE_LONG_BYBIT' ? 'SELL' : 'BUY';
        const bybitEntrySide = fundingFlow.direction === 'SHORT_BINANCE_LONG_BYBIT' ? 'BUY' : 'SELL';
        const binanceExitSide = binanceEntrySide === 'BUY' ? 'SELL' : 'BUY';
        const bybitExitSide = bybitEntrySide === 'BUY' ? 'SELL' : 'BUY';
        // 2. Entry fees (if maker-taker hybrid enabled, Bybit leg is placed as post-only maker)
        const bybitEntryRate = input.makerTakerHybridEnabled && input.bybitCommission.makerRate
            ? input.bybitCommission.makerRate
            : input.bybitCommission.takerRate;
        const binanceEntryFee = input.binanceNotionalUsd.times(input.binanceCommission.takerRate);
        const bybitEntryFee = input.bybitNotionalUsd.times(bybitEntryRate);
        const totalEntryFees = binanceEntryFee.plus(bybitEntryFee);
        // 3. Exit fees (taker rate applied to expected exit notional)
        const binanceExitFee = input.binanceNotionalUsd.times(input.binanceCommission.takerRate);
        const bybitExitFee = input.bybitNotionalUsd.times(input.bybitCommission.takerRate);
        const totalExitFees = binanceExitFee.plus(bybitExitFee);
        // 4. Slippage estimates from order book
        const bEntryEstimate = OrderBookManager.estimateExecution(input.binanceOrderBook, binanceEntrySide, input.binanceQuantity);
        const byEntryEstimate = OrderBookManager.estimateExecution(input.bybitOrderBook, bybitEntrySide, input.bybitQuantity);
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
        const bExitEstimate = OrderBookManager.estimateExecution(input.binanceOrderBook, binanceExitSide, input.binanceQuantity);
        const byExitEstimate = OrderBookManager.estimateExecution(input.bybitOrderBook, bybitExitSide, input.bybitQuantity);
        const bExitSlippageUsd = input.binanceNotionalUsd.times(bExitEstimate.slippageBps).dividedBy('10000');
        const byExitSlippageUsd = input.bybitNotionalUsd.times(byExitEstimate.slippageBps).dividedBy('10000');
        const totalExitSlippageUsd = bExitSlippageUsd.plus(byExitSlippageUsd);
        // 5. Total trading costs (entry fees + exit fees + entry/exit slippage + risk buffer)
        const totalCosts = totalEntryFees
            .plus(totalExitFees)
            .plus(totalEntrySlippageUsd)
            .plus(totalExitSlippageUsd)
            .plus(input.riskBufferUsd);
        // 6. Expected Net Profit Formula
        // In cumulative carry mode, holding across multi-cycle funding periods (default: 2 cycles)
        // amortizes entry and exit trading fees across the entire holding duration.
        const cycles = input.expectedHoldingCycles && input.expectedHoldingCycles > 1
            ? input.expectedHoldingCycles
            : 1;
        const totalFundingCashFlow = fundingFlow.netFundingCashFlow.times(cycles);
        const expectedNetProfit = totalFundingCashFlow.minus(totalCosts);
        const singleCycleNetProfit = fundingFlow.netFundingCashFlow.minus(totalCosts);
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
            singleCycleNetProfitUsd: singleCycleNetProfit,
            expectedHoldingCycles: cycles,
            isProfitable,
            rejectionReason: isProfitable
                ? undefined
                : `Expected net profit $${expectedNetProfit.toFixed(4)} (${cycles}-cycle carry) is below minimum required $${minNetProfitUsd.toFixed(4)}`,
        };
    }
}
//# sourceMappingURL=profitability-engine.js.map