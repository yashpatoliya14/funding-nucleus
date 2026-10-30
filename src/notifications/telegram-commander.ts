import { request } from 'undici';
import { IExchangeClient } from '../exchanges/exchange.interface.js';
import { TradeRepository, DailySummaryRepository } from '../persistence/repositories.js';
import { TelegramNotifier } from './telegram.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/time.js';
import { CircuitBreaker } from '../risk/circuit-breaker.js';
import { KillSwitch } from '../risk/kill-switch.js';

export interface TelegramCommanderOptions {
  botToken: string;
  chatId: string;
  binanceClient: IExchangeClient;
  bybitClient: IExchangeClient;
  tradeRepo: TradeRepository;
  dailyRepo: DailySummaryRepository;
  circuitBreaker: CircuitBreaker;
  killSwitch: KillSwitch;
  telegramNotifier: TelegramNotifier;
  getOpportunitiesSnapshot?: () => Promise<any[]>;
}

export class TelegramCommander {
  private botToken: string;
  private chatId: string;
  private binanceClient: IExchangeClient;
  private bybitClient: IExchangeClient;
  private tradeRepo: TradeRepository;
  private dailyRepo: DailySummaryRepository;
  private circuitBreaker: CircuitBreaker;
  private killSwitch: KillSwitch;
  private telegramNotifier: TelegramNotifier;
  private getOpportunitiesSnapshot?: () => Promise<any[]>;
  private isPolling: boolean = false;
  private lastUpdateId: number = 0;

  constructor(options: TelegramCommanderOptions) {
    this.botToken = options.botToken;
    this.chatId = options.chatId;
    this.binanceClient = options.binanceClient;
    this.bybitClient = options.bybitClient;
    this.tradeRepo = options.tradeRepo;
    this.dailyRepo = options.dailyRepo;
    this.circuitBreaker = options.circuitBreaker;
    this.killSwitch = options.killSwitch;
    this.telegramNotifier = options.telegramNotifier;
    this.getOpportunitiesSnapshot = options.getOpportunitiesSnapshot;
  }

  public start(): void {
    if (this.isPolling) return;
    this.isPolling = true;
    logger.info({ chatId: this.chatId }, 'Telegram interactive command listener started');
    this.pollLoop().catch((err) => {
      logger.error({ err: err?.message }, 'Telegram command polling encountered unexpected fatal error');
    });
  }

  public stop(): void {
    this.isPolling = false;
  }

  private async pollLoop(): Promise<void> {
    while (this.isPolling) {
      try {
        const url = `https://api.telegram.org/bot${this.botToken}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=20`;
        const res = await request(url, { method: 'GET' });
        if (res.statusCode === 200) {
          const body: any = await res.body.json();
          if (body.ok && Array.isArray(body.result)) {
            for (const update of body.result) {
              this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
              if (update.message && update.message.text) {
                const senderChatId = String(update.message.chat?.id || '');
                // Authorization check: Only respond to authorized chat ID
                if (senderChatId === this.chatId) {
                  await this.handleMessage(update.message.text.trim());
                }
              }
            }
          }
        } else {
          await sleep(3000);
        }
      } catch (err: any) {
        // Sleep on network error then continue
        await sleep(3000);
      }
    }
  }

  private async handleMessage(text: string): Promise<void> {
    const rawCmd = text.toLowerCase().replace('/', '').trim();
    logger.info({ rawCmd }, 'Received Telegram command from authorized user');

    switch (rawCmd) {
      case 'help':
      case 'commands':
      case 'start':
      case 'menu':
        await this.handleHelp();
        break;

      case 'wallet':
      case 'balance':
      case 'balances':
        await this.handleWallet();
        break;

      case 'top':
      case 'top5':
      case 'diff':
      case 'rates':
      case 'funding':
        await this.handleTop5();
        break;

      case 'status':
      case 'info':
      case 'health':
        await this.handleStatus();
        break;

      case 'trades':
      case 'positions':
      case 'pos':
        await this.handleTrades();
        break;

      case 'flatten':
      case 'kill':
      case 'emergency':
        await this.handleEmergencyFlatten();
        break;

      default:
        // If unknown command, provide quick options
        await this.telegramNotifier.sendAlert(
          'Command Not Recognized',
          `Unknown command: \`${text}\`\n\nSend *help* to see available commands:\n• *wallet* - Check wallet balances\n• *top5* - Top 5 funding spreads\n• *status* - System & PnL status\n• *trades* - Open trades\n• *flatten* - Emergency kill-switch`,
          'INFO'
        );
        break;
    }
  }

  private async handleHelp(): Promise<void> {
    const msg = [
      `🤖 *ARBITRAGE BOT COMMAND MENU*`,
      `━━━━━━━━━━━━━━━━━━━━━━`,
      `• *wallet* (or *bal*) — Live Binance & Bybit balances & max safe trade size`,
      `• *top5* (or *diff*) — Top 5 highest funding diff coins with APR & direction`,
      `• *status* — System health, circuit breaker state, and today's PnL`,
      `• *trades* (or *pos*) — Currently active arbitrage positions`,
      `• *flatten* (or *kill*) — 🚨 Emergency kill-switch: closes all open positions`,
      `• *help* — Show this command menu`,
      `━━━━━━━━━━━━━━━━━━━━━━`,
      `_Tip: You can send commands with or without slash (e.g. "wallet" or "/wallet")_`,
    ].join('\n');

    await this.telegramNotifier.sendAlert('Interactive Command Menu', msg, 'INFO');
  }

  private async handleWallet(): Promise<void> {
    try {
      const [binanceBalances, bybitBalances] = await Promise.allSettled([
        this.binanceClient.getBalances(),
        this.bybitClient.getBalances(),
      ]);

      let biUsdt = 0;
      let biMargin = 0;
      let biTotal = 0;
      let biStatus = '✅ Connected';

      if (binanceBalances.status === 'fulfilled') {
        const usdt = binanceBalances.value.find((b) => b.asset === 'USDT');
        biUsdt = usdt ? parseFloat(usdt.availableBalance.toString()) : 0;
        biMargin = usdt ? parseFloat(usdt.marginBalance.toString()) : 0;
        biTotal = usdt ? parseFloat(usdt.walletBalance.toString()) : 0;
      } else {
        biStatus = '❌ Error (Check API Permissions)';
      }

      let byUsdt = 0;
      let byMargin = 0;
      let byTotal = 0;
      let byStatus = '✅ Connected';

      if (bybitBalances.status === 'fulfilled') {
        const usdt = bybitBalances.value.find((b) => b.asset === 'USDT');
        byUsdt = usdt ? parseFloat(usdt.availableBalance.toString()) : 0;
        byMargin = usdt ? parseFloat(usdt.marginBalance.toString()) : 0;
        byTotal = usdt ? parseFloat(usdt.walletBalance.toString()) : 0;
      } else {
        byStatus = '❌ Error (Check API Credentials)';
      }

      const bottleneck = Math.min(biUsdt, byUsdt);
      const safe3x = (bottleneck * 3).toFixed(2);
      const safe5x = (bottleneck * 5).toFixed(2);

      const msg = [
        `💼 *EXCHANGE WALLET AUDIT*`,
        `━━━━━━━━━━━━━━━━━━━━━━`,
        `🟡 *Binance Futures Wallet:* ${biStatus}`,
        `   • Available: \`$${biUsdt.toFixed(2)} USDT\``,
        `   • Margin: \`$${biMargin.toFixed(2)} USDT\``,
        `   • Total: \`$${biTotal.toFixed(2)} USDT\``,
        '',
        `⚫ *Bybit Unified Wallet:* ${byStatus}`,
        `   • Available: \`$${byUsdt.toFixed(2)} USDT\``,
        `   • Margin: \`$${byMargin.toFixed(2)} USDT\``,
        `   • Total: \`$${byTotal.toFixed(2)} USDT\``,
        '',
        `⚖️ *Capital Bottleneck:* \`$${bottleneck.toFixed(2)} USDT\``,
        `🚀 *Max Safe Trade Size (Per Leg):*`,
        `   • At 3x Leverage: \`$${safe3x}\``,
        `   • At 5x Leverage: \`$${safe5x}\``,
        `━━━━━━━━━━━━━━━━━━━━━━`,
      ].join('\n');

      await this.telegramNotifier.sendAlert('Wallet & Margin Status', msg, 'INFO');
    } catch (err: any) {
      await this.telegramNotifier.sendAlert('Wallet Query Error', `Failed to query wallets: ${err?.message}`, 'ERROR');
    }
  }

  private async handleTop5(): Promise<void> {
    try {
      if (this.getOpportunitiesSnapshot) {
        const opps = await this.getOpportunitiesSnapshot();
        if (opps && opps.length > 0) {
          const top5 = opps.slice(0, 5);
          const lines = top5.map((opp, idx) => {
            const coin = opp.mapping ? opp.mapping.normalized_symbol : opp.symbol || 'UNKNOWN';
            const edge = parseFloat((opp.fundingDiffPct || opp.diffPct || 0).toString()).toFixed(4);
            const bRate = (parseFloat((opp.binanceRate || opp.binanceRatePct || 0).toString()) * (opp.binanceRatePct ? 1 : 100)).toFixed(4);
            const byRate = (parseFloat((opp.bybitRate || opp.bybitRatePct || 0).toString()) * (opp.bybitRatePct ? 1 : 100)).toFixed(4);
            const bSign = parseFloat(bRate) > 0 ? '+' : '';
            const bySign = parseFloat(byRate) > 0 ? '+' : '';
            const apr = (parseFloat(edge) * 3 * 365).toFixed(1);
            return `${idx + 1}. *${coin}* | Diff: \`${edge}%\` (APR: \`${apr}%\`)\n   • BI: \`${bSign}${bRate}%\` | BY: \`${bySign}${byRate}%\``;
          });

          const msg = [
            `🔥 *TOP 5 FUNDING SPREADS (BINANCE vs BYBIT)*`,
            `━━━━━━━━━━━━━━━━━━━━━━`,
            lines.join('\n\n'),
            `━━━━━━━━━━━━━━━━━━━━━━`,
            `_Updated from live market scanner cache_`,
          ].join('\n');

          await this.telegramNotifier.sendAlert('Top 5 Funding Spreads', msg, 'INFO');
          return;
        }
      }

      await this.telegramNotifier.sendAlert(
        'Top 5 Funding Spreads',
        'Scanner is currently collecting order books. Send *top5* again in 10 seconds.',
        'INFO'
      );
    } catch (err: any) {
      await this.telegramNotifier.sendAlert('Scan Error', `Failed to retrieve spreads: ${err?.message}`, 'ERROR');
    }
  }

  private async handleStatus(): Promise<void> {
    try {
      const today = this.dailyRepo.getOrCreateToday();
      const activeTrades = this.tradeRepo.getActiveTrades();
      const isCbTripped = this.circuitBreaker.isTripped();
      const isKillEngaged = this.killSwitch.isEngaged();

      let health = '🟢 HEALTHY';
      if (isKillEngaged) health = '🔴 KILL SWITCH ENGAGED';
      else if (isCbTripped) health = '🟠 CIRCUIT BREAKER TRIPPED';

      const netPnl = parseFloat(today.net_pnl_usd.toString());
      const pnlSign = netPnl >= 0 ? '+' : '';

      const msg = [
        `📊 *SYSTEM & OPERATIONAL STATUS*`,
        `━━━━━━━━━━━━━━━━━━━━━━`,
        `• *System Health:* ${health}`,
        `• *Active Trades:* \`${activeTrades.length}\``,
        `• *Today Completed Trades:* \`${today.trade_count}\``,
        `• *Today Realized PnL:* \`${pnlSign}$${netPnl.toFixed(2)}\``,
        `• *Today Funding PnL:* \`$${parseFloat(today.total_funding_pnl_usd.toString()).toFixed(2)}\``,
        `• *Today Fees Paid:* \`-$${parseFloat(today.total_fees_usd.toString()).toFixed(2)}\``,
        `• *Loss Limit Reached:* \`${today.loss_limit_hit ? 'YES (HALTED)' : 'NO'}\``,
        `━━━━━━━━━━━━━━━━━━━━━━`,
      ].join('\n');

      await this.telegramNotifier.sendAlert('System Status', msg, 'INFO');
    } catch (err: any) {
      await this.telegramNotifier.sendAlert('Status Error', `Failed to query status: ${err?.message}`, 'ERROR');
    }
  }

  private async handleTrades(): Promise<void> {
    try {
      const activeTrades = this.tradeRepo.getActiveTrades();
      if (activeTrades.length === 0) {
        await this.telegramNotifier.sendAlert(
          'Active Positions',
          '🟢 *No open positions.* Engine is idle and scanning for opportunities.',
          'INFO'
        );
        return;
      }

      const lines = activeTrades.map((t, idx) => {
        return [
          `*${idx + 1}. ${t.coin}* (ID: \`${t.id.slice(0, 8)}\`)`,
          `• *State:* \`${t.state}\``,
          `• *Direction:* \`${t.direction}\``,
          `• *Leg Notional:* \`$${t.target_notional_usd}\``,
          `• *Exp Net Profit:* \`$${t.expected_net_profit_usd}\``,
        ].join('\n');
      });

      const msg = [
        `⚡ *ACTIVE OPEN POSITIONS (${activeTrades.length})*`,
        `━━━━━━━━━━━━━━━━━━━━━━`,
        lines.join('\n\n'),
        `━━━━━━━━━━━━━━━━━━━━━━`,
      ].join('\n');

      await this.telegramNotifier.sendAlert('Active Positions', msg, 'INFO');
    } catch (err: any) {
      await this.telegramNotifier.sendAlert('Trades Error', `Failed to query trades: ${err?.message}`, 'ERROR');
    }
  }

  private async handleEmergencyFlatten(): Promise<void> {
    try {
      await this.telegramNotifier.sendAlert(
        '🚨 EMERGENCY FLATTEN INITIATED 🚨',
        'Operator requested emergency flatten via Telegram. Liquidating all positions and engaging kill switch...',
        'WARN'
      );

      this.killSwitch.activate('Telegram operator emergency flatten command');
      await this.killSwitch.emergencyFlatten();

      await this.telegramNotifier.sendAlert(
        '✅ FLATTEN COMPLETE',
        'All open positions closed. Accounts verified flat. Kill switch is now active.',
        'INFO'
      );
    } catch (err: any) {
      await this.telegramNotifier.sendAlert('Emergency Flatten Error', `Flatten failed: ${err?.message}`, 'ERROR');
    }
  }
}
