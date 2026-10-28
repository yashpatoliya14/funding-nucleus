import { Decimal, roundToStep, toDecimal } from '../utils/decimal.js';
import { InstrumentInfo } from '../exchanges/types.js';
import { RiskLimitViolationError } from '../utils/errors.js';

export interface SizingResult {
  binanceQuantity: Decimal;
  bybitQuantity: Decimal;
  binanceActualNotionalUsd: Decimal;
  bybitActualNotionalUsd: Decimal;
  notionalMismatchPct: Decimal;
  appliedLeverage: number;
}

export class PositionSizer {
  static calculateSizing(
    targetNotionalUsd: Decimal | string | number,
    binancePrice: Decimal | string | number,
    bybitPrice: Decimal | string | number,
    binanceInst: InstrumentInfo,
    bybitInst: InstrumentInfo,
    defaultLeverageCap: number = 5,
    maxMismatchPct: Decimal | string | number = '0.5'
  ): SizingResult {
    const targetNotional = toDecimal(targetNotionalUsd);
    const bPrice = toDecimal(binancePrice);
    const byPrice = toDecimal(bybitPrice);
    const maxMismatch = toDecimal(maxMismatchPct);

    if (bPrice.isZero() || byPrice.isZero()) {
      throw new Error('Reference price cannot be zero for position sizing');
    }

    // Raw quantities needed for target notional
    // Qty = TargetNotional / (Price * contractMultiplier)
    const rawBQty = targetNotional.dividedBy(bPrice.times(binanceInst.contractMultiplier));
    const rawByQty = targetNotional.dividedBy(byPrice.times(bybitInst.contractMultiplier));

    // Round conservatively to step size
    const bQty = roundToStep(rawBQty, binanceInst.quantityStep);
    const byQty = roundToStep(rawByQty, bybitInst.quantityStep);

    // Validate minimum quantities
    if (bQty.lessThan(binanceInst.minQuantity)) {
      throw new RiskLimitViolationError(
        'MIN_QUANTITY_BINANCE',
        `Calculated Binance quantity ${bQty} is less than minimum ${binanceInst.minQuantity}`
      );
    }
    if (byQty.lessThan(bybitInst.minQuantity)) {
      throw new RiskLimitViolationError(
        'MIN_QUANTITY_BYBIT',
        `Calculated Bybit quantity ${byQty} is less than minimum ${bybitInst.minQuantity}`
      );
    }

    // Actual USD notionals
    const bActualNotional = bQty.times(bPrice).times(binanceInst.contractMultiplier);
    const byActualNotional = byQty.times(byPrice).times(bybitInst.contractMultiplier);

    // Calculate percentage mismatch relative to target notional
    const notionalDiff = bActualNotional.minus(byActualNotional).abs();
    const mismatchPct = notionalDiff.dividedBy(targetNotional).times('100');

    if (mismatchPct.greaterThan(maxMismatch)) {
      throw new RiskLimitViolationError(
        'NOTIONAL_MISMATCH',
        `Notional mismatch ${mismatchPct.toFixed(2)}% exceeds maximum allowed ${maxMismatch}% (Binance: $${bActualNotional.toFixed(2)}, Bybit: $${byActualNotional.toFixed(2)})`
      );
    }

    // Common leverage ceiling
    const appliedLeverage = Math.min(
      binanceInst.maxLeverage,
      bybitInst.maxLeverage,
      defaultLeverageCap
    );

    return {
      binanceQuantity: bQty,
      bybitQuantity: byQty,
      binanceActualNotionalUsd: bActualNotional,
      bybitActualNotionalUsd: byActualNotional,
      notionalMismatchPct: mismatchPct,
      appliedLeverage,
    };
  }
}
