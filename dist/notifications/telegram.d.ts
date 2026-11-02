export interface TelegramConfig {
    enabled: boolean;
    botToken?: string;
    chatId?: string;
    monitoringEnabled?: boolean;
    durationDays?: number;
    dailySummaryHourUtc?: number;
    dailySummaryMinuteUtc?: number;
}
export type TelegramEventType = 'BOT_STARTED' | 'MODE_STATUS' | 'CONNECTIVITY_STATUS' | 'SYMBOL_CACHE_REFRESH' | 'OPPORTUNITY_ELIGIBLE' | 'OPPORTUNITY_REJECTED' | 'TRADE_STARTED' | 'BOTH_LEGS_FILLED' | 'ONE_LEG_FAILURE' | 'HEDGE_RECOVERY_STARTED' | 'EMERGENCY_FLATTEN' | 'FUNDING_SETTLEMENT_VERIFIED' | 'TRADE_CLOSED' | 'NET_PNL_RECORDED' | 'UNEXPECTED_POSITION' | 'DAILY_LOSS_LIMIT' | 'KILL_SWITCH_ACTIVATED' | 'AUTH_FAILURE' | 'MONITORING_EXPIRED';
export declare class TelegramNotifier {
    private enabled;
    private botToken?;
    private chatId?;
    private monitoringExpiresAt;
    private recentMessages;
    private isTestingMode;
    private mockSender?;
    constructor(config: TelegramConfig);
    setMockSender(sender: (title: string, text: string) => Promise<void>): void;
    getChatId(): string | undefined;
    getBotToken(): string | undefined;
    isEnabled(): boolean;
    isMonitoringActive(): boolean;
    getMonitoringExpiry(): Date;
    extendMonitoring(additionalDays: number): Date;
    testConnection(): Promise<{
        ok: boolean;
        message: string;
    }>;
    /**
     * Registers bot slash commands with Telegram Bot API so they appear in autocomplete & menu button.
     */
    registerBotCommands(): Promise<boolean>;
    /**
     * Sets the Telegram chat menu button to show the commands list.
     */
    setCommandsMenuButton(): Promise<boolean>;
    /**
     * Returns a persistent Telegram reply keyboard with one-tap action buttons.
     */
    getDefaultReplyKeyboard(): any;
    private isCriticalEvent;
    notifyEvent(eventType: TelegramEventType, title: string, details: string, severity?: 'INFO' | 'WARN' | 'ERROR'): Promise<void>;
    sendDailySummary(summaryData: {
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
    }): Promise<void>;
    sendMessage(text: string): Promise<void>;
    sendMessageWithMarkup(text: string, replyMarkup?: any): Promise<{
        ok: boolean;
        messageId?: number;
    }>;
    editMessageText(messageId: number, text: string, replyMarkup?: any): Promise<boolean>;
    answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean>;
    sendAlert(title: string, message: string, severity?: 'INFO' | 'WARN' | 'ERROR'): Promise<void>;
}
//# sourceMappingURL=telegram.d.ts.map