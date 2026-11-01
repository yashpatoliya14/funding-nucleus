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
  marginPerLegUsd?: number;
  defaultLeverageCap?: number;
  minFundingEdgePct?: number;
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
  private marginPerLegUsd: number = 10;
  private defaultLeverageCap: number = 25;
  private minFundingEdgePct: number = 0.15;
  private isPolling: boolean = false;
  private lastUpdateId: number = 0;
  private processedUpdateIds: Set<number> = new Set();
  private isProcessingCommand: boolean = false;

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
    this.marginPerLegUsd = options.marginPerLegUsd ?? 10;
    this.defaultLeverageCap = options.defaultLeverageCap ?? 25;
    this.minFundingEdgePct = options.minFundingEdgePct ?? 0.15;
  }

  public start(): void {
    if (this.isPolling) return;
    this.isPolling = true;
    logger.info({ chatId: this.chatId }, 'Telegram interactive command listener started');
    this.initAndPoll().catch((err) => {
      logger.error({ err: err?.message }, 'Telegram command polling encountered unexpected fatal error');
    });
  }

  public stop(): void {
    this.isPolling = false;
  }

  private async initAndPoll(): Promise<void> {
    await this.initializeOffset();
    await this.pollLoop();
  }

  private async initializeOffset(): Promise<void> {
    try {
      const url = `https://api.telegram.org/bot${this.botToken}/getUpdates?offset=-1&limit=1`;
      const res = await request(url, { method: 'GET' });
      if (res.statusCode === 200) {
        const body: any = await res.body.json();
        if (body.ok && Array.isArray(body.result) && body.result.length > 0) {
          const latest = body.result[body.result.length - 1];
          this.lastUpdateId = latest.update_id;
          this.processedUpdateIds.add(latest.update_id);
          logger.info({ lastUpdateId: this.lastUpdateId }, 'Flushed previous Telegram updates on startup');
        }
      }
    } catch {
      // Non-fatal
    }
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
              if (this.processedUpdateIds.has(update.update_id)) {
                this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
                continue;
              }
              this.processedUpdateIds.add(update.update_id);
              this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);

              if (this.processedUpdateIds.size > 2000) {
                const arr = Array.from(this.processedUpdateIds);
                this.processedUpdateIds = new Set(arr.slice(arr.length - 1000));
              }

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
    const rawCmd = (text.toLowerCase().replace('/', '').split('@')[0] || '').trim();
    logger.info({ rawCmd }, 'Received Telegram command from authorized user');

    this.isProcessingCommand = true;
    try {
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
          await this.handleDualTestOrder();
          break;

        default:
          await this.telegramNotifier.sendMessage(
            `Unknown command: \`${text}\`\n\nCommands:\n• *next* - Next trade plan\n• *wallet* - Exchange balances\n• *top5* - Top 5 funding spreads\n• *status* - Bot status\n• *test* - Test connection\n• *flatten* - Emergency stop`
          );
          break;
      }
    } finally {
      this.isProcessingCommand = false;
    }
  }

  private async handleHelp(): Promise<void> {
    const msg = [
      `🤖 *Arbitrage Bot Commands*`,
      ``,
      `• *next* — Plan to trade in next funding cycle`,
      `• *wallet* — Binance & Bybit wallet balances`,
      `• *top5* — Top 5 cross-exchange funding spreads`,
      `• *status* — System health & today's PnL`,
      `• *test* — Connection check order (ETH)`,
      `• *flatten* — Emergency close all positions`,
    ].join('\n');

    await this.telegramNotifier.sendMessage(msg);
  }

  private async handleWallet(): Promise<void> {
    try {
      const [binanceBalances, bybitBalances, bComm, byComm] = await Promise.allSettled([
        this.binanceClient.getBalances(),
        this.bybitClient.getBalances(),
        this.binanceClient.getCommissionRates('ETHUSDT'),
        this.bybitClient.getCommissionRates('ETHUSDT'),
      ]);

      let biAvail = '$0.00';
      let biMargin = '$0.00';
      let biTotal = '$0.00';
      let biStatus = 'Connected';
      let biFeeStr = 'Maker 0.020% | Taker 0.050%';

      if (binanceBalances.status === 'fulfilled') {
        const usdt = binanceBalances.value.find((b) => b.asset === 'USDT');
        if (usdt) {
          biAvail = `$${parseFloat(usdt.availableBalance.toString()).toFixed(2)}`;
          biMargin = `$${parseFloat(usdt.marginBalance.toString()).toFixed(2)}`;
          biTotal = `$${parseFloat(usdt.walletBalance.toString()).toFixed(2)}`;
        }
      } else {
        biStatus = `Error (${binanceBalances.reason?.message || 'Check API'})`;
      }

      if (bComm.status === 'fulfilled') {
        const m = (parseFloat(bComm.value.makerRate.toString()) * 100).toFixed(3);
        const t = (parseFloat(bComm.value.takerRate.toString()) * 100).toFixed(3);
        biFeeStr = `Maker ${m}% | Taker ${t}%`;
      }

      let byAvail = '$0.00';
      let byMargin = '$0.00';
      let byTotal = '$0.00';
      let byStatus = 'Connected';
      let byFeeStr = 'Maker 0.020% | Taker 0.055%';

      if (bybitBalances.status === 'fulfilled') {
        const usdt = bybitBalances.value.find((b) => b.asset === 'USDT');
        if (usdt) {
          byAvail = `$${parseFloat(usdt.availableBalance.toString()).toFixed(2)}`;
          byMargin = `$${parseFloat(usdt.marginBalance.toString()).toFixed(2)}`;
          byTotal = `$${parseFloat(usdt.walletBalance.toString()).toFixed(2)}`;
        }
      } else {
        byStatus = `Error (${bybitBalances.reason?.message || 'Check API'})`;
      }

      if (byComm.status === 'fulfilled') {
        const m = (parseFloat(byComm.value.makerRate.toString()) * 100).toFixed(3);
        const t = (parseFloat(byComm.value.takerRate.toString()) * 100).toFixed(3);
        byFeeStr = `Maker ${m}% | Taker ${t}%`;
      }

      const numBi = parseFloat(biAvail.replace('$', '')) || 0;
      const numBy = parseFloat(byAvail.replace('$', '')) || 0;
      const limiting = Math.min(numBi, numBy);
      const lev = this.defaultLeverageCap;
      const margin = this.marginPerLegUsd;
      const targetNotional = margin * lev;

      const msg = [
        `💼 *Exchange Wallets*`,
        ``,
        `🟡 *Binance Futures* (${biStatus})`,
        `• Available: \`${biAvail} USDT\``,
        `• Margin: \`${biMargin} USDT\``,
        `• Total: \`${biTotal} USDT\``,
        `• Fees: \`${biFeeStr}\``,
        ``,
        `⚫ *Bybit Unified* (${byStatus})`,
        `• Available: \`${byAvail} USDT\``,
        `• Margin: \`${byMargin} USDT\``,
        `• Total: \`${byTotal} USDT\``,
        `• Fees: \`${byFeeStr}\``,
        ``,
        `⚖️ *Limiting Trading Margin:* \`$${limiting.toFixed(2)} USDT\``,
        `⚙️ *Config:* \`$${margin.toFixed(2)}\` margin/leg @ \`${lev}x\` = \`$${targetNotional.toFixed(2)}\` notional/leg`,
      ].join('\n');

      await this.telegramNotifier.sendMessage(msg);
    } catch (err: any) {
      await this.telegramNotifier.sendMessage(`⚠️ Failed to query wallets: ${err?.message || err}`);
    }
  }

  private async handleTop5(): Promise<void> {
    try {
      if (!this.getOpportunitiesSnapshot) {
        await this.telegramNotifier.sendMessage('⚠️ Scanner is not currently active.');
        return;
      }

      const opps = await this.getOpportunitiesSnapshot();
      if (!opps || opps.length === 0) {
        await this.telegramNotifier.sendMessage('📊 No cross-exchange funding spreads available yet.');
        return;
      }

      const top5 = opps.slice(0, 5);
      const now = Date.now();

      const lines = top5.map((opp, idx) => {
        const coin = opp.mapping ? opp.mapping.normalized_symbol : opp.symbol || 'UNKNOWN';
        const edge = parseFloat((opp.fundingDiffPct || opp.diffPct || 0).toString()).toFixed(4);
        const bRate = (parseFloat((opp.binanceRate || 0).toString()) * 100).toFixed(4);
        const byRate = (parseFloat((opp.bybitRate || 0).toString()) * 100).toFixed(4);
        const bSign = parseFloat(bRate) > 0 ? '+' : '';
        const bySign = parseFloat(byRate) > 0 ? '+' : '';
        const apr = (parseFloat(edge) * 3 * 365).toFixed(1);

        const targetTime = opp.targetFundingTimeMs || 0;
        const msLeft = Math.max(0, targetTime - now);
        const hours = Math.floor(msLeft / 3600000);
        const mins = Math.floor((msLeft % 3600000) / 60000);
        const timeStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

        return [
          `${idx + 1}. *${coin}* | Spread: *${edge}%* (${apr}% APR)`,
          `   • Binance: \`${bSign}${bRate}%\` | Bybit: \`${bySign}${byRate}%\``,
          `   • Settlement: in \`${timeStr}\``,
        ].join('\n');
      });

      const msg = [`📊 *Top 5 Funding Spreads*`, ``, ...lines].join('\n');
      await this.telegramNotifier.sendMessage(msg);
    } catch (err: any) {
      await this.telegramNotifier.sendMessage(`⚠️ Failed to retrieve top 5 spreads: ${err?.message || err}`);
    }
  }

  private async handleStatus(): Promise<void> {
    try {
      const today = this.dailyRepo.getOrCreateToday();
      const activeTrades = this.tradeRepo.getActiveTrades();
      const isCbTripped = this.circuitBreaker.isTripped();
      const isKillEngaged = this.killSwitch.isEngaged();

      let health = '🟢 Running & Scanning';
      if (isKillEngaged) health = '🔴 KILL SWITCH ENGAGED';
      else if (isCbTripped) health = '🟠 CIRCUIT BREAKER TRIPPED';

      const netPnl = parseFloat(today.net_pnl_usd.toString());
      const pnlSign = netPnl >= 0 ? '+' : '';

      const msg = [
        `🤖 *Bot Status*`,
        ``,
        `• *State:* ${health}`,
        `• *Active Trades:* \`${activeTrades.length}\``,
        `• *Today Completed:* \`${today.trade_count}\``,
        `• *Today Net PnL:* \`${pnlSign}$${netPnl.toFixed(4)} USDT\``,
        `• *Config:* \`$${this.marginPerLegUsd}\` margin/leg @ \`${this.defaultLeverageCap}x\``,
      ].join('\n');

      await this.telegramNotifier.sendMessage(msg);
    } catch (err: any) {
      await this.telegramNotifier.sendMessage(`⚠️ Failed to query status: ${err?.message || err}`);
    }
  }

  private async handleNextPlannedTrade(): Promise<void> {
    try {
      if (!this.getOpportunitiesSnapshot) {
        await this.telegramNotifier.sendMessage('⚠️ Scanner is not currently active.');
        return;
      }

      const opps = await this.getOpportunitiesSnapshot();
      if (!opps || opps.length === 0) {
        await this.telegramNotifier.sendMessage('🔍 Scanning perpetuals... No aligned opportunity found yet.');
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

      let sizingText = '';
      let profitText = '';
      let statusText = '⏳ Waiting for Entry Window';

      if (this.evaluateOpportunity) {
        try {
          const evaluated = await this.evaluateOpportunity(topOpp);
          if (evaluated && evaluated.sizing && evaluated.sizing.appliedLeverage) {
            const appliedLev = evaluated.sizing.appliedLeverage;
            const bNotional = evaluated.sizing.binanceActualNotionalUsd ? evaluated.sizing.binanceActualNotionalUsd.toFixed(2) : (this.marginPerLegUsd * appliedLev).toFixed(2);
            const byNotional = evaluated.sizing.bybitActualNotionalUsd ? evaluated.sizing.bybitActualNotionalUsd.toFixed(2) : (this.marginPerLegUsd * appliedLev).toFixed(2);
            const bQty = evaluated.sizing.binanceQuantity ? evaluated.sizing.binanceQuantity.toFixed(4) : '0';
            const byQty = evaluated.sizing.bybitQuantity ? evaluated.sizing.bybitQuantity.toFixed(4) : '0';
            const bMargin = (parseFloat(bNotional) / appliedLev).toFixed(2);
            const byMargin = (parseFloat(byNotional) / appliedLev).toFixed(2);

            const biSide = evaluated.profitability?.direction === 'SHORT_BINANCE_LONG_BYBIT' ? 'SHORT' : 'LONG';
            const bySide = evaluated.profitability?.direction === 'SHORT_BINANCE_LONG_BYBIT' ? 'LONG' : 'SHORT';

            sizingText = [
              `• *Sizing (${appliedLev}x Leverage):*`,
              `  - Binance: ${biSide} \`${bQty} ${coin}\` (~$${bNotional} | $${bMargin} margin | 0.050% taker fee)`,
              `  - Bybit: ${bySide} \`${byQty} ${coin}\` (~$${byNotional} | $${byMargin} margin | 0.055% taker fee)`,
            ].join('\n');

            if (evaluated.profitability && evaluated.profitability.expectedNetProfitUsd) {
              const netProfit = parseFloat(evaluated.profitability.expectedNetProfitUsd.toString());
              const netProfitSign = netProfit >= 0 ? '+' : '';
              const netProfitStr = `${netProfitSign}$${netProfit.toFixed(4)}`;

              const entryFees = evaluated.profitability.estimatedEntryFees;
              const exitFees = evaluated.profitability.estimatedExitFees;
              const totalFees = entryFees && exitFees
                ? entryFees.plus(exitFees).toFixed(4)
                : '0.0000';

              const entrySlip = evaluated.profitability.estimatedEntrySlippageUsd;
              const exitSlip = evaluated.profitability.estimatedExitSlippageUsd;
              const totalSlippage = entrySlip && exitSlip
                ? entrySlip.plus(exitSlip).toFixed(4)
                : '0.0000';

              const grossFunding = evaluated.profitability.netFundingCashFlow
                ? evaluated.profitability.netFundingCashFlow.toFixed(4)
                : '0.0000';

              profitText = [
                `• *Profit & Cost Breakdown:*`,
                `  - Gross Funding: \`+$${grossFunding} USDT\``,
                `  - Trading Fees Takes: \`-$${totalFees} USDT\` (Binance: 0.050% | Bybit: 0.055% | Roundtrip: 0.210%)`,
                `  - Slippage Cost Takes: \`-$${totalSlippage} USDT\` (Orderbook execution spread)`,
                `  - Expected Net Profit: \`${netProfitStr} USDT\``,
              ].join('\n');

              if (netProfit <= 0) {
                statusText = `❌ *Rejected:* Expected net profit (${netProfitStr}) is in minus. Trade will NOT be taken.`;
              } else if (evaluated.isApproved) {
                statusText = `✅ *Approved:* Expected profit (${netProfitStr}) is positive. Will execute in ${entryStr}.`;
              } else if (evaluated.rejectionReason) {
                statusText = `⚠️ *Filter Pending:* ${evaluated.rejectionReason}`;
              }
            }
          } else if (evaluated && evaluated.rejectionReason) {
            statusText = `⚠️ *Filter Status:* ${evaluated.rejectionReason}`;
          }
        } catch (evalErr: any) {
          statusText = `⚠️ *Evaluation Error:* ${evalErr?.message || evalErr}`;
        }
      }

      const msg = [
        `🎯 *Next Trade Plan*`,
        ``,
        `• *Coin:* \`${coin}\``,
        `• *Funding Spread:* \`${edgePct}%\` (APR: \`${apr}%\`)`,
        `  - Binance: \`${bSign}${bRate}%\``,
        `  - Bybit: \`${bySign}${byRate}%\``,
        ``,
        `• *Timing:*`,
        `  - Settlement Due: \`${settlementStr}\``,
        `  - Orders Fire: \`${entryStr}\` (${this.entryLeadMinutes}m pre-funding)`,
        ``,
        sizingText,
        profitText,
        `• *Decision:* ${statusText}`,
      ].filter(Boolean).join('\n');

      await this.telegramNotifier.sendMessage(msg);
    } catch (err: any) {
      await this.telegramNotifier.sendMessage(`⚠️ Failed to determine next trade: ${err?.message || err}`);
    }
  }

  private async handleTrades(): Promise<void> {
    try {
      const activeTrades = this.tradeRepo.getActiveTrades();
      if (activeTrades.length === 0) {
        await this.telegramNotifier.sendMessage('🟢 No open positions. Engine is scanning for opportunities.');
        return;
      }

      const lines = activeTrades.map((t, idx) => {
        return [
          `${idx + 1}. *${t.coin}*`,
          `• State: \`${t.state}\` | Direction: \`${t.direction}\``,
          `• Notional: \`$${t.target_notional_usd}\` | Exp Profit: \`$${t.expected_net_profit_usd}\``,
        ].join('\n');
      });

      const msg = [`⚡ *Active Open Positions (${activeTrades.length})*`, ``, ...lines].join('\n');
      await this.telegramNotifier.sendMessage(msg);
    } catch (err: any) {
      await this.telegramNotifier.sendMessage(`⚠️ Failed to query trades: ${err?.message || err}`);
    }
  }

  private async handleEmergencyFlatten(): Promise<void> {
    try {
      this.killSwitch.activate('Telegram operator emergency flatten command');
      await this.killSwitch.emergencyFlatten();
      await this.telegramNotifier.sendMessage('🛑 *Kill Switch Engaged:* All open positions closed. Accounts flat.');
    } catch (err: any) {
      await this.telegramNotifier.sendMessage(`⚠️ Flatten failed: ${err?.message || err}`);
    }
  }

  private async handleDualTestOrder(): Promise<void> {
    const symbol = 'ETHUSDT';
    try {
      // Execute on both Binance and Bybit concurrently
      const [binanceRes, bybitRes] = await Promise.allSettled([
        executeTestOrder(this.binanceClient, {
          symbol,
          side: 'BUY',
          autoClose: true,
          holdSeconds: 3,
          leverage: 3,
        }),
        executeTestOrder(this.bybitClient, {
          symbol,
          side: 'BUY',
          autoClose: true,
          holdSeconds: 3,
          leverage: 3,
        }),
      ]);

      const isBinanceOk = binanceRes.status === 'fulfilled' && binanceRes.value.success;
      const isBybitOk = bybitRes.status === 'fulfilled' && bybitRes.value.success;

      if (isBinanceOk && isBybitOk) {
        const b = (binanceRes as PromiseFulfilledResult<any>).value;
        const by = (bybitRes as PromiseFulfilledResult<any>).value;

        const msg = [
          `🧪 *Connection Test: PASSED*`,
          ``,
          `🟡 *Binance Futures (ETH):*`,
          `• Qty: \`${b.qty} ETH\` (~$${b.notionalUsd})`,
          `• Status: Open \`${b.openStatus}\` | Closed \`${b.closeStatus || 'FILLED'}\``,
          ``,
          `⚫ *Bybit Unified (ETH):*`,
          `• Qty: \`${by.qty} ETH\` (~$${by.notionalUsd})`,
          `• Status: Open \`${by.openStatus}\` | Closed \`${by.closeStatus || 'FILLED'}\``,
          ``,
          `✅ Both exchange orders executed and auto-closed successfully!`,
        ].join('\n');

        await this.telegramNotifier.sendMessage(msg);
      } else {
        const bErr = binanceRes.status === 'rejected' ? (binanceRes.reason?.message || binanceRes.reason) : (binanceRes.value.error || 'OK');
        const byErr = bybitRes.status === 'rejected' ? (bybitRes.reason?.message || bybitRes.reason) : (bybitRes.value.error || 'OK');

        const errMsg = [
          `🚨 *Connection Test: FAILED*`,
          ``,
          `• Binance: ${isBinanceOk ? '✅ Success' : `❌ Failed: \`${bErr}\``}`,
          `• Bybit: ${isBybitOk ? '✅ Success' : `❌ Failed: \`${byErr}\``}`,
        ].join('\n');

        await this.telegramNotifier.sendMessage(errMsg);
      }
    } catch (err: any) {
      await this.telegramNotifier.sendMessage(`⚠️ Test order error: ${err?.message || err}`);
    }
  }
}
