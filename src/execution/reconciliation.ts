import { IExchangeClient } from '../exchanges/exchange.interface.js';
import { OrderResult, Position } from '../exchanges/types.js';
import { FillRepository, PositionSnapshotRepository } from '../persistence/repositories.js';
import { ReconciliationResult } from './types.js';
import { Decimal, toDecimal } from '../utils/decimal.js';
import { logger } from '../utils/logger.js';

export class ExecutionReconciliation {
  constructor(
    private binanceClient: IExchangeClient,
    private bybitClient: IExchangeClient,
    private fillRepo: FillRepository,
    private snapshotRepo: PositionSnapshotRepository
  ) {}

  async reconcilePositions(tradeId: string, binanceSymbol: string, bybitSymbol: string): Promise<ReconciliationResult> {
    const [bPositions, byPositions] = await Promise.all([
      this.binanceClient.getPositions(binanceSymbol),
      this.bybitClient.getPositions(bybitSymbol),
    ]);

    const bPos = bPositions.find((p) => p.symbol === binanceSymbol);
    const byPos = byPositions.find((p) => p.symbol === bybitSymbol);

    const bQty = bPos ? bPos.quantity : toDecimal('0');
    const byQty = byPos ? byPos.quantity : toDecimal('0');
    const bPrice = bPos ? bPos.markPrice : toDecimal('0');
    const byPrice = byPos ? byPos.markPrice : toDecimal('0');

    const bNotional = bQty.times(bPrice);
    const byNotional = byQty.times(byPrice);

    // Save position snapshots
    const now = new Date().toISOString();
    if (bPos) {
      this.snapshotRepo.create({
        id: `snap-b-${Date.now()}-${Math.floor(Math.random() * 1000000)}`,
        trade_id: tradeId,
        exchange: 'binance',
        symbol: binanceSymbol,
        side: bPos.side,
        quantity: bPos.quantity.toString(),
        entry_price: bPos.entryPrice.toString(),
        mark_price: bPos.markPrice.toString(),
        unrealized_pnl: bPos.unrealizedPnl.toString(),
        leverage: bPos.leverage.toString(),
        timestamp: now,
      });
    }

    if (byPos) {
      this.snapshotRepo.create({
        id: `snap-by-${Date.now()}-${Math.floor(Math.random() * 1000000)}`,
        trade_id: tradeId,
        exchange: 'bybit',
        symbol: bybitSymbol,
        side: byPos.side,
        quantity: byPos.quantity.toString(),
        entry_price: byPos.entryPrice.toString(),
        mark_price: byPos.markPrice.toString(),
        unrealized_pnl: byPos.unrealizedPnl.toString(),
        leverage: byPos.leverage.toString(),
        timestamp: now,
      });
    }

    const isFlat = bQty.isZero() && byQty.isZero();
    const bothFilled = bQty.isPositive() && !bQty.isZero() && byQty.isPositive() && !byQty.isZero();
    const oneLegFailed = (bQty.isZero() && !byQty.isZero()) || (!bQty.isZero() && byQty.isZero());

    // Residual mismatch
    let mismatchPct = toDecimal('0');
    const avgNotional = bNotional.plus(byNotional).dividedBy(2);
    if (!avgNotional.isZero()) {
      mismatchPct = bNotional.minus(byNotional).abs().dividedBy(avgNotional).times('100');
    }

    return {
      binanceExecutedQty: bQty,
      bybitExecutedQty: byQty,
      binanceAvgPrice: bPos ? bPos.entryPrice : toDecimal('0'),
      bybitAvgPrice: byPos ? byPos.entryPrice : toDecimal('0'),
      binanceNotionalUsd: bNotional,
      bybitNotionalUsd: byNotional,
      residualMismatchPct: mismatchPct,
      bothLegsFilled: bothFilled,
      oneLegFailed,
      isFlat,
      errors: [],
    };
  }

  recordFills(tradeId: string, bOrder: OrderResult | null, byOrder: OrderResult | null): void {
    const now = new Date().toISOString();
    if (bOrder && bOrder.executedQuantity.isPositive() && !bOrder.executedQuantity.isZero()) {
      this.fillRepo.create({
        id: `fill-b-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        order_id: bOrder.clientOrderId,
        trade_id: tradeId,
        exchange: 'binance',
        exchange_execution_id: bOrder.exchangeOrderId,
        price: bOrder.averagePrice.toString(),
        quantity: bOrder.executedQuantity.toString(),
        fee: bOrder.fee.toString(),
        fee_currency: bOrder.feeCurrency,
        timestamp: now,
      });
    }

    if (byOrder && byOrder.executedQuantity.isPositive() && !byOrder.executedQuantity.isZero()) {
      this.fillRepo.create({
        id: `fill-by-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        order_id: byOrder.clientOrderId,
        trade_id: tradeId,
        exchange: 'bybit',
        exchange_execution_id: byOrder.exchangeOrderId,
        price: byOrder.averagePrice.toString(),
        quantity: byOrder.executedQuantity.toString(),
        fee: byOrder.fee.toString(),
        fee_currency: byOrder.feeCurrency,
        timestamp: now,
      });
    }
  }
}
