import { describe, it, expect, beforeEach } from 'vitest';
import DatabaseConstructor from 'better-sqlite3';
import { runMigrations } from '../../src/persistence/migrations.js';
import { FundingEventRepository, StateTransitionRepository, TradeRepository } from '../../src/persistence/repositories.js';
import { TradeStateMachine } from '../../src/execution/state-machine.js';
import { StateMachineError } from '../../src/utils/errors.js';

describe('TradeStateMachine', () => {
  let db: any;
  let tradeRepo: TradeRepository;
  let fundingEventRepo: FundingEventRepository;
  let transitionRepo: StateTransitionRepository;
  let stateMachine: TradeStateMachine;

  beforeEach(() => {
    db = new DatabaseConstructor(':memory:');
    runMigrations(db);
    tradeRepo = new TradeRepository(db);
    fundingEventRepo = new FundingEventRepository(db);
    transitionRepo = new StateTransitionRepository(db);
    stateMachine = new TradeStateMachine(tradeRepo, transitionRepo);
  });

  it('allows valid sequential transitions', () => {
    const now = new Date().toISOString();

    // Satisfy foreign key constraint
    fundingEventRepo.upsert({
      id: 'fe-1',
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
      id: 'test-trade-1',
      coin: 'BTC',
      binance_symbol: 'BTCUSDT',
      bybit_symbol: 'BTCUSDT',
      funding_event_id: 'fe-1',
      state: 'IDLE',
      direction: 'SHORT_BINANCE_LONG_BYBIT',
      target_notional_usd: '100',
      binance_entry_qty: '0.001',
      bybit_entry_qty: '0.001',
      binance_exit_qty: '0',
      bybit_exit_qty: '0',
      expected_funding_edge_pct: '0.05',
      expected_net_profit_usd: '0.5',
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

    // IDLE -> SCANNING -> OPPORTUNITY_VALIDATED -> RISK_APPROVED -> EXECUTION_INTENT_SAVED
    let state = stateMachine.transition('test-trade-1', 'IDLE', 'SCANNING', 'Scan started');
    expect(state).toBe('SCANNING');

    state = stateMachine.transition('test-trade-1', state, 'OPPORTUNITY_VALIDATED', 'Opp validated');
    expect(state).toBe('OPPORTUNITY_VALIDATED');

    state = stateMachine.transition('test-trade-1', state, 'RISK_APPROVED', 'Risk passed');
    expect(state).toBe('RISK_APPROVED');

    state = stateMachine.transition('test-trade-1', state, 'EXECUTION_INTENT_SAVED', 'Intent saved');
    expect(state).toBe('EXECUTION_INTENT_SAVED');

    // Verify DB updated
    const updated = tradeRepo.getById('test-trade-1');
    expect(updated?.state).toBe('EXECUTION_INTENT_SAVED');

    // Verify transition logs
    const history = transitionRepo.getByTradeId('test-trade-1');
    expect(history.length).toBe(4);
  });

  it('rejects illegal state transitions', () => {
    expect(() =>
      stateMachine.transition('test-trade-1', 'IDLE', 'COMPLETED', 'Illegal jump')
    ).toThrow(StateMachineError);
  });

  it('permits idempotent transitions without duplicate recording', () => {
    const s = stateMachine.transition('test-trade-1', 'IDLE', 'IDLE', 'No-op');
    expect(s).toBe('IDLE');
  });
});
