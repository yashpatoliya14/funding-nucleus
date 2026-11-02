import { IExchangeClient } from './exchange.interface.js';
import { AccountBalance, CommissionRates, FundingRateInfo, FundingTransaction, InstrumentInfo, OrderBook, OrderRequest, OrderResult, Position } from './types.js';
import { ExchangeName } from '../persistence/models.js';
import { Decimal } from '../utils/decimal.js';
export interface PaperClientOptions {
    exchangeName: ExchangeName;
    initialBalanceUsdt?: Decimal | number | string;
    takerFeeRate?: Decimal | number | string;
    makerFeeRate?: Decimal | number | string;
    simulateFailure?: 'NONE' | 'REJECT' | 'PARTIAL' | 'TIMEOUT';
}
export declare class PaperClient implements IExchangeClient {
    readonly exchangeName: ExchangeName;
    private balances;
    private positions;
    private orders;
    private fundingHistory;
    private books;
    private rates;
    private instruments;
    private takerFeeRate;
    private makerFeeRate;
    private failureMode;
    constructor(options: PaperClientOptions);
    setFailureMode(mode: 'NONE' | 'REJECT' | 'PARTIAL' | 'TIMEOUT'): void;
    mockOrderBook(book: OrderBook): void;
    mockFundingRate(rate: FundingRateInfo): void;
    mockInstrument(inst: InstrumentInfo): void;
    getServerTime(): Promise<number>;
    getInstruments(): Promise<InstrumentInfo[]>;
    getFundingRates(): Promise<FundingRateInfo[]>;
    getOrderBook(symbol: string, _limit?: number): Promise<OrderBook>;
    getBalances(): Promise<AccountBalance[]>;
    getPositions(symbol?: string): Promise<Position[]>;
    getCommissionRates(symbol: string): Promise<CommissionRates>;
    placeMarketOrder(order: OrderRequest): Promise<OrderResult>;
    getOrderStatus(_symbol: string, clientOrderId: string, _exchangeOrderId?: string): Promise<OrderResult>;
    getFundingHistory(symbol: string, _startTime?: number, _limit?: number): Promise<FundingTransaction[]>;
    recordSimulatedFunding(tx: FundingTransaction): void;
}
//# sourceMappingURL=paper.client.d.ts.map