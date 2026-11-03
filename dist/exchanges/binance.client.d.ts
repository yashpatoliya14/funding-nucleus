import { IExchangeClient } from './exchange.interface.js';
import { AccountBalance, CommissionRates, FundingRateInfo, FundingTransaction, InstrumentInfo, OrderBook, OrderRequest, OrderResult, Position } from './types.js';
import { Decimal } from '../utils/decimal.js';
export interface BinanceClientOptions {
    apiKey: string;
    apiSecret: string;
    testnet?: boolean;
}
export declare class BinanceClient implements IExchangeClient {
    readonly exchangeName: 'binance';
    private readonly baseUrl;
    private readonly apiKey;
    private readonly apiSecret;
    private readonly rateLimiter;
    private timeOffsetMs;
    private hasSyncedTime;
    private isDualSidePosition;
    private fundingIntervalCache;
    private lastFundingIntervalFetchMs;
    private readonly INTERVAL_CACHE_TTL_MS;
    constructor(options: BinanceClientOptions);
    syncTime(): Promise<number>;
    private requestApi;
    getServerTime(): Promise<number>;
    getInstruments(): Promise<InstrumentInfo[]>;
    getFundingRates(): Promise<FundingRateInfo[]>;
    getOrderBook(symbol: string, limit?: number): Promise<OrderBook>;
    getBalances(): Promise<AccountBalance[]>;
    getPositions(symbol?: string): Promise<Position[]>;
    getCommissionRates(symbol: string): Promise<CommissionRates>;
    syncPositionSideMode(): Promise<boolean>;
    placePostOnlyOrder(order: OrderRequest, price: Decimal): Promise<OrderResult>;
    cancelOrder(symbol: string, clientOrderId: string, exchangeOrderId?: string): Promise<boolean>;
    placeMarketOrder(order: OrderRequest): Promise<OrderResult>;
    getOrderStatus(symbol: string, clientOrderId: string, exchangeOrderId?: string): Promise<OrderResult>;
    getFundingHistory(symbol: string, startTime?: number, limit?: number): Promise<FundingTransaction[]>;
    getMaxLeverage(symbol: string): Promise<number>;
    setLeverage(symbol: string, leverage: number): Promise<boolean>;
}
//# sourceMappingURL=binance.client.d.ts.map