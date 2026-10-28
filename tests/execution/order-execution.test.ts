import { describe, it, expect, beforeEach } from 'vitest';
import DatabaseConstructor from 'better-sqlite3';
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
import { EvaluatedOpportunity } from '../../src/strategy/opportunity-filter.js';
import { AppConfigSchema } from '../../src/config/schema.js';
import { toDecimal } from '../../src/utils/decimal.js';

describe('ExecutionEngine Full Lifecycle', () => {
  let db: any;
  let binanceClient: PaperClient;
  let bybitClient: PaperClient;
  let executionEngine: ExecutionEngine;
  let tradeRepo: TradeRepository;

  beforeEach(() => {
    db = new DatabaseConstructor(':memory:');
    runMigrations(db);

    const orderRepo = new OrderRepository(db);
    const fillRepo = new FillRepository(db);
    tradeRepo = new TradeRepository(db);
    const fundingEventRepo = new FundingEventRepository(db);
    const fundingTxRepo = new FundingTransactionRepository(db);
    const snapshotRepo = new PositionSnapshotRepository(db);
    const transitionRepo = new StateTransitionRepository(db);
    const riskRepo = new RiskEventRepository(db);
    const dailyRepo = new DailySummaryRepository(db);

    binanceClient = new PaperClient({ exchangeName: 'binance' });
    bybitClient = new PaperClient({ exchangeName: 'bybit' });

    const orderManager = new OrderManager(orderRepo);
    const reconciliation = new ExecutionReconciliation(binanceClient, bybitClient, fillRepo, snapshotRepo);
    const config = AppConfigSchema.parse({});
    const hedgeRecovery = new HedgeRecovery(binanceClient, bybitClient, orderManager, reconciliation, riskRepo, config);
    const stateMachine = new TradeStateMachine(tradeRepo, transitionRepo);

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

  it('successfully completes both entry and exit when both legs fill', async () => {
    const candidate: EvaluatedOpportunity = {
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
        binanceRate: toDecimal('0.0003'),
        bybitRate: toDecimal('0.0001'),
        fundingDiffPct: toDecimal('0.02'),
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
        expectedFundingCashFlowBinance: toDecimal('0.195'),
        expectedFundingCashFlowBybit: toDecimal('-0.065'),
        netFundingCashFlow: toDecimal('0.13'),
        estimatedEntryFees: toDecimal('0.068'),
        estimatedExitFees: toDecimal('0.068'),
        estimatedEntrySlippageUsd: toDecimal('0.01'),
        estimatedExitSlippageUsd: toDecimal('0.01'),
        riskBufferUsd: toDecimal('0.10'),
        expectedNetProfitUsd: toDecimal('0.55'),
        isProfitable: true,
      },
      isApproved: true,
    };

    const finishedTrade = await executionEngine.executeTrade(candidate, true);

    expect(finishedTrade.state).toBe('COMPLETED');
    expect(finishedTrade.completed_at).toBeDefined();

    // Verify exchange accounts are confirmed flat
    const bPos = await binanceClient.getPositions('BTCUSDT');
    const byPos = await bybitClient.getPositions('BTCUSDT');
    expect(bPos.length === 0 || bPos[0]?.quantity.isZero()).toBe(true);
    expect(byPos.length === 0 || byPos[0]?.quantity.isZero()).toBe(true);
  });
});
