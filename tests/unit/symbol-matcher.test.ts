import { describe, it, expect, beforeEach } from 'vitest';
import DatabaseConstructor from 'better-sqlite3';
import { SymbolMatcher } from '../../src/market-data/symbol-matcher.js';
import { SymbolCache } from '../../src/market-data/symbol-cache.js';
import { runMigrations } from '../../src/persistence/migrations.js';
import { SymbolRepository } from '../../src/persistence/repositories.js';
import { InstrumentInfo } from '../../src/exchanges/types.js';
import { toDecimal } from '../../src/utils/decimal.js';

describe('Unit Tests: Symbol Matching & Cache', () => {
  let db: any;
  let symbolRepo: SymbolRepository;

  beforeEach(() => {
    db = new DatabaseConstructor(':memory:');
    runMigrations(db);
    symbolRepo = new SymbolRepository(db);
  });

  // 1. Matching BTCUSDT perpetual contracts
  it('1. correctly matches BTCUSDT perpetual contracts across both exchanges', async () => {
    const binanceClient: any = {
      exchangeName: 'binance',
      getInstruments: async () => [
        {
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
        },
      ],
    };
    const bybitClient: any = {
      exchangeName: 'bybit',
      getInstruments: async () => [
        {
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
        },
      ],
    };

    const matcher = new SymbolMatcher(binanceClient, bybitClient);
    const matches = await matcher.matchInstruments();
    expect(matches.length).toBe(1);
    expect(matches[0]!.normalizedSymbol).toBe('BTC');
    expect(matches[0]!.binanceInstrument.symbol).toBe('BTCUSDT');
    expect(matches[0]!.bybitInstrument.symbol).toBe('BTCUSDT');
  });

  // 2. Matching ETHUSDT perpetual contracts
  it('2. correctly matches ETHUSDT perpetual contracts', async () => {
    const binanceClient: any = {
      exchangeName: 'binance',
      getInstruments: async () => [
        {
          exchange: 'binance',
          symbol: 'ETHUSDT',
          baseAsset: 'ETH',
          quoteAsset: 'USDT',
          settleAsset: 'USDT',
          contractType: 'PERPETUAL',
          contractMultiplier: toDecimal('1'),
          minQuantity: toDecimal('0.01'),
          quantityStep: toDecimal('0.01'),
          priceTick: toDecimal('0.01'),
          minNotional: toDecimal('5'),
          isActive: true,
          maxLeverage: 50,
        },
      ],
    };
    const bybitClient: any = {
      exchangeName: 'bybit',
      getInstruments: async () => [
        {
          exchange: 'bybit',
          symbol: 'ETHUSDT',
          baseAsset: 'ETH',
          quoteAsset: 'USDT',
          settleAsset: 'USDT',
          contractType: 'PERPETUAL',
          contractMultiplier: toDecimal('1'),
          minQuantity: toDecimal('0.02'),
          quantityStep: toDecimal('0.01'),
          priceTick: toDecimal('0.05'),
          minNotional: toDecimal('5'),
          isActive: true,
          maxLeverage: 50,
        },
      ],
    };

    const matcher = new SymbolMatcher(binanceClient, bybitClient);
    const matches = await matcher.matchInstruments();
    expect(matches.length).toBe(1);
    expect(matches[0]!.normalizedSymbol).toBe('ETH');
    expect(matches[0]!.minQuantity.toString()).toBe('0.02'); // Max of both minQuantities
  });

  // 3. Rejecting spot vs perpetual contracts
  it('3. rejects spot contracts when matching perpetuals', async () => {
    const binanceClient: any = {
      exchangeName: 'binance',
      getInstruments: async () => [
        {
          exchange: 'binance',
          symbol: 'SOLUSDT',
          baseAsset: 'SOL',
          quoteAsset: 'USDT',
          settleAsset: 'USDT',
          contractType: 'SPOT', // Spot!
          contractMultiplier: toDecimal('1'),
          minQuantity: toDecimal('0.1'),
          quantityStep: toDecimal('0.1'),
          priceTick: toDecimal('0.01'),
          minNotional: toDecimal('5'),
          isActive: true,
          maxLeverage: 1,
        },
      ],
    };
    const bybitClient: any = {
      exchangeName: 'bybit',
      getInstruments: async () => [
        {
          exchange: 'bybit',
          symbol: 'SOLUSDT',
          baseAsset: 'SOL',
          quoteAsset: 'USDT',
          settleAsset: 'USDT',
          contractType: 'PERPETUAL',
          contractMultiplier: toDecimal('1'),
          minQuantity: toDecimal('0.1'),
          quantityStep: toDecimal('0.1'),
          priceTick: toDecimal('0.01'),
          minNotional: toDecimal('5'),
          isActive: true,
          maxLeverage: 20,
        },
      ],
    };

    const matcher = new SymbolMatcher(binanceClient, bybitClient);
    const matches = await matcher.matchInstruments();
    expect(matches.length).toBe(0);
  });

  // 4. Rejecting incompatible settlement currencies (USDC vs USDT)
  it('4. rejects incompatible settlement currencies', async () => {
    const binanceClient: any = {
      exchangeName: 'binance',
      getInstruments: async () => [
        {
          exchange: 'binance',
          symbol: 'BTCUSDC',
          baseAsset: 'BTC',
          quoteAsset: 'USDC',
          settleAsset: 'USDC', // USDC settle!
          contractType: 'PERPETUAL',
          contractMultiplier: toDecimal('1'),
          minQuantity: toDecimal('0.001'),
          quantityStep: toDecimal('0.001'),
          priceTick: toDecimal('0.1'),
          minNotional: toDecimal('5'),
          isActive: true,
          maxLeverage: 50,
        },
      ],
    };
    const bybitClient: any = {
      exchangeName: 'bybit',
      getInstruments: async () => [
        {
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
          maxLeverage: 50,
        },
      ],
    };

    const matcher = new SymbolMatcher(binanceClient, bybitClient);
    const matches = await matcher.matchInstruments();
    expect(matches.length).toBe(0);
  });

  // 5. Rejecting inactive or suspended contracts
  it('5. rejects inactive or suspended contracts', async () => {
    const binanceClient: any = {
      exchangeName: 'binance',
      getInstruments: async () => [
        {
          exchange: 'binance',
          symbol: 'XRPUSDT',
          baseAsset: 'XRP',
          quoteAsset: 'USDT',
          settleAsset: 'USDT',
          contractType: 'PERPETUAL',
          contractMultiplier: toDecimal('1'),
          minQuantity: toDecimal('1'),
          quantityStep: toDecimal('1'),
          priceTick: toDecimal('0.0001'),
          minNotional: toDecimal('5'),
          isActive: false, // Inactive!
          maxLeverage: 20,
        },
      ],
    };
    const bybitClient: any = {
      exchangeName: 'bybit',
      getInstruments: async () => [
        {
          exchange: 'bybit',
          symbol: 'XRPUSDT',
          baseAsset: 'XRP',
          quoteAsset: 'USDT',
          settleAsset: 'USDT',
          contractType: 'PERPETUAL',
          contractMultiplier: toDecimal('1'),
          minQuantity: toDecimal('1'),
          quantityStep: toDecimal('1'),
          priceTick: toDecimal('0.0001'),
          minNotional: toDecimal('5'),
          isActive: true,
          maxLeverage: 20,
        },
      ],
    };

    const matcher = new SymbolMatcher(binanceClient, bybitClient);
    const matches = await matcher.matchInstruments();
    expect(matches.length).toBe(0);
  });

  // 6. Rejecting incompatible contract specifications (multiplier mismatch)
  it('6. rejects contracts with incompatible multipliers', async () => {
    const binanceClient: any = {
      exchangeName: 'binance',
      getInstruments: async () => [
        {
          exchange: 'binance',
          symbol: 'DOGEUSDT',
          baseAsset: 'DOGE',
          quoteAsset: 'USDT',
          settleAsset: 'USDT',
          contractType: 'PERPETUAL',
          contractMultiplier: toDecimal('10'), // Multiplier 10
          minQuantity: toDecimal('1'),
          quantityStep: toDecimal('1'),
          priceTick: toDecimal('0.0001'),
          minNotional: toDecimal('5'),
          isActive: true,
          maxLeverage: 20,
        },
      ],
    };
    const bybitClient: any = {
      exchangeName: 'bybit',
      getInstruments: async () => [
        {
          exchange: 'bybit',
          symbol: 'DOGEUSDT',
          baseAsset: 'DOGE',
          quoteAsset: 'USDT',
          settleAsset: 'USDT',
          contractType: 'PERPETUAL',
          contractMultiplier: toDecimal('1'), // Multiplier 1
          minQuantity: toDecimal('1'),
          quantityStep: toDecimal('1'),
          priceTick: toDecimal('0.0001'),
          minNotional: toDecimal('5'),
          isActive: true,
          maxLeverage: 20,
        },
      ],
    };

    const matcher = new SymbolMatcher(binanceClient, bybitClient);
    const matches = await matcher.matchInstruments();
    expect(matches.length).toBe(0);
  });

  // 7. Cache hit before 24 hours
  it('7. hits cache and skips network refresh when within 24-hour TTL', async () => {
    let callCount = 0;
    const binanceClient: any = {
      exchangeName: 'binance',
      getInstruments: async () => {
        callCount++;
        return [
          {
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
          },
        ];
      },
    };
    const bybitClient: any = {
      exchangeName: 'bybit',
      getInstruments: async () => [
        {
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
          maxLeverage: 50,
        },
      ],
    };

    const matcher = new SymbolMatcher(binanceClient, bybitClient);
    const cache = new SymbolCache(symbolRepo, matcher, 24);

    // Initial populate
    await cache.refreshIfExpired();
    expect(callCount).toBe(1);

    // Immediate second call should hit SQLite cache
    await cache.refreshIfExpired();
    expect(callCount).toBe(1); // Still 1, didn't re-fetch
  });

  // 8. Cache refresh after expiry
  it('8. triggers refresh when cache is expired', async () => {
    let callCount = 0;
    const binanceClient: any = {
      exchangeName: 'binance',
      getInstruments: async () => {
        callCount++;
        return [
          {
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
          },
        ];
      },
    };
    const bybitClient: any = {
      exchangeName: 'bybit',
      getInstruments: async () => [
        {
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
          maxLeverage: 50,
        },
      ],
    };

    // Pre-insert an expired record
    const expiredTime = new Date(Date.now() - 3600000).toISOString();
    symbolRepo.upsert({
      id: 'BTCUSDT_BTCUSDT',
      normalized_symbol: 'BTC',
      binance_symbol: 'BTCUSDT',
      bybit_symbol: 'BTCUSDT',
      base_asset: 'BTC',
      quote_asset: 'USDT',
      contract_multiplier: '1',
      min_quantity: '0.001',
      quantity_step: '0.001',
      price_tick: '0.1',
      binance_status: 'TRADING',
      bybit_status: 'Trading',
      is_active: 1,
      last_validated_at: expiredTime,
      expires_at: expiredTime, // Expired!
    });

    const matcher = new SymbolMatcher(binanceClient, bybitClient);
    const cache = new SymbolCache(symbolRepo, matcher, 24);

    await cache.refreshIfExpired();
    expect(callCount).toBe(1); // Fetched new data because expired
  });

  // 9. Immediate invalidation when trading status becomes invalid
  it('9. immediately excludes inactive contracts', async () => {
    symbolRepo.upsert({
      id: 'LUNAUSDT_LUNAUSDT',
      normalized_symbol: 'LUNA',
      binance_symbol: 'LUNAUSDT',
      bybit_symbol: 'LUNAUSDT',
      base_asset: 'LUNA',
      quote_asset: 'USDT',
      contract_multiplier: '1',
      min_quantity: '1',
      quantity_step: '1',
      price_tick: '0.01',
      binance_status: 'DISABLED',
      bybit_status: 'Disabled',
      is_active: 0, // Disabled!
      last_validated_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });

    const mapping = symbolRepo.getByNormalized('LUNA');
    expect(mapping).toBeUndefined(); // Only active contracts returned
  });

  // 10. Handling missing or incomplete metadata safely
  it('10. handles missing or incomplete metadata safely', async () => {
    const binanceClient: any = {
      exchangeName: 'binance',
      getInstruments: async () => [
        {
          exchange: 'binance',
          symbol: 'UNKNOWN',
          baseAsset: '',
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
        },
      ],
    };
    const bybitClient: any = {
      exchangeName: 'bybit',
      getInstruments: async () => [],
    };

    const matcher = new SymbolMatcher(binanceClient, bybitClient);
    const matches = await matcher.matchInstruments();
    expect(matches).toEqual([]);
  });
});
