import { IExchangeClient } from '../exchanges/exchange.interface.js';
import { RiskEventRepository } from '../persistence/repositories.js';
export declare class KillSwitch {
    private binanceClient;
    private bybitClient;
    private riskRepo;
    private active;
    private reason;
    constructor(binanceClient: IExchangeClient, bybitClient: IExchangeClient, riskRepo: RiskEventRepository);
    isEngaged(): boolean;
    getReason(): string | null;
    activate(reason: string): void;
    /**
     * Flattens all existing positions on both exchanges using reduce-only MARKET orders.
     */
    emergencyFlatten(): Promise<{
        flattenedCount: number;
        errors: string[];
    }>;
}
//# sourceMappingURL=kill-switch.d.ts.map