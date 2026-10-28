import { IExchangeClient } from '../exchanges/exchange.interface.js';
import { OrderRequest, OrderResult } from '../exchanges/types.js';
import { OrderRepository } from '../persistence/repositories.js';
import { DbOrder, ExchangeName, OrderSide } from '../persistence/models.js';
import { Decimal, toDecimal } from '../utils/decimal.js';
import { logger } from '../utils/logger.js';

export class OrderManager {
  constructor(private orderRepo: OrderRepository) {}

  generateClientOrderId(exchange: ExchangeName, tradeId: string, side: OrderSide, purpose: string): string {
    const shortTradeId = tradeId.replace(/-/g, '').slice(0, 8);
    const ts = Date.now().toString().slice(-6);
    return `arb_${exchange.slice(0, 2)}_${shortTradeId}_${purpose.slice(0, 3)}_${ts}`;
  }

  async executeMarketOrder(
    client: IExchangeClient,
    tradeId: string,
    symbol: string,
    side: OrderSide,
    quantity: Decimal,
    purpose: 'ENTRY' | 'EXIT' | 'RECOVERY',
    reduceOnly: boolean = false
  ): Promise<OrderResult> {
    const exchange = client.exchangeName;
    const clientOrderId = this.generateClientOrderId(exchange, tradeId, side, purpose);
    const now = new Date().toISOString();

    // 1. Persist order intent in SQLite BEFORE network call
    const dbOrder: DbOrder = {
      id: `ord-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      trade_id: tradeId,
      exchange,
      client_order_id: clientOrderId,
      exchange_order_id: null,
      symbol,
      side,
      order_type: 'MARKET',
      requested_quantity: quantity.toString(),
      executed_quantity: '0',
      average_price: '0',
      status: 'PENDING',
      is_reduce_only: reduceOnly ? 1 : 0,
      is_recovery: purpose === 'RECOVERY' ? 1 : 0,
      purpose,
      error_message: null,
      created_at: now,
      updated_at: now,
    };
    this.orderRepo.create(dbOrder);

    const orderReq: OrderRequest = {
      symbol,
      side,
      orderType: 'MARKET',
      quantity,
      clientOrderId,
      reduceOnly,
    };

    logger.info({ exchange, symbol, side, qty: quantity.toString(), clientOrderId, purpose }, 'Submitting MARKET order');

    try {
      const result = await client.placeMarketOrder(orderReq);

      // If status is PENDING, query exchange to obtain confirmed fill details
      let confirmedResult = result;
      if (result.status === 'PENDING') {
        try {
          confirmedResult = await client.getOrderStatus(symbol, clientOrderId, result.exchangeOrderId || undefined);
        } catch (statusErr) {
          logger.warn({ statusErr, clientOrderId }, 'Could not immediately query status, keeping initial order result');
        }
      }

      // Update SQLite record with execution details
      this.orderRepo.update({
        id: dbOrder.id,
        exchange_order_id: confirmedResult.exchangeOrderId,
        status: confirmedResult.status,
        executed_quantity: confirmedResult.executedQuantity.toString(),
        average_price: confirmedResult.averagePrice.toString(),
      });

      return confirmedResult;
    } catch (error: any) {
      logger.error({ error: error?.message, clientOrderId }, 'Order placement threw exception. Querying exchange status...');
      
      // Do NOT blindly resubmit! Reconcile order status on exchange
      try {
        const recoveredResult = await client.getOrderStatus(symbol, clientOrderId);
        logger.info({ clientOrderId, status: recoveredResult.status }, 'Recovered order status from exchange after network error');
        this.orderRepo.update({
          id: dbOrder.id,
          exchange_order_id: recoveredResult.exchangeOrderId,
          status: recoveredResult.status,
          executed_quantity: recoveredResult.executedQuantity.toString(),
          average_price: recoveredResult.averagePrice.toString(),
        });
        return recoveredResult;
      } catch (statusErr: any) {
        logger.error({ statusErr: statusErr?.message, clientOrderId }, 'Order status could not be found on exchange. Marking REJECTED');
        this.orderRepo.update({
          id: dbOrder.id,
          status: 'REJECTED',
          error_message: error?.message || 'Order submission failed and status could not be recovered',
        });
        throw error;
      }
    }
  }
}
