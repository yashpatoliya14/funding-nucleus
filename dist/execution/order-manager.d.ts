import { IExchangeClient } from '../exchanges/exchange.interface.js';
import { OrderResult } from '../exchanges/types.js';
import { OrderRepository } from '../persistence/repositories.js';
import { ExchangeName, OrderSide } from '../persistence/models.js';
import { Decimal } from '../utils/decimal.js';
export declare class OrderManager {
    private orderRepo;
    constructor(orderRepo: OrderRepository);
    generateClientOrderId(exchange: ExchangeName, tradeId: string, side: OrderSide, purpose: string): string;
    executeMarketOrder(client: IExchangeClient, tradeId: string, symbol: string, side: OrderSide, quantity: Decimal, purpose: 'ENTRY' | 'EXIT' | 'RECOVERY', reduceOnly?: boolean): Promise<OrderResult>;
}
//# sourceMappingURL=order-manager.d.ts.map