import { IExchangeClient } from '../exchanges/exchange.interface.js';
import { TelegramNotifier } from '../notifications/telegram.js';
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

export class MarginMonitor {
  private lastAlertTimestamp: number = 0;

  constructor(
    private binanceClient: IExchangeClient,
    private bybitClient: IExchangeClient,
    private telegram?: TelegramNotifier,
    private warningThresholdUsd: number = 3.50,
    private criticalThresholdUsd: number = 1.50
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
      }
      if (binancePositions.status === 'fulfilled') {
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
      }
      if (bybitPositions.status === 'fulfilled') {
        for (const p of bybitPositions.value) {
          if (p.side !== 'FLAT') {
            byUnPnl += parseFloat(p.unrealizedPnl.toString());
          }
        }
      }

      const isBiLow = biAvail < this.warningThresholdUsd;
      const isByLow = byAvail < this.warningThresholdUsd;
      const isCritical = biAvail < this.criticalThresholdUsd || byAvail < this.criticalThresholdUsd;

      // Only trigger if an active imbalance exists (one side has open positions or adverse pnl)
      if ((isBiLow || isByLow) && (Math.abs(biUnPnl) > 0.05 || Math.abs(byUnPnl) > 0.05 || biAvail !== byAvail)) {
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
}
