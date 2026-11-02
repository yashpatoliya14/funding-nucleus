import { IExchangeClient } from '../exchanges/exchange.interface.js';
import { TradeRepository, DailySummaryRepository } from '../persistence/repositories.js';
import { TelegramNotifier } from './telegram.js';
import { CircuitBreaker } from '../risk/circuit-breaker.js';
import { KillSwitch } from '../risk/kill-switch.js';
import { FundingHistoryService } from '../analytics/funding-history.service.js';
import { ManualTradeService } from '../execution/manual-trade.service.js';
import { LiquidationSentinel } from '../risk/liquidation-sentinel.js';
import { SymbolCache } from '../market-data/symbol-cache.js';
export interface TelegramCommanderOptions {
    botToken: string;
    chatId: string;
    binanceClient: IExchangeClient;
    bybitClient: IExchangeClient;
    tradeRepo: TradeRepository;
    dailyRepo: DailySummaryRepository;
    circuitBreaker: CircuitBreaker;
    killSwitch: KillSwitch;
    telegramNotifier: TelegramNotifier;
    getOpportunitiesSnapshot?: () => Promise<any[]>;
    evaluateOpportunity?: (opp: any) => Promise<any>;
    entryLeadMinutes?: number;
    marginPerLegUsd?: number;
    defaultLeverageCap?: number;
    minFundingEdgePct?: number;
    historyService?: FundingHistoryService;
    manualTradeService?: ManualTradeService;
    sentinel?: LiquidationSentinel;
    symbolCache?: SymbolCache;
    isAutoExecutionFrozen?: () => boolean;
    freezeAutoExecution?: () => void;
    unfreezeAutoExecution?: () => void;
}
export declare class TelegramCommander {
    private botToken;
    private chatId;
    private binanceClient;
    private bybitClient;
    private tradeRepo;
    private dailyRepo;
    private circuitBreaker;
    private killSwitch;
    private telegramNotifier;
    private getOpportunitiesSnapshot?;
    private evaluateOpportunity?;
    private entryLeadMinutes;
    private marginPerLegUsd;
    private defaultLeverageCap;
    private minFundingEdgePct;
    private historyService?;
    private manualTradeService?;
    private sentinel?;
    private symbolCache?;
    private isAutoExecutionFrozen?;
    private freezeAutoExecution?;
    private unfreezeAutoExecution?;
    private isPolling;
    private lastUpdateId;
    private processedUpdateIds;
    private isProcessingCommand;
    private startedAtSec;
    constructor(options: TelegramCommanderOptions);
    start(): void;
    stop(): void;
    private initAndPoll;
    private initializeOffset;
    private pollLoop;
    private handleCallbackQuery;
    private handleMessage;
    /**
     * Top 10 Arbitrage Opportunity Interactive Telegram Dashboard
     */
    handleDashboard(messageId?: number): Promise<void>;
    /**
     * Pair Detail View: Shows 7-Day Funding Rate Historical Analysis & 5x Margin Buttons
     */
    handlePairSelected(coin: string, messageId?: number): Promise<void>;
    /**
     * Executes a simultaneous delta-neutral trade on Binance & Bybit with strictly 5x leverage
     */
    handleExecuteTrade(coin: string, marginUsd: number): Promise<void>;
    private handleHelp;
    private handleWallet;
    private handleTop10;
    private handleStatus;
    private handleNextPlannedTrade;
    private handleTrades;
    /**
     * Emergency Flatten: Instantly market closes 100% of positions on Binance & Bybit
     */
    handleEmergencyFlatten(): Promise<void>;
    private handleDualTestOrder;
}
//# sourceMappingURL=telegram-commander.d.ts.map