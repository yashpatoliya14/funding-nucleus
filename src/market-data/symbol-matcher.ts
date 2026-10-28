import { IExchangeClient } from '../exchanges/exchange.interface.js';
import { InstrumentInfo } from '../exchanges/types.js';
import { DbSymbolMapping } from '../persistence/models.js';
import { Decimal, maxDecimal } from '../utils/decimal.js';
import { logger } from '../utils/logger.js';

export interface MatchedPair {
  normalizedSymbol: string;
  binanceInstrument: InstrumentInfo;
  bybitInstrument: InstrumentInfo;
  contractMultiplier: Decimal;
  minQuantity: Decimal;
  quantityStep: Decimal;
  priceTick: Decimal;
}

export class SymbolMatcher {
  constructor(
    private binanceClient: IExchangeClient,
    private bybitClient: IExchangeClient
  ) {}

  async matchInstruments(): Promise<MatchedPair[]> {
    logger.info('Fetching instruments from Binance and Bybit for symbol matching');
    const [binanceInsts, bybitInsts] = await Promise.all([
      this.binanceClient.getInstruments(),
      this.bybitClient.getInstruments(),
    ]);

    const bybitMap = new Map<string, InstrumentInfo>();
    for (const inst of bybitInsts) {
      if (inst.isActive && inst.contractType === 'PERPETUAL' && inst.quoteAsset === 'USDT' && inst.settleAsset === 'USDT') {
        bybitMap.set(inst.baseAsset.toUpperCase(), inst);
      }
    }

    const matchedPairs: MatchedPair[] = [];

    for (const bInst of binanceInsts) {
      if (!bInst.isActive || bInst.contractType !== 'PERPETUAL' || bInst.quoteAsset !== 'USDT' || bInst.settleAsset !== 'USDT') {
        continue;
      }

      const baseAsset = bInst.baseAsset.toUpperCase();
      const bybitInst = bybitMap.get(baseAsset);

      if (!bybitInst) {
        continue;
      }

      // Check contract multiplier compatibility
      if (!bInst.contractMultiplier.equals(bybitInst.contractMultiplier)) {
        logger.warn(
          { baseAsset, binanceMult: bInst.contractMultiplier.toString(), bybitMult: bybitInst.contractMultiplier.toString() },
          'Skipping pair due to contract multiplier mismatch'
        );
        continue;
      }

      // Compute conservative common constraints (max minQuantity, max quantityStep, max priceTick)
      const commonMinQty = maxDecimal(bInst.minQuantity, bybitInst.minQuantity);
      const commonQtyStep = maxDecimal(bInst.quantityStep, bybitInst.quantityStep);
      const commonPriceTick = maxDecimal(bInst.priceTick, bybitInst.priceTick);

      matchedPairs.push({
        normalizedSymbol: baseAsset,
        binanceInstrument: bInst,
        bybitInstrument: bybitInst,
        contractMultiplier: bInst.contractMultiplier,
        minQuantity: commonMinQty,
        quantityStep: commonQtyStep,
        priceTick: commonPriceTick,
      });
    }

    logger.info({ matchedCount: matchedPairs.length }, 'Symbol matching completed successfully');
    return matchedPairs;
  }

  static toDbMapping(pair: MatchedPair, ttlHours: number = 24): DbSymbolMapping {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlHours * 3600 * 1000);

    return {
      id: `${pair.binanceInstrument.symbol}_${pair.bybitInstrument.symbol}`,
      normalized_symbol: pair.normalizedSymbol,
      binance_symbol: pair.binanceInstrument.symbol,
      bybit_symbol: pair.bybitInstrument.symbol,
      base_asset: pair.normalizedSymbol,
      quote_asset: 'USDT',
      contract_multiplier: pair.contractMultiplier.toString(),
      min_quantity: pair.minQuantity.toString(),
      quantity_step: pair.quantityStep.toString(),
      price_tick: pair.priceTick.toString(),
      binance_status: pair.binanceInstrument.isActive ? 'TRADING' : 'DISABLED',
      bybit_status: pair.bybitInstrument.isActive ? 'Trading' : 'Disabled',
      is_active: pair.binanceInstrument.isActive && pair.bybitInstrument.isActive ? 1 : 0,
      last_validated_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    };
  }
}
