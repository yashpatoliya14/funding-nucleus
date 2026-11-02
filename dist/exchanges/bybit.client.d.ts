import { IExchangeClient } from './exchange.interface.js';
import { AccountBalance, CommissionRates, FundingRateInfo, FundingTransaction, InstrumentInfo, OrderBook, OrderRequest, OrderResult, Position } from './types.js';
export interface BybitClientOptions {
    apiKey: string;
    apiSecret: string;
    testnet?: boolean;
}
export declare class BybitClient implements IExchangeClient {
    readonly exchangeName: 'bybit';
    private readonly baseUrl;
    private readonly apiKey;
    private readonly apiSecret;
    private readonly rateLimiter;
    private timeOffsetMs;
    private hasSyncedTime;
    constructor(options: BybitClientOptions);
    syncTime(): Promise<number>;
    private requestApi;
    getServerTime(): Promise<number>;
    getInstruments(): Promise<InstrumentInfo[]>;
    getFundingRates(): Promise<FundingRateInfo[]>;
    getOrderBook(symbol: string, limit?: number): Promise<OrderBook>;
    getBalances(): Promise<AccountBalance[]>;
    getPositions(symbol?: string): Promise<Position[]>;
    getCommissionRates(symbol: string): Promise<CommissionRates>;
    placeMarketOrder(order: OrderRequest): Promise<OrderResult>;
    getOrderStatus(symbol: string, clientOrderId: string, exchangeOrderId?: string): Promise<OrderResult>;
    private mapBybitOrder;
    getFundingHistory(symbol: string, startTime?: number, limit?: number): Promise<FundingTransaction[]>;
    getMaxLeverage(symbol: string): Promise<number>;
    setLeverage(symbol: string, leverage: number): Promise<boolean>;
}
//# sourceMappingURL=bybit.client.d.ts.map