import { IExchangeClient } from '../exchanges/exchange.interface.js';
import { TelegramNotifier } from '../notifications/telegram.js';
import { OrderManager } from '../execution/order-manager.js';
export interface MarginStatus {
    needsRebalance: boolean;
    isCritical: boolean;
    binanceAvailable: number;
    bybitAvailable: number;
    binanceUnrealizedPnl: number;
    bybitUnrealizedPnl: number;
    losingExchange?: 'Binance' | 'Bybit';
    winningExchange?: 'Binance' | 'Bybit';
    recommendedTransferUsd: number;
    reason?: string;
}
export declare class MarginMonitor {
    private binanceClient;
    private bybitClient;
    private telegram?;
    private warningThresholdUsd;
    private criticalThresholdUsd;
    private orderManager?;
    private lastAlertTimestamp;
    constructor(binanceClient: IExchangeClient, bybitClient: IExchangeClient, telegram?: TelegramNotifier | undefined, warningThresholdUsd?: number, criticalThresholdUsd?: number, orderManager?: OrderManager | undefined);
    checkMarginBalance(symbol?: string): Promise<MarginStatus>;
    private maybeSendRebalanceAlert;
    checkAndRecoverOrphanPositions(): Promise<boolean>;
}
//# sourceMappingURL=margin-monitor.d.ts.map