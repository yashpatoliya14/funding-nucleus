import { IExchangeClient } from '../exchanges/exchange.interface.js';
import { OrderManager } from './order-manager.js';
import { ExecutionReconciliation } from './reconciliation.js';
import { AppConfig } from '../config/schema.js';
import { RiskEventRepository } from '../persistence/repositories.js';
import { OrderSide } from '../persistence/models.js';
import { Decimal } from '../utils/decimal.js';
export interface RecoveryActionPlan {
    action: 'COMPLETE_HEDGE' | 'CLOSE_FILLED_LEG' | 'ADJUST_MISMATCH' | 'NONE';
    exchangeToTrade?: 'binance' | 'bybit';
    side?: OrderSide;
    quantity?: Decimal;
    reason: string;
}
export declare class HedgeRecovery {
    private binanceClient;
    private bybitClient;
    private orderManager;
    private reconciliation;
    private riskRepo;
    private config;
    constructor(binanceClient: IExchangeClient, bybitClient: IExchangeClient, orderManager: OrderManager, reconciliation: ExecutionReconciliation, riskRepo: RiskEventRepository, config: AppConfig);
    recover(tradeId: string, binanceSymbol: string, bybitSymbol: string, intendedDirection: 'SHORT_BINANCE_LONG_BYBIT' | 'LONG_BINANCE_SHORT_BYBIT', targetQuantityBinance: Decimal, targetQuantityBybit: Decimal): Promise<{
        success: boolean;
        isFlat: boolean;
        message: string;
    }>;
    flattenAllLegs(tradeId: string, binanceSymbol: string, bybitSymbol: string, reason: string): Promise<{
        success: boolean;
        isFlat: boolean;
        message: string;
    }>;
}
//# sourceMappingURL=hedge-recovery.d.ts.map