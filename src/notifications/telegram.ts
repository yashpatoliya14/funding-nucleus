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

  /**
   * Registers bot slash commands with Telegram Bot API so they appear in autocomplete & menu button.
   */
  async registerBotCommands(): Promise<boolean> {
    if (!this.enabled || !this.botToken) return false;

    const commands = [
      { command: 'flatten', description: '🚨 Emergency Stop: Flatten All Positions (100% USDT)' },
      { command: 'current', description: '📊 Current Active Trade Details & Positions' },
      { command: 'top10', description: '📈 Top 10 Cross-Exchange Funding Spreads' },
      { command: 'wallet', description: '💼 Binance & Bybit Balances & Margin' },
      { command: 'netpnl', description: '💰 Today Realized Net PnL & Performance' },
      { command: 'help', description: '❓ Commands Reference Guide' },
    ];

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/setMyCommands`;
      const res = await request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commands }),
      });
      logger.info({ statusCode: res.statusCode }, 'Registered bot commands with Telegram API');
      return res.statusCode === 200;
    } catch (err: any) {
      logger.warn({ err: err?.message }, 'Failed to register bot commands with Telegram');
      return false;
    }
  }

  /**
   * Sets the Telegram chat menu button to show the commands list.
   */
  async setCommandsMenuButton(): Promise<boolean> {
    if (!this.enabled || !this.botToken) return false;
    try {
      const url = `https://api.telegram.org/bot${this.botToken}/setChatMenuButton`;
      const res = await request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ menu_button: { type: 'commands' } }),
      });
      return res.statusCode === 200;
    } catch {
      return false;
    }
  }

  /**
   * Returns a persistent Telegram reply keyboard with one-tap action buttons.
   */
  public getDefaultReplyKeyboard(): any {
    return {
      keyboard: [
        [
          { text: '🚨 Flatten for Emergency' },
        ],
        [
          { text: '📊 Current Trade Details' },
          { text: '📈 Top 10' },
        ],
        [
          { text: '💼 Wallet' },
          { text: '💰 Net PnL' },
        ],
      ],
      resize_keyboard: true,
      is_persistent: true,
    };
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
    const isCritical = this.isCriticalEvent(eventType);
    if (!this.isMonitoringActive() && !isCritical) {
      logger.debug({ eventType }, 'Monitoring window expired; skipping routine notification');
      return;
    }

    const dedupKey = `${eventType}:${title}:${details}`;
    const now = Date.now();
    const lastSent = this.recentMessages.get(dedupKey);
    if (lastSent && now - lastSent < 60000) {
      logger.debug({ eventType, title }, 'Suppressing duplicate Telegram notification');
      return;
    }
    this.recentMessages.set(dedupKey, now);

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

  async sendMessage(text: string): Promise<void> {
    await this.sendMessageWithMarkup(text);
  }

  async sendMessageWithMarkup(text: string, replyMarkup?: any): Promise<{ ok: boolean; messageId?: number }> {
    if (!this.enabled && !this.isTestingMode) {
      return { ok: false };
    }

    if (this.isTestingMode && this.mockSender) {
      await this.mockSender('', text);
      return { ok: true, messageId: 999 };
    }

    if (!this.botToken || !this.chatId) {
      return { ok: false };
    }

    // Retry with bounded backoff (max 3 attempts)
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
        const payload: any = {
          chat_id: this.chatId,
          text,
          parse_mode: 'Markdown',
        };
        if (replyMarkup) {
          payload.reply_markup = replyMarkup;
        }

        const res = await request(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (res.statusCode === 200) {
          const body: any = await res.body.json();
          return { ok: true, messageId: body?.result?.message_id };
        }

        const errText = await res.body.text();
        logger.warn({ attempt, statusCode: res.statusCode, errText }, 'Telegram API returned non-200');
        await sleep(500 * Math.pow(2, attempt));
      } catch (err: any) {
        logger.warn({ attempt, err: err?.message }, 'Transient error sending Telegram message');
        if (attempt < 3) {
          await sleep(500 * Math.pow(2, attempt));
        }
      }
    }
    return { ok: false };
  }

  async editMessageText(messageId: number, text: string, replyMarkup?: any): Promise<boolean> {
    if (!this.enabled || !this.botToken || !this.chatId) return false;

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/editMessageText`;
      const payload: any = {
        chat_id: this.chatId,
        message_id: messageId,
        text,
        parse_mode: 'Markdown',
      };
      if (replyMarkup) {
        payload.reply_markup = replyMarkup;
      }

      const res = await request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      return res.statusCode === 200;
    } catch {
      return false;
    }
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean> {
    if (!this.enabled || !this.botToken) return false;

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/answerCallbackQuery`;
      const payload: any = { callback_query_id: callbackQueryId };
      if (text) payload.text = text;

      const res = await request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      return res.statusCode === 200;
    } catch {
      return false;
    }
  }

  async sendAlert(title: string, message: string, severity: 'INFO' | 'WARN' | 'ERROR' = 'INFO'): Promise<void> {
    if (!this.enabled && !this.isTestingMode) {
      return;
    }

    if (this.isTestingMode && this.mockSender) {
      await this.mockSender(title, message);
      return;
    }

    const emoji = severity === 'ERROR' ? '🚨' : severity === 'WARN' ? '⚠️' : 'ℹ️';
    const text = title ? `${emoji} *${title}*\n\n${message}` : message;
    await this.sendMessage(text);
  }
}
