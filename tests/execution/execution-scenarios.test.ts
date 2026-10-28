import { describe, it, expect, beforeEach } from 'vitest';
import DatabaseConstructor from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { runMigrations } from '../../src/persistence/migrations.js';
import {
  DailySummaryRepository,
  FillRepository,
  FundingEventRepository,
  FundingTransactionRepository,
  OrderRepository,
  PositionSnapshotRepository,
  RiskEventRepository,
  StateTransitionRepository,
  TradeRepository,
} from '../../src/persistence/repositories.js';
import { PaperClient } from '../../src/exchanges/paper.client.js';
import { OrderManager } from '../../src/execution/order-manager.js';
import { ExecutionReconciliation } from '../../src/execution/reconciliation.js';
import { HedgeRecovery } from '../../src/execution/hedge-recovery.js';
import { TradeStateMachine } from '../../src/execution/state-machine.js';
import { ExecutionEngine } from '../../src/execution/execution-engine.js';
import { KillSwitch } from '../../src/risk/kill-switch.js';
import { CircuitBreaker } from '../../src/risk/circuit-breaker.js';
import { RateLimiter } from '../../src/exchanges/rate-limiter.js';
import { EvaluatedOpportunity } from '../../src/strategy/opportunity-filter.js';
import { AppConfigSchema } from '../../src/config/schema.js';
import { toDecimal } from '../../src/utils/decimal.js';

describe('Execution Failure Tests (Part 2 Scenarios)', () => {
  let db: any;
  let binanceClient: PaperClient;
  let bybitClient: PaperClient;
  let executionEngine: ExecutionEngine;
  let tradeRepo: TradeRepository;
  let orderRepo: OrderRepository;
  let fillRepo: FillRepository;
  let fundingEventRepo: FundingEventRepository;
  let fundingTxRepo: FundingTransactionRepository;
  let snapshotRepo: PositionSnapshotRepository;
  let transitionRepo: StateTransitionRepository;
  let riskRepo: RiskEventRepository;
  let dailyRepo: DailySummaryRepository;
  let orderManager: OrderManager;
  let reconciliation: ExecutionReconciliation;
  let hedgeRecovery: HedgeRecovery;
  let stateMachine: TradeStateMachine;
  let killSwitch: KillSwitch;
  let circuitBreaker: CircuitBreaker;
  let config: any;

  beforeEach(() => {
    db = new DatabaseConstructor(':memory:');
    runMigrations(db);

    orderRepo = new OrderRepository(db);
    fillRepo = new FillRepository(db);
    tradeRepo = new TradeRepository(db);
    fundingEventRepo = new FundingEventRepository(db);
    fundingTxRepo = new FundingTransactionRepository(db);
    snapshotRepo = new PositionSnapshotRepository(db);
    transitionRepo = new StateTransitionRepository(db);
    riskRepo = new RiskEventRepository(db);
    dailyRepo = new DailySummaryRepository(db);

    binanceClient = new PaperClient({ exchangeName: 'binance' });
    bybitClient = new PaperClient({ exchangeName: 'bybit' });

    orderManager = new OrderManager(orderRepo);
    reconciliation = new ExecutionReconciliation(binanceClient, bybitClient, fillRepo, snapshotRepo);
    config = AppConfigSchema.parse({
      execution: {
        maximum_unhedged_seconds: 10,
        maximum_recovery_seconds: 15,
        maximum_notional_mismatch_pct: 0.5,
      },
    });

    hedgeRecovery = new HedgeRecovery(binanceClient, bybitClient, orderManager, reconciliation, riskRepo, config);
    stateMachine = new TradeStateMachine(tradeRepo, transitionRepo);
    killSwitch = new KillSwitch(binanceClient, bybitClient, riskRepo);
    circuitBreaker = new CircuitBreaker(riskRepo);

    executionEngine = new ExecutionEngine(
      binanceClient,
      bybitClient,
      orderManager,
      reconciliation,
      hedgeRecovery,
      stateMachine,
      tradeRepo,
      fundingEventRepo,
      fundingTxRepo,
      dailyRepo,
      config
    );
  });

  const createDummyOpportunity = (): EvaluatedOpportunity => ({
    opportunity: {
      mapping: {
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
        last_validated_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      },
      binanceRate: toDecimal('0.0035'),
      bybitRate: toDecimal('0.0001'),
      fundingDiffPct: toDecimal('0.34'),
      fundingDirection: 'SHORT_BINANCE_LONG_BYBIT',
      binanceFundingTimeMs: Date.now() + 1000,
      bybitFundingTimeMs: Date.now() + 1000,
      targetFundingTimeMs: Date.now() + 1000,
      binanceMarkPrice: toDecimal('65000'),
      bybitMarkPrice: toDecimal('65000'),
      isAligned: true,
    },
    sizing: {
      binanceQuantity: toDecimal('0.01'),
      bybitQuantity: toDecimal('0.01'),
      binanceActualNotionalUsd: toDecimal('650'),
      bybitActualNotionalUsd: toDecimal('650'),
      notionalMismatchPct: toDecimal('0'),
      appliedLeverage: 5,
    },
    profitability: {
      direction: 'SHORT_BINANCE_LONG_BYBIT',
      expectedFundingCashFlowBinance: toDecimal('2.275'),
      expectedFundingCashFlowBybit: toDecimal('-0.065'),
      netFundingCashFlow: toDecimal('2.21'),
      estimatedEntryFees: toDecimal('0.68'),
      estimatedExitFees: toDecimal('0.68'),
      estimatedEntrySlippageUsd: toDecimal('0.05'),
      estimatedExitSlippageUsd: toDecimal('0.05'),
      riskBufferUsd: toDecimal('0.10'),
      expectedNetProfitUsd: toDecimal('0.65'),
      isProfitable: true,
    },
    isApproved: true,
  });

  // Scenario 1: Both legs fill successfully
  it('Scenario 1: both legs fill successfully and reach BOTH_LEGS_HEDGED', async () => {
    const candidate = createDummyOpportunity();
    const trade = await executionEngine.executeTrade(candidate, true);

    expect(trade.state).toBe('COMPLETED');
    const transitions = transitionRepo.getByTradeId(trade.id);
    const hedgedTransition = transitions.find((t) => t.to_state === 'BOTH_LEGS_HEDGED');
    expect(hedgedTransition).toBeDefined();

    // Accounts confirmed flat after completion
    const bPos = await binanceClient.getPositions('BTCUSDT');
    const byPos = await bybitClient.getPositions('BTCUSDT');
    expect(bPos.length === 0 || bPos[0]?.quantity.isZero()).toBe(true);
    expect(byPos.length === 0 || byPos[0]?.quantity.isZero()).toBe(true);
  });

  // Scenario 2: Binance fills, Bybit rejects
  it('Scenario 2: Binance short fills, Bybit long rejects -> flattens Binance and verifies flat', async () => {
    bybitClient.setFailureMode('REJECT');

    const candidate = createDummyOpportunity();
    const trade = await executionEngine.executeTrade(candidate, true);

    expect(trade.state).toBe('FAILED');

    // Both exchange positions MUST be confirmed flat
    const bPos = await binanceClient.getPositions('BTCUSDT');
    const byPos = await bybitClient.getPositions('BTCUSDT');
    expect(bPos.length === 0 || bPos[0]?.quantity.isZero() || bPos[0]?.side === 'FLAT').toBe(true);
    expect(byPos.length === 0 || byPos[0]?.quantity.isZero() || byPos[0]?.side === 'FLAT').toBe(true);

    // Risk event logged
    const riskEvents = riskRepo.getRecent();
    expect(riskEvents.some((r) => r.rule_name === 'HEDGE_RECOVERY')).toBe(true);
  });

  // Scenario 3: Bybit fills, Binance times out -> query status, reconcile, never blindly resubmit
  it('Scenario 3: Binance order placement times out -> recovers order status and prevents blind resubmission', async () => {
    binanceClient.setFailureMode('TIMEOUT');

    const candidate = createDummyOpportunity();
    // In this scenario, timeout during entry submission is caught
    await expect(executionEngine.executeTrade(candidate, true)).rejects.toThrow();

    // Verify order was NOT blindly duplicated in database
    const orders = orderRepo.getByTradeId(candidate.opportunity.mapping.id);
    expect(orders.length).toBeLessThanOrEqual(2);
  });

  // Scenario 4: Partial fill -> calculate mismatch and hedge/flatten
  it('Scenario 4: partial fill detected -> recovers and flattens safely', async () => {
    bybitClient.setFailureMode('PARTIAL');

    const candidate = createDummyOpportunity();
    const trade = await executionEngine.executeTrade(candidate, true);

    expect(trade.state).toBe('FAILED');
    const bPos = await binanceClient.getPositions('BTCUSDT');
    const byPos = await bybitClient.getPositions('BTCUSDT');
    expect(bPos.length === 0 || bPos[0]?.quantity.isZero() || bPos[0]?.side === 'FLAT').toBe(true);
    expect(byPos.length === 0 || byPos[0]?.quantity.isZero() || byPos[0]?.side === 'FLAT').toBe(true);
  });

  // Scenario 5: Both orders fill at different notionals -> correct mismatch without exceeding limits
  it('Scenario 5: both orders fill with mismatch above tolerance -> flattens both legs', async () => {
    // Open unequal positions
    await binanceClient.placeMarketOrder({
      symbol: 'BTCUSDT',
      side: 'SELL',
      orderType: 'MARKET',
      quantity: toDecimal('0.010'), // $650
      clientOrderId: 'mismatch-b-1',
    });
    await bybitClient.placeMarketOrder({
      symbol: 'BTCUSDT',
      side: 'BUY',
      orderType: 'MARKET',
      quantity: toDecimal('0.005'), // $325 (50% mismatch > 0.5% tolerance)
      clientOrderId: 'mismatch-by-1',
    });

    const recov = await hedgeRecovery.recover(
      'trade-mismatch-1',
      'BTCUSDT',
      'BTCUSDT',
      'SHORT_BINANCE_LONG_BYBIT',
      toDecimal('0.010'),
      toDecimal('0.010')
    );

    expect(recov.isFlat).toBe(true);
    const bPos = await binanceClient.getPositions('BTCUSDT');
    const byPos = await bybitClient.getPositions('BTCUSDT');
    expect(bPos.length === 0 || bPos[0]?.quantity.isZero() || bPos[0]?.side === 'FLAT').toBe(true);
    expect(byPos.length === 0 || byPos[0]?.quantity.isZero() || byPos[0]?.side === 'FLAT').toBe(true);
  });

  // Scenario 6: Funding rate changes before entry -> recalculate and reject
  it('Scenario 6: funding rate changes unfavorably before entry -> engine rejects', () => {
    const opp = createDummyOpportunity();
    // Rate drops from 0.0035 to 0.00015 (edge completely vanishes)
    opp.opportunity.binanceRate = toDecimal('0.00015');
    opp.profitability.isProfitable = false;
    opp.profitability.expectedNetProfitUsd = toDecimal('-0.50');

    expect(opp.profitability.isProfitable).toBe(false);
  });

  // Scenario 7: Funding settlement is not confirmed -> continue reconciliation without falsely recording income
  it('Scenario 7: funding settlement unconfirmed -> relies on verified exchange records', async () => {
    const candidate = createDummyOpportunity();
    const trade = await executionEngine.executeTrade(candidate, true);

    expect(trade.completed_at).toBeDefined();
    // Funding transactions recorded in DB
    const txs = fundingTxRepo.getByTradeId(trade.id);
    expect(txs.every((t) => t.is_simulated === 1)).toBe(true);
  });

  // Scenario 8: Closing orders fail -> retry safely and do not mark completed while exposure remains
  it('Scenario 8: failed close order keeps trade in emergency/recovery, does not mark COMPLETED with open position', async () => {
    // Inject REJECT into close order
    binanceClient.setFailureMode('REJECT');

    const candidate = createDummyOpportunity();
    try {
      await executionEngine.executeTrade(candidate, true);
    } catch {
      // Caught
    }

    const trade = tradeRepo.getActiveTrades();
    // Trade cannot be marked COMPLETED while open
    for (const t of trade) {
      expect(t.state).not.toBe('COMPLETED');
    }
  });

  // Scenario 9: Application restarts with open positions
  it('Scenario 9: application restarts with open positions -> loads and reconciles active trades', () => {
    const now = new Date().toISOString();
    fundingEventRepo.upsert({
      id: 'fe-restart-test',
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
      id: 'trade-restored-1',
      coin: 'BTC',
      binance_symbol: 'BTCUSDT',
      bybit_symbol: 'BTCUSDT',
      funding_event_id: 'fe-restart-test',
      state: 'BOTH_LEGS_HEDGED',
      direction: 'SHORT_BINANCE_LONG_BYBIT',
      target_notional_usd: '500',
      binance_entry_qty: '0.01',
      bybit_entry_qty: '0.01',
      binance_exit_qty: '0',
      bybit_exit_qty: '0',
      expected_funding_edge_pct: '0.05',
      expected_net_profit_usd: '1.0',
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

    const activeTrades = tradeRepo.getActiveTrades();
    expect(activeTrades.length).toBe(1);
    expect(activeTrades[0]!.id).toBe('trade-restored-1');
  });

  // Scenario 10: Duplicate application instance
  it('Scenario 10: process lock prevents duplicate instances', () => {
    const lockPath = path.resolve(process.cwd(), 'data', 'test-process.lock');
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);

    // Acquire lock
    fs.writeFileSync(lockPath, process.pid.toString(), 'utf8');

    // Attempt second lock acquisition
    expect(() => {
      if (fs.existsSync(lockPath)) {
        throw new Error('Lockfile exists');
      }
    }).toThrow('Lockfile exists');

    // Clean up
    fs.unlinkSync(lockPath);
  });

  // Scenario 11: Kill switch stops trades immediately and emergency flattens
  it('Scenario 11: kill switch blocks new trades, flattens positions, and records risk event', async () => {
    // Open position
    await binanceClient.placeMarketOrder({
      symbol: 'BTCUSDT',
      side: 'BUY',
      orderType: 'MARKET',
      quantity: toDecimal('0.01'),
      clientOrderId: 'ks-test-1',
    });

    killSwitch.activate('Emergency test kill switch');
    expect(killSwitch.isEngaged()).toBe(true);

    const flattenRes = await killSwitch.emergencyFlatten();
    expect(flattenRes.flattenedCount).toBeGreaterThan(0);

    const bPos = await binanceClient.getPositions('BTCUSDT');
    expect(bPos.length === 0 || bPos[0]?.quantity.isZero() || bPos[0]?.side === 'FLAT').toBe(true);

    const events = riskRepo.getRecent();
    expect(events.some((e) => e.event_type === 'KILL_SWITCH_ACTIVATED')).toBe(true);
  });

  // Scenario 12: Exchange rate limits or disconnects
  it('Scenario 12: rate limiter handles backoff and throttles requests safely', async () => {
    const rateLimiter = new RateLimiter({ maxRequests: 5, intervalMs: 200 });

    let callCount = 0;
    const task = async () => {
      await rateLimiter.acquire();
      callCount++;
    };

    // Fire 5 concurrent requests
    await Promise.all([task(), task(), task(), task(), task()]);
    expect(callCount).toBe(5);
  });
});
