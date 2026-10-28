import { describe, it, expect, beforeEach } from 'vitest';
import DatabaseConstructor from 'better-sqlite3';
import { runMigrations } from '../../src/persistence/migrations.js';
import {
  DailySummaryRepository,
  RiskEventRepository,
  TradeRepository,
} from '../../src/persistence/repositories.js';
import { PaperClient } from '../../src/exchanges/paper.client.js';
import { CircuitBreaker } from '../../src/risk/circuit-breaker.js';
import { KillSwitch } from '../../src/risk/kill-switch.js';
import { RiskManager } from '../../src/risk/risk-manager.js';
import { MarketHealth } from '../../src/market-data/market-health.js';
import { AppConfigSchema } from '../../src/config/schema.js';
import { toDecimal } from '../../src/utils/decimal.js';
import { RiskLimitViolationError, StaleDataError } from '../../src/utils/errors.js';

describe('Safety Invariants & Risk Controls', () => {
  let db: any;
  let binanceClient: PaperClient;
  let bybitClient: PaperClient;
  let riskManager: RiskManager;
  let circuitBreaker: CircuitBreaker;
  let killSwitch: KillSwitch;
  let dailyRepo: DailySummaryRepository;
  let marketHealth: MarketHealth;

  beforeEach(() => {
    db = new DatabaseConstructor(':memory:');
    runMigrations(db);

    const tradeRepo = new TradeRepository(db);
    dailyRepo = new DailySummaryRepository(db);
    const riskRepo = new RiskEventRepository(db);

    binanceClient = new PaperClient({ exchangeName: 'binance' });
    bybitClient = new PaperClient({ exchangeName: 'bybit' });

    circuitBreaker = new CircuitBreaker(riskRepo);
    killSwitch = new KillSwitch(binanceClient, bybitClient, riskRepo);
    const config = AppConfigSchema.parse({
      risk: {
        maximum_daily_loss_usd: 5,
        maximum_concurrent_trades: 1,
        maximum_aggregate_notional_usd: 200,
      },
    });

    riskManager = new RiskManager(
      binanceClient,
      bybitClient,
      tradeRepo,
      dailyRepo,
      riskRepo,
      circuitBreaker,
      killSwitch,
      config
    );

    marketHealth = new MarketHealth(binanceClient, bybitClient, 2000, 10000);
  });

  it('rejects trades when daily loss limit is reached', async () => {
    // Record $6 loss today (> $5 limit)
    dailyRepo.addTradeResult(toDecimal('-6'), toDecimal('0'), toDecimal('0'));

    const dummyCandidate: any = {
      opportunity: { mapping: { normalized_symbol: 'BTC' } },
      sizing: {
        binanceActualNotionalUsd: toDecimal('100'),
        bybitActualNotionalUsd: toDecimal('100'),
      },
    };

    await expect(riskManager.validatePreTrade(dummyCandidate)).rejects.toThrow(RiskLimitViolationError);
    expect(circuitBreaker.isTripped()).toBe(true);
  });

  it('blocks execution when market data is stale', () => {
    const staleTimestamp = Date.now() - 25000; // 25s old (max allowed 10s)
    expect(() => marketHealth.assertFreshness(staleTimestamp, 'BinanceBook')).toThrow(StaleDataError);
  });

  it('strictly enforces MARKET order only; rejects any other order type', async () => {
    const invalidOrder: any = {
      symbol: 'BTCUSDT',
      side: 'BUY',
      orderType: 'LIMIT', // Violation!
      quantity: toDecimal('0.01'),
      clientOrderId: 'viol-1',
    };

    await expect(binanceClient.placeMarketOrder(invalidOrder)).rejects.toThrow('Enforcement violation');
    await expect(bybitClient.placeMarketOrder(invalidOrder)).rejects.toThrow('Enforcement violation');
  });

  it('kill switch stops trades immediately and emergency flattens positions', async () => {
    // Open a position on paper binance
    await binanceClient.placeMarketOrder({
      symbol: 'BTCUSDT',
      side: 'BUY',
      orderType: 'MARKET',
      quantity: toDecimal('0.01'),
      clientOrderId: 'open-1',
    });

    const posBefore = await binanceClient.getPositions('BTCUSDT');
    expect(posBefore[0]?.quantity.toString()).toBe('0.01');

    // Activate Kill Switch
    killSwitch.activate('Emergency test halt');
    expect(killSwitch.isEngaged()).toBe(true);

    // Pre-trade validation must now reject
    const dummyCandidate: any = {
      opportunity: { mapping: { normalized_symbol: 'BTC' } },
      sizing: {
        binanceActualNotionalUsd: toDecimal('50'),
        bybitActualNotionalUsd: toDecimal('50'),
      },
    };
    await expect(riskManager.validatePreTrade(dummyCandidate)).rejects.toThrow('Kill switch is engaged');

    // Run emergency flatten
    const flattenRes = await killSwitch.emergencyFlatten();
    expect(flattenRes.flattenedCount).toBeGreaterThan(0);

    // Verify positions are flat
    const posAfter = await binanceClient.getPositions('BTCUSDT');
    expect(posAfter.length === 0 || posAfter[0]?.quantity.isZero() || posAfter[0]?.side === 'FLAT').toBe(true);
  });
});
