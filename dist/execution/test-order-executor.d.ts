import { IExchangeClient } from '../exchanges/exchange.interface.js';
export interface TestOrderOptions {
    symbol?: string;
    side?: 'BUY' | 'SELL';
    autoClose?: boolean;
    holdSeconds?: number;
    leverage?: number;
}
export interface TestOrderSummary {
    success: boolean;
    exchange: string;
    symbol: string;
    entryPrice: string;
    qty: string;
    notionalUsd: string;
    openStatus: string;
    closeStatus?: string;
    error?: string;
}
export declare function executeTestOrder(exchange: IExchangeClient, options?: TestOrderOptions): Promise<TestOrderSummary>;
//# sourceMappingURL=test-order-executor.d.ts.map