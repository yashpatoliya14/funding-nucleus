import { request } from 'undici';
import { IExchangeClient } from '../exchanges/exchange.interface.js';
import { TradeRepository, DailySummaryRepository } from '../persistence/repositories.js';
import { TelegramNotifier } from './telegram.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/time.js';
import { CircuitBreaker } from '../risk/circuit-breaker.js';
import { KillSwitch } from '../risk/kill-switch.js';
import { FundingHistoryService, SevenDayFundingStats } from '../analytics/funding-history.service.js';
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
  sentinel?: LiquidationSentinel;
  symbolCache?: SymbolCache;
  isAutoExecutionFrozen?: () => boolean;
  freezeAutoExecution?: () => void;
  unfreezeAutoExecution?: () => void;
}

interface ParsedOpportunity {
  coin: string;
  bSymbol: string;
  bySymbol: string;
  bRatePct: number;
  byRatePct: number;
  spreadPct: number;
  aprPct: number;
  targetTime: number;
  timeStr: string;
  direction: string;
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
  private defaultLeverageCap: number = 100;
  private minFundingEdgePct: number = 0.08;
  private historyService?: FundingHistoryService;
  private sentinel?: LiquidationSentinel;
  private symbolCache?: SymbolCache;
  private isAutoExecutionFrozen?: () => boolean;
  private freezeAutoExecution?: () => void;
  private unfreezeAutoExecution?: () => void;
  private isPolling: boolean = false;
  private lastUpdateId: number = 0;
  private processedUpdateIds: Set<number> = new Set();
  private isProcessingCommand: boolean = false;
  private startedAtSec: number = Math.floor(Date.now() / 1000);

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
    this.defaultLeverageCap = options.defaultLeverageCap ?? 100;
    this.minFundingEdgePct = options.minFundingEdgePct ?? 0.08;
    this.historyService = options.historyService;
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
    try {
      await this.telegramNotifier.registerBotCommands();
      await this.telegramNotifier.setCommandsMenuButton();
    } catch (err: any) {
      logger.warn({ err: err?.message }, 'Failed registering bot commands with Telegram API in initAndPoll');
    }
    await this.initializeOffset();
    await this.pollLoop();
  }

  private async initializeOffset(): Promise<void> {
    this.startedAtSec = Math.floor(Date.now() / 1000);
    try {
      const flushUrl = `https://api.telegram.org/bot${this.botToken}/deleteWebhook?drop_pending_updates=true`;
      await request(flushUrl, { method: 'POST' });
      logger.info('Purged stale Telegram update backlog on startup via deleteWebhook');
    } catch (err: any) {
      logger.warn({ err: err?.message }, 'Failed to drop pending Telegram updates via deleteWebhook');
    }

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/getUpdates?offset=-1&limit=1`;
      const res = await request(url, { method: 'GET' });
      if (res.statusCode === 200) {
        const body: any = await res.body.json();
        if (body.ok && Array.isArray(body.result) && body.result.length > 0) {
          const latest = body.result[body.result.length - 1];
          this.lastUpdateId = latest.update_id;
          this.processedUpdateIds.add(latest.update_id);
          await request(`https://api.telegram.org/bot${this.botToken}/getUpdates?offset=${this.lastUpdateId + 1}&limit=1`, { method: 'GET' });
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

              if (update.callback_query) {
                const cb = update.callback_query;
                const cbDate = cb.message?.date;
                if (cbDate && cbDate < this.startedAtSec - 30) continue;
                const senderChatId = String(cb.message?.chat?.id || cb.from?.id || '');
                if (senderChatId === this.chatId) {
                  await this.handleCallbackQuery(cb);
                }
                continue;
              }

              if (update.message && update.message.text) {
                const msgDate = update.message.date;
                if (msgDate && msgDate < this.startedAtSec - 30) continue;
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
      } catch {
        await sleep(3000);
      }
    }
  }

  private async handleCallbackQuery(cb: any): Promise<void> {
    const data: string = cb.data || '';
    const messageId: number = cb.message?.message_id;
    await this.telegramNotifier.answerCallbackQuery(cb.id);

    logger.info({ callbackData: data }, 'Processing Telegram callback query');

    if (data === 'FLATTEN_ALL' || data === 'FLATTEN') {
      await this.handleEmergencyFlatten();
    } else if (data === 'CURRENT' || data === 'TRADES') {
      await this.handleTrades();
    } else if (data === 'NEXT' || data === 'NEXT_PLAN') {
      await this.handleNextPlannedTrade();
    } else if (data === 'TOP10') {
      await this.handleTop10();
    } else if (data === 'DASHBOARD') {
      await this.handleDashboard(messageId);
    } else if (data === 'WALLET') {
      await this.handleWallet();
    } else if (data === 'NETPNL' || data === 'STATUS') {
      await this.handleNetPnl();
    } else if (data.startsWith('PAIR:')) {
      const symbol = data.substring(5).trim();
      await this.handlePairSelected(symbol, messageId);
    } else if (data.startsWith('TRADE:')) {
      await this.telegramNotifier.sendMessage('⚠️ Manual trade execution from Telegram is disabled.');
    } else if (data === 'FREEZE') {
      if (this.freezeAutoExecution) this.freezeAutoExecution();
      await this.telegramNotifier.sendMessage('❄️ *Automated trade execution is now FROZEN.*');
    } else if (data === 'UNFREEZE') {
      if (this.unfreezeAutoExecution) this.unfreezeAutoExecution();
      await this.telegramNotifier.sendMessage('🟢 *Automated trade execution is now UNFROZEN.*');
    }
  }

  private normalizeCommand(rawText: string): string {
    const trimmed = rawText.trim();
    const lower = trimmed.toLowerCase();

    if (lower.includes('flatten') || lower.includes('emergency') || lower === 'kill') return 'flatten';
    if (lower.includes('current trade') || lower.includes('trade details') || lower === 'current' || lower === 'trades' || lower === 'positions' || lower === 'pos') return 'current';
    if (lower.includes('next') || lower.includes('plan') || lower === 'target') return 'next';
    if (lower.includes('dashboard') || lower.startsWith('dash')) return 'dashboard';
    if (lower.includes('top10') || lower.includes('top 10') || lower.includes('spreads') || lower === 'top' || lower === 'rates' || lower === 'diff' || lower === 'funding') return 'top10';
    if (lower.includes('wallet') || lower.includes('balance')) return 'wallet';
    if (lower.includes('netpnl') || lower.includes('net pnl') || (lower.includes('status') && !lower.includes('freeze')) || lower === 'pnl' || lower === 'info' || lower === 'health') return 'netpnl';
    if (lower.includes('unfreeze') || lower.includes('resume')) return 'unfreeze';
    if (lower.includes('freeze') || lower.includes('pause')) return 'freeze';
    if (lower.includes('help') || lower.includes('command') || lower === 'start' || lower === 'menu' || lower === '?') return 'help';
    if (lower.startsWith('trade') || lower.startsWith('/trade')) return 'trade';

    const firstWord = trimmed.split(/\s+/)[0]?.replace(/^\//, '').split('@')[0]?.toLowerCase() || '';
    return firstWord;
  }

  private async handleMessage(text: string): Promise<void> {
    const rawTrimmed = text.trim();
    const cmd = this.normalizeCommand(rawTrimmed);
    logger.info({ rawCmd: cmd, fullText: rawTrimmed }, 'Received Telegram command from authorized user');

    this.isProcessingCommand = true;
    try {
      switch (cmd) {
        case 'flatten':
          await this.handleEmergencyFlatten();
          return;
        case 'current':
          await this.handleTrades();
          return;
        case 'next':
          await this.handleNextPlannedTrade();
          return;
        case 'top10':
          await this.handleTop10();
          return;
        case 'dashboard':
          await this.handleDashboard();
          return;
        case 'wallet':
          await this.handleWallet();
          return;
        case 'netpnl':
          await this.handleNetPnl();
          return;
        case 'trade':
          await this.telegramNotifier.sendMessage('⚠️ Manual trade execution from Telegram is disabled.');
          return;
        case 'unfreeze':
          if (this.unfreezeAutoExecution) this.unfreezeAutoExecution();
          await this.telegramNotifier.sendMessage('🟢 *Automated trade execution is now UNFROZEN.*');
          return;
        case 'freeze':
          if (this.freezeAutoExecution) this.freezeAutoExecution();
          await this.telegramNotifier.sendMessage('❄️ *Automated trade execution is now FROZEN.*');
          return;
        case 'help':
          await this.handleHelp();
          return;
      }

      // Check 7d history or single pair lookup
      const parts = rawTrimmed.split(/\s+/);
      const firstPart = parts[0]?.toLowerCase().replace(/^\//, '') || '';
      if ((firstPart === '7d' || firstPart === 'history') && parts[1]) {
        await this.handlePairSelected(parts[1].toUpperCase());
        return;
      }

      const candidateSymbol = rawTrimmed.toUpperCase().replace(/^\//, '').replace(/USDT$/, '');
      const reserved = new Set(['HELP', 'START', 'MENU', 'STATUS', 'WALLET', 'TRADES', 'POS', 'FLATTEN', 'TEST', 'DASHBOARD', 'DASH', 'TOP', 'TOP10', 'CURRENT', 'NETPNL', 'PNL', 'FREEZE', 'UNFREEZE']);
      if (/^[A-Z0-9]{2,10}$/.test(candidateSymbol) && parts.length === 1 && !reserved.has(candidateSymbol)) {
        await this.handlePairSelected(candidateSymbol);
        return;
      }

      // Fallback response with the 6 core options
      const fallbackMsg = [
        `❓ Unknown command: \`${text}\``,
        '',
        '🤖 *Available Options:*',
        '1️⃣ /flatten — 🚨 Flatten for Emergency (100% USDT)',
        '2️⃣ /current — 📊 Current Trade Details & Positions',
        '3️⃣ /next — 🎯 Next Trade Plan & Sizing Forecast',
        '4️⃣ /top10 — 📈 Top 10 Cross-Exchange Funding Spreads',
        '5️⃣ /wallet — 💼 Binance & Bybit Balances & Margin',
        '6️⃣ /netpnl — 💰 Today Realized Net PnL & Status',
        'ℹ️ /help — Commands & Strategy Reference Guide',
      ].join('\n');

      await this.telegramNotifier.sendMessageWithMarkup(
        fallbackMsg,
        this.telegramNotifier.getDefaultReplyKeyboard()
      );
    } finally {
      this.isProcessingCommand = false;
    }
  }

  private parseOpportunity(opp: any, now: number): ParsedOpportunity {
    const coin = opp.mapping ? opp.mapping.normalized_symbol : opp.symbol || 'UNKNOWN';
    const bSymbol = opp.mapping ? opp.mapping.binance_symbol : `${coin}USDT`;
    const bySymbol = opp.mapping ? opp.mapping.bybit_symbol : `${coin}USDT`;

    const bRatePct = parseFloat((parseFloat((opp.binanceRate || 0).toString()) * 100).toFixed(4));
    const byRatePct = parseFloat((parseFloat((opp.bybitRate || 0).toString()) * 100).toFixed(4));
    const spreadPct = parseFloat((opp.fundingDiffPct || opp.diffPct || Math.abs(bRatePct - byRatePct)).toFixed(4));
    const aprPct = parseFloat((spreadPct * 3 * 365).toFixed(1));

    const targetTime = opp.targetFundingTimeMs || opp.nextFundingTimeMs || 0;
    const msLeft = Math.max(0, targetTime - now);
    const hours = Math.floor(msLeft / 3600000);
    const mins = Math.floor((msLeft % 3600000) / 60000);
    const timeStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
    const direction = opp.fundingDirection || (bRatePct >= byRatePct ? 'SHORT_BINANCE_LONG_BYBIT' : 'LONG_BINANCE_SHORT_BYBIT');

    return {
      coin,
      bSymbol,
      bySymbol,
      bRatePct,
      byRatePct,
      spreadPct,
      aprPct,
      targetTime,
      timeStr,
      direction,
    };
  }

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

      const enriched = await Promise.all(
        top10.map(async (opp, rank) => {
          const parsed = this.parseOpportunity(opp, now);
          let sevenDay: SevenDayFundingStats | null = null;
          if (this.historyService) {
            sevenDay = await this.historyService
              .getSevenDayFundingHistory(parsed.bSymbol, parsed.bySymbol, parsed.coin)
              .catch(() => null);
          }
          return { rank: rank + 1, ...parsed, sevenDay };
        })
      );

      const isFrozen = this.isAutoExecutionFrozen ? this.isAutoExecutionFrozen() : false;
      const modeBadge = isFrozen ? '❄️ MANUAL ONLY (Auto-Trade Frozen)' : '🟢 AUTO-EXECUTE ENABLED';

      const textLines: string[] = [
        `📊 *FUNDING ARBITRAGE DASHBOARD (TOP 10)*`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `⚡ *Mode:* \`${modeBadge}\``,
        `⚖️ *Leverage:* \`Common Highest Dynamic Leverage\``,
        `🛡️ *Watchdog:* \`ACTIVE (Auto-Flatten Surviving Leg on Orphan Liquidation)\``,
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
        `👇 *Select a pair below to view 7-Day Funding History:*`
      );

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

      inline_keyboard.push([
        { text: '📊 Current Trade Details', callback_data: 'CURRENT' },
        { text: '💼 Wallets', callback_data: 'WALLET' },
      ]);
      inline_keyboard.push([
        { text: '💰 Net PnL', callback_data: 'NETPNL' },
        { text: '🚨 Flatten for Emergency', callback_data: 'FLATTEN_ALL' },
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

  public async handlePairSelected(coin: string, messageId?: number): Promise<void> {
    try {
      const cleanCoin = coin.replace(/USDT$/, '').toUpperCase();
      const bSymbol = `${cleanCoin}USDT`;
      const bySymbol = `${cleanCoin}USDT`;

      let stats: SevenDayFundingStats | null = null;
      if (this.historyService) {
        stats = await this.historyService.getSevenDayFundingHistory(bSymbol, bySymbol, cleanCoin);
      }

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

      const [binanceInsts, bybitInsts] = await Promise.allSettled([
        this.binanceClient.getInstruments(),
        this.bybitClient.getInstruments(),
      ]);
      let bMax = 20;
      let byMax = 25;
      if (binanceInsts.status === 'fulfilled') {
        const inst = binanceInsts.value.find((i) => i.symbol === bSymbol);
        if (inst && inst.maxLeverage) bMax = inst.maxLeverage;
      }
      if (bybitInsts.status === 'fulfilled') {
        const inst = bybitInsts.value.find((i) => i.symbol === bySymbol);
        if (inst && inst.maxLeverage) byMax = inst.maxLeverage;
      }
      const lev = Math.min(bMax, byMax, this.defaultLeverageCap || 100);

      const calcPnL = (marginUsd: number) => {
        const notional = marginUsd * lev;
        const gross = notional * (spreadPct / 100);
        const fees = notional * 0.0021;
        const net = gross - fees;
        return {
          notional: notional.toFixed(0),
          gross: gross >= 0 ? `+${gross.toFixed(3)}` : gross.toFixed(3),
          net: net >= 0 ? `+${net.toFixed(3)}` : net.toFixed(3),
        };
      };

      const p10 = calcPnL(10);
      const p25 = calcPnL(25);
      const p50 = calcPnL(50);
      const p100 = calcPnL(100);

      const bSign = bRate > 0 ? '+' : '';
      const bySign = byRate > 0 ? '+' : '';

      const text = [
        `📈 *PAIR DASHBOARD: ${cleanCoin} (${lev}x HIGHEST COMMON LEVERAGE)*`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `💰 *Current Live Rates:*`,
        `• Binance: \`${bSign}${bRate.toFixed(4)}%\` (Max: \`${bMax}x\`)`,
        `• Bybit: \`${bySign}${byRate.toFixed(4)}%\` (Max: \`${byMax}x\`)`,
        `• Highest Common Leverage: *\`${lev}x\`* (Unified across exchanges)`,
        `• Current Spread: *+${spreadPct.toFixed(4)}%* (${aprPct}% APR)`,
        `• Direction: \`${direction}\``,
        `• Next Payout in: \`${countdownStr}\``,
        ``,
        `📅 *Last 7 Days Funding Rate Opportunity:*`,
        `• 7D Cumulative Yield: *+${stats?.cumulativeReturnPct ?? 0}%*`,
        `• Average Settlement Spread: \`+${stats?.averageSpreadPct ?? 0}%\``,
        `• Edge Consistency (Win Rate): *+${stats?.consistencyScorePct ?? 0}%* (${stats?.settlementCount ?? 0} settlements)`,
        `• Dominant Direction: \`${stats?.dominantDirection === 'SHORT_BINANCE_LONG_BYBIT' ? 'Short Binance / Long Bybit' : 'Long Binance / Short Bybit'}\``,
        `• Arbitrage Edge Rating: ${stats?.hasStrongArbitrageEdge ? '🔥 *STRONG OPPORTUNITY*' : '⚖️ *MODERATE*'}`,
        ``,
        `⚡ *${lev}x Common Highest Leverage Forecast (1 Settlement):*`,
        `• *$10 Margin ($${p10.notional} Notional):* Gross \`${p10.gross}\`, Net *${p10.net} USDT*`,
        `• *$25 Margin ($${p25.notional} Notional):* Gross \`${p25.gross}\`, Net *${p25.net} USDT*`,
        `• *$50 Margin ($${p50.notional} Notional):* Gross \`${p50.gross}\`, Net *${p50.net} USDT*`,
        `• *$100 Margin ($${p100.notional} Notional):* Gross \`${p100.gross}\`, Net *${p100.net} USDT*`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `👇 *Use the buttons below to navigate funding analytics:*`,
      ].join('\n');

      const inline_keyboard = [
        [
          { text: `🔙 Back to Top 10`, callback_data: 'TOP10' },
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

  private async handleHelp(): Promise<void> {
    const msg = [
      `🤖 *FUNDING ARBITRAGE BOT — 6 CORE OPTIONS* 🤖`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `1️⃣ */flatten* — 🚨 *Flatten for Emergency*`,
      `   Instantly market-closes 100% of open positions on Binance & Bybit to USDT.`,
      ``,
      `2️⃣ */current* — 📊 *Current Trade Details*`,
      `   Inspect active positions, open notionals, dynamic leverage, unrealized PnL, current funding rates, and countdown to next settlement.`,
      ``,
      `3️⃣ */next* — 🎯 *Next Trade Plan*`,
      `   Upcoming candidate pair, spread, countdown to entry window, dynamic sizing forecast, and expected net profit breakdown.`,
      ``,
      `4️⃣ */top10* — 📈 *Top 10 Funding Spreads*`,
      `   Live highest cross-exchange funding opportunities across Binance & Bybit with APR and settlement countdown.`,
      ``,
      `5️⃣ */wallet* — 💼 *Exchange Wallets*`,
      `   Live available balances, margin, and total equity on Binance Futures and Bybit Unified accounts.`,
      ``,
      `6️⃣ */netpnl* — 💰 *Net PnL & Performance*`,
      `   Today realized net PnL, cumulative funding collected, completed trade count, and autonomous system status.`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `🛡️ *Strategy Invariants Locked in Code:*`,
      `• *Net Yield Invariant:* All taker fees (entry + exit) and orderbook slippage are deducted; entry is created ONLY if net profit is positive.`,
      `• *Common Highest Leverage:* Dynamically applies the maximum common leverage supported by both Binance & Bybit for each coin.`,
      `• *1-Leg Liquidation Recovery:* If one leg liquidates, surviving leg is immediately closed to 100% USDT and the bot immediately resumes scanning for new opportunities.`,
      `• *Multi-Cycle Carry:* In the next cycle, if the funding spread remains 0.08% or above, the bot holds through settlement to collect funding without duplicate fees.`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `💡 _Use the reply buttons below or tap any command._`,
    ].join('\n');

    await this.telegramNotifier.sendMessageWithMarkup(msg, this.telegramNotifier.getDefaultReplyKeyboard());
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
      const maxLev = this.defaultLeverageCap || 100;
      const margin = this.marginPerLegUsd;

      const msg = [
        `💼 *EXCHANGE WALLETS & MARGIN*`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `🟡 *Binance Futures* (${biStatus})`,
        `• Available Margin: \`${biAvail} USDT\``,
        `• Position Margin: \`${biMargin} USDT\``,
        `• Total Balance: \`${biTotal} USDT\``,
        ``,
        `⚫ *Bybit Unified* (${byStatus})`,
        `• Available Margin: \`${byAvail} USDT\``,
        `• Position Margin: \`${byMargin} USDT\``,
        `• Total Balance: \`${byTotal} USDT\``,
        ``,
        `⚖️ *Limiting Trading Margin:* \`$${limiting.toFixed(2)} USDT\``,
        `⚙️ *Leverage Policy:* \`Dynamic Highest Common Leverage\` (Up to ${maxLev}x)`,
        `💵 *Target Margin Per Leg:* \`$${margin.toFixed(2)} USDT\``,
      ].join('\n');

      const inline_keyboard = [
        [
          { text: '📊 Current Trade', callback_data: 'CURRENT' },
          { text: '📈 Top 10 Spreads', callback_data: 'TOP10' },
        ],
        [
          { text: '💰 Net PnL', callback_data: 'NETPNL' },
          { text: '🚨 Flatten for Emergency', callback_data: 'FLATTEN_ALL' },
        ],
      ];

      await this.telegramNotifier.sendMessageWithMarkup(msg, { inline_keyboard });
    } catch (err: any) {
      await this.telegramNotifier.sendMessage(`⚠️ Failed to query wallets: ${err?.message || err}`);
    }
  }

  public async handleTop10(): Promise<void> {
    try {
      if (!this.getOpportunitiesSnapshot) {
        await this.telegramNotifier.sendMessage('⚠️ Scanner is not currently active.');
        return;
      }

      const opps = await this.getOpportunitiesSnapshot();
      if (!opps || opps.length === 0) {
        await this.telegramNotifier.sendMessage('📊 Scanning 600+ perpetuals... No cross-exchange funding spreads available yet.');
        return;
      }

      const top10 = opps.slice(0, 10);
      const now = Date.now();

      const lines = top10.map((opp, idx) => {
        const item = this.parseOpportunity(opp, now);
        const bSign = item.bRatePct > 0 ? '+' : '';
        const bySign = item.byRatePct > 0 ? '+' : '';
        const dirShort = item.direction === 'SHORT_BINANCE_LONG_BYBIT' ? 'Short BI / Long BY' : 'Long BI / Short BY';

        return [
          `*${idx + 1}. ${item.coin}* | Spread: *+${item.spreadPct}%* (${item.aprPct}% APR)`,
          `   • BI: \`${bSign}${item.bRatePct}%\` | BY: \`${bySign}${item.byRatePct}%\` (${dirShort})`,
          `   • Settlement: in \`${item.timeStr}\``,
        ].join('\n');
      });

      const msg = [
        `📈 *TOP 10 CROSS-EXCHANGE FUNDING SPREADS*`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        ...lines,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `⚡ *Auto-Execution:* Scans 600+ pairs continuously. Enters when net profit is positive after all fees and slippage.`,
      ].join('\n');

      const inline_keyboard = [
        [
          { text: '📊 Current Trade', callback_data: 'CURRENT' },
          { text: '💼 Wallet', callback_data: 'WALLET' },
        ],
        [
          { text: '💰 Net PnL', callback_data: 'NETPNL' },
          { text: '🚨 Flatten for Emergency', callback_data: 'FLATTEN_ALL' },
        ],
      ];
      await this.telegramNotifier.sendMessageWithMarkup(msg, { inline_keyboard });
    } catch (err: any) {
      await this.telegramNotifier.sendMessage(`⚠️ Failed to retrieve top 10 spreads: ${err?.message || err}`);
    }
  }

  public async handleNetPnl(): Promise<void> {
    try {
      const today = this.dailyRepo.getOrCreateToday();
      const activeTrades = this.tradeRepo.getActiveTrades();
      const isCbTripped = this.circuitBreaker.isTripped();
      const isKillEngaged = this.killSwitch.isEngaged();

      let health = '🟢 Running & Scanning 600+ Perpetuals';
      if (isKillEngaged) health = '🔴 KILL SWITCH ENGAGED';
      else if (isCbTripped) health = '🟠 CIRCUIT BREAKER TRIPPED';

      const netPnl = parseFloat(today.net_pnl_usd.toString());
      const pnlSign = netPnl >= 0 ? '+' : '';

      const msg = [
        `💰 *TODAY REALIZED NET PNL & STATUS*`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `• *Today Net PnL:* \`${pnlSign}$${netPnl.toFixed(4)} USDT\``,
        `• *Completed Trades Today:* \`${today.trade_count}\``,
        `• *Active Open Trades:* \`${activeTrades.length}\``,
        `• *Execution Mode:* \`🟢 100% Autonomous\``,
        `• *System Health:* \`${health}\``,
        ``,
        `🛡️ *Strategy Invariants Enforced:*`,
        `• *Net Profit Threshold:* Only creates entry after all fees & slippage`,
        `• *Leverage:* Dynamic highest common leverage per coin`,
        `• *Carry Retention:* Minimum \`0.08%\` next cycle spread`,
        `• *Liquidation Recovery:* Auto-closes surviving leg & finds new opportunity`,
      ].join('\n');

      const inline_keyboard = [
        [
          { text: '📊 Current Trade', callback_data: 'CURRENT' },
          { text: '📈 Top 10 Spreads', callback_data: 'TOP10' },
        ],
        [
          { text: '💼 Wallet Balances', callback_data: 'WALLET' },
          { text: '🚨 Flatten for Emergency', callback_data: 'FLATTEN_ALL' },
        ],
      ];

      await this.telegramNotifier.sendMessageWithMarkup(msg, { inline_keyboard });
    } catch (err: any) {
      await this.telegramNotifier.sendMessage(`⚠️ Failed to query Net PnL: ${err?.message || err}`);
    }
  }

  public async handleStatus(): Promise<void> {
    await this.handleNetPnl();
  }

  public async handleNextPlannedTrade(): Promise<void> {
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

      // Prioritize candidates currently in the active entry window, then sort by highest edge
      const inWindowOpps = opps.filter((o) => {
        const targetTime = o.targetFundingTimeMs || o.nextFundingTimeMs || 0;
        const msRemaining = targetTime - this.entryLeadMinutes * 60 * 1000 - Date.now();
        return msRemaining <= 0 && targetTime - 60000 > Date.now();
      });
      const poolToScan = inWindowOpps.length > 0 ? inWindowOpps : opps;

      if (this.evaluateOpportunity) {
        for (let i = 0; i < Math.min(15, poolToScan.length); i++) {
          try {
            const evalResult = await this.evaluateOpportunity(poolToScan[i]);
            if (evalResult && evalResult.isApproved) {
              topOpp = poolToScan[i];
              evaluated = evalResult;
              candidateRank = i + 1;
              break;
            } else if (i === 0) {
              evaluated = evalResult;
            }
          } catch {
            // Check next
          }
        }
      }

      const now = Date.now();
      const parsed = this.parseOpportunity(topOpp, now);
      const bSign = parsed.bRatePct > 0 ? '+' : '';
      const bySign = parsed.byRatePct > 0 ? '+' : '';

      const targetFundingTime = parsed.targetTime;
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
        const appliedLev = evaluated.sizing.appliedLeverage || this.defaultLeverageCap || 20;
        const bNotional = evaluated.sizing.binanceActualNotionalUsd ? evaluated.sizing.binanceActualNotionalUsd.toFixed(2) : (this.marginPerLegUsd * appliedLev).toFixed(2);
        const byNotional = evaluated.sizing.bybitActualNotionalUsd ? evaluated.sizing.bybitActualNotionalUsd.toFixed(2) : (this.marginPerLegUsd * appliedLev).toFixed(2);
        const bQty = evaluated.sizing.binanceQuantity ? evaluated.sizing.binanceQuantity.toFixed(4) : '0';
        const byQty = evaluated.sizing.bybitQuantity ? evaluated.sizing.bybitQuantity.toFixed(4) : '0';
        const bMargin = (parseFloat(bNotional) / appliedLev).toFixed(2);
        const byMargin = (parseFloat(byNotional) / appliedLev).toFixed(2);

        const biSide = evaluated.profitability?.direction === 'SHORT_BINANCE_LONG_BYBIT' ? 'SHORT' : 'LONG';
        const bySide = evaluated.profitability?.direction === 'SHORT_BINANCE_LONG_BYBIT' ? 'LONG' : 'SHORT';

        sizingText = [
          `• *Sizing (${appliedLev}x Common Leverage):*`,
          `  - Binance: ${biSide} \`${bQty} ${parsed.coin}\` (~$${bNotional} | $${bMargin} margin)`,
          `  - Bybit: ${bySide} \`${byQty} ${parsed.coin}\` (~$${byNotional} | $${byMargin} margin)`,
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
          statusText = msUntilEntry === 0
            ? '🔥 *IN ENTRY WINDOW — Executing Automatically!*'
            : `🟢 *Approved — Standing by (Automatic punch in ${entryStr})*`;
        } else {
          statusText = `🔴 Rejection Reason: \`${evaluated.rejectionReason || 'Profit below threshold'}\``;
        }
      }

      const msg = [
        `🎯 *Next Trade Plan Candidate:* \`#${candidateRank} ${parsed.coin}\``,
        `• *Spread:* \`+${parsed.spreadPct}%\` (${parsed.aprPct}% APR)`,
        `• *Binance:* \`${bSign}${parsed.bRatePct}%\` | *Bybit:* \`${bySign}${parsed.byRatePct}%\``,
        `• *Status:* ${statusText}`,
        `• *Entry Window Opens:* in \`${entryStr}\``,
        `• *Funding Settlement:* in \`${settlementStr}\``,
        `• *Execution:* \`100% Autonomous — market orders punch automatically at 0s\``,
        sizingText,
        profitText,
      ].filter(Boolean).join('\n');

      const inline_keyboard = [
        [
          { text: '📊 Current Trade', callback_data: 'CURRENT' },
          { text: '📈 Top 10 Spreads', callback_data: 'TOP10' },
        ],
        [
          { text: '💼 Wallet', callback_data: 'WALLET' },
          { text: '💰 Net PnL', callback_data: 'NETPNL' },
        ],
        [
          { text: '🚨 Flatten for Emergency', callback_data: 'FLATTEN_ALL' },
        ],
      ];

      await this.telegramNotifier.sendMessageWithMarkup(msg, { inline_keyboard });
    } catch (err: any) {
      await this.telegramNotifier.sendMessage(`⚠️ Failed to evaluate next trade: ${err?.message || err}`);
    }
  }

  public async handleTrades(): Promise<void> {
    try {
      const [binancePos, bybitPos] = await Promise.allSettled([
        this.binanceClient.getPositions(),
        this.bybitClient.getPositions(),
      ]);
      const [binanceRates, bybitRates] = await Promise.allSettled([
        this.binanceClient.getFundingRates(),
        this.bybitClient.getFundingRates(),
      ]);

      const bActive = binancePos.status === 'fulfilled'
        ? binancePos.value.filter((p) => p.side !== 'FLAT' && !p.quantity.isZero())
        : [];
      const byActive = bybitPos.status === 'fulfilled'
        ? bybitPos.value.filter((p) => p.side !== 'FLAT' && !p.quantity.isZero())
        : [];

      if (bActive.length === 0 && byActive.length === 0) {
        const flatMsg = [
          '📊 *CURRENT TRADE DETAILS*',
          '━━━━━━━━━━━━━━━━━━━━━━━━━━',
          '🛡️ *Status:* `All Accounts Flat (100% USDT)`',
          '• Binance: `No open positions`',
          '• Bybit: `No open positions`',
          '',
          '🔍 *Active Scanner:* Continuously evaluating 600+ perpetuals.',
          '⚡ *Entry Invariant:* All fees & slippage deducted; trade creates entry ONLY when expected net profit is positive with common highest leverage.',
          '🔄 *Carry Rule:* Next cycle funding spread >= 0.08% collected automatically.',
        ].join('\n');

        const inline_keyboard = [
          [
            { text: '📈 Top 10 Spreads', callback_data: 'TOP10' },
            { text: '💼 Wallet Balances', callback_data: 'WALLET' },
          ],
          [
            { text: '💰 Net PnL & Status', callback_data: 'NETPNL' },
          ],
        ];
        await this.telegramNotifier.sendMessageWithMarkup(flatMsg, { inline_keyboard });
        return;
      }

      const allActive = [...bActive, ...byActive];
      const activeTrades = this.tradeRepo.getActiveTrades();
      const fundingRequests = allActive.map((position) => {
        const trade = activeTrades.find(
          (item) => item.binance_symbol === position.symbol || item.bybit_symbol === position.symbol
        );
        const startTime = trade ? new Date(trade.created_at).getTime() : undefined;
        const client = position.exchange === 'binance' ? this.binanceClient : this.bybitClient;
        return client.getFundingHistory(position.symbol, startTime, 50);
      });
      const fundingResults = await Promise.allSettled(fundingRequests);

      const totalUnrealizedPnl = allActive.reduce((total, position) => total + Number(position.unrealizedPnl), 0);
      const fundingByPosition = allActive.map((position, index) => {
        const result = fundingResults[index];
        const collected = result?.status === 'fulfilled'
          ? result.value.reduce((total, item) => total + Number(item.paymentAmount), 0)
          : 0;
        return { position, collected };
      });
      const totalFundingCollected = fundingByPosition.reduce((total, item) => total + item.collected, 0);
      const totalNotional = allActive.reduce(
        (total, position) => total + Number(position.quantity.times(position.markPrice)),
        0
      );
      const totalLeverage = allActive.length > 0
        ? allActive.reduce((total, position) => total + position.leverage, 0) / allActive.length
        : 0;
      const pnlSign = totalUnrealizedPnl >= 0 ? '+' : '';
      const pnlIcon = totalUnrealizedPnl >= 0 ? '🟢' : '🔴';

      const lines: string[] = [
        '📊 *CURRENT TRADE DETAILS*',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━',
        `${pnlIcon} *Total Unrealized PnL:* \`${pnlSign}$${totalUnrealizedPnl.toFixed(4)} USDT\``,
        `💼 *Open Notional:* \`$${totalNotional.toFixed(2)} USDT\``,
        `⚖️ *Average Leverage:* \`${totalLeverage.toFixed(2)}x\``,
        `💰 *Funding Collected/Paid:* \`${totalFundingCollected >= 0 ? '+' : ''}$${totalFundingCollected.toFixed(4)} USDT\``,
        `📌 *Open Legs:* \`${allActive.length}\``,
        '',
      ];
      for (const { position: p, collected } of fundingByPosition) {
        const rates = p.exchange === 'binance' ? binanceRates : bybitRates;
        const rate = rates.status === 'fulfilled'
          ? rates.value.find((item) => item.symbol === p.symbol)
          : undefined;
        const currentRatePct = rate ? Number(rate.fundingRate.times(100)) : 0;
        const nextFunding = rate?.fundingTimeMs
          ? new Date(rate.fundingTimeMs).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
          : 'Unavailable';
        const rateSign = currentRatePct >= 0 ? '+' : '';
        lines.push(
          `🏦 *${p.exchange === 'binance' ? 'Binance' : 'Bybit'} — ${p.symbol}*`,
          `• Side: \`${p.side}\` | Quantity: \`${p.quantity.toString()}\``,
          `• Leverage: \`${p.leverage}x\` | Notional: \`$${Number(p.quantity.times(p.markPrice)).toFixed(2)}\``,
          `• Entry: \`$${p.entryPrice.toFixed(4)}\` | Mark: \`$${p.markPrice.toFixed(4)}\``,
          `• Unrealized PnL: \`${Number(p.unrealizedPnl) >= 0 ? '+' : ''}$${Number(p.unrealizedPnl).toFixed(4)} USDT\``,
          `• Current Funding Rate: \`${rateSign}${currentRatePct.toFixed(5)}%\``,
          `• Next Funding: \`${nextFunding}\``,
          `• Funding Collected/Paid: \`${collected >= 0 ? '+' : ''}$${collected.toFixed(4)} USDT\``,
          ''
        );
      }

      const inline_keyboard = [
        [
          { text: '📈 Top 10 Spreads', callback_data: 'TOP10' },
          { text: '💼 Wallet Balances', callback_data: 'WALLET' },
        ],
        [
          { text: '💰 Net PnL', callback_data: 'NETPNL' },
          { text: '🚨 Flatten for Emergency', callback_data: 'FLATTEN_ALL' },
        ],
      ];

      await this.telegramNotifier.sendMessageWithMarkup(lines.join('\n'), { inline_keyboard });
    } catch (err: any) {
      await this.telegramNotifier.sendMessage(`⚠️ Failed to query positions: ${err?.message || err}`);
    }
  }

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
}
