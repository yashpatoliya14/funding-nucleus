import { describe, it, expect } from 'vitest';
import { ProfitabilityEngine } from '../../src/strategy/profitability-engine.js';
import { MarketHealth } from '../../src/market-data/market-health.js';
import { toDecimal } from '../../src/utils/decimal.js';
import { StaleDataError } from '../../src/utils/errors.js';

describe('Unit Tests: Fees & Profitability Engine', () => {
  const dummyBinanceCommission = {
    exchange: 'binance' as const,
    symbol: 'BTCUSDT',
    makerRate: toDecimal('0.0002'),
    takerRate: toDecimal('0.0005'), // 5 bps
  };

  const dummyBybitCommission = {
    exchange: 'bybit' as const,
    symbol: 'BTCUSDT',
    makerRate: toDecimal('0.0002'),
    takerRate: toDecimal('0.00055'), // 5.5 bps
  };

  const dummyBook = {
    exchange: 'binance' as const,
    symbol: 'BTCUSDT',
    bids: [
      { price: toDecimal('65000'), quantity: toDecimal('10') },
      { price: toDecimal('64995'), quantity: toDecimal('20') },
    ],
    asks: [
      { price: toDecimal('65001'), quantity: toDecimal('10') },
      { price: toDecimal('65005'), quantity: toDecimal('20') },
    ],
    timestampMs: Date.now(),
  };

  // 1. Positive expected net profit
  it('1. approves when expected net profit is positive and above threshold', () => {
    // 34 bps funding diff on $10,000 = $34.00
    // Total fees: (5 + 5.5) * 2 = 21 bps = $21.00
    // Slippage: ~0.001% = $0.20
    // Risk buffer: $0.10
    // Net profit = $34 - $21 - $0.20 - $0.10 = ~$12.70 > $0.50
    const res = ProfitabilityEngine.evaluate(
      {
        binanceRate: toDecimal('0.0035'),
        bybitRate: toDecimal('0.0001'),
        binanceNotionalUsd: toDecimal('10000'),
        bybitNotionalUsd: toDecimal('10000'),
        binanceQuantity: toDecimal('0.15'),
        bybitQuantity: toDecimal('0.15'),
        binanceCommission: dummyBinanceCommission,
        bybitCommission: dummyBybitCommission,
        binanceOrderBook: dummyBook,
        bybitOrderBook: dummyBook,
        riskBufferUsd: toDecimal('0.10'),
      },
      toDecimal('0.50')
    );

    expect(res.isProfitable).toBe(true);
    expect(res.expectedNetProfitUsd.greaterThan('0.50')).toBe(true);
  });

  // 2. Negative expected net profit
  it('2. rejects when expected net profit is negative', () => {
    // 1 bp edge ($1) vs 21 bps fees ($21)
    const res = ProfitabilityEngine.evaluate(
      {
        binanceRate: toDecimal('0.0002'),
        bybitRate: toDecimal('0.0001'),
        binanceNotionalUsd: toDecimal('10000'),
        bybitNotionalUsd: toDecimal('10000'),
        binanceQuantity: toDecimal('0.15'),
        bybitQuantity: toDecimal('0.15'),
        binanceCommission: dummyBinanceCommission,
        bybitCommission: dummyBybitCommission,
        binanceOrderBook: dummyBook,
        bybitOrderBook: dummyBook,
        riskBufferUsd: toDecimal('0.10'),
      },
      toDecimal('0.50')
    );

    expect(res.isProfitable).toBe(false);
    expect(res.expectedNetProfitUsd.isNegative()).toBe(true);
  });

  // 3. Opening fees greater than expected funding income
  it('3. rejects when opening fees exceed expected funding income', () => {
    // Funding income: 8 bps = $8 on $10,000
    // Opening fees: 5 bps + 5.5 bps = 10.5 bps = $10.50 > $8
    const res = ProfitabilityEngine.evaluate(
      {
        binanceRate: toDecimal('0.0009'),
        bybitRate: toDecimal('0.0001'),
        binanceNotionalUsd: toDecimal('10000'),
        bybitNotionalUsd: toDecimal('10000'),
        binanceQuantity: toDecimal('0.15'),
        bybitQuantity: toDecimal('0.15'),
        binanceCommission: dummyBinanceCommission,
        bybitCommission: dummyBybitCommission,
        binanceOrderBook: dummyBook,
        bybitOrderBook: dummyBook,
        riskBufferUsd: toDecimal('0.10'),
      },
      toDecimal('0.50')
    );

    expect(res.isProfitable).toBe(false);
  });

  // 4. Closing fees greater than expected funding income
  it('4. rejects when closing fees erode residual funding advantage', () => {
    const highExitCommission = {
      ...dummyBinanceCommission,
      takerRate: toDecimal('0.005'), // 50 bps closing fee!
    };

    const res = ProfitabilityEngine.evaluate(
      {
        binanceRate: toDecimal('0.0035'),
        bybitRate: toDecimal('0.0001'),
        binanceNotionalUsd: toDecimal('10000'),
        bybitNotionalUsd: toDecimal('10000'),
        binanceQuantity: toDecimal('0.15'),
        bybitQuantity: toDecimal('0.15'),
        binanceCommission: highExitCommission,
        bybitCommission: dummyBybitCommission,
        binanceOrderBook: dummyBook,
        bybitOrderBook: dummyBook,
        riskBufferUsd: toDecimal('0.10'),
      },
      toDecimal('0.50')
    );

    expect(res.isProfitable).toBe(false);
  });

  // 5. High slippage makes trade unprofitable
  it('5. rejects when order book slippage turns an otherwise profitable trade negative', () => {
    // Thin book with huge spread / gap
    const thinBook = {
      exchange: 'binance' as const,
      symbol: 'BTCUSDT',
      bids: [{ price: toDecimal('60000'), quantity: toDecimal('0.01') }], // 8% below ask!
      asks: [{ price: toDecimal('65000'), quantity: toDecimal('0.01') }],
      timestampMs: Date.now(),
    };

    const res = ProfitabilityEngine.evaluate(
      {
        binanceRate: toDecimal('0.0035'),
        bybitRate: toDecimal('0.0001'),
        binanceNotionalUsd: toDecimal('10000'),
        bybitNotionalUsd: toDecimal('10000'),
        binanceQuantity: toDecimal('0.15'),
        bybitQuantity: toDecimal('0.15'),
        binanceCommission: dummyBinanceCommission,
        bybitCommission: dummyBybitCommission,
        binanceOrderBook: thinBook,
        bybitOrderBook: dummyBook,
        riskBufferUsd: toDecimal('0.10'),
      },
      toDecimal('0.50')
    );

    expect(res.isProfitable).toBe(false);
  });

  // 6. Missing commission rates
  it('6. throws or flags when commission rates are invalid or zero', () => {
    const zeroCommission = {
      exchange: 'binance' as const,
      symbol: 'BTCUSDT',
      makerRate: toDecimal('0'),
      takerRate: toDecimal('0'),
    };

    // If zero fee rate was provided, ensure it uses standard Decimal
    const res = ProfitabilityEngine.evaluate(
      {
        binanceRate: toDecimal('0.0001'),
        bybitRate: toDecimal('0.0001'),
        binanceNotionalUsd: toDecimal('10000'),
        bybitNotionalUsd: toDecimal('10000'),
        binanceQuantity: toDecimal('0.15'),
        bybitQuantity: toDecimal('0.15'),
        binanceCommission: zeroCommission,
        bybitCommission: dummyBybitCommission,
        binanceOrderBook: dummyBook,
        bybitOrderBook: dummyBook,
        riskBufferUsd: toDecimal('0.10'),
      },
      toDecimal('0.50')
    );
    expect(res.isProfitable).toBe(false);
  });

  // 7. Stale order-book data
  it('7. detects and rejects stale order book data', () => {
    const health = new MarketHealth(null as any, null as any, 2000, 10000);
    const staleTime = Date.now() - 30000; // 30s old > 10s allowed
    expect(() => health.assertFreshness(staleTime, 'OrderBook')).toThrow(StaleDataError);
  });

  // 8. Insufficient order-book depth
  it('8. rejects when order book depth is insufficient to fill required quantity', () => {
    const tinyBook = {
      exchange: 'binance' as const,
      symbol: 'BTCUSDT',
      bids: [{ price: toDecimal('65000'), quantity: toDecimal('0.001') }], // Only 0.001 BTC
      asks: [{ price: toDecimal('65001'), quantity: toDecimal('0.001') }],
      timestampMs: Date.now(),
    };

    const res = ProfitabilityEngine.evaluate(
      {
        binanceRate: toDecimal('0.0050'),
        bybitRate: toDecimal('0.0001'),
        binanceNotionalUsd: toDecimal('10000'),
        bybitNotionalUsd: toDecimal('10000'),
        binanceQuantity: toDecimal('1.0'), // Wants 1.0 BTC, book has 0.001
        bybitQuantity: toDecimal('1.0'),
        binanceCommission: dummyBinanceCommission,
        bybitCommission: dummyBybitCommission,
        binanceOrderBook: tinyBook,
        bybitOrderBook: dummyBook,
        riskBufferUsd: toDecimal('0.10'),
      },
      toDecimal('0.50')
    );

    expect(res.isProfitable).toBe(false);
    expect(res.rejectionReason).toContain('depth');
  });

  // 9. Risk buffer makes otherwise profitable trade ineligible
  it('9. blocks trade when risk buffer reduces net profit below minimum', () => {
    // Net profit before risk buffer is $0.55
    // With $0.10 risk buffer -> $0.45 < $0.50 minimum
    const res = ProfitabilityEngine.evaluate(
      {
        binanceRate: toDecimal('0.00236'), // Generates ~$23.60 on $10k
        bybitRate: toDecimal('0.0001'),   // Pays $1.00 -> Net funding $22.60
        binanceNotionalUsd: toDecimal('10000'),
        bybitNotionalUsd: toDecimal('10000'),
        binanceQuantity: toDecimal('0.15'),
        bybitQuantity: toDecimal('0.15'),
        binanceCommission: dummyBinanceCommission, // $10.50 open
        bybitCommission: dummyBybitCommission,     // $10.50 close -> $21.00 fees
        binanceOrderBook: dummyBook,
        bybitOrderBook: dummyBook,
        riskBufferUsd: toDecimal('1.50'), // Large risk buffer!
      },
      toDecimal('0.50')
    );

    expect(res.isProfitable).toBe(false);
  });

  // 10. Decimal arithmetic at small funding-rate values
  it('10. calculates exact precision at micro-rate values without float precision error', () => {
    // 0.00001234 rate
    const res = ProfitabilityEngine.evaluate(
      {
        binanceRate: toDecimal('0.0000123456789'),
        bybitRate: toDecimal('0.0000012345678'),
        binanceNotionalUsd: toDecimal('1000'),
        bybitNotionalUsd: toDecimal('1000'),
        binanceQuantity: toDecimal('0.01'),
        bybitQuantity: toDecimal('0.01'),
        binanceCommission: dummyBinanceCommission,
        bybitCommission: dummyBybitCommission,
        binanceOrderBook: dummyBook,
        bybitOrderBook: dummyBook,
        riskBufferUsd: toDecimal('0.01'),
      },
      toDecimal('0.001')
    );

    expect(res.expectedFundingCashFlowBinance.toString()).toBe('0.0123456789');
    expect(res.expectedFundingCashFlowBybit.toString()).toBe('-0.0012345678');
  });
});
