import { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { DbSymbolMapping, DbTrade, DbOrder, DbFill, DbFundingEvent, DbFundingTransaction, DbPositionSnapshot, DbStateTransition, DbRiskEvent, DbDailySummary } from './models.js';
import { Decimal } from '../utils/decimal.js';
export declare class SymbolRepository {
    private db;
    constructor(db: BetterSqliteDatabase);
    upsert(mapping: DbSymbolMapping): void;
    getByNormalized(normalizedSymbol: string): DbSymbolMapping | undefined;
    getAllActive(): DbSymbolMapping[];
}
export declare class TradeRepository {
    private db;
    constructor(db: BetterSqliteDatabase);
    create(trade: DbTrade): void;
    update(trade: Partial<DbTrade> & {
        id: string;
    }): void;
    getById(id: string): DbTrade | undefined;
    getActiveTrades(): DbTrade[];
    getByFundingEvent(fundingEventId: string): DbTrade | undefined;
}
export declare class OrderRepository {
    private db;
    constructor(db: BetterSqliteDatabase);
    create(order: DbOrder): void;
    update(order: Partial<DbOrder> & {
        id: string;
    }): void;
    getByClientOrderId(clientOrderId: string): DbOrder | undefined;
    getByTradeId(tradeId: string): DbOrder[];
}
export declare class FillRepository {
    private db;
    constructor(db: BetterSqliteDatabase);
    create(fill: DbFill): void;
    getByTradeId(tradeId: string): DbFill[];
}
export declare class FundingEventRepository {
    private db;
    constructor(db: BetterSqliteDatabase);
    upsert(event: DbFundingEvent): void;
    getById(id: string): DbFundingEvent | undefined;
}
export declare class FundingTransactionRepository {
    private db;
    constructor(db: BetterSqliteDatabase);
    create(tx: DbFundingTransaction): void;
    getByTradeId(tradeId: string): DbFundingTransaction[];
}
export declare class PositionSnapshotRepository {
    private db;
    constructor(db: BetterSqliteDatabase);
    create(snapshot: DbPositionSnapshot): void;
    getLatestByTrade(tradeId: string): DbPositionSnapshot[];
}
export declare class StateTransitionRepository {
    private db;
    constructor(db: BetterSqliteDatabase);
    record(transition: DbStateTransition): void;
    getByTradeId(tradeId: string): DbStateTransition[];
}
export declare class RiskEventRepository {
    private db;
    constructor(db: BetterSqliteDatabase);
    record(event: DbRiskEvent): void;
    getRecent(limit?: number): DbRiskEvent[];
}
export declare class DailySummaryRepository {
    private db;
    constructor(db: BetterSqliteDatabase);
    getOrCreateToday(): DbDailySummary;
    addTradeResult(tradingPnl: Decimal, fundingPnl: Decimal, fees: Decimal, hitLossLimit?: boolean): void;
}
//# sourceMappingURL=repositories.d.ts.map