import { describe, it, expect, beforeEach } from 'vitest';
import { TelegramNotifier, TelegramEventType } from '../../src/notifications/telegram.js';

describe('Integration Tests: Telegram Monitoring System', () => {
  let dispatchedMessages: { title: string; text: string }[] = [];
  let notifier: TelegramNotifier;

  beforeEach(() => {
    dispatchedMessages = [];
    notifier = new TelegramNotifier({
      enabled: true,
      botToken: '123456:mock_token_abc',
      chatId: '987654321',
      durationDays: 3,
    });
    notifier.setMockSender(async (title, text) => {
      dispatchedMessages.push({ title, text });
    });
  });

  it('tests connection successfully with mock sender', async () => {
    const res = await notifier.testConnection();
    expect(res.ok).toBe(true);
  });

  it('correctly dispatches notifications for all 19 defined event types', async () => {
    const events: TelegramEventType[] = [
      'BOT_STARTED',
      'MODE_STATUS',
      'CONNECTIVITY_STATUS',
      'SYMBOL_CACHE_REFRESH',
      'OPPORTUNITY_ELIGIBLE',
      'OPPORTUNITY_REJECTED',
      'TRADE_STARTED',
      'BOTH_LEGS_FILLED',
      'ONE_LEG_FAILURE',
      'HEDGE_RECOVERY_STARTED',
      'EMERGENCY_FLATTEN',
      'FUNDING_SETTLEMENT_VERIFIED',
      'TRADE_CLOSED',
      'NET_PNL_RECORDED',
      'UNEXPECTED_POSITION',
      'DAILY_LOSS_LIMIT',
      'KILL_SWITCH_ACTIVATED',
      'AUTH_FAILURE',
      'MONITORING_EXPIRED',
    ];

    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      await notifier.notifyEvent(ev, `Title for ${ev}`, `Details for event #${i + 1}`);
    }

    expect(dispatchedMessages.length).toBe(19);
  });

  it('deduplicates identical messages within 60 seconds', async () => {
    await notifier.notifyEvent('OPPORTUNITY_REJECTED', 'Opp Rejected', 'Edge too small');
    await notifier.notifyEvent('OPPORTUNITY_REJECTED', 'Opp Rejected', 'Edge too small'); // Duplicate!

    expect(dispatchedMessages.length).toBe(1); // Second was suppressed
  });

  it('formats and sends structured daily summary', async () => {
    await notifier.sendDailySummary({
      date: '2026-10-29',
      mode: 'paper',
      binanceStatus: 'OK (Ping: 45ms)',
      bybitStatus: 'OK (Ping: 48ms)',
      coinsScanned: 24,
      eligibleOpportunities: 3,
      tradesAttempted: 2,
      tradesCompleted: 2,
      tradesRejected: 1,
      executionFailures: 0,
      recoveryEvents: 0,
      fundingReceivedUsd: '4.50',
      fundingPaidUsd: '1.20',
      tradingFeesUsd: '1.40',
      realizedTradingPnlUsd: '0.00',
      netRealizedPnlUsd: '1.90',
      openPositionsText: 'None (Both accounts verified flat)',
      unresolvedExposuresText: 'None',
      riskStatusText: 'Healthy (Circuit Breaker: CLOSED)',
    });

    expect(dispatchedMessages.length).toBe(1);
    expect(dispatchedMessages[0]!.title).toContain('Daily Operational Summary');
    expect(dispatchedMessages[0]!.text).toContain('Funding Arbitrage Bot — Daily Summary');
    expect(dispatchedMessages[0]!.text).toContain('*Net Realized P&L:* *$1.90*');
  });

  it('handles monitoring expiration: blocks routine notifications but continues critical risk alerts', async () => {
    // Force monitoring expired by setting duration to 0 days in the past
    const expiredNotifier = new TelegramNotifier({
      enabled: true,
      botToken: '123456:mock_token_abc',
      chatId: '987654321',
      durationDays: 0,
    });
    const expiredMessages: { title: string; text: string }[] = [];
    expiredNotifier.setMockSender(async (title, text) => {
      expiredMessages.push({ title, text });
    });

    expect(expiredNotifier.isMonitoringActive()).toBe(false);

    // Routine notification should be BLOCKED
    await expiredNotifier.notifyEvent('SYMBOL_CACHE_REFRESH', 'Cache Refresh', 'Refreshed 20 symbols');
    expect(expiredMessages.length).toBe(0);

    // Critical risk alert MUST still be DISPATCHED!
    await expiredNotifier.notifyEvent('KILL_SWITCH_ACTIVATED', 'Emergency Kill Switch', 'All positions flattened!', 'ERROR');
    expect(expiredMessages.length).toBe(1);
    expect(expiredMessages[0]!.title).toContain('Emergency Kill Switch');
  });

  it('allows extending the monitoring window', () => {
    const initialExpiry = notifier.getMonitoringExpiry().getTime();
    const newExpiry = notifier.extendMonitoring(5).getTime();
    expect(newExpiry).toBeGreaterThan(initialExpiry + 4 * 24 * 3600 * 1000);
  });
});
