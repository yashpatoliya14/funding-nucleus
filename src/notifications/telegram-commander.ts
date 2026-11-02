import { request } from 'undici';
import { IExchangeClient } from '../exchanges/exchange.interface.js';
import { TradeRepository, DailySummaryRepository } from '../persistence/repositories.js';
import { TelegramNotifier } from './telegram.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/time.js';
import { CircuitBreaker } from '../risk/circuit-breaker.js';
import { KillSwitch } from '../risk/kill-switch.js';
import { executeTestOrder } from '../execution/test-order-executor.js';
import { FundingHistoryService, SevenDayFundingStats } from '../analytics/funding-history.service.js';
import { ManualTradeService } from '../execution/manual-trade.service.js';
import { LiquidationSentinel } from '../risk/liquidation-sentinel.js';
import { SymbolCache } from '../market-data/symbol-cache.js';

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
  historyService?: FundingHistoryService;
  manualTradeService?: ManualTradeService;
  sentinel?: LiquidationSentinel;
  symbolCache?: SymbolCache;
  isAutoExecutionFrozen?: () => boolean;
  freezeAutoExecution?: () => void;
  unfreezeAutoExecution?: () => void;
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
  private historyService?: FundingHistoryService;
  private manualTradeService?: ManualTradeService;
  private sentinel?: LiquidationSentinel;
  private symbolCache?: SymbolCache;
  private isAutoExecutionFrozen?: () => boolean;
  private freezeAutoExecution?: () => void;
  private unfreezeAutoExecution?: () => void;
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
    this.historyService = options.historyService;
    this.manualTradeService = options.manualTradeService;
    this.sentinel = options.sentinel;
    this.symbolCache = options.symbolCache;
    this.isAutoExecutionFrozen = options.isAutoExecutionFrozen;
    this.freezeAutoExecution = options.freezeAutoExecution;
    this.unfreezeAutoExecution = options.unfreezeAutoExecution;
  }

  public start(): void {
    if (this.isPolling) return;
    this.isPolling = true;
    logger.info({ chatId: this.chatId }, 'Telegram interactive command & dashboard listener started');
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

              // Handle callback queries (button clicks)
              if (update.callback_query) {
                const cb = update.callback_query;
                const senderChatId = String(cb.message?.chat?.id || cb.from?.id || '');
                if (senderChatId === this.chatId) {
                  await this.handleCallbackQuery(cb);
                }
                continue;
              }

              // Handle text messages
              if (update.message && update.message.text) {
                const senderChatId = String(update.message.chat?.id || '');
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
        await sleep(3000);
      }
    }
  }

  private async handleCallbackQuery(cb: any): Promise<void> {
    const data: string = cb.data || '';
    const messageId: number = cb.message?.message_id;
    await this.telegramNotifier.answerCallbackQuery(cb.id);

    logger.info({ callbackData: data }, 'Processing Telegram callback query');

    if (data === 'DASHBOARD' || data === 'TOP10') {
      await this.handleDashboard(messageId);
    } else if (data.startsWith('PAIR:')) {
      const symbol = data.substring(5).trim();
      await this.handlePairSelected(symbol, messageId);
    } else if (data.startsWith('TRADE:')) {
      // TRADE:SYMBOL:MARGIN
      const parts = data.split(':');
      const symbol = parts[1] || '';
      const margin = parts[2] ? parseFloat(parts[2]) : 10;
      if (symbol) {
        await this.handleExecuteTrade(symbol, margin);
      }
    } else if (data === 'FLATTEN_ALL') {
      await this.handleEmergencyFlatten();
    } else if (data === 'WALLET') {
      await this.handleWallet();
    } else if (data === 'STATUS') {
      await this.handleStatus();
    } else if (data === 'FREEZE') {
      if (this.freezeAutoExecution) this.freezeAutoExecution();
      await this.telegramNotifier.sendMessage('❄️ *Automated trade execution is now FROZEN (Manual Mode Active).* Bot will not place trades on its own.');
      await this.handleDashboard();
    } else if (data === 'UNFREEZE') {
      if (this.unfreezeAutoExecution) this.unfreezeAutoExecution();
      await this.telegramNotifier.sendMessage('🟢 *Automated trade execution is now UNFROZEN.* Bot will automatically execute approved candidates in entry window.');
      await this.handleDashboard();
    }
  }

  private async handleMessage(text: string): Promise<void> {
    const parts = text.trim().split(/\s+/);
    const firstWord = parts[0] || '';
    const rawCmd = (firstWord.toLowerCase().replace('/', '').split('@')[0] || '').trim();
    logger.info({ rawCmd, fullText: text }, 'Received Telegram command from authorized user');

    this.isProcessingCommand = true;
    try {
      // Custom command with arguments: "trade <symbol> <margin>"
      if (rawCmd === 'trade' && parts.length >= 2) {
        const symbol = (parts[1] || '').toUpperCase();
        const margin = parts[2] ? parseFloat(parts[2]) : 10;
        if (symbol) {
          await this.handleExecuteTrade(symbol, margin);
        }
        return;
      }

      // Custom command: "7d <symbol>"
      if ((rawCmd === '7d' || rawCmd === 'history') && parts.length >= 2) {
        const symbol = (parts[1] || '').toUpperCase();
        if (symbol) {
          await this.handlePairSelected(symbol);
        }
        return;
      }

      switch (rawCmd) {
        case 'dashboard':
        case 'dash':
        case 'top10':
        case 'start':
        case 'menu':
          await this.handleDashboard();
          break;

        case 'top':
        case 'top5':
        case 'diff':
        case 'rates':
        case 'funding':
          await this.handleTop5();
          break;

        case 'wallet':
        case 'balance':
        case 'balances':
          await this.handleWallet();
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

        case 'freeze':
        case 'pause':
          if (this.freezeAutoExecution) {
            this.freezeAutoExecution();
            await this.telegramNotifier.sendMessage('❄️ *Automated trade execution is now FROZEN (Manual Mode Active).* Bot will not place trades autonomously. Use the Telegram dashboard to trade.');
          } else {
            await this.telegramNotifier.sendMessage('❄️ *Automated trade execution is FROZEN.*');
          }
          break;

        case 'unfreeze':
        case 'resume':
          if (this.unfreezeAutoExecution) {
            this.unfreezeAutoExecution();
            await this.telegramNotifier.sendMessage('🟢 *Automated trade execution is now UNFROZEN.* Bot will automatically execute approved candidates in entry window.');
          } else {
            await this.telegramNotifier.sendMessage('🟢 *Automated trade execution is enabled.*');
          }
          break;

        case 'help':
        case 'commands':
          await this.handleHelp();
          break;

        default:
          await this.telegramNotifier.sendMessage(
            `❓ Unknown command: \`${text}\`\n\nSend one of these commands:\n• *dashboard* — Interactive Top 10 Dashboard with 5x trade buttons\n• *next* — Next trade plan & profit forecast\n• *wallet* — Binance & Bybit balances & margin\n• *top5* — Top 5 funding spreads\n• *status* — Bot status & today's PnL\n• *trade <pair> <margin>* — Execute 5x trade (e.g. \`trade AKE 10\`)\n• *flatten* — 🚨 Emergency close all positions (100% USDT)`
          );
          break;
      }
    } finally {
      this.isProcessingCommand = false;
    }
  }

  /**
   * Top 10 Arbitrage Opportunity Interactive Telegram Dashboard
   */
  public async handleDashboard(messageId?: number): Promise<void> {
    try {
      if (!this.getOpportunitiesSnapshot) {
        await this.telegramNotifier.sendMessage('⚠️ Scanner is not currently active.');
        return;
      }

      const opps = await this.getOpportunitiesSnapshot();
      if (!opps || opps.length === 0) {
        await this.telegramNotifier.sendMessage('📊 Scanning 600+ perpetual contracts... No cross-exchange funding spreads available yet.');
        return;
      }

      const top10 = opps.slice(0, 10);
      const now = Date.now();

      // Concurrently query 7-day stats for top 10
      const enriched = await Promise.all(
        top10.map(async (opp, rank) => {
          const coin = opp.mapping ? opp.mapping.normalized_symbol : opp.symbol || 'UNKNOWN';
          const bSymbol = opp.mapping ? opp.mapping.binance_symbol : `${coin}USDT`;
          const bySymbol = opp.mapping ? opp.mapping.bybit_symbol : `${coin}USDT`;

          const bRatePct = parseFloat((parseFloat((opp.binanceRate || 0).toString()) * 100).toFixed(4));
          const byRatePct = parseFloat((parseFloat((opp.bybitRate || 0).toString()) * 100).toFixed(4));
          const spreadPct = parseFloat((opp.fundingDiffPct || opp.diffPct || Math.abs(bRatePct - byRatePct)).toFixed(4));
          const aprPct = parseFloat((spreadPct * 3 * 365).toFixed(1));

          const targetTime = opp.targetFundingTimeMs || 0;
          const msLeft = Math.max(0, targetTime - now);
          const hours = Math.floor(msLeft / 3600000);
          const mins = Math.floor((msLeft % 3600000) / 60000);
          const timeStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

          let sevenDay: SevenDayFundingStats | null = null;
          if (this.historyService) {
            sevenDay = await this.historyService
              .getSevenDayFundingHistory(bSymbol, bySymbol, coin)
              .catch(() => null);
          }

          return {
            rank: rank + 1,
            coin,
            bRatePct,
            byRatePct,
            spreadPct,
            aprPct,
            direction: opp.fundingDirection || (bRatePct >= byRatePct ? 'SHORT_BINANCE_LONG_BYBIT' : 'LONG_BINANCE_SHORT_BYBIT'),
            timeStr,
            sevenDay,
          };
        })
      );

      const isFrozen = this.isAutoExecutionFrozen ? this.isAutoExecutionFrozen() : true;
      const modeBadge = isFrozen ? '❄️ MANUAL ONLY (Auto-Trade Frozen)' : '🟢 AUTO-EXECUTE ENABLED';

      // Build Top 10 Text
      const textLines: string[] = [
        `📊 *FUNDING ARBITRAGE DASHBOARD (TOP 10)*`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `⚡ *Mode:* \`${modeBadge}\``,
        `⚖️ *Leverage:* \`STRICT 5x ONLY\``,
        `🛡️ *Watchdog:* \`ACTIVE (Auto-Flatten on Orphan Leg or Margin Depletion)\``,
        ``,
      ];

      for (const item of enriched) {
        const bSign = item.bRatePct > 0 ? '+' : '';
        const bySign = item.byRatePct > 0 ? '+' : '';
        const dirShort = item.direction === 'SHORT_BINANCE_LONG_BYBIT' ? 'Short Bi / Long By' : 'Long Bi / Short By';
        const edge7d = item.sevenDay ? `• 7D Edge: \`+${item.sevenDay.cumulativeReturnPct}%\` (Win: \`${item.sevenDay.consistencyScorePct}%\`)` : '';

        textLines.push(
          `*${item.rank}. ${item.coin}* | Spread: *+${item.spreadPct}%* (${item.aprPct}% APR)`,
          `• Bi: \`${bSign}${item.bRatePct}%\` | By: \`${bySign}${item.byRatePct}%\` (${dirShort})`,
          edge7d,
          `• Payout in: \`${item.timeStr}\``,
          ``
        );
      }

      textLines.push(
        `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `👇 *Select a pair below to view 7-Day History & Trade (5x):*`
      );

      // Construct Inline Keyboard with buttons for each pair (2 per row)
      const inline_keyboard: any[][] = [];
      for (let i = 0; i < enriched.length; i += 2) {
        const itemA = enriched[i];
        if (itemA) {
          const row: any[] = [
            {
              text: `${itemA.rank}. ${itemA.coin} (+${itemA.spreadPct}%)`,
              callback_data: `PAIR:${itemA.coin}`,
            },
          ];
          const itemB = enriched[i + 1];
          if (itemB) {
            row.push({
              text: `${itemB.rank}. ${itemB.coin} (+${itemB.spreadPct}%)`,
              callback_data: `PAIR:${itemB.coin}`,
            });
          }
          inline_keyboard.push(row);
        }
      }

      // Add Utility Actions row
      inline_keyboard.push([
        { text: isFrozen ? '🟢 Unfreeze Auto-Trade' : '❄️ Freeze Auto-Trade', callback_data: isFrozen ? 'UNFREEZE' : 'FREEZE' },
        { text: '🔄 Refresh Top 10', callback_data: 'DASHBOARD' },
      ]);
      inline_keyboard.push([
        { text: '💼 Wallets', callback_data: 'WALLET' },
        { text: '🚨 Flatten All (100% USDT)', callback_data: 'FLATTEN_ALL' },
      ]);

      const fullMessage = textLines.filter((l) => l !== undefined).join('\n');

      if (messageId) {
        const edited = await this.telegramNotifier.editMessageText(messageId, fullMessage, { inline_keyboard });
        if (!edited) {
          await this.telegramNotifier.sendMessageWithMarkup(fullMessage, { inline_keyboard });
        }
      } else {
        await this.telegramNotifier.sendMessageWithMarkup(fullMessage, { inline_keyboard });
      }
    } catch (err: any) {
      logger.error({ err: err?.message }, 'Failed to render Telegram dashboard');
      await this.telegramNotifier.sendMessage(`⚠️ Failed to load Top 10 dashboard: ${err?.message || err}`);
    }
  }

  /**
   * Pair Detail View: Shows 7-Day Funding Rate Historical Analysis & 5x Margin Buttons
   */
  public async handlePairSelected(coin: string, messageId?: number): Promise<void> {
    try {
      const cleanCoin = coin.replace(/USDT$/, '').toUpperCase();
      const bSymbol = `${cleanCoin}USDT`;
      const bySymbol = `${cleanCoin}USDT`;

      // Fetch 7-Day Funding Stats
      let stats: SevenDayFundingStats | null = null;
      if (this.historyService) {
        stats = await this.historyService.getSevenDayFundingHistory(bSymbol, bySymbol, cleanCoin);
      }

      // Query current live rates
      const [bRates, byRates] = await Promise.allSettled([
        this.binanceClient.getFundingRates(),
        this.bybitClient.getFundingRates(),
      ]);

      let bRate = 0;
      let byRate = 0;
      let targetTime = Date.now() + 8 * 3600 * 1000;

      if (bRates.status === 'fulfilled') {
        const r = bRates.value.find((x) => x.symbol === bSymbol);
        if (r) {
          bRate = parseFloat(r.fundingRate.toString()) * 100;
          targetTime = r.fundingTimeMs;
        }
      }
      if (byRates.status === 'fulfilled') {
        const r = byRates.value.find((x) => x.symbol === bySymbol);
        if (r) {
          byRate = parseFloat(r.fundingRate.toString()) * 100;
          targetTime = Math.min(targetTime, r.fundingTimeMs);
        }
      }

      const diff = bRate - byRate;
      const spreadPct = Math.abs(diff);
      const aprPct = (spreadPct * 3 * 365).toFixed(1);
      const direction = diff >= 0 ? 'SHORT_BINANCE_LONG_BYBIT' : 'LONG_BINANCE_SHORT_BYBIT';

      const msLeft = Math.max(0, targetTime - Date.now());
      const totalSec = Math.floor(msLeft / 1000);
      const hours = Math.floor(totalSec / 3600);
      const mins = Math.floor((totalSec % 3600) / 60);
      const secs = totalSec % 60;
      const countdownStr = hours > 0 ? `${hours}h ${mins}m ${secs}s` : `${mins}m ${secs}s`;

      // Strict 5x Leverage PnL Forecast Helper
      const calc5x = (marginUsd: number) => {
        const notional = marginUsd * 5;
        const gross = notional * (spreadPct / 100);
        const fees = notional * 0.0021; // ~0.21% roundtrip taker fees
        const net = gross - fees;
        return {
          notional: notional.toFixed(0),
          gross: gross >= 0 ? `+${gross.toFixed(3)}` : gross.toFixed(3),
          net: net >= 0 ? `+${net.toFixed(3)}` : net.toFixed(3),
        };
      };

      const p10 = calc5x(10);
      const p25 = calc5x(25);
      const p50 = calc5x(50);
      const p100 = calc5x(100);

      const bSign = bRate > 0 ? '+' : '';
      const bySign = byRate > 0 ? '+' : '';

      const text = [
        `📈 *PAIR DASHBOARD: ${cleanCoin} (5x LEVERAGE)*`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `💰 *Current Live Rates:*`,
        `• Binance: \`${bSign}${bRate.toFixed(4)}%\``,
        `• Bybit: \`${bySign}${byRate.toFixed(4)}%\``,
        `• Current Spread: *+${spreadPct.toFixed(4)}%* (${aprPct}% APR)`,
        `• Direction: \`${direction}\``,
        `• Next Payout in: \`${countdownStr}\``,
        ``,
        `📅 *Last 7 Days Funding Rate Opportunity:*`,
        `• 7D Cumulative Yield: *+${stats?.cumulativeReturnPct ?? 0}%*`,
        `• Average Settlement Spread: \`+${stats?.averageSpreadPct ?? 0}%\``,
        `• Edge Consistency (Win Rate): *${stats?.consistencyScorePct ?? 0}%* (${stats?.settlementCount ?? 0} settlements)`,
        `• Dominant Direction: \`${stats?.dominantDirection === 'SHORT_BINANCE_LONG_BYBIT' ? 'Short Binance / Long Bybit' : 'Long Binance / Short Bybit'}\``,
        `• Arbitrage Edge Rating: ${stats?.hasStrongArbitrageEdge ? '🔥 *STRONG OPPORTUNITY*' : '⚖️ *MODERATE*'}`,
        ``,
        `⚡ *5x Leverage Net Profit Forecast (1 Settlement):*`,
        `• *$10 Margin ($50 Notional):* Gross \`${p10.gross}\`, Net *${p10.net} USDT*`,
        `• *$25 Margin ($125 Notional):* Gross \`${p25.gross}\`, Net *${p25.net} USDT*`,
        `• *$50 Margin ($250 Notional):* Gross \`${p50.gross}\`, Net *${p50.net} USDT*`,
        `• *$100 Margin ($500 Notional):* Gross \`${p100.gross}\`, Net *${p100.net} USDT*`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `👇 *Click Below to Execute Simultaneous 5x Trade:*`
      ].join('\n');

      const inline_keyboard = [
        [
          { text: `💵 Trade $10 (5x)`, callback_data: `TRADE:${cleanCoin}:10` },
          { text: `💵 Trade $25 (5x)`, callback_data: `TRADE:${cleanCoin}:25` },
        ],
        [
          { text: `💵 Trade $50 (5x)`, callback_data: `TRADE:${cleanCoin}:50` },
          { text: `💵 Trade $100 (5x)`, callback_data: `TRADE:${cleanCoin}:100` },
        ],
        [
          { text: `🔙 Back to Top 10`, callback_data: 'DASHBOARD' },
          { text: `🚨 Emergency Flatten`, callback_data: 'FLATTEN_ALL' },
        ],
      ];

      if (messageId) {
        const edited = await this.telegramNotifier.editMessageText(messageId, text, { inline_keyboard });
        if (!edited) {
          await this.telegramNotifier.sendMessageWithMarkup(text, { inline_keyboard });
        }
      } else {
        await this.telegramNotifier.sendMessageWithMarkup(text, { inline_keyboard });
      }
    } catch (err: any) {
      await this.telegramNotifier.sendMessage(`⚠️ Failed to load details for ${coin}: ${err?.message || err}`);
    }
  }

  /**
   * Executes a simultaneous delta-neutral trade on Binance & Bybit with strictly 5x leverage
   */
  public async handleExecuteTrade(coin: string, marginUsd: number): Promise<void> {
    if (!this.manualTradeService) {
      await this.telegramNotifier.sendMessage('⚠️ Trade execution engine is not attached.');
      return;
    }

    try {
      await this.telegramNotifier.sendMessage(
        `⏳ *Checking margin & submitting simultaneous 5x orders for ${coin} ($${marginUsd} USDT margin)...*`
      );

      const isSimulated = false; // Runs live if in live mode
      const result = await this.manualTradeService.executeManualTrade(
        {
          symbol: coin,
          marginUsd,
        },
        isSimulated
      );

      const text = [
        `✅ *5X ARBITRAGE TRADE SIMULTANEOUSLY OPENED*`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `🎯 *Pair:* \`${result.symbol}\` (\`Strict 5x Leverage\`)`,
        `💵 *Margin per Leg:* \`$${result.marginUsd.toFixed(2)} USDT\``,
        `⚖️ *Notional per Leg:* \`$${result.notionalUsd.toFixed(2)} USDT\``,
        `🔄 *Direction:* \`${result.direction}\``,
        `📊 *Live Spread:* \`+${result.spreadPct}%\``,
        `💰 *Expected Net Profit:* \`+$${result.expectedNetProfitUsd.toFixed(4)} USDT\``,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `🛡️ *Liquidation Sentinel Active:*`,
        `• Real-time orphan leg detection (surviving leg auto-flattens immediately)`,
        `• Minimum margin guard actively monitored every 3 seconds`,
        `• Post-settlement exit will close flat and collect funding automatically.`
      ].join('\n');

      const inline_keyboard = [
        [
          { text: '📊 Open Positions', callback_data: 'STATUS' },
          { text: '🔙 Top 10 Dashboard', callback_data: 'DASHBOARD' },
        ],
        [
          { text: '🚨 Flatten All Positions (100% USDT)', callback_data: 'FLATTEN_ALL' },
        ],
      ];

      await this.telegramNotifier.sendMessageWithMarkup(text, { inline_keyboard });
    } catch (err: any) {
      logger.error({ coin, marginUsd, err: err?.message }, 'Manual trade execution failed from Telegram');
      await this.telegramNotifier.sendMessage(
        `🚨 *TRADE EXECUTION FAILED:*\n\`${err?.message || err}\`\n\n_Safety checks prevented execution to protect capital._`
      );
    }
  }

  private async handleHelp(): Promise<void> {
    const msg = [
      `🤖 *FUNDING ARBITRAGE BOT — COMMAND & DASHBOARD GUIDE* 🤖`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `💬 *Interactive Telegram Commands:*\n`,
      `• *dashboard* — Opens the live Top 10 Arbitrage Dashboard with interactive 5x trade buttons.`,
      `• *trade <pair> <margin>* — Instantly opens a 5x trade (e.g. \`trade AKE 10\`).`,
      `• *7d <pair>* — Displays last 7 days funding rate history and performance (e.g. \`7d BTC\`).`,
      `• *next* — Shows the upcoming candidate pair, margin required, fee deductions, and net profit forecast.`,
      `• *wallet* — Shows live USDT balances, free margin, and fee tiers on Binance & Bybit.`,
      `• *top5* — Displays top 5 highest cross-exchange funding spreads right now with APR.`,
      `• *status* — Bot uptime, risk engine status, circuit breaker health, and today's realized PnL.`,
      `• *flatten* — 🚨 Instant Emergency Stop: Closes 100% of open positions on Binance & Bybit to USDT.\n`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `🛡️ *Automatic Safety Guarantees:*`,
      `1️⃣ *Strict 5x Leverage:* All positions, sizing, and orders are locked to 5x leverage.`,
      `2️⃣ *Liquidation Sentinel:* If one leg liquidates or margin is insufficient, ALL positions are flattened immediately with urgent Telegram alert.`,
      `3️⃣ *Delta-Neutral Hedge:* Binance and Bybit orders are submitted simultaneously.`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `💡 _Send_ \`dashboard\` _to get started!_`
    ].join('\n');

    await this.telegramNotifier.sendMessage(msg);
  }

  private async handleWallet(): Promise<void> {
    try {
      const [binanceBalances, bybitBalances] = await Promise.allSettled([
        this.binanceClient.getBalances(),
        this.bybitClient.getBalances(),
      ]);

      let biAvail = '$0.00';
      let biMargin = '$0.00';
      let biTotal = '$0.00';
      let biStatus = 'Connected';

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

      let byAvail = '$0.00';
      let byMargin = '$0.00';
      let byTotal = '$0.00';
      let byStatus = 'Connected';

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

      const numBi = parseFloat(biAvail.replace('$', '')) || 0;
      const numBy = parseFloat(byAvail.replace('$', '')) || 0;
      const limiting = Math.min(numBi, numBy);
      const lev = 5; // STRICT 5x
      const margin = this.marginPerLegUsd;
      const targetNotional = margin * lev;

      const msg = [
        `💼 *Exchange Wallets*`,
        ``,
        `🟡 *Binance Futures* (${biStatus})`,
        `• Available: \`${biAvail} USDT\``,
        `• Margin: \`${biMargin} USDT\``,
        `• Total: \`${biTotal} USDT\``,
        ``,
        `⚫ *Bybit Unified* (${byStatus})`,
        `• Available: \`${byAvail} USDT\``,
        `• Margin: \`${byMargin} USDT\``,
        `• Total: \`${byTotal} USDT\``,
        ``,
        `⚖️ *Limiting Trading Margin:* \`$${limiting.toFixed(2)} USDT\``,
        `⚙️ *Locked Leverage:* \`5x\` (Max notional with $${margin}: $${targetNotional.toFixed(2)})`,
      ].join('\n');

      const inline_keyboard = [
        [
          { text: '📊 Top 10 Dashboard', callback_data: 'DASHBOARD' },
          { text: '🚨 Flatten All', callback_data: 'FLATTEN_ALL' },
        ],
      ];

      await this.telegramNotifier.sendMessageWithMarkup(msg, { inline_keyboard });
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
          `${idx + 1}. *${coin}* | Spread: *+${edge}%* (${apr}% APR)`,
          `   • Binance: \`${bSign}${bRate}%\` | Bybit: \`${bySign}${byRate}%\``,
          `   • Settlement: in \`${timeStr}\``,
        ].join('\n');
      });

      const msg = [`📊 *Top 5 Funding Spreads*`, ``, ...lines].join('\n');
      const inline_keyboard = [
        [{ text: '📊 View Full Top 10 Dashboard', callback_data: 'DASHBOARD' }],
      ];
      await this.telegramNotifier.sendMessageWithMarkup(msg, { inline_keyboard });
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
      const isFrozen = this.isAutoExecutionFrozen ? this.isAutoExecutionFrozen() : true;
      const modeStr = isFrozen ? '❄️ MANUAL ONLY (Auto-Trade Frozen)' : '🟢 AUTO-EXECUTE ENABLED';

      const msg = [
        `🤖 *Bot Status & Safety Watchdog*`,
        ``,
        `• *State:* ${health}`,
        `• *Execution Mode:* \`${modeStr}\``,
        `• *Active Trades:* \`${activeTrades.length}\``,
        `• *Today Completed:* \`${today.trade_count}\``,
        `• *Today Net PnL:* \`${pnlSign}$${netPnl.toFixed(4)} USDT\``,
        `• *Execution Leverage:* \`5x Locked\``,
        `• *Sentinel Protection:* \`ACTIVE (Instant Flatten on 1-Leg Liquidation / Low Margin)\``,
      ].join('\n');

      const inline_keyboard = [
        [
          { text: '📊 Top 10 Dashboard', callback_data: 'DASHBOARD' },
          { text: '💼 Wallets', callback_data: 'WALLET' },
        ],
        [
          { text: '🚨 Emergency Flatten (100% USDT)', callback_data: 'FLATTEN_ALL' },
        ],
      ];

      await this.telegramNotifier.sendMessageWithMarkup(msg, { inline_keyboard });
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

      let topOpp = opps[0];
      let evaluated: any = null;
      let candidateRank = 1;
      const skippedNotes: string[] = [];

      if (this.evaluateOpportunity) {
        for (let i = 0; i < Math.min(5, opps.length); i++) {
          try {
            const evalResult = await this.evaluateOpportunity(opps[i]);
            if (evalResult && evalResult.isApproved) {
              topOpp = opps[i];
              evaluated = evalResult;
              candidateRank = i + 1;
              break;
            } else {
              const reason = evalResult?.rejectionReason || 'Profit below threshold';
              const sym = opps[i].mapping?.normalized_symbol || opps[i].symbol || `Rank ${i + 1}`;
              skippedNotes.push(`• *#${i + 1} ${sym}:* ${reason}`);
              if (i === 0) {
                evaluated = evalResult;
              }
            }
          } catch (evalErr: any) {
            skippedNotes.push(`• *#${i + 1}:* ${evalErr?.message || evalErr}`);
          }
        }
      }

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

      if (evaluated && evaluated.sizing && evaluated.sizing.appliedLeverage) {
        const appliedLev = 5; // STRICT 5x
        const bNotional = evaluated.sizing.binanceActualNotionalUsd ? evaluated.sizing.binanceActualNotionalUsd.toFixed(2) : (this.marginPerLegUsd * appliedLev).toFixed(2);
        const byNotional = evaluated.sizing.bybitActualNotionalUsd ? evaluated.sizing.bybitActualNotionalUsd.toFixed(2) : (this.marginPerLegUsd * appliedLev).toFixed(2);
        const bQty = evaluated.sizing.binanceQuantity ? evaluated.sizing.binanceQuantity.toFixed(4) : '0';
        const byQty = evaluated.sizing.bybitQuantity ? evaluated.sizing.bybitQuantity.toFixed(4) : '0';
        const bMargin = (parseFloat(bNotional) / appliedLev).toFixed(2);
        const byMargin = (parseFloat(byNotional) / appliedLev).toFixed(2);

        const biSide = evaluated.profitability?.direction === 'SHORT_BINANCE_LONG_BYBIT' ? 'SHORT' : 'LONG';
        const bySide = evaluated.profitability?.direction === 'SHORT_BINANCE_LONG_BYBIT' ? 'LONG' : 'SHORT';

        sizingText = [
          `• *Sizing (Strict 5x Leverage):*`,
          `  - Binance: ${biSide} \`${bQty} ${coin}\` (~$${bNotional} | $${bMargin} margin)`,
          `  - Bybit: ${bySide} \`${byQty} ${coin}\` (~$${byNotional} | $${byMargin} margin)`,
        ].join('\n');

        if (evaluated.profitability && evaluated.profitability.expectedNetProfitUsd) {
          const netProfit = parseFloat(evaluated.profitability.expectedNetProfitUsd.toString());
          const netProfitSign = netProfit >= 0 ? '+' : '';
          const netProfitStr = `${netProfitSign}${netProfit.toFixed(4)}`;

          const grossFunding = evaluated.profitability.netFundingCashFlow
            ? evaluated.profitability.netFundingCashFlow.toFixed(4)
            : '0.0000';

          profitText = [
            `• *Profit Breakdown:*`,
            `  - Gross Funding: \`+${grossFunding} USDT\``,
            `  - Expected Net Profit: \`${netProfitStr} USDT\``,
          ].join('\n');
        }

        if (evaluated.isApproved) {
          statusText = '🟢 Approved & Scheduled for Entry';
        } else {
          statusText = `🔴 Rejection Reason: \`${evaluated.rejectionReason || 'Profit below threshold'}\``;
        }
      }

      const msg = [
        `🎯 *Upcoming Candidate:* \`#${candidateRank} ${coin}\``,
        `• *Spread:* \`+${edgePct}%\` (${apr}% APR)`,
        `• *Binance:* \`${bSign}${bRate}%\` | *Bybit:* \`${bySign}${byRate}%\``,
        `• *Status:* ${statusText}`,
        `• *Entry Window Opens:* in \`${entryStr}\``,
        `• *Funding Settlement:* in \`${settlementStr}\``,
        sizingText,
        profitText,
      ].filter(Boolean).join('\n');

      const inline_keyboard = [
        [
          { text: `💵 Trade $10 (5x)`, callback_data: `TRADE:${coin}:10` },
          { text: `💵 Trade $25 (5x)`, callback_data: `TRADE:${coin}:25` },
        ],
        [
          { text: '📊 Top 10 Dashboard', callback_data: 'DASHBOARD' },
        ],
      ];

      await this.telegramNotifier.sendMessageWithMarkup(msg, { inline_keyboard });
    } catch (err: any) {
      await this.telegramNotifier.sendMessage(`⚠️ Failed to evaluate next trade: ${err?.message || err}`);
    }
  }

  private async handleTrades(): Promise<void> {
    try {
      const [binancePos, bybitPos] = await Promise.allSettled([
        this.binanceClient.getPositions(),
        this.bybitClient.getPositions(),
      ]);

      const bActive = binancePos.status === 'fulfilled'
        ? binancePos.value.filter((p) => p.side !== 'FLAT' && !p.quantity.isZero())
        : [];
      const byActive = bybitPos.status === 'fulfilled'
        ? bybitPos.value.filter((p) => p.side !== 'FLAT' && !p.quantity.isZero())
        : [];

      if (bActive.length === 0 && byActive.length === 0) {
        await this.telegramNotifier.sendMessage('📊 No open positions on Binance or Bybit. All accounts flat (100% USDT).');
        return;
      }

      const lines: string[] = ['📊 *Active Hedged Positions:*', ''];
      for (const p of bActive) {
        lines.push(`• *Binance:* \`${p.symbol}\` ${p.side} \`${p.quantity.toString()}\` @ $${p.entryPrice.toString()}`);
      }
      for (const p of byActive) {
        lines.push(`• *Bybit:* \`${p.symbol}\` ${p.side} \`${p.quantity.toString()}\` @ $${p.entryPrice.toString()}`);
      }

      const inline_keyboard = [
        [{ text: '🚨 Flatten All (100% USDT)', callback_data: 'FLATTEN_ALL' }],
      ];

      await this.telegramNotifier.sendMessageWithMarkup(lines.join('\n'), { inline_keyboard });
    } catch (err: any) {
      await this.telegramNotifier.sendMessage(`⚠️ Failed to query positions: ${err?.message || err}`);
    }
  }

  /**
   * Emergency Flatten: Instantly market closes 100% of positions on Binance & Bybit
   */
  public async handleEmergencyFlatten(): Promise<void> {
    try {
      await this.telegramNotifier.sendMessage('🚨 *EMERGENCY STOP INITIATED:* Flattening 100% of positions to USDT...');

      if (this.sentinel) {
        await this.sentinel.triggerEmergencyFlatten('TELEGRAM_USER_COMMAND', 'User triggered emergency flatten from Telegram');
      } else {
        this.killSwitch.activate('Manual flatten triggered from Telegram');
        const res = await this.killSwitch.emergencyFlatten();
        await this.telegramNotifier.sendMessage(
          `🛡️ *All positions flattened:* \`${res.flattenedCount}\` positions closed to USDT. Kill switch engaged.`
        );
      }
    } catch (err: any) {
      await this.telegramNotifier.sendMessage(`⚠️ Error flattening positions: ${err?.message || err}`);
    }
  }

  private async handleDualTestOrder(): Promise<void> {
    try {
      await this.telegramNotifier.sendMessage('⚡ Initiating small dual test order across Binance and Bybit...');
      const [biRes, byRes] = await Promise.allSettled([
        executeTestOrder(this.binanceClient, { symbol: 'DOGEUSDT', autoClose: true }),
        executeTestOrder(this.bybitClient, { symbol: 'DOGEUSDT', autoClose: true }),
      ]);
      const biOk = biRes.status === 'fulfilled' && biRes.value.success;
      const byOk = byRes.status === 'fulfilled' && byRes.value.success;
      if (biOk && byOk) {
        await this.telegramNotifier.sendMessage(`✅ Dual test order completed successfully on both Binance and Bybit.`);
      } else {
        await this.telegramNotifier.sendMessage(`⚠️ Dual test order result: Binance ${biOk ? 'OK' : 'Error'}, Bybit ${byOk ? 'OK' : 'Error'}.`);
      }
    } catch (err: any) {
      await this.telegramNotifier.sendMessage(`❌ Test order execution failed: ${err?.message || err}`);
    }
  }
}
