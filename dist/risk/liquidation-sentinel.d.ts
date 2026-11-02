import { IExchangeClient } from '../exchanges/exchange.interface.js';
import { KillSwitch } from './kill-switch.js';
import { TelegramNotifier } from '../notifications/telegram.js';
export interface SentinelOptions {
    binanceClient: IExchangeClient;
    bybitClient: IExchangeClient;
    killSwitch: KillSwitch;
    telegram: TelegramNotifier;
    checkIntervalMs?: number;
    minEmergencyMarginUsd?: number;
}
export declare class LiquidationSentinel {
    private binanceClient;
    private bybitClient;
    private killSwitch;
    private telegram;
    private checkIntervalMs;
    private minEmergencyMarginUsd;
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
     * Instantly executes emergency market close for 100% of positions on both exchanges,
     * engages the kill switch, and sends a critical Telegram alert.
     */
    triggerEmergencyFlatten(triggerType: string, reasonText: string): Promise<void>;
}
//# sourceMappingURL=liquidation-sentinel.d.ts.map