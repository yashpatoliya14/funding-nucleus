import { IExchangeClient } from '../exchanges/exchange.interface.js';
import { SymbolCache } from '../market-data/symbol-cache.js';
import { ExecutionEngine } from './execution-engine.js';
import { TelegramNotifier } from '../notifications/telegram.js';
import { AppConfig } from '../config/schema.js';
export interface ManualTradeRequest {
    symbol: string;
    marginUsd: number;
}
export interface ManualTradeResult {
    success: boolean;
    tradeId?: string;
    symbol: string;
    marginUsd: number;
    leverage: number;
    notionalUsd: number;
    direction: string;
    binanceRatePct: number;
    bybitRatePct: number;
    spreadPct: number;
    expectedNetProfitUsd: number;
    targetFundingTimeMs: number;
    message?: string;
}
export declare class ManualTradeService {
    private binanceClient;
    private bybitClient;
    private symbolCache;
    private executionEngine;
    private telegram;
    private config;
    constructor(binanceClient: IExchangeClient, bybitClient: IExchangeClient, symbolCache: SymbolCache, executionEngine: ExecutionEngine, telegram: TelegramNotifier, config: AppConfig);
    /**
     * Executes a manual arbitrage trade on a specific pair at STRICTLY 5x leverage.
     */
    executeManualTrade(request: ManualTradeRequest, isSimulated?: boolean): Promise<ManualTradeResult>;
}
//# sourceMappingURL=manual-trade.service.d.ts.map