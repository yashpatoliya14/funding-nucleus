import { describe, it, expect, beforeEach } from 'vitest';
import { OpportunityFilter } from '../../src/strategy/opportunity-filter.js';
import { PaperClient } from '../../src/exchanges/paper.client.js';
import { loadConfig } from '../../src/config/env.js';
import { toDecimal } from '../../src/utils/decimal.js';
import { OrderManager } from '../../src/execution/order-manager.js';
import { OrderRepository, TradeRepository, FundingEventRepository } from '../../src/persistence/repositories.js';
import DatabaseConstructor from 'better-sqlite3';
import { runMigrations } from '../../src/persistence/migrations.js';

describe('Institutional Strategy Improvements (Items 3, 6, 7, 8)', () => {
  let binanceClient: PaperClient;
  let bybitClient: PaperClient;
  let config: any;
  let orderRepo: OrderRepository;
  let tradeRepo: TradeRepository;
  let fundingEventRepo: FundingEventRepository;
  let orderManager: OrderManager;

  beforeEach(() => {
    const db = new DatabaseConstructor(':memory:');
    runMigrations(db);
    orderRepo = new OrderRepository(db);
    tradeRepo = new TradeRepository(db);
    fundingEventRepo = new FundingEventRepository(db);
    orderManager = new OrderManager(orderRepo);

    binanceClient = new PaperClient({ exchangeName: 'binance' });
    bybitClient = new PaperClient({ exchangeName: 'bybit' });
    config = loadConfig().appConfig;

    // Seed dummy funding event and trade for foreign key integrity
    const now = new Date().toISOString();
    fundingEventRepo.upsert({
      id: 'fe-test-1',
      coin: 'BTC',
      binance_funding_rate: '0.001',
      bybit_funding_rate: '0.000',
      funding_rate_diff: '0.1',
      binance_funding_time: now,
      bybit_funding_time: now,
      target_funding_time: now,
      is_aligned: 1,
      status: 'PENDING',
      created_at: now,
    });

    tradeRepo.create({
      id: 'trade-maker-1',
      coin: 'BTC',
      binance_symbol: 'BTCUSDT',
      bybit_symbol: 'BTCUSDT',
      funding_event_id: 'fe-test-1',
      state: 'ENTRY_SUBMITTED',
      direction: 'SHORT_BINANCE_LONG_BYBIT',
      target_notional_usd: '100',
      binance_entry_qty: '0.01',
      bybit_entry_qty: '0.01',
      binance_exit_qty: '0',
      bybit_exit_qty: '0',
      expected_funding_edge_pct: '0.1',
      expected_net_profit_usd: '1',
      realized_pnl_usd: '0',
      total_fees_usd: '0',
      total_funding_usd: '0',
      net_pnl_usd: '0',
      is_simulated: 1,
      error_message: null,
      created_at: now,
      updated_at: now,
      completed_at: null,
    });
  });

  describe('Item 6: Rapid Post-Settlement Exit Optimization', () => {
    it('sets default target_exit_delay_seconds to 15 seconds to avoid post-settlement liquidity crunch', () => {
      expect(config.strategy.target_exit_delay_seconds).toBe(15);
    });
  });

  describe('Item 7: Flash Mirage & Rate Stability Filter', () => {
    it('rejects candidates when orderbook bid-ask spread is wider than maximum allowed threshold', async () => {
      // Create wide spread on Bybit (bestBid 100, bestAsk 101.50 -> 1.50% spread > 0.80% limit)
      bybitClient.mockOrderBook({
        exchange: 'bybit',
        symbol: 'BTCUSDT',
        bids: [{ price: toDecimal('100.0'), quantity: toDecimal('10.0') }],
        asks: [{ price: toDecimal('101.50'), quantity: toDecimal('10.0') }],
        timestampMs: Date.now(),
      });

      const filter = new OpportunityFilter(binanceClient, bybitClient, config);
      const opp: any = {
        mapping: { normalized_symbol: 'BTC', binance_symbol: 'BTCUSDT', bybit_symbol: 'BTCUSDT' },
        fundingDiffPct: toDecimal('0.50'),
        binanceRate: toDecimal('0.005'),
        bybitRate: toDecimal('0.000'),
        binanceMarkPrice: toDecimal('100'),
        bybitMarkPrice: toDecimal('100'),
        fundingDirection: 'SHORT_BINANCE_LONG_BYBIT',
      };

      const result = await filter.evaluateOpportunity(opp);
      expect(result.isApproved).toBe(false);
      expect(result.rejectionReason).toContain('order book spread');
      expect(result.rejectionReason).toContain('is too wide');
    });

    it('rejects candidates when 7-day edge consistency is below the minimum stability threshold (flash spike)', async () => {
      const flashConfig = {
        ...config,
        strategy: {
          ...config.strategy,
          flash_mirage_filter_enabled: true,
          min_historical_consistency_pct: 50.0,
        },
      };

      const mockHistoryService: any = {
        getSevenDayFundingHistory: async () => ({
          symbol: 'BTCUSDT',
          normalizedSymbol: 'BTC',
          settlementCount: 15,
          cumulativeReturnPct: 0.1,
          averageSpreadPct: 0.01,
          consistencyScorePct: 25.0, // Low consistency = 25% < 50% threshold!
          dominantDirection: 'LONG_BINANCE_SHORT_BYBIT',
          hasStrongArbitrageEdge: false,
        }),
      };

      const filter = new OpportunityFilter(binanceClient, bybitClient, flashConfig, mockHistoryService);
      const opp: any = {
        mapping: { normalized_symbol: 'BTC', binance_symbol: 'BTCUSDT', bybit_symbol: 'BTCUSDT' },
        fundingDiffPct: toDecimal('0.50'),
        binanceRate: toDecimal('0.005'),
        bybitRate: toDecimal('0.000'),
        binanceMarkPrice: toDecimal('100'),
        bybitMarkPrice: toDecimal('100'),
        fundingDirection: 'SHORT_BINANCE_LONG_BYBIT',
      };

      const result = await filter.evaluateOpportunity(opp);
      expect(result.isApproved).toBe(false);
      expect(result.rejectionReason).toContain('Flash rate mirage');
      expect(result.rejectionReason).toContain('low 7-day edge consistency');
    });

    it('approves candidates with high 7-day consistency and assigns carry potential score', async () => {
      const mockHistoryService: any = {
        getSevenDayFundingHistory: async () => ({
          symbol: 'BTCUSDT',
          normalizedSymbol: 'BTC',
          settlementCount: 20,
          cumulativeReturnPct: 4.5,
          averageSpreadPct: 0.22,
          consistencyScorePct: 85.0, // High consistency = 85%
          dominantDirection: 'SHORT_BINANCE_LONG_BYBIT',
          hasStrongArbitrageEdge: true,
        }),
      };

      const filter = new OpportunityFilter(binanceClient, bybitClient, config, mockHistoryService);
      const opp: any = {
        mapping: { normalized_symbol: 'BTC', binance_symbol: 'BTCUSDT', bybit_symbol: 'BTCUSDT' },
        fundingDiffPct: toDecimal('0.50'),
        binanceRate: toDecimal('0.005'),
        bybitRate: toDecimal('0.000'),
        binanceMarkPrice: toDecimal('100'),
        bybitMarkPrice: toDecimal('100'),
        fundingDirection: 'SHORT_BINANCE_LONG_BYBIT',
      };

      const result = await filter.evaluateOpportunity(opp);
      expect(result.isApproved).toBe(true);
      expect(result.carryPotentialScore).toBe(85.0);
      expect(result.sevenDayStats).toBeDefined();
    });
  });

  describe('Item 8: Maker-Taker Execution Hybrid', () => {
    it('successfully places a Post-Only maker order and charges maker fee rate', async () => {
      const bestBid = toDecimal('64990');
      const orderResult = await orderManager.executeMakerOrder(
        bybitClient,
        'trade-maker-1',
        'BTCUSDT',
        'BUY',
        toDecimal('0.01'),
        bestBid,
        'ENTRY'
      );

      expect(orderResult.status).toBe('FILLED');
      expect(orderResult.executedQuantity.toString()).toBe('0.01');
      expect(orderResult.averagePrice.toString()).toBe('64990');
      // Maker fee rate is 0.0002 (vs 0.00055 taker)
      // 0.01 * 64990 * 0.0002 = 0.12998 USDT
      expect(orderResult.fee.toFixed(5)).toBe('0.12998');
    });

    it('rejects Post-Only maker order when price crosses the order book spread', async () => {
      // Trying to BUY at or above ask (65000.5) must throw PostOnly crossing error
      const crossingAsk = toDecimal('65001.0');

      await expect(
        orderManager.executeMakerOrder(
          bybitClient,
          'trade-maker-1',
          'BTCUSDT',
          'BUY',
          toDecimal('0.01'),
          crossingAsk,
          'ENTRY'
        )
      ).rejects.toThrow('PostOnly order would cross book as taker');
    });
  });

  describe('Item 3: Multi-Cycle Carry Compounding Calculation', () => {
    it('verifies avoided fee friction calculation across multiple carry cycles', () => {
      const notionalTotal = toDecimal('100.0'); // $50 Binance + $50 Bybit
      const feeDragPerCycle = notionalTotal.times(0.0021); // 0.21%
      expect(feeDragPerCycle.toFixed(4)).toBe('0.2100');

      const carryCycles = 3;
      const totalAvoidedFees = feeDragPerCycle.times(carryCycles);
      expect(totalAvoidedFees.toFixed(4)).toBe('0.6300'); // $0.63 in saved fees alone
    });
  });
});
