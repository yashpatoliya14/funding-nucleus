import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import DatabaseConstructor from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { runMigrations } from '../../src/persistence/migrations.js';
import {
  FillRepository,
  FundingEventRepository,
  FundingTransactionRepository,
  OrderRepository,
  PositionSnapshotRepository,
  StateTransitionRepository,
  TradeRepository,
} from '../../src/persistence/repositories.js';
import { displayLastTrades } from '../../src/scripts/last-trades.js';

describe('Integration Tests: Last Trades CLI Tool', () => {
  const testDbDir = path.resolve(process.cwd(), 'data');
  const testDbPath = path.resolve(testDbDir, 'test-last-trades.sqlite');
  let db: any;
  let logSpy: any;
  let errorSpy: any;

  beforeEach(() => {
    if (!fs.existsSync(testDbDir)) {
      fs.mkdirSync(testDbDir, { recursive: true });
    }
    if (fs.existsSync(testDbPath)) {
      try {
        fs.unlinkSync(testDbPath);
      } catch {}
    }

    db = new DatabaseConstructor(testDbPath);
    runMigrations(db);

    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    if (db) {
      try {
        db.close();
      } catch {}
    }
    if (fs.existsSync(testDbPath)) {
      try {
        fs.unlinkSync(testDbPath);
      } catch {}
    }
  });

  it('handles empty database gracefully without throwing', () => {
    db.close();
    displayLastTrades({
      limit: 10,
      format: 'table',
      dbPath: testDbPath,
    });

    const calls = logSpy.mock.calls.map((c: any) => c.join(' ')).join('\n');
    expect(calls).toContain('No trades found');
  });

  it('displays table and correct summary when populated with test trades', () => {
    const tradeRepo = new TradeRepository(db);
    const fundingRepo = new FundingEventRepository(db);
    const now = new Date().toISOString();

    // Populate 3 trades: 2 COMPLETED, 1 FAILED
    fundingRepo.upsert({
      id: 'fe-btc-101',
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
      id: 'trade-1042',
      coin: 'BTCUSDT',
      binance_symbol: 'BTCUSDT',
      bybit_symbol: 'BTCUSDT',
      funding_event_id: 'fe-btc-101',
      state: 'COMPLETED',
      direction: 'SHORT_BINANCE_LONG_BYBIT',
      target_notional_usd: '100',
      binance_entry_qty: '0.001',
      bybit_entry_qty: '0.001',
      binance_exit_qty: '0.001',
      bybit_exit_qty: '0.001',
      expected_funding_edge_pct: '0.05',
      expected_net_profit_usd: '0.42',
      realized_pnl_usd: '0',
      total_fees_usd: '0.10',
      total_funding_usd: '0.52',
      net_pnl_usd: '0.42',
      is_simulated: 1,
      error_message: null,
      created_at: now,
      updated_at: now,
      completed_at: now,
    });

    tradeRepo.create({
      id: 'trade-1041',
      coin: 'ETHUSDT',
      binance_symbol: 'ETHUSDT',
      bybit_symbol: 'ETHUSDT',
      funding_event_id: 'fe-btc-101',
      state: 'COMPLETED',
      direction: 'LONG_BINANCE_SHORT_BYBIT',
      target_notional_usd: '100',
      binance_entry_qty: '0.02',
      bybit_entry_qty: '0.02',
      binance_exit_qty: '0.02',
      bybit_exit_qty: '0.02',
      expected_funding_edge_pct: '0.04',
      expected_net_profit_usd: '0.30',
      realized_pnl_usd: '0',
      total_fees_usd: '0.12',
      total_funding_usd: '0.40',
      net_pnl_usd: '0.28',
      is_simulated: 1,
      error_message: null,
      created_at: now,
      updated_at: now,
      completed_at: now,
    });

    tradeRepo.create({
      id: 'trade-1040',
      coin: 'SOLUSDT',
      binance_symbol: 'SOLUSDT',
      bybit_symbol: 'SOLUSDT',
      funding_event_id: 'fe-btc-101',
      state: 'FAILED',
      direction: 'SHORT_BINANCE_LONG_BYBIT',
      target_notional_usd: '100',
      binance_entry_qty: '0.5',
      bybit_entry_qty: '0.5',
      binance_exit_qty: '0.5',
      bybit_exit_qty: '0.5',
      expected_funding_edge_pct: '0.05',
      expected_net_profit_usd: '0.35',
      realized_pnl_usd: '0',
      total_fees_usd: '0.02',
      total_funding_usd: '0',
      net_pnl_usd: '-0.02',
      is_simulated: 1,
      error_message: 'Bybit rejected entry order; flattened safely',
      created_at: now,
      updated_at: now,
      completed_at: now,
    });

    // Close db handle so displayLastTrades can read it cleanly
    db.close();

    displayLastTrades({
      limit: 10,
      format: 'table',
      dbPath: testDbPath,
    });

    const output = logSpy.mock.calls.map((c: any) => c.join(' ')).join('\n');
    expect(output).toContain('LAST 3 FUNDING ARBITRAGE TRADES');
    expect(output).toContain('BTCUSDT');
    expect(output).toContain('ETHUSDT');
    expect(output).toContain('SOLUSDT');
    expect(output).toContain('Completed:                          2');
    expect(output).toContain('Failed:                             1');
  });

  it('outputs JSON array when --format json is specified', () => {
    db.close();
    displayLastTrades({
      limit: 5,
      format: 'json',
      dbPath: testDbPath,
    });

    const output = logSpy.mock.calls.map((c: any) => c.join(' ')).join('\n');
    expect(() => JSON.parse(output)).not.toThrow();
  });

  it('inspects detailed trade records with state transitions and orders when --id is specified', () => {
    const tradeRepo = new TradeRepository(db);
    const fundingRepo = new FundingEventRepository(db);
    const orderRepo = new OrderRepository(db);
    const transitionRepo = new StateTransitionRepository(db);
    const now = new Date().toISOString();

    fundingRepo.upsert({
      id: 'fe-detail-1',
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
      id: 'trade-detail-123',
      coin: 'BTCUSDT',
      binance_symbol: 'BTCUSDT',
      bybit_symbol: 'BTCUSDT',
      funding_event_id: 'fe-detail-1',
      state: 'COMPLETED',
      direction: 'SHORT_BINANCE_LONG_BYBIT',
      target_notional_usd: '500',
      binance_entry_qty: '0.01',
      bybit_entry_qty: '0.01',
      binance_exit_qty: '0.01',
      bybit_exit_qty: '0.01',
      expected_funding_edge_pct: '0.05',
      expected_net_profit_usd: '1.20',
      realized_pnl_usd: '0',
      total_fees_usd: '0.20',
      total_funding_usd: '1.40',
      net_pnl_usd: '1.20',
      is_simulated: 1,
      error_message: null,
      created_at: now,
      updated_at: now,
      completed_at: now,
    });

    orderRepo.create({
      id: 'ord-det-1',
      trade_id: 'trade-detail-123',
      exchange: 'binance',
      client_order_id: 'arb_bi_det_1',
      exchange_order_id: 'ex-ord-999',
      symbol: 'BTCUSDT',
      side: 'SELL',
      order_type: 'MARKET',
      requested_quantity: '0.01',
      executed_quantity: '0.01',
      average_price: '65000',
      status: 'FILLED',
      is_reduce_only: 0,
      is_recovery: 0,
      purpose: 'ENTRY',
      error_message: null,
      created_at: now,
      updated_at: now,
    });

    transitionRepo.record({
      id: 'st-det-1',
      trade_id: 'trade-detail-123',
      from_state: 'ENTRY_SUBMITTED',
      to_state: 'BOTH_LEGS_HEDGED',
      reason: 'Both orders executed cleanly',
      metadata: null,
      timestamp: now,
    });

    db.close();

    displayLastTrades({
      limit: 10,
      tradeId: 'trade-detail-123',
      format: 'table',
      dbPath: testDbPath,
    });

    const output = logSpy.mock.calls.map((c: any) => c.join(' ')).join('\n');
    expect(output).toContain('TRADE AUDIT INSPECTION — ID: trade-detail-123');
    expect(output).toContain('BOTH_LEGS_HEDGED');
    expect(output).toContain('arb_bi_det_1');
  });
});
