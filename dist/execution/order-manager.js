import { logger } from '../utils/logger.js';
export class OrderManager {
    orderRepo;
    constructor(orderRepo) {
        this.orderRepo = orderRepo;
    }
    generateClientOrderId(exchange, tradeId, side, purpose) {
        const shortTradeId = tradeId.replace(/-/g, '').slice(0, 8);
        const ts = Date.now().toString().slice(-6);
        const rand = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
        return `arb_${exchange.slice(0, 2)}_${shortTradeId}_${purpose.slice(0, 3)}_${ts}_${rand}`;
    }
    async executeMakerOrder(client, tradeId, symbol, side, quantity, price, purpose = 'ENTRY') {
        const exchange = client.exchangeName;
        const clientOrderId = this.generateClientOrderId(exchange, tradeId, side, purpose);
        const now = new Date().toISOString();
        const dbOrder = {
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
            average_price: price.toString(),
            status: 'PENDING',
            is_reduce_only: 0,
            is_recovery: 0,
            purpose,
            error_message: null,
            created_at: now,
            updated_at: now,
        };
        this.orderRepo.create(dbOrder);
        const orderReq = {
            symbol,
            side,
            orderType: 'MARKET',
            quantity,
            clientOrderId,
            reduceOnly: false,
        };
        if (client.placePostOnlyOrder) {
            try {
                const result = await client.placePostOnlyOrder(orderReq, price);
                this.orderRepo.update({
                    id: dbOrder.id,
                    exchange_order_id: result.exchangeOrderId,
                    status: result.status,
                    executed_quantity: result.executedQuantity.toString(),
                    average_price: result.averagePrice.toString(),
                });
                return result;
            }
            catch (postOnlyErr) {
                logger.debug({ err: postOnlyErr?.message, clientOrderId }, 'PostOnly order failed or rejected as taker');
                throw postOnlyErr;
            }
        }
        return this.executeMarketOrder(client, tradeId, symbol, side, quantity, purpose, false);
    }
    async executeMarketOrder(client, tradeId, symbol, side, quantity, purpose, reduceOnly = false) {
        const exchange = client.exchangeName;
        const clientOrderId = this.generateClientOrderId(exchange, tradeId, side, purpose);
        const now = new Date().toISOString();
        // 1. Persist order intent in SQLite BEFORE network call
        const dbOrder = {
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
        const orderReq = {
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
                }
                catch (statusErr) {
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
        }
        catch (error) {
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
            }
            catch (statusErr) {
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
//# sourceMappingURL=order-manager.js.map