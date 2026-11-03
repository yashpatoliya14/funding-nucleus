import { IExchangeClient } from '../exchanges/exchange.interface.js';
import { KillSwitch } from './kill-switch.js';
import { TelegramNotifier } from '../notifications/telegram.js';
import { TradeRepository } from '../persistence/repositories.js';
export interface SentinelOptions {
    binanceClient: IExchangeClient;
    bybitClient: IExchangeClient;
    killSwitch: KillSwitch;
    telegram: TelegramNotifier;
    checkIntervalMs?: number;
    minEmergencyMarginUsd?: number;
    tradeRepo?: TradeRepository;
}
export declare class LiquidationSentinel {
    private binanceClient;
    private bybitClient;
    private killSwitch;
    private telegram;
    private checkIntervalMs;
    private minEmergencyMarginUsd;
    private tradeRepo?;
    private isRunning;
    private lastAlertTime;
    constructor(options: SentinelOptions);
    start(): void;
    stop(): void;
    private loop;
    /**
     * Main check:
     * 1. Detects if one leg was liquidated (orphan position) -> Flatten ALL immediately!
     * 2. Detects if free margin is depleted while holding positions -> Flatten ALL immediately!
     */
    checkPositionsAndMargin(): Promise<boolean>;
    /**
     * One-leg liquidation recovery:
     * Immediately market-closes the surviving orphan leg on the opposite exchange (reduce-only),
     * verifies accounts are flat, notifies Telegram, and keeps trading active so the bot
     * immediately searches for and enters a new arbitrage opportunity.
     */
    recoverOrphanLegAndResume(reasonText: string): Promise<void>;
    /**
     * Instantly executes emergency market close for 100% of positions on both exchanges,
     * engages the kill switch, and sends a critical Telegram alert.
     */
    triggerEmergencyFlatten(triggerType: string, reasonText: string): Promise<void>;
}
//# sourceMappingURL=liquidation-sentinel.d.ts.map