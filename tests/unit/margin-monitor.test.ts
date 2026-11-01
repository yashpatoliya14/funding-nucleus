import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MarginMonitor } from '../../src/risk/margin-monitor.js';
import { PaperClient } from '../../src/exchanges/paper.client.js';
import { TelegramNotifier } from '../../src/notifications/telegram.js';
import { toDecimal } from '../../src/utils/decimal.js';

describe('MarginMonitor', () => {
  let binanceClient: PaperClient;
  let bybitClient: PaperClient;
  let telegram: TelegramNotifier;
  let sentMessages: string[] = [];

  beforeEach(() => {
    binanceClient = new PaperClient({ exchangeName: 'binance' });
    bybitClient = new PaperClient({ exchangeName: 'bybit' });
    sentMessages = [];

    telegram = {
      sendMessage: vi.fn(async (text: string) => {
        sentMessages.push(text);
      }),
      sendAlert: vi.fn(),
    } as unknown as TelegramNotifier;
  });

  it('reports healthy when both balances are above warning threshold', async () => {
    const monitor = new MarginMonitor(binanceClient, bybitClient, telegram, 3.50, 1.50);
    const status = await monitor.checkMarginBalance();

    expect(status.needsRebalance).toBe(false);
    expect(status.isCritical).toBe(false);
    expect(sentMessages.length).toBe(0);
  });

  it('detects asymmetric margin drift and triggers rebalance alert', async () => {
    // Simulate Binance having only $2 available while Bybit has $18
    vi.spyOn(binanceClient, 'getBalances').mockResolvedValueOnce([
      { asset: 'USDT', totalWalletBalance: toDecimal('2'), availableBalance: toDecimal('2'), unrealizedPnl: toDecimal('-8') },
    ]);
    vi.spyOn(bybitClient, 'getBalances').mockResolvedValueOnce([
      { asset: 'USDT', totalWalletBalance: toDecimal('18'), availableBalance: toDecimal('18'), unrealizedPnl: toDecimal('8') },
    ]);

    const monitor = new MarginMonitor(binanceClient, bybitClient, telegram, 3.50, 1.50);
    const status = await monitor.checkMarginBalance('ETHUSDT');

    expect(status.needsRebalance).toBe(true);
    expect(status.losingExchange).toBe('Binance');
    expect(status.winningExchange).toBe('Bybit');
    expect(status.recommendedTransferUsd).toBe(8); // (18 - 2) / 2 = 8
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]).toContain('MARGIN REBALANCE ALERT');
    expect(sentMessages[0]).toContain('Transfer *~$8.00 USDT* from *Bybit* to *Binance*');
  });

  it('marks critical when available balance drops below critical threshold ($1.50)', async () => {
    vi.spyOn(binanceClient, 'getBalances').mockResolvedValueOnce([
      { asset: 'USDT', totalWalletBalance: toDecimal('1'), availableBalance: toDecimal('1'), unrealizedPnl: toDecimal('-9') },
    ]);
    vi.spyOn(bybitClient, 'getBalances').mockResolvedValueOnce([
      { asset: 'USDT', totalWalletBalance: toDecimal('19'), availableBalance: toDecimal('19'), unrealizedPnl: toDecimal('9') },
    ]);

    const monitor = new MarginMonitor(binanceClient, bybitClient, telegram, 3.50, 1.50);
    const status = await monitor.checkMarginBalance('ETHUSDT');

    expect(status.needsRebalance).toBe(true);
    expect(status.isCritical).toBe(true);
    expect(status.losingExchange).toBe('Binance');
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]).toContain('🚨 *MARGIN REBALANCE ALERT*');
  });
});
