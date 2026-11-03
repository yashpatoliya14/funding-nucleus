import { IExchangeClient } from '../exchanges/exchange.interface.js';
import { TelegramNotifier } from '../notifications/telegram.js';
import { OrderManager } from '../execution/order-manager.js';
import { logger } from '../utils/logger.js';

export interface MarginStatus {
  needsRebalance: boolean;
  isCritical: boolean;
  binanceAvailable: number;
  bybitAvailable: number;
  binanceUnrealizedPnl: number;
  bybitUnrealizedPnl: number;
  losingExchange?: 'Binance' | 'Bybit';
  winningExchange?: 'Binance' | 'Bybit';
  recommendedTransferUsd: number;
  reason?: string;
}

function normalizeSymbol(symbol: string): string {
  return symbol.toUpperCase().replace(/^1000000|^100000|^10000|^1000/, '').replace(/USDT$|USDC$/, '');
}

export class MarginMonitor {
  private lastAlertTimestamp: number = 0;

  constructor(
    private binanceClient: IExchangeClient,
    private bybitClient: IExchangeClient,
    private telegram?: TelegramNotifier,
    private warningThresholdUsd: number = 3.50,
    private criticalThresholdUsd: number = 1.50,
    private orderManager?: OrderManager
  ) {}

  async checkMarginBalance(symbol?: string): Promise<MarginStatus> {
    try {
      const [binanceBalances, bybitBalances, binancePositions, bybitPositions] = await Promise.allSettled([
        this.binanceClient.getBalances(),
        this.bybitClient.getBalances(),
        this.binanceClient.getPositions(symbol),
        this.bybitClient.getPositions(symbol),
      ]);

      let biAvail = 0;
      let biUnPnl = 0;
      if (binanceBalances.status === 'fulfilled') {
        const usdt = binanceBalances.value.find((b) => b.asset === 'USDT');
        biAvail = usdt ? parseFloat(usdt.availableBalance.toString()) : 0;
        if (usdt && usdt.unrealizedPnl && !usdt.unrealizedPnl.isZero()) {
          biUnPnl = parseFloat(usdt.unrealizedPnl.toString());
        }
      }
      if (biUnPnl === 0 && binancePositions.status === 'fulfilled') {
        for (const p of binancePositions.value) {
          if (p.side !== 'FLAT') {
            biUnPnl += parseFloat(p.unrealizedPnl.toString());
          }
        }
      }

      let byAvail = 0;
      let byUnPnl = 0;
      if (bybitBalances.status === 'fulfilled') {
        const usdt = bybitBalances.value.find((b) => b.asset === 'USDT');
        byAvail = usdt ? parseFloat(usdt.availableBalance.toString()) : 0;
        if (usdt && usdt.unrealizedPnl && !usdt.unrealizedPnl.isZero()) {
          byUnPnl = parseFloat(usdt.unrealizedPnl.toString());
        }
      }
      if (byUnPnl === 0 && bybitPositions.status === 'fulfilled') {
        for (const p of bybitPositions.value) {
          if (p.side !== 'FLAT') {
            byUnPnl += parseFloat(p.unrealizedPnl.toString());
          }
        }
      }

      const isBiLow = biAvail < this.warningThresholdUsd;
      const isByLow = byAvail < this.warningThresholdUsd;
      const isCritical = biAvail < this.criticalThresholdUsd || byAvail < this.criticalThresholdUsd;

      // Imbalance check: one exchange has low margin (< $3.50), AND there is meaningful divergence (P&L drift or >= $2 balance spread)
      const hasPnlDrift = Math.abs(biUnPnl) >= 0.20 || Math.abs(byUnPnl) >= 0.20;
      const hasBalanceSkew = Math.abs(biAvail - byAvail) >= 2.00;

      if ((isBiLow || isByLow) && (hasPnlDrift || hasBalanceSkew)) {
        const losingExchange = biAvail < byAvail ? 'Binance' : 'Bybit';
        const winningExchange = losingExchange === 'Binance' ? 'Bybit' : 'Binance';
        const lowerBal = Math.min(biAvail, byAvail);
        const higherBal = Math.max(biAvail, byAvail);
        const diff = higherBal - lowerBal;
        const recommendedTransfer = Math.max(1, Math.round((diff / 2) * 100) / 100);

        const status: MarginStatus = {
          needsRebalance: true,
          isCritical,
          binanceAvailable: biAvail,
          bybitAvailable: byAvail,
          binanceUnrealizedPnl: biUnPnl,
          bybitUnrealizedPnl: byUnPnl,
          losingExchange,
          winningExchange,
          recommendedTransferUsd: recommendedTransfer,
          reason: `Available margin on ${losingExchange} ($${lowerBal.toFixed(2)}) is below safety threshold ($${this.warningThresholdUsd.toFixed(2)})`,
        };

        await this.maybeSendRebalanceAlert(status);
        return status;
      }

      return {
        needsRebalance: false,
        isCritical: false,
        binanceAvailable: biAvail,
        bybitAvailable: byAvail,
        binanceUnrealizedPnl: biUnPnl,
        bybitUnrealizedPnl: byUnPnl,
        recommendedTransferUsd: 0,
      };
    } catch (err: any) {
      logger.warn({ err: err?.message }, 'Failed to check margin balance');
      return {
        needsRebalance: false,
        isCritical: false,
        binanceAvailable: 0,
        bybitAvailable: 0,
        binanceUnrealizedPnl: 0,
        bybitUnrealizedPnl: 0,
        recommendedTransferUsd: 0,
      };
    }
  }

  private async maybeSendRebalanceAlert(status: MarginStatus): Promise<void> {
    if (!this.telegram || !status.needsRebalance) return;

    const now = Date.now();
    const minIntervalMs = status.isCritical ? 3 * 60 * 1000 : 15 * 60 * 1000;
    if (now - this.lastAlertTimestamp < minIntervalMs) {
      return;
    }
    this.lastAlertTimestamp = now;

    const biPnlSign = status.binanceUnrealizedPnl >= 0 ? '+' : '';
    const byPnlSign = status.bybitUnrealizedPnl >= 0 ? '+' : '';
    const emoji = status.isCritical ? '🚨' : '⚠️';

    const msg = [
      `${emoji} *MARGIN REBALANCE ALERT*`,
      ``,
      `Market price movement has produced profit on one exchange and loss on the other:`,
      `• *Binance Futures:*`,
      `  - Available Margin: \`$${status.binanceAvailable.toFixed(2)} USDT\``,
      `  - Unrealized PnL: \`${biPnlSign}$${status.binanceUnrealizedPnl.toFixed(2)} USDT\``,
      `• *Bybit Unified:*`,
      `  - Available Margin: \`$${status.bybitAvailable.toFixed(2)} USDT\``,
      `  - Unrealized PnL: \`${byPnlSign}$${status.bybitUnrealizedPnl.toFixed(2)} USDT\``,
      ``,
      `💡 *Action Required:*`,
      `Transfer *~$${status.recommendedTransferUsd.toFixed(2)} USDT* from *${status.winningExchange}* to *${status.losingExchange}* to balance your margin and eliminate liquidation risk.`,
    ].join('\n');

    await this.telegram.sendMessage(msg);
  }

  async checkAndRecoverOrphanPositions(): Promise<boolean> {
    try {
      const [binancePositions, bybitPositions] = await Promise.all([
        this.binanceClient.getPositions(),
        this.bybitClient.getPositions(),
      ]);

      const activeBi = binancePositions.filter((p) => p.side !== 'FLAT' && !p.quantity.isZero());
      const activeBy = bybitPositions.filter((p) => p.side !== 'FLAT' && !p.quantity.isZero());

      if (activeBi.length === 0 && activeBy.length === 0) {
        return false;
      }

      // Check if Binance has orphan positions where Bybit has zero (e.g. Bybit was liquidated)
      for (const bPos of activeBi) {
        const bNorm = normalizeSymbol(bPos.symbol);
        const match = activeBy.find(
          (by) => normalizeSymbol(by.symbol) === bNorm || by.symbol.toUpperCase() === bPos.symbol.toUpperCase()
        );
        if (!match || match.quantity.isZero() || match.side === 'FLAT') {
          logger.error(
            { symbol: bPos.symbol, side: bPos.side, qty: bPos.quantity.toString() },
            'CRITICAL: Unhedged orphan position detected on Binance! Bybit leg is missing (liquidated or closed).'
          );

          if (this.orderManager) {
            const closeSide = bPos.side === 'LONG' ? 'SELL' : 'BUY';
            await this.orderManager.executeMarketOrder(
              this.binanceClient,
              `liq-orphan-${Date.now()}`,
              bPos.symbol,
              closeSide,
              bPos.quantity,
              'RECOVERY',
              true
            );
          }

          if (this.telegram) {
            const msg = [
              `🚨 *EMERGENCY: LIQUIDATION AUTO-PROTECTION* 🚨`,
              ``,
              `⚠️ *One of your position legs was liquidated or closed by the exchange!*`,
              `• *Symbol:* \`${bPos.symbol}\``,
              `• *Liquidated Leg:* *Bybit* (Position: \`0\`)`,
              `• *Surviving Leg:* *Binance* (Position: \`${bPos.side} ${bPos.quantity.toString()}\`)`,
              ``,
              `⚡ *INSTANT SAFETY ACTION:*`,
              `The bot immediately placed an **emergency reduce-only market close order** on *Binance* to eliminate unhedged directional exposure!`,
              ``,
              `🛡️ *Binance position has been flattened.*`,
            ].join('\n');
            await this.telegram.sendMessage(msg);
          }
          return true;
        }
      }

      // Check if Bybit has orphan positions where Binance has zero (e.g. Binance was liquidated)
      for (const byPos of activeBy) {
        const byNorm = normalizeSymbol(byPos.symbol);
        const match = activeBi.find(
          (bi) => normalizeSymbol(bi.symbol) === byNorm || bi.symbol.toUpperCase() === byPos.symbol.toUpperCase()
        );
        if (!match || match.quantity.isZero() || match.side === 'FLAT') {
          logger.error(
            { symbol: byPos.symbol, side: byPos.side, qty: byPos.quantity.toString() },
            'CRITICAL: Unhedged orphan position detected on Bybit! Binance leg is missing (liquidated or closed).'
          );

          if (this.orderManager) {
            const closeSide = byPos.side === 'LONG' ? 'SELL' : 'BUY';
            await this.orderManager.executeMarketOrder(
              this.bybitClient,
              `liq-orphan-${Date.now()}`,
              byPos.symbol,
              closeSide,
              byPos.quantity,
              'RECOVERY',
              true
            );
          }

          if (this.telegram) {
            const msg = [
              `🚨 *EMERGENCY: LIQUIDATION AUTO-PROTECTION* 🚨`,
              ``,
              `⚠️ *One of your position legs was liquidated or closed by the exchange!*`,
              `• *Symbol:* \`${byPos.symbol}\``,
              `• *Liquidated Leg:* *Binance* (Position: \`0\`)`,
              `• *Surviving Leg:* *Bybit* (Position: \`${byPos.side} ${byPos.quantity.toString()}\`)`,
              ``,
              `⚡ *INSTANT SAFETY ACTION:*`,
              `The bot immediately placed an **emergency reduce-only market close order** on *Bybit* to eliminate unhedged directional exposure!`,
              ``,
              `🛡️ *Bybit position has been flattened.*`,
            ].join('\n');
            await this.telegram.sendMessage(msg);
          }
          return true;
        }
      }

      return false;
    } catch (err: any) {
      logger.error({ err: err?.message }, 'Failed to check and recover orphan positions');
      return false;
    }
  }
}

