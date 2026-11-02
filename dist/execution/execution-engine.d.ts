import { IExchangeClient } from '../exchanges/exchange.interface.js';
import { OrderManager } from './order-manager.js';
import { ExecutionReconciliation } from './reconciliation.js';
import { HedgeRecovery } from './hedge-recovery.js';
import { TradeStateMachine } from './state-machine.js';
import { EvaluatedOpportunity } from '../strategy/opportunity-filter.js';
import { DailySummaryRepository, FundingEventRepository, FundingTransactionRepository, TradeRepository } from '../persistence/repositories.js';
import { DbTrade } from '../persistence/models.js';
import { AppConfig } from '../config/schema.js';
import { MarginMonitor } from '../risk/margin-monitor.js';
import { TelegramNotifier } from '../notifications/telegram.js';
export declare class ExecutionEngine {
    private binanceClient;
    private bybitClient;
    private orderManager;
    private reconciliation;
    private hedgeRecovery;
    private stateMachine;
    private tradeRepo;
    private fundingEventRepo;
    private fundingTxRepo;
    private dailyRepo;
    private config;
    private marginMonitor?;
    private telegram?;
    constructor(binanceClient: IExchangeClient, bybitClient: IExchangeClient, orderManager: OrderManager, reconciliation: ExecutionReconciliation, hedgeRecovery: HedgeRecovery, stateMachine: TradeStateMachine, tradeRepo: TradeRepository, fundingEventRepo: FundingEventRepository, fundingTxRepo: FundingTransactionRepository, dailyRepo: DailySummaryRepository, config: AppConfig, marginMonitor?: MarginMonitor | undefined, telegram?: TelegramNotifier | undefined);
    executeTrade(candidate: EvaluatedOpportunity, isSimulated?: boolean, enforceProfitability?: boolean): Promise<DbTrade>;
}
//# sourceMappingURL=execution-engine.d.ts.map