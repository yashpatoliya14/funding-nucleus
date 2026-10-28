import { IExchangeClient } from '../exchanges/exchange.interface.js';
import { OrderManager } from './order-manager.js';
import { ExecutionReconciliation } from './reconciliation.js';
import { AppConfig } from '../config/schema.js';
import { RiskEventRepository } from '../persistence/repositories.js';
import { OrderSide } from '../persistence/models.js';
import { Decimal, toDecimal } from '../utils/decimal.js';
import { RecoveryFailedError, UnhedgedTimeoutError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/time.js';

export interface RecoveryActionPlan {
  action: 'COMPLETE_HEDGE' | 'CLOSE_FILLED_LEG' | 'ADJUST_MISMATCH' | 'NONE';
  exchangeToTrade?: 'binance' | 'bybit';
  side?: OrderSide;
  quantity?: Decimal;
  reason: string;
}

export class HedgeRecovery {
  constructor(
    private binanceClient: IExchangeClient,
    private bybitClient: IExchangeClient,
    private orderManager: OrderManager,
    private reconciliation: ExecutionReconciliation,
    private riskRepo: RiskEventRepository,
    private config: AppConfig
  ) {}

  async recover(
    tradeId: string,
    binanceSymbol: string,
    bybitSymbol: string,
    intendedDirection: 'SHORT_BINANCE_LONG_BYBIT' | 'LONG_BINANCE_SHORT_BYBIT',
    targetQuantityBinance: Decimal,
    targetQuantityBybit: Decimal
  ): Promise<{ success: boolean; isFlat: boolean; message: string }> {
    const startTime = Date.now();
    const maxUnhedgedMs = this.config.execution.maximum_unhedged_seconds * 1000;
    const maxRecoveryMs = this.config.execution.maximum_recovery_seconds * 1000;

    logger.warn({ tradeId, binanceSymbol, bybitSymbol }, 'Hedge recovery routine initiated');

    // 1. Initial Position Reconcile
    const initialRecon = await this.reconciliation.reconcilePositions(tradeId, binanceSymbol, bybitSymbol);

    // If already flat, nothing to recover
    if (initialRecon.isFlat) {
      return { success: true, isFlat: true, message: 'Both exchange accounts confirmed flat' };
    }

    // 2. Identify the failure state
    const bQty = initialRecon.binanceExecutedQty;
    const byQty = initialRecon.bybitExecutedQty;

    // Both filled, but check mismatch
    if (initialRecon.bothLegsFilled) {
      const maxMismatch = toDecimal(this.config.execution.maximum_notional_mismatch_pct);
      if (initialRecon.residualMismatchPct.lessThanOrEqualTo(maxMismatch)) {
        return {
          success: true,
          isFlat: false,
          message: `Both legs filled and mismatch is acceptable (${initialRecon.residualMismatchPct.toFixed(2)}% <= ${maxMismatch}%)`,
        };
      }

      // Adjust mismatch if feasible
      logger.info(
        { mismatchPct: initialRecon.residualMismatchPct.toFixed(2), maxMismatch: maxMismatch.toString() },
        'Adjusting residual notional mismatch'
      );
      // For simplicity and safety, if mismatch is above tolerance, close both legs
      return await this.flattenAllLegs(tradeId, binanceSymbol, bybitSymbol, 'Mismatch above tolerance');
    }

    // Exactly one leg is open (unhedged exposure!)
    const hasBinanceOpen = !bQty.isZero();
    const hasBybitOpen = !byQty.isZero();

    // Check elapsed unhedged duration limit
    const elapsed = Date.now() - startTime;
    if (elapsed > maxUnhedgedMs) {
      throw new UnhedgedTimeoutError(tradeId, elapsed / 1000, this.config.execution.maximum_unhedged_seconds);
    }

    // Decision: Close filled leg immediately using reduce-only market order to minimize directional risk
    logger.warn(
      { hasBinanceOpen, hasBybitOpen, elapsedMs: elapsed },
      'One leg failure detected. Safely aborting and flattening filled exposure'
    );

    return await this.flattenAllLegs(tradeId, binanceSymbol, bybitSymbol, 'One-leg failure abort and flatten');
  }

  async flattenAllLegs(
    tradeId: string,
    binanceSymbol: string,
    bybitSymbol: string,
    reason: string
  ): Promise<{ success: boolean; isFlat: boolean; message: string }> {
    logger.warn({ tradeId, reason }, 'Flattening all open positions for trade');

    const [bPositions, byPositions] = await Promise.all([
      this.binanceClient.getPositions(binanceSymbol),
      this.bybitClient.getPositions(bybitSymbol),
    ]);

    const bPos = bPositions.find((p) => p.symbol === binanceSymbol && !p.quantity.isZero() && p.side !== 'FLAT');
    const byPos = byPositions.find((p) => p.symbol === bybitSymbol && !p.quantity.isZero() && p.side !== 'FLAT');

    const closePromises: Promise<any>[] = [];

    if (bPos) {
      const closeSide = bPos.side === 'LONG' ? 'SELL' : 'BUY';
      closePromises.push(
        this.orderManager.executeMarketOrder(
          this.binanceClient,
          tradeId,
          binanceSymbol,
          closeSide,
          bPos.quantity,
          'RECOVERY',
          true // reduce-only
        )
      );
    }

    if (byPos) {
      const closeSide = byPos.side === 'LONG' ? 'SELL' : 'BUY';
      closePromises.push(
        this.orderManager.executeMarketOrder(
          this.bybitClient,
          tradeId,
          bybitSymbol,
          closeSide,
          byPos.quantity,
          'RECOVERY',
          true // reduce-only
        )
      );
    }

    await Promise.allSettled(closePromises);

    // Verify both positions are now flat
    await sleep(200);
    const finalRecon = await this.reconciliation.reconcilePositions(tradeId, binanceSymbol, bybitSymbol);

    this.riskRepo.record({
      id: `recov-${Date.now()}`,
      event_type: 'WARNING',
      rule_name: 'HEDGE_RECOVERY',
      trade_id: tradeId,
      details: JSON.stringify({ reason, isFlat: finalRecon.isFlat, finalRecon }),
      timestamp: new Date().toISOString(),
    });

    if (!finalRecon.isFlat) {
      throw new RecoveryFailedError(`Failed to flatten positions after recovery: ${reason}`, tradeId);
    }

    logger.info({ tradeId }, 'Hedge recovery completed: both accounts verified flat');
    return { success: true, isFlat: true, message: `Positions safely flattened: ${reason}` };
  }
}
