import { describe, it, expect } from 'vitest';
import { FundingCalculator } from '../../src/strategy/funding-calculator.js';
import { areFundingTimesAligned } from '../../src/utils/time.js';
import { toDecimal } from '../../src/utils/decimal.js';

describe('Unit Tests: Funding Calculation & Scenarios', () => {
  // Case 1 from Prompt:
  // Binance funding = +0.10% (0.0010)
  // Bybit funding   = +0.02% (0.0002)
  // Expected direction: SHORT Binance, LONG Bybit
  // Combined funding advantage on matched notional ($1000): 0.08% ($0.80)
  it('Fixture Case 1: Binance +0.10%, Bybit +0.02%', () => {
    const res = FundingCalculator.calculateCashFlow('0.0010', '0.0002', '1000', '1000');
    expect(res.direction).toBe('SHORT_BINANCE_LONG_BYBIT');
    // Short receives funding: +0.0010 * 1000 = +1.00
    expect(res.binanceFundingCashFlow.toString()).toBe('1');
    // Long pays funding: -0.0002 * 1000 = -0.20
    expect(res.bybitFundingCashFlow.toString()).toBe('-0.2');
    // Net: +1.00 - 0.20 = +0.80 (0.08% advantage)
    expect(res.netFundingCashFlow.toString()).toBe('0.8');
  });

  // Case 2 from Prompt:
  // Binance funding = +0.01% (0.0001)
  // Bybit funding   = +0.08% (0.0008)
  // Expected direction: LONG Binance, SHORT Bybit
  // Combined funding advantage on matched notional ($1000): 0.07% ($0.70)
  it('Fixture Case 2: Binance +0.01%, Bybit +0.08%', () => {
    const res = FundingCalculator.calculateCashFlow('0.0001', '0.0008', '1000', '1000');
    expect(res.direction).toBe('LONG_BINANCE_SHORT_BYBIT');
    // Long pays funding: -0.0001 * 1000 = -0.10
    expect(res.binanceFundingCashFlow.toString()).toBe('-0.1');
    // Short receives funding: +0.0008 * 1000 = +0.80
    expect(res.bybitFundingCashFlow.toString()).toBe('0.8');
    // Net: -0.10 + 0.80 = +0.70 (0.07% advantage)
    expect(res.netFundingCashFlow.toString()).toBe('0.7');
  });

  it('calculates cash flow when both rates are negative', () => {
    // Binance: -0.05% (-0.0005), Bybit: -0.02% (-0.0002)
    // Diff: -0.0005 - (-0.0002) = -0.0003 (Bybit rate is higher algebraically)
    // Direction: Long Binance, Short Bybit
    const res = FundingCalculator.calculateCashFlow('-0.0005', '-0.0002', '1000', '1000');
    expect(res.direction).toBe('LONG_BINANCE_SHORT_BYBIT');
    // Long receives when rate negative: -(-0.0005) * 1000 = +0.50
    expect(res.binanceFundingCashFlow.toString()).toBe('0.5');
    // Short pays when rate negative: +(-0.0002) * 1000 = -0.20
    expect(res.bybitFundingCashFlow.toString()).toBe('-0.2');
    expect(res.netFundingCashFlow.toString()).toBe('0.3');
  });

  it('calculates cash flow when one rate is positive and the other is negative', () => {
    // Binance: +0.05% (0.0005), Bybit: -0.05% (-0.0005)
    // Short Binance (receives +0.50), Long Bybit (receives -(-0.50) = +0.50)
    // Double receipt!
    const res = FundingCalculator.calculateCashFlow('0.0005', '-0.0005', '1000', '1000');
    expect(res.direction).toBe('SHORT_BINANCE_LONG_BYBIT');
    expect(res.binanceFundingCashFlow.toString()).toBe('0.5');
    expect(res.bybitFundingCashFlow.toString()).toBe('0.5');
    expect(res.netFundingCashFlow.toString()).toBe('1');
  });

  it('handles equal funding rates with zero net advantage', () => {
    const res = FundingCalculator.calculateCashFlow('0.0001', '0.0001', '1000', '1000');
    expect(res.netFundingCashFlow.toString()).toBe('0');
  });

  it('detects misaligned funding timestamps', () => {
    const t0 = 1700000000000;
    // 8h apart
    const tMisaligned = t0 + 8 * 3600 * 1000;
    expect(areFundingTimesAligned(t0, tMisaligned, 60)).toBe(false);

    // 10s apart (within 60s tolerance)
    const tAligned = t0 + 10 * 1000;
    expect(areFundingTimesAligned(t0, tAligned, 60)).toBe(true);
  });

  it('handles predicted rate changes before execution', () => {
    // Initial rate
    const initial = FundingCalculator.calculateCashFlow('0.0003', '0.0001', '1000', '1000');
    expect(initial.netFundingCashFlow.toString()).toBe('0.2');

    // Predicted rate flips before execution: Binance drops to 0.00005, Bybit rises to 0.0003
    const updated = FundingCalculator.calculateCashFlow('0.00005', '0.0003', '1000', '1000');
    expect(updated.direction).toBe('LONG_BINANCE_SHORT_BYBIT');
    expect(updated.netFundingCashFlow.toString()).toBe('0.25');
  });
});
