import { describe, it, expect, beforeEach } from 'vitest';
import { TelegramNotifier } from '../../src/notifications/telegram.js';
import { TelegramCommander } from '../../src/notifications/telegram-commander.js';
import { LiquidationSentinel } from '../../src/risk/liquidation-sentinel.js';
import { KillSwitch } from '../../src/risk/kill-switch.js';
import { CircuitBreaker } from '../../src/risk/circuit-breaker.js';
import { PaperClient } from '../../src/exchanges/paper.client.js';
import DatabaseConstructor from 'better-sqlite3';
import { runMigrations } from '../../src/persistence/migrations.js';
import {
  TradeRepository,
  DailySummaryRepository,
  RiskEventRepository,
} from '../../src/persistence/repositories.js';
import { toDecimal } from '../../src/utils/decimal.js';

describe('Integration Tests: Telegram Interactive Dashboard & Monitoring', () => {
  let dispatchedMessages: { text: string; markup?: any }[] = [];
  let notifier: TelegramNotifier;
  let binanceClient: PaperClient;
  let bybitClient: PaperClient;
  let killSwitch: KillSwitch;
  let circuitBreaker: CircuitBreaker;
  let tradeRepo: TradeRepository;
  let dailyRepo: DailySummaryRepository;
  let sentinel: LiquidationSentinel;
  let commander: TelegramCommander;

  beforeEach(() => {
    dispatchedMessages = [];
    const sqliteDb = new DatabaseConstructor(':memory:');
    runMigrations(sqliteDb);

    tradeRepo = new TradeRepository(sqliteDb);
    dailyRepo = new DailySummaryRepository(sqliteDb);
    const riskRepo = new RiskEventRepository(sqliteDb);

    binanceClient = new PaperClient({ exchangeName: 'binance' });
    bybitClient = new PaperClient({ exchangeName: 'bybit' });

    killSwitch = new KillSwitch(binanceClient, bybitClient, riskRepo);
    circuitBreaker = new CircuitBreaker(riskRepo);

    notifier = new TelegramNotifier({
      enabled: true,
      botToken: '123456:mock_token_abc',
      chatId: '987654321',
      durationDays: 3,
    });
    notifier.setMockSender(async (_title, text) => {
      dispatchedMessages.push({ text });
    });

    sentinel = new LiquidationSentinel({
      binanceClient,
      bybitClient,
      killSwitch,
      telegram: notifier,
      minEmergencyMarginUsd: 2.0,
    });

    let isFrozen = true;
    commander = new TelegramCommander({
      botToken: '123456:mock_token_abc',
      chatId: '987654321',
      binanceClient,
      bybitClient,
      tradeRepo,
      dailyRepo,
      circuitBreaker,
      killSwitch,
      telegramNotifier: notifier,
      getOpportunitiesSnapshot: async () => [
        {
          symbol: 'AKEUSDT',
          mapping: { normalized_symbol: 'AKE', binance_symbol: 'AKEUSDT', bybit_symbol: 'AKEUSDT' },
          binanceRate: toDecimal('0.005'),
          bybitRate: toDecimal('-0.003'),
          fundingDiffPct: 0.8,
          fundingDirection: 'SHORT_BINANCE_LONG_BYBIT',
          targetFundingTimeMs: Date.now() + 3600000,
        },
        {
          symbol: 'IOSTUSDT',
          mapping: { normalized_symbol: 'IOST', binance_symbol: 'IOSTUSDT', bybit_symbol: 'IOSTUSDT' },
          binanceRate: toDecimal('-0.004'),
          bybitRate: toDecimal('0.002'),
          fundingDiffPct: 0.6,
          fundingDirection: 'LONG_BINANCE_SHORT_BYBIT',
          targetFundingTimeMs: Date.now() + 3600000,
        },
      ],
      sentinel,
      isAutoExecutionFrozen: () => isFrozen,
      freezeAutoExecution: () => { isFrozen = true; },
      unfreezeAutoExecution: () => { isFrozen = false; },
    });
  });

  it('renders top 10 arbitrage dashboard with pair inline buttons and frozen manual badge', async () => {
    await commander.handleDashboard();
    expect(dispatchedMessages.length).toBeGreaterThanOrEqual(1);

    const lastMsg = dispatchedMessages[dispatchedMessages.length - 1]!;
    expect(lastMsg.text).toContain('FUNDING ARBITRAGE DASHBOARD');
    expect(lastMsg.text).toContain('MANUAL ONLY (Auto-Trade Frozen)');
    expect(lastMsg.text).toContain('AKE');
    expect(lastMsg.text).toContain('IOST');
    expect(lastMsg.text).toContain('STRICT 5x ONLY');
  });

  it('dispatches the registered dashboard slash command', async () => {
    await (commander as any).handleMessage('/dashboard');

    expect(dispatchedMessages.length).toBeGreaterThanOrEqual(1);
    expect(dispatchedMessages[dispatchedMessages.length - 1]!.text).toContain('FUNDING ARBITRAGE DASHBOARD');
  });

  it('provides buttons for every safe Telegram command', () => {
    const keyboard = notifier.getDefaultReplyKeyboard();
    const buttons = keyboard.keyboard.flat().map((button: { text: string }) => button.text);

    expect(buttons).toEqual([
      '📊 Top 10 Dashboard',
      '📈 Funding Spreads',
      '🗓️ 7-Day History',
      '🎯 Next Trade Plan',
      '💼 Wallet & Margin',
      '🤖 Bot Status',
      '📋 Current Trade Details',
      '❄️ Freeze Auto-Trade',
      '🟢 Unfreeze Auto-Trade',
      '🚨 Emergency Flatten',
      '❓ Help & Commands',
    ]);
  });

  it('does not execute trades from the Telegram command', async () => {
    await (commander as any).handleMessage('/trade AKE 10');

    expect(dispatchedMessages[dispatchedMessages.length - 1]!.text).toContain('Manual trade execution from Telegram is disabled');
    expect((await binanceClient.getPositions()).every((position) => position.quantity.isZero())).toBe(true);
    expect((await bybitClient.getPositions()).every((position) => position.quantity.isZero())).toBe(true);
  });

  it('routes the current trade details button to the positions view', async () => {
    await (commander as any).handleMessage('📋 Current Trade Details');

    expect(dispatchedMessages[dispatchedMessages.length - 1]!.text).toContain('No open positions');
  });

  it('shows live PnL, notional, quantity, leverage, and prices for open positions', async () => {
    await binanceClient.placeMarketOrder({
      clientOrderId: 'details-test-1',
      symbol: 'BTCUSDT',
      side: 'BUY',
      orderType: 'MARKET',
      quantity: toDecimal('0.01'),
      isReduceOnly: false,
    });

    await (commander as any).handleMessage('📋 Current Trade Details');

    const details = dispatchedMessages[dispatchedMessages.length - 1]!.text;
    expect(details).toContain('CURRENT TRADE DETAILS');
    expect(details).toContain('Total Unrealized PnL');
    expect(details).toContain('Open Notional');
    expect(details).toContain('Quantity');
    expect(details).toContain('Leverage');
    expect(details).toContain('Entry:');
    expect(details).toContain('Mark:');
    expect(details).toContain('Current Funding Rate');
    expect(details).toContain('Funding Collected/Paid');
  });

  it('toggles freeze and unfreeze execution mode via Telegram command', async () => {
    // Unfreeze command
    await (commander as any).handleMessage('unfreeze');
    expect(dispatchedMessages[dispatchedMessages.length - 1]!.text).toContain('UNFROZEN');

    // Freeze command
    await (commander as any).handleMessage('freeze');
    expect(dispatchedMessages[dispatchedMessages.length - 1]!.text).toContain('FROZEN');
  });

  it('renders pair detail view with 7-day stats and 5x margin options', async () => {
    await commander.handlePairSelected('AKE');
    expect(dispatchedMessages.length).toBeGreaterThanOrEqual(1);

    const lastMsg = dispatchedMessages[dispatchedMessages.length - 1]!;
    expect(lastMsg.text).toContain('PAIR DASHBOARD: AKE (5x LEVERAGE)');
    expect(lastMsg.text).toContain('Current Spread:');
    expect(lastMsg.text).toContain('$10 Margin');
    expect(lastMsg.text).toContain('$25 Margin');
    expect(lastMsg.text).toContain('$50 Margin');
    expect(lastMsg.text).toContain('$100 Margin');
  });

  it('emergency flatten closes all positions to 100% USDT and activates kill switch', async () => {
    // Open a mock position on Binance
    await binanceClient.placeMarketOrder({
      clientOrderId: 'test-pos-1',
      symbol: 'BTCUSDT',
      side: 'BUY',
      orderType: 'MARKET',
      quantity: toDecimal('0.01'),
      isReduceOnly: false,
    });

    const bPos = await binanceClient.getPositions();
    expect(bPos.find((p) => p.symbol === 'BTCUSDT' && !p.quantity.isZero())).toBeDefined();

    // Trigger emergency flatten
    await commander.handleEmergencyFlatten();

    // Verify all positions are flat and kill switch is active
    const postPos = await binanceClient.getPositions();
    const active = postPos.filter((p) => p.side !== 'FLAT' && !p.quantity.isZero());
    expect(active.length).toBe(0);
    expect(killSwitch.isEngaged()).toBe(true);

    const flattenAlert = dispatchedMessages.find((m) => m.text.includes('EMERGENCY SAFETY SHUTDOWN') || m.text.includes('EMERGENCY STOP') || m.text.includes('All positions flattened'));
    expect(flattenAlert).toBeDefined();
  });

  it('Liquidation Sentinel detects orphan leg (one exchange liquidated) and auto-flattens', async () => {
    // Put Binance into position but Bybit remains flat -> Orphan position!
    await binanceClient.placeMarketOrder({
      clientOrderId: 'orphan-test-1',
      symbol: 'SOLUSDT',
      side: 'BUY',
      orderType: 'MARKET',
      quantity: toDecimal('1'),
      isReduceOnly: false,
    });

    // Check positions and margin
    const triggered = await sentinel.checkPositionsAndMargin();
    expect(triggered).toBe(true);
    expect(killSwitch.isEngaged()).toBe(true);

    // Verify surviving leg was flattened
    const afterPos = await binanceClient.getPositions();
    const active = afterPos.filter((p) => p.side !== 'FLAT' && !p.quantity.isZero());
    expect(active.length).toBe(0);

    const alert = dispatchedMessages.find((m) => m.text.includes('EMERGENCY') || m.text.includes('LIQUIDATED') || m.text.includes('FLATTENED'));
    expect(alert).toBeDefined();
  });
});
