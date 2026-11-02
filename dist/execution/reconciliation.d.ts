import { IExchangeClient } from '../exchanges/exchange.interface.js';
import { OrderResult } from '../exchanges/types.js';
import { FillRepository, PositionSnapshotRepository } from '../persistence/repositories.js';
import { ReconciliationResult } from './types.js';
export declare class ExecutionReconciliation {
    private binanceClient;
    private bybitClient;
    private fillRepo;
    private snapshotRepo;
    constructor(binanceClient: IExchangeClient, bybitClient: IExchangeClient, fillRepo: FillRepository, snapshotRepo: PositionSnapshotRepository);
    reconcilePositions(tradeId: string, binanceSymbol: string, bybitSymbol: string): Promise<ReconciliationResult>;
    recordFills(tradeId: string, bOrder: OrderResult | null, byOrder: OrderResult | null): void;
}
//# sourceMappingURL=reconciliation.d.ts.map