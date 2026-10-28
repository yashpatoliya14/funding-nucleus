import { describe, it, expect, beforeEach } from 'vitest';
import DatabaseConstructor from 'better-sqlite3';
import { runMigrations } from '../../src/persistence/migrations.js';
import {
  DailySummaryRepository,
  FillRepository,
  FundingEventRepository,
  FundingTransactionRepository,
  OrderRepository,
  StateTransitionRepository,
  TradeRepository,
} from '../../src/persistence/repositories.js';
import { toDecimal } from '../../src/utils/decimal.js';

describe('Unit Tests: SQLite Persistence & Recovery', () => {
  let db: any;
  let tradeRepo: TradeRepository;
  let orderRepo: OrderRepository;
  let fillRepo: FillRepository;
  let fundingRepo: FundingEventRepository;
  let fundingTxRepo: FundingTransactionRepository;
  let transitionRepo: StateTransitionRepository;
  let dailyRepo: DailySummaryRepository;

  beforeEach(() => {
    db = new DatabaseConstructor(':memory:');
    runMigrations(db);
    tradeRepo = new TradeRepository(db);
    orderRepo = new OrderRepository(db);
    fillRepo = new FillRepository(db);
    fundingRepo = new FundingEventRepository(db);
    fundingTxRepo = new FundingTransactionRepository(db);
    transitionRepo = new StateTransitionRepository(db);
    dailyRepo = new DailySummaryRepository(db);

    const now = new Date().toISOString();
    // Default parent records for foreign key integrity
    fundingRepo.upsert({
      id: 'fe-btc-1',
      coin: 'BTC',
      binance_funding_rate: '0.0003',
      bybit_funding_rate: '0.0001',
      funding_rate_diff: '0.0002',
      binance_funding_time: now,
      bybit_funding_time: now,
      target_funding_time: now,
      is_aligned: 1,
      status: 'TRADED',
      created_at: now,
    });

    tradeRepo.create({
      id: 'trade-uuid-1',
      coin: 'BTC',
      binance_symbol: 'BTCUSDT',
      bybit_symbol: 'BTCUSDT',
      funding_event_id: 'fe-btc-1',
      state: 'BOTH_LEGS_HEDGED',
      direction: 'SHORT_BINANCE_LONG_BYBIT',
      target_notional_usd: '1000.50',
      binance_entry_qty: '0.015',
      bybit_entry_qty: '0.015',
      binance_exit_qty: '0',
      bybit_exit_qty: '0',
      expected_funding_edge_pct: '0.02',
      expected_net_profit_usd: '0.85',
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

  it('preserves exact string-serialized decimal precision in daily summaries', () => {
    dailyRepo.getOrCreateToday();

    // Add $0.123456789012345678 trading PnL
    const precisePnl = toDecimal('0.123456789012345678');
    dailyRepo.addTradeResult(precisePnl, toDecimal('0.5'), toDecimal('0.05'));

    const today = dailyRepo.getOrCreateToday();
    expect(today.total_trading_pnl_usd).toBe('0.123456789012345678');
    expect(today.trade_count).toBe(1);
  });

  it('saves and retrieves a trade record with exact decimal representation', () => {
    const retrieved = tradeRepo.getById('trade-uuid-1');
    expect(retrieved).toBeDefined();
    expect(retrieved?.coin).toBe('BTC');
    expect(retrieved?.target_notional_usd).toBe('1000.50');
  });

  it('saves exchange order IDs and updates execution status', () => {
    const now = new Date().toISOString();
    orderRepo.create({
      id: 'ord-1',
      trade_id: 'trade-uuid-1',
      exchange: 'binance',
      client_order_id: 'arb_bi_test_1',
      exchange_order_id: null,
      symbol: 'BTCUSDT',
      side: 'SELL',
      order_type: 'MARKET',
      requested_quantity: '0.015',
      executed_quantity: '0',
      average_price: '0',
      status: 'PENDING',
      is_reduce_only: 0,
      is_recovery: 0,
      purpose: 'ENTRY',
      error_message: null,
      created_at: now,
      updated_at: now,
    });

    orderRepo.update({
      id: 'ord-1',
      exchange_order_id: 'binance-order-998877',
      status: 'FILLED',
      executed_quantity: '0.015',
      average_price: '65000.50',
    });

    const ord = orderRepo.getByClientOrderId('arb_bi_test_1');
    expect(ord?.status).toBe('FILLED');
    expect(ord?.exchange_order_id).toBe('binance-order-998877');
    expect(ord?.average_price).toBe('65000.50');
  });

  it('records partial fills and actual fee transactions', () => {
    const now = new Date().toISOString();
    orderRepo.create({
      id: 'ord-1',
      trade_id: 'trade-uuid-1',
      exchange: 'binance',
      client_order_id: 'arb_bi_test_1',
      exchange_order_id: null,
      symbol: 'BTCUSDT',
      side: 'SELL',
      order_type: 'MARKET',
      requested_quantity: '0.015',
      executed_quantity: '0',
      average_price: '0',
      status: 'PENDING',
      is_reduce_only: 0,
      is_recovery: 0,
      purpose: 'ENTRY',
      error_message: null,
      created_at: now,
      updated_at: now,
    });

    fillRepo.create({
      id: 'fill-1',
      order_id: 'arb_bi_test_1',
      trade_id: 'trade-uuid-1',
      exchange: 'binance',
      exchange_execution_id: 'exec-12345',
      price: '65000',
      quantity: '0.0075', // 50% partial fill
      fee: '0.24375',
      fee_currency: 'USDT',
      timestamp: now,
    });

    const fills = fillRepo.getByTradeId('trade-uuid-1');
    expect(fills.length).toBe(1);
    expect(fills[0]!.quantity).toBe('0.0075');
    expect(fills[0]!.fee).toBe('0.24375');
  });

  it('persists state transition audit trail', () => {
    const now = new Date().toISOString();
    transitionRepo.record({
      id: 'st-1',
      trade_id: 'trade-uuid-1',
      from_state: 'IDLE',
      to_state: 'SCANNING',
      reason: 'Opportunity evaluation initiated',
      metadata: JSON.stringify({ edge: '0.05%' }),
      timestamp: now,
    });

    const history = transitionRepo.getByTradeId('trade-uuid-1');
    expect(history.length).toBe(1);
    expect(history[0]!.from_state).toBe('IDLE');
    expect(history[0]!.to_state).toBe('SCANNING');
  });

  it('rolls back database transaction on failure', () => {
    try {
      db.transaction(() => {
        db.prepare(`
          INSERT INTO daily_summaries (date, trade_count, total_trading_pnl_usd, total_funding_pnl_usd, total_fees_usd, net_pnl_usd, loss_limit_hit, created_at, updated_at)
          VALUES ('2026-10-29', 5, '0', '0', '0', '0', 0, '2026-10-29T00:00:00Z', '2026-10-29T00:00:00Z')
        `).run();
        throw new Error('Intentional crash inside transaction');
      })();
    } catch {
      // Caught
    }

    const row = db.prepare(`SELECT * FROM daily_summaries WHERE date = '2026-10-29'`).get();
    expect(row).toBeUndefined(); // Rolled back!
  });

  it('restores active trades correctly across restarts', () => {
    const tradeRepo2 = new TradeRepository(db);
    const activeTradesAfterRestart = tradeRepo2.getActiveTrades();
    expect(activeTradesAfterRestart.length).toBe(1);
    expect(activeTradesAfterRestart[0]!.id).toBe('trade-uuid-1');
    expect(activeTradesAfterRestart[0]!.state).toBe('BOTH_LEGS_HEDGED');

    tradeRepo2.update({ id: 'trade-uuid-1', state: 'COMPLETED' });
    const remaining = tradeRepo2.getActiveTrades();
    expect(remaining.length).toBe(0);
  });
});
