import { request } from 'undici';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/time.js';

export interface TelegramConfig {
  enabled: boolean;
  botToken?: string;
  chatId?: string;
  monitoringEnabled?: boolean;
  durationDays?: number;
  dailySummaryHourUtc?: number;
  dailySummaryMinuteUtc?: number;
}

export type TelegramEventType =
  | 'BOT_STARTED'
  | 'MODE_STATUS'
  | 'CONNECTIVITY_STATUS'
  | 'SYMBOL_CACHE_REFRESH'
  | 'OPPORTUNITY_ELIGIBLE'
  | 'OPPORTUNITY_REJECTED'
  | 'TRADE_STARTED'
  | 'BOTH_LEGS_FILLED'
  | 'ONE_LEG_FAILURE'
  | 'HEDGE_RECOVERY_STARTED'
  | 'EMERGENCY_FLATTEN'
  | 'FUNDING_SETTLEMENT_VERIFIED'
  | 'TRADE_CLOSED'
  | 'NET_PNL_RECORDED'
  | 'UNEXPECTED_POSITION'
  | 'DAILY_LOSS_LIMIT'
  | 'KILL_SWITCH_ACTIVATED'
  | 'AUTH_FAILURE'
  | 'MONITORING_EXPIRED';

export class TelegramNotifier {
  private enabled: boolean;
  private botToken?: string;
  private chatId?: string;
  private monitoringExpiresAt: number;
  private recentMessages: Map<string, number> = new Map();
  private isTestingMode: boolean = false;
  private mockSender?: (title: string, text: string) => Promise<void>;

  constructor(config: TelegramConfig) {
    this.enabled = config.enabled && Boolean(config.botToken) && Boolean(config.chatId);
    this.botToken = config.botToken;
    this.chatId = config.chatId;

    const days = config.durationDays ?? 3;
    this.monitoringExpiresAt = Date.now() + days * 24 * 3600 * 1000;

    if (this.enabled) {
      logger.info(
        {
          chatId: this.chatId,
          durationDays: days,
          expiresAt: new Date(this.monitoringExpiresAt).toISOString(),
        },
        'Telegram monitoring initialized'
      );
    }
  }

  public setMockSender(sender: (title: string, text: string) => Promise<void>) {
    this.isTestingMode = true;
    this.mockSender = sender;
  }

  public getChatId(): string | undefined {
    return this.chatId;
  }

  public getBotToken(): string | undefined {
    return this.botToken;
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public isMonitoringActive(): boolean {
    return Date.now() < this.monitoringExpiresAt;
  }

  public getMonitoringExpiry(): Date {
    return new Date(this.monitoringExpiresAt);
  }

  public extendMonitoring(additionalDays: number): Date {
    const base = Math.max(Date.now(), this.monitoringExpiresAt);
    this.monitoringExpiresAt = base + additionalDays * 24 * 3600 * 1000;
    logger.info(
      { additionalDays, newExpiresAt: new Date(this.monitoringExpiresAt).toISOString() },
      'Telegram monitoring window extended'
    );
    return new Date(this.monitoringExpiresAt);
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    if (!this.enabled || !this.botToken || !this.chatId) {
      return { ok: false, message: 'Telegram credentials missing or notifications disabled' };
    }

    if (this.isTestingMode) {
      return { ok: true, message: 'Mock Telegram connection successful' };
    }

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/getMe`;
      const res = await request(url, { method: 'GET' });
      const body: any = await res.body.json();
      if (body.ok) {
        return { ok: true, message: `Connected to bot @${body.result.username}` };
      }
      return { ok: false, message: body.description || 'Failed to authenticate bot' };
    } catch (err: any) {
      return { ok: false, message: err?.message || 'Network error reaching Telegram API' };
    }
  }

  private isCriticalEvent(eventType: TelegramEventType): boolean {
    const critical: TelegramEventType[] = [
      'ONE_LEG_FAILURE',
      'HEDGE_RECOVERY_STARTED',
      'EMERGENCY_FLATTEN',
      'UNEXPECTED_POSITION',
      'DAILY_LOSS_LIMIT',
      'KILL_SWITCH_ACTIVATED',
      'AUTH_FAILURE',
    ];
    return critical.includes(eventType);
  }

  async notifyEvent(
    eventType: TelegramEventType,
    title: string,
    details: string,
    severity: 'INFO' | 'WARN' | 'ERROR' = 'INFO'
  ): Promise<void> {
    // If routine monitoring expired, ONLY allow critical risk alerts through!
    const isCritical = this.isCriticalEvent(eventType);
    if (!this.isMonitoringActive() && !isCritical) {
      logger.debug({ eventType }, 'Monitoring window expired; skipping routine notification');
      return;
    }

    // Deduplication check: suppress identical messages within 60 seconds
    const dedupKey = `${eventType}:${title}:${details}`;
    const now = Date.now();
    const lastSent = this.recentMessages.get(dedupKey);
    if (lastSent && now - lastSent < 60000) {
      logger.debug({ eventType, title }, 'Suppressing duplicate Telegram notification');
      return;
    }
    this.recentMessages.set(dedupKey, now);

    // Clean up old dedup entries
    if (this.recentMessages.size > 100) {
      for (const [k, v] of this.recentMessages.entries()) {
        if (now - v > 120000) this.recentMessages.delete(k);
      }
    }

    await this.sendAlert(title, details, severity);
  }

  async sendDailySummary(summaryData: {
    date: string;
    mode: string;
    binanceStatus: string;
    bybitStatus: string;
    coinsScanned: number;
    eligibleOpportunities: number;
    tradesAttempted: number;
    tradesCompleted: number;
    tradesRejected: number;
    executionFailures: number;
    recoveryEvents: number;
    fundingReceivedUsd: string;
    fundingPaidUsd: string;
    tradingFeesUsd: string;
    realizedTradingPnlUsd: string;
    netRealizedPnlUsd: string;
    openPositionsText: string;
    unresolvedExposuresText: string;
    riskStatusText: string;
  }): Promise<void> {
    const text = `
*Funding Arbitrage Bot — Daily Summary*

*Date:* \`${summaryData.date}\`
*Mode:* \`${summaryData.mode.toUpperCase()}\`
*Binance Status:* ${summaryData.binanceStatus}
*Bybit Status:* ${summaryData.bybitStatus}

*Coins Scanned:* ${summaryData.coinsScanned}
*Eligible Opportunities:* ${summaryData.eligibleOpportunities}
*Trades Attempted:* ${summaryData.tradesAttempted}
*Trades Completed:* ${summaryData.tradesCompleted}
*Trades Rejected:* ${summaryData.tradesRejected}
*Execution Failures:* ${summaryData.executionFailures}
*Recovery Events:* ${summaryData.recoveryEvents}

*Funding Received:* +$${summaryData.fundingReceivedUsd}
*Funding Paid:* -$${summaryData.fundingPaidUsd}
*Trading Fees:* -$${summaryData.tradingFeesUsd}
*Realized Trading P&L:* $${summaryData.realizedTradingPnlUsd}
*Net Realized P&L:* *$${summaryData.netRealizedPnlUsd}*

*Open Positions:* ${summaryData.openPositionsText}
*Unresolved Exposures:* ${summaryData.unresolvedExposuresText}
*Risk Status:* ${summaryData.riskStatusText}
`.trim();

    await this.sendAlert('Daily Operational Summary', text, 'INFO');
  }

  async sendAlert(title: string, message: string, severity: 'INFO' | 'WARN' | 'ERROR' = 'INFO'): Promise<void> {
    if (!this.enabled && !this.isTestingMode) {
      return;
    }

    if (this.isTestingMode && this.mockSender) {
      await this.mockSender(title, message);
      return;
    }

    if (!this.botToken || !this.chatId) {
      return;
    }

    const emoji = severity === 'ERROR' ? '🚨' : severity === 'WARN' ? '⚠️' : 'ℹ️';
    const text = `${emoji} *${title}*\n\n${message}\n\n_Time: ${new Date().toISOString()}_`;

    // Retry with bounded backoff (max 3 attempts). NEVER crash the trading engine!
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
        const res = await request(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: this.chatId,
            text,
            parse_mode: 'Markdown',
          }),
        });

        if (res.statusCode === 200) {
          return;
        }

        const errText = await res.body.text();
        logger.warn({ attempt, statusCode: res.statusCode, errText }, 'Telegram API returned non-200');
        await sleep(500 * Math.pow(2, attempt));
      } catch (err: any) {
        logger.warn({ attempt, err: err?.message }, 'Transient error sending Telegram alert');
        if (attempt === 3) {
          logger.error({ title }, 'Could not deliver Telegram notification after 3 attempts');
        } else {
          await sleep(500 * Math.pow(2, attempt));
        }
      }
    }
  }
}
