import { IExchangeClient } from '../exchanges/exchange.interface.js';
import { RiskEventRepository } from '../persistence/repositories.js';
import { logger } from '../utils/logger.js';
import { Decimal } from '../utils/decimal.js';

export class KillSwitch {
  private active: boolean = false;
  private reason: string | null = null;

  constructor(
    private binanceClient: IExchangeClient,
    private bybitClient: IExchangeClient,
    private riskRepo: RiskEventRepository
  ) {}

  public isEngaged(): boolean {
    return this.active;
  }

  public getReason(): string | null {
    return this.reason;
  }

  public activate(reason: string): void {
    this.active = true;
    this.reason = reason;
    logger.error({ reason }, 'EMERGENCY KILL SWITCH ENGAGED! Immediate trading stop.');

    this.riskRepo.record({
      id: `ks-${Date.now()}`,
      event_type: 'KILL_SWITCH_ACTIVATED',
      rule_name: 'KILL_SWITCH',
      trade_id: null,
      details: JSON.stringify({ reason, timestamp: new Date().toISOString() }),
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Flattens all existing positions on both exchanges using reduce-only MARKET orders.
   */
  async emergencyFlatten(): Promise<{ flattenedCount: number; errors: string[] }> {
    logger.warn('Executing emergency flatten across Binance and Bybit positions');
    const errors: string[] = [];
    let flattenedCount = 0;

    // 1. Binance positions
    try {
      const bPositions = await this.binanceClient.getPositions();
      for (const p of bPositions) {
        if (p.quantity.isZero() || p.side === 'FLAT') continue;
        const closeSide = p.side === 'LONG' ? 'SELL' : 'BUY';
        logger.info({ exchange: 'binance', symbol: p.symbol, side: closeSide, qty: p.quantity.toString() }, 'Emergency closing position');
        try {
          await this.binanceClient.placeMarketOrder({
            symbol: p.symbol,
            side: closeSide,
            orderType: 'MARKET',
            quantity: p.quantity,
            clientOrderId: `emg-b-${Date.now()}`,
            reduceOnly: true,
          });
          flattenedCount++;
        } catch (err: any) {
          errors.push(`Binance flatten ${p.symbol} failed: ${err?.message}`);
        }
      }
    } catch (err: any) {
      errors.push(`Failed to fetch Binance positions: ${err?.message}`);
    }

    // 2. Bybit positions
    try {
      const byPositions = await this.bybitClient.getPositions();
      for (const p of byPositions) {
        if (p.quantity.isZero() || p.side === 'FLAT') continue;
        const closeSide = p.side === 'LONG' ? 'SELL' : 'BUY';
        logger.info({ exchange: 'bybit', symbol: p.symbol, side: closeSide, qty: p.quantity.toString() }, 'Emergency closing position');
        try {
          await this.bybitClient.placeMarketOrder({
            symbol: p.symbol,
            side: closeSide,
            orderType: 'MARKET',
            quantity: p.quantity,
            clientOrderId: `emg-by-${Date.now()}`,
            reduceOnly: true,
          });
          flattenedCount++;
        } catch (err: any) {
          errors.push(`Bybit flatten ${p.symbol} failed: ${err?.message}`);
        }
      }
    } catch (err: any) {
      errors.push(`Failed to fetch Bybit positions: ${err?.message}`);
    }

    this.riskRepo.record({
      id: `flatten-${Date.now()}`,
      event_type: 'EMERGENCY_FLATTEN',
      rule_name: 'KILL_SWITCH',
      trade_id: null,
      details: JSON.stringify({ flattenedCount, errors, timestamp: new Date().toISOString() }),
      timestamp: new Date().toISOString(),
    });

    return { flattenedCount, errors };
  }
}
