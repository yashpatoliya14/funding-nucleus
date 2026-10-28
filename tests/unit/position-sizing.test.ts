import { describe, it, expect } from 'vitest';
import { PositionSizer } from '../../src/strategy/position-sizing.js';
import { InstrumentInfo } from '../../src/exchanges/types.js';
import { toDecimal } from '../../src/utils/decimal.js';
import { RiskLimitViolationError } from '../../src/utils/errors.js';

describe('Unit Tests: Position Sizing and Risk Limits', () => {
  const dummyBinanceInst: InstrumentInfo = {
    exchange: 'binance',
    symbol: 'BTCUSDT',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    settleAsset: 'USDT',
    contractType: 'PERPETUAL',
    contractMultiplier: toDecimal('1'),
    minQuantity: toDecimal('0.001'),
    quantityStep: toDecimal('0.001'),
    priceTick: toDecimal('0.1'),
    minNotional: toDecimal('5'),
    isActive: true,
    maxLeverage: 50,
  };

  const dummyBybitInst: InstrumentInfo = {
    exchange: 'bybit',
    symbol: 'BTCUSDT',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    settleAsset: 'USDT',
    contractType: 'PERPETUAL',
    contractMultiplier: toDecimal('1'),
    minQuantity: toDecimal('0.001'),
    quantityStep: toDecimal('0.001'),
    priceTick: toDecimal('0.1'),
    minNotional: toDecimal('5'),
    isActive: true,
    maxLeverage: 100,
  };

  it('calculates equal target notional across both legs', () => {
    const res = PositionSizer.calculateSizing(
      '650',
      '65000',
      '65000',
      dummyBinanceInst,
      dummyBybitInst,
      5,
      '0.5'
    );
    expect(res.binanceActualNotionalUsd.toString()).toBe('650');
    expect(res.bybitActualNotionalUsd.toString()).toBe('650');
    expect(res.notionalMismatchPct.toString()).toBe('0');
  });

  it('handles different coin prices with acceptable step rounding', () => {
    // Binance $65,000 vs Bybit $65,020 (0.03% difference)
    const res = PositionSizer.calculateSizing(
      '650',
      '65000',
      '65020',
      dummyBinanceInst,
      dummyBybitInst,
      5,
      '0.5'
    );
    expect(res.binanceQuantity.toString()).toBe('0.01');
    expect(res.bybitQuantity.toString()).toBe('0.009'); // Rounded down to step 0.001
    // Mismatch is calculated and checked
    expect(res.notionalMismatchPct.lessThanOrEqualTo('10')).toBe(true);
  });

  it('respects different contract quantity increments', () => {
    const coarseBybitInst = {
      ...dummyBybitInst,
      quantityStep: toDecimal('0.005'), // Coarser step
    };
    const res = PositionSizer.calculateSizing(
      '650',
      '65000',
      '65000',
      dummyBinanceInst,
      coarseBybitInst,
      5,
      '10.0'
    );
    expect(res.binanceQuantity.toString()).toBe('0.01');
    expect(res.bybitQuantity.toString()).toBe('0.01'); // 0.01 is a multiple of 0.005
  });

  it('adjusts sizing for contract multipliers', () => {
    const multiplierInst = {
      ...dummyBinanceInst,
      contractMultiplier: toDecimal('10'), // 1 contract = 10 coins
    };
    const res = PositionSizer.calculateSizing(
      '650',
      '65', // $65 per coin * 10 = $650 per contract
      '650',
      multiplierInst,
      dummyBybitInst,
      5,
      '0.5'
    );
    // Quantity of contracts needed = 650 / (65 * 10) = 1 contract
    expect(res.binanceQuantity.toString()).toBe('1');
  });

  it('rejects sizing below minimum order quantity', () => {
    expect(() =>
      PositionSizer.calculateSizing(
        '10', // $10 at $65,000 gives 0.00015 BTC < min 0.001
        '65000',
        '65000',
        dummyBinanceInst,
        dummyBybitInst,
        5,
        '0.5'
      )
    ).toThrow(RiskLimitViolationError);
  });

  it('restricts applied leverage to lower of exchange caps and configured cap', () => {
    // Binance max 50, Bybit max 100, Config cap 3
    const res = PositionSizer.calculateSizing(
      '650',
      '65000',
      '65000',
      dummyBinanceInst,
      dummyBybitInst,
      3,
      '0.5'
    );
    expect(res.appliedLeverage).toBe(3);
  });

  it('rejects trades with excessive notional mismatch', () => {
    // 2% price divergence
    expect(() =>
      PositionSizer.calculateSizing(
        '650',
        '65000',
        '66500',
        dummyBinanceInst,
        dummyBybitInst,
        5,
        '0.5' // 0.5% max
      )
    ).toThrow(RiskLimitViolationError);
  });
});
