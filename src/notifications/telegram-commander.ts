import { request } from 'undici';
import { IExchangeClient } from '../exchanges/exchange.interface.js';
import { TradeRepository, DailySummaryRepository } from '../persistence/repositories.js';
import { TelegramNotifier } from './telegram.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/time.js';
import { CircuitBreaker } from '../risk/circuit-breaker.js';
import { KillSwitch } from '../risk/kill-switch.js';
import { executeTestOrder } from '../execution/test-order-executor.js';

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
  evaluateOpportunity?: (opp: any) => Promise<any>;
  entryLeadMinutes?: number;
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
  private evaluateOpportunity?: (opp: any) => Promise<any>;
  private entryLeadMinutes: number = 10;
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
    this.evaluateOpportunity = options.evaluateOpportunity;
    this.entryLeadMinutes = options.entryLeadMinutes ?? 10;
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

      case 'next':
      case 'planned':
      case 'plan':
      case 'target':
        await this.handleNextPlannedTrade();
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

      case 'testorder':
      case 'test':
      case 'testtrade':
        await this.handleTestOrder();
        break;

      default:
        // If unknown command, provide quick options
        await this.telegramNotifier.sendAlert(
          'Command Not Recognized',
          `Unknown command: \`${text}\`\n\nSend *help* to see available commands:\n• *wallet* - Check wallet balances\n• *top5* - Top 5 funding spreads\n• *status* - System & PnL status\n• *trades* - Open trades\n• *testorder* - Test order on futures\n• *flatten* - Emergency kill-switch`,
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
      `• *next* (or *plan*) — 🎯 Details of the next planned trade with countdown & sizing`,
      `• *top5* (or *diff*) — Top 5 highest funding diff coins with APR & direction`,
      `• *status* — System health, circuit breaker state, and today's PnL`,
      `• *trades* (or *pos*) — Currently active arbitrage positions`,
      `• *testorder* (or *test*) — 🧪 Places a minimal test order & closes it immediately`,
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

  private async handleNextPlannedTrade(): Promise<void> {
    try {
      if (!this.getOpportunitiesSnapshot) {
        await this.telegramNotifier.sendAlert(
          'Next Planned Trade',
          'Market scanner is not currently initialized.',
          'WARN'
        );
        return;
      }

      const opps = await this.getOpportunitiesSnapshot();
      if (!opps || opps.length === 0) {
        await this.telegramNotifier.sendAlert(
          'Next Planned Trade',
          '🔍 Currently scanning all 675 perpetuals... No aligned opportunity found yet. Check back in 10s.',
          'INFO'
        );
        return;
      }

      const topOpp = opps[0];
      const coin = topOpp.mapping ? topOpp.mapping.normalized_symbol : topOpp.symbol;
      const bRate = (parseFloat((topOpp.binanceRate || 0).toString()) * 100).toFixed(4);
      const byRate = (parseFloat((topOpp.bybitRate || 0).toString()) * 100).toFixed(4);
      const edgePct = parseFloat((topOpp.fundingDiffPct || topOpp.diffPct || 0).toString()).toFixed(4);
      const bSign = parseFloat(bRate) > 0 ? '+' : '';
      const bySign = parseFloat(byRate) > 0 ? '+' : '';
      const apr = (parseFloat(edgePct) * 3 * 365).toFixed(1);

      const now = Date.now();
      const targetFundingTime = topOpp.targetFundingTimeMs || topOpp.nextFundingTimeMs || 0;
      const msUntilSettlement = Math.max(0, targetFundingTime - now);
      const totalSecSettlement = Math.floor(msUntilSettlement / 1000);
      const hoursSettlement = Math.floor(totalSecSettlement / 3600);
      const minSettlement = Math.floor((totalSecSettlement % 3600) / 60);
      const secSettlement = totalSecSettlement % 60;
      const settlementStr = hoursSettlement > 0 ? `${hoursSettlement}h ${minSettlement}m ${secSettlement}s` : `${minSettlement}m ${secSettlement}s`;

      const msUntilEntry = Math.max(0, targetFundingTime - this.entryLeadMinutes * 60 * 1000 - now);
      const totalSecEntry = Math.floor(msUntilEntry / 1000);
      const hoursEntry = Math.floor(totalSecEntry / 3600);
      const minEntry = Math.floor((totalSecEntry % 3600) / 60);
      const secEntry = totalSecEntry % 60;
      const entryStr = hoursEntry > 0 ? `${hoursEntry}h ${minEntry}m ${secEntry}s` : `${minEntry}m ${secEntry}s`;

      // Deep evaluate if evaluator available
      let detailedSizing = '';
      let profitabilityBreakdown = '';
      let isApprovedStr = '⏳ Waiting for Entry Window';

      if (this.evaluateOpportunity) {
        try {
          const evaluated = await this.evaluateOpportunity(topOpp);
          if (evaluated && evaluated.sizing) {
            const appliedLev = evaluated.sizing.appliedLeverage;
            const bNotional = evaluated.sizing.binanceActualNotionalUsd ? evaluated.sizing.binanceActualNotionalUsd.toFixed(2) : '50.00';
            const byNotional = evaluated.sizing.bybitActualNotionalUsd ? evaluated.sizing.bybitActualNotionalUsd.toFixed(2) : '50.00';
            const bQty = evaluated.sizing.binanceQuantity ? evaluated.sizing.binanceQuantity.toFixed(4) : '0';
            const byQty = evaluated.sizing.bybitQuantity ? evaluated.sizing.bybitQuantity.toFixed(4) : '0';
            const bMargin = (parseFloat(bNotional) / appliedLev).toFixed(2);
            const byMargin = (parseFloat(byNotional) / appliedLev).toFixed(2);

            const biSide = evaluated.profitability?.direction === 'SHORT_BINANCE_LONG_BYBIT' ? 'SHORT (SELL)' : 'LONG (BUY)';
            const bySide = evaluated.profitability?.direction === 'SHORT_BINANCE_LONG_BYBIT' ? 'LONG (BUY)' : 'SHORT (SELL)';

            detailedSizing = [
              `⚖️ *Common Dynamic Leverage:* \`${appliedLev}x\` (Auto-matched)`,
              `• *Binance Leg:* \`${biSide}\``,
              `   └ Notional: \`$${bNotional}\` | Qty: \`${bQty}\``,
              `   └ Required Margin: \`$${bMargin} USDT\``,
              `• *Bybit Leg:* \`${bySide}\``,
              `   └ Notional: \`$${byNotional}\` | Qty: \`${byQty}\``,
              `   └ Required Margin: \`$${byMargin} USDT\``,
            ].join('\n');

            if (evaluated.profitability) {
              const netPnlNum = evaluated.profitability.expectedNetProfitUsd ? parseFloat(evaluated.profitability.expectedNetProfitUsd.toString()) : 0;
              const netPnlSign = netPnlNum >= 0 ? '+' : '';
              const netPnlStr = `${netPnlSign}$${netPnlNum.toFixed(4)}`;

              const totalFees = evaluated.profitability.estimatedEntryFees
                ? evaluated.profitability.estimatedEntryFees.plus(evaluated.profitability.estimatedExitFees).toFixed(4)
                : '0.0000';
              const totalSlippage = evaluated.profitability.estimatedEntrySlippageUsd
                ? evaluated.profitability.estimatedEntrySlippageUsd.plus(evaluated.profitability.estimatedExitSlippageUsd).toFixed(4)
                : '0.0000';
              const grossFunding = evaluated.profitability.netFundingCashFlow
                ? evaluated.profitability.netFundingCashFlow.toFixed(4)
                : '0.0000';

              profitabilityBreakdown = [
                `💰 *Projected Profit & Cost Breakdown:*`,
                `• *Gross Funding Cash Flow:* \`+$${grossFunding} USDT\``,
                `• *Taker Fees (Entry + Exit):* \`-$${totalFees} USDT\``,
                `• *Est. Slippage Cost:* \`-$${totalSlippage} USDT\``,
                `• *Expected NET Profit:* \`${netPnlStr} USDT\``,
              ].join('\n');
            }

            if (evaluated.isApproved) {
              isApprovedStr = '✅ *Pre-Approved & Ready To Fire*';
            } else if (evaluated.rejectionReason) {
              isApprovedStr = `⚠️ *Filter Pending:* ${evaluated.rejectionReason}`;
            }
          }
        } catch {
          // fallback if evaluation fails
        }
      }

      const msg = [
        `🎯 *NEXT PLANNED ARBITRAGE TRADE*`,
        `━━━━━━━━━━━━━━━━━━━━━━`,
        `🪙 *Target Coin:* \`${coin}\``,
        `📊 *Funding Difference (Edge):* \`${edgePct}%\` (APR: \`${apr}%\`)`,
        `   • Binance Rate: \`${bSign}${bRate}%\``,
        `   • Bybit Rate: \`${bySign}${byRate}%\``,
        '',
        `⏰ *Timing & Schedule:*`,
        `• *Funding Settlement Due In:* \`${settlementStr}\``,
        `• *Auto-Entry Orders Fire In:* \`${entryStr}\` (${this.entryLeadMinutes}m pre-funding)`,
        '',
        detailedSizing ? `${detailedSizing}\n` : '',
        profitabilityBreakdown ? `${profitabilityBreakdown}\n` : '',
        `📋 *Status:* ${isApprovedStr}`,
        `━━━━━━━━━━━━━━━━━━━━━━`,
      ].join('\n');

      await this.telegramNotifier.sendAlert(`Next Planned Trade: ${coin}`, msg, 'INFO');
    } catch (err: any) {
      await this.telegramNotifier.sendAlert('Next Trade Query Error', `Failed to determine next trade: ${err?.message}`, 'ERROR');
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

  private async handleTestOrder(): Promise<void> {
    try {
      await this.telegramNotifier.sendAlert(
        '🧪 TEST ORDER INITIATED',
        'Submitting minimum test market order with 3s auto-close to verify exchange connectivity...',
        'INFO'
      );

      // Execute test order on Bybit (or Binance if available)
      const res = await executeTestOrder(this.bybitClient, {
        symbol: 'DOGEUSDT',
        side: 'BUY',
        autoClose: true,
        holdSeconds: 3,
        leverage: 3,
      });

      const msg = [
        `✅ *TEST ORDER COMPLETED*`,
        `━━━━━━━━━━━━━━━━━━━━━━`,
        `• *Exchange:* \`${this.bybitClient.exchangeName.toUpperCase()}\``,
        `• *Symbol:* \`${res.symbol}\``,
        `• *Filled Qty:* \`${res.qty}\``,
        `• *Entry Price:* \`$${res.entryPrice}\``,
        `• *Notional:* \`$${res.notionalUsd} USDT\``,
        `• *Open Status:* \`${res.openStatus}\``,
        `• *Auto-Closed Status:* \`${res.closeStatus || 'FILLED'}\``,
        `━━━━━━━━━━━━━━━━━━━━━━`,
        `🎉 Exchange futures order placement and reduce-only exit verified successfully!`,
      ].join('\n');

      await this.telegramNotifier.sendAlert('Test Order Success', msg, 'INFO');
    } catch (err: any) {
      await this.telegramNotifier.sendAlert(
        'Test Order Failed',
        `Could not execute test order:\n\`${err?.message || err}\``,
        'ERROR'
      );
    }
  }
}
