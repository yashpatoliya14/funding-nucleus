import fs from 'node:fs';
import path from 'node:path';
import { FullConfig } from './config/env.js';
import { AppDatabase } from './persistence/database.js';
import { runMigrations } from './persistence/migrations.js';
import {
  DailySummaryRepository,
  FillRepository,
  FundingEventRepository,
  FundingTransactionRepository,
  OrderRepository,
  PositionSnapshotRepository,
  RiskEventRepository,
  StateTransitionRepository,
  SymbolRepository,
  TradeRepository,
} from './persistence/repositories.js';
import { IExchangeClient } from './exchanges/exchange.interface.js';
import { BinanceClient } from './exchanges/binance.client.js';
import { BybitClient } from './exchanges/bybit.client.js';
import { PaperClient } from './exchanges/paper.client.js';
import { SymbolMatcher } from './market-data/symbol-matcher.js';
import { SymbolCache } from './market-data/symbol-cache.js';
import { FundingScanner } from './market-data/funding-scanner.js';
import { MarketHealth } from './market-data/market-health.js';
import { OpportunityFilter } from './strategy/opportunity-filter.js';
import { CircuitBreaker } from './risk/circuit-breaker.js';
import { KillSwitch } from './risk/kill-switch.js';
import { RiskManager } from './risk/risk-manager.js';
import { OrderManager } from './execution/order-manager.js';
import { ExecutionReconciliation } from './execution/reconciliation.js';
import { HedgeRecovery } from './execution/hedge-recovery.js';
import { TradeStateMachine } from './execution/state-machine.js';
import { ExecutionEngine } from './execution/execution-engine.js';
import { FundingScheduler } from './scheduler/funding-scheduler.js';
import { TelegramNotifier } from './notifications/telegram.js';
import { TelegramCommander } from './notifications/telegram-commander.js';
import { SystemHealth } from './monitoring/health.js';
import { MetricsCollector } from './monitoring/metrics.js';
import { logger } from './utils/logger.js';
import { sleep } from './utils/time.js';

export class FundingArbitrageApp {
  private db: AppDatabase;
  private binanceClient: IExchangeClient;
  private bybitClient: IExchangeClient;
  private symbolCache: SymbolCache;
  private scanner: FundingScanner;
  private marketHealth: MarketHealth;
  private opportunityFilter: OpportunityFilter;
  private riskManager: RiskManager;
  private circuitBreaker: CircuitBreaker;
  private killSwitch: KillSwitch;
  private executionEngine: ExecutionEngine;
  private telegram: TelegramNotifier;
  private telegramCommander?: TelegramCommander;
  private health: SystemHealth;
  private metrics: MetricsCollector;
  private tradeRepo: TradeRepository;
  private dailyRepo: DailySummaryRepository;
  private lockFilePath: string;
  private isRunning: boolean = false;
  private lastPeriodicReportTime: number = 0;

  constructor(private config: FullConfig) {
    const dataDir = path.dirname(path.resolve(process.cwd(), config.appConfig.persistence.path));
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    this.lockFilePath = path.join(dataDir, 'funding-bot.lock');

    // 1. Initialize SQLite database & migrations
    this.db = new AppDatabase(config.appConfig.persistence.path);
    const sqliteDb = this.db.connect();
    runMigrations(sqliteDb);

    // 2. Repositories
    const symbolRepo = new SymbolRepository(sqliteDb);
    this.tradeRepo = new TradeRepository(sqliteDb);
    const orderRepo = new OrderRepository(sqliteDb);
    const fillRepo = new FillRepository(sqliteDb);
    const fundingEventRepo = new FundingEventRepository(sqliteDb);
    const fundingTxRepo = new FundingTransactionRepository(sqliteDb);
    const snapshotRepo = new PositionSnapshotRepository(sqliteDb);
    const transitionRepo = new StateTransitionRepository(sqliteDb);
    const riskRepo = new RiskEventRepository(sqliteDb);
    this.dailyRepo = new DailySummaryRepository(sqliteDb);
    const dailyRepo = this.dailyRepo;

    // 3. Exchange Adapters (Paper or Live)
    const isLive = config.appConfig.app.mode === 'live';
    if (isLive) {
      logger.info('Initializing LIVE exchange clients');
      this.binanceClient = new BinanceClient({
        apiKey: config.env.BINANCE_API_KEY,
        apiSecret: config.env.BINANCE_API_SECRET,
        testnet: config.env.BINANCE_TESTNET,
      });
      this.bybitClient = new BybitClient({
        apiKey: config.env.BYBIT_API_KEY,
        apiSecret: config.env.BYBIT_API_SECRET,
        testnet: config.env.BYBIT_TESTNET,
      });
    } else {
      logger.info('Initializing PAPER simulated exchange clients');
      this.binanceClient = new PaperClient({ exchangeName: 'binance' });
      this.bybitClient = new PaperClient({ exchangeName: 'bybit' });
    }

    // 4. Market Data & Strategy
    const matcher = new SymbolMatcher(this.binanceClient, this.bybitClient);
    this.symbolCache = new SymbolCache(symbolRepo, matcher, config.appConfig.symbols.cache_ttl_hours);
    this.scanner = new FundingScanner(
      this.binanceClient,
      this.bybitClient,
      config.appConfig.strategy.require_aligned_funding_events
    );
    this.marketHealth = new MarketHealth(this.binanceClient, this.bybitClient);
    this.opportunityFilter = new OpportunityFilter(this.binanceClient, this.bybitClient, config.appConfig);

    // 5. Risk Controls
    this.circuitBreaker = new CircuitBreaker(riskRepo);
    this.killSwitch = new KillSwitch(this.binanceClient, this.bybitClient, riskRepo);
    this.riskManager = new RiskManager(
      this.binanceClient,
      this.bybitClient,
      this.tradeRepo,
      dailyRepo,
      riskRepo,
      this.circuitBreaker,
      this.killSwitch,
      config.appConfig
    );

    // 6. Execution & Recovery
    const orderManager = new OrderManager(orderRepo);
    const reconciliation = new ExecutionReconciliation(this.binanceClient, this.bybitClient, fillRepo, snapshotRepo);
    const hedgeRecovery = new HedgeRecovery(
      this.binanceClient,
      this.bybitClient,
      orderManager,
      reconciliation,
      riskRepo,
      config.appConfig
    );
    const stateMachine = new TradeStateMachine(this.tradeRepo, transitionRepo);
    this.executionEngine = new ExecutionEngine(
      this.binanceClient,
      this.bybitClient,
      orderManager,
      reconciliation,
      hedgeRecovery,
      stateMachine,
      this.tradeRepo,
      fundingEventRepo,
      fundingTxRepo,
      dailyRepo,
      config.appConfig
    );

    // 7. Notifications & Monitoring
    this.telegram = new TelegramNotifier({
      enabled: config.appConfig.monitoring.telegram_enabled,
      botToken: config.env.TELEGRAM_BOT_TOKEN,
      chatId: config.env.TELEGRAM_CHAT_ID,
    });

    if (config.appConfig.monitoring.telegram_enabled && config.env.TELEGRAM_BOT_TOKEN && config.env.TELEGRAM_CHAT_ID) {
      this.telegramCommander = new TelegramCommander({
        botToken: config.env.TELEGRAM_BOT_TOKEN,
        chatId: config.env.TELEGRAM_CHAT_ID,
        binanceClient: this.binanceClient,
        bybitClient: this.bybitClient,
        tradeRepo: this.tradeRepo,
        dailyRepo: this.dailyRepo,
        circuitBreaker: this.circuitBreaker,
        killSwitch: this.killSwitch,
        telegramNotifier: this.telegram,
        getOpportunitiesSnapshot: async () => {
          const symbols = this.symbolCache.getAllActive();
          return this.scanner.scanOpportunities(symbols);
        },
      });
    }

    this.health = new SystemHealth(sqliteDb, this.binanceClient, this.bybitClient, this.circuitBreaker, this.marketHealth);
    this.metrics = new MetricsCollector(sqliteDb, dailyRepo);
  }

  private acquireLock(): void {
    if (fs.existsSync(this.lockFilePath)) {
      const pidStr = fs.readFileSync(this.lockFilePath, 'utf8').trim();
      const pid = parseInt(pidStr, 10);

      // Check if the holding process is actually alive
      let isProcessAlive = false;
      if (!isNaN(pid)) {
        try {
          process.kill(pid, 0); // Signal 0 checks process existence without killing it
          isProcessAlive = true;
        } catch {
          isProcessAlive = false;
        }
      }

      if (isProcessAlive) {
        throw new Error(`Instance lockfile exists (${this.lockFilePath}) held by active PID ${pid}. Another bot instance is currently running!`);
      } else {
        logger.warn({ deadPid: pidStr }, 'Stale lockfile detected from terminated process. Removing stale lock.');
        try {
          fs.unlinkSync(this.lockFilePath);
        } catch {}
      }
    }
    fs.writeFileSync(this.lockFilePath, process.pid.toString(), 'utf8');
  }

  private releaseLock(): void {
    try {
      if (fs.existsSync(this.lockFilePath)) {
        fs.unlinkSync(this.lockFilePath);
      }
    } catch (err) {
      logger.warn({ err }, 'Could not remove process lock file');
    }
  }

  async startupReconciliation(): Promise<void> {
    logger.info('Performing startup reconciliation against SQLite records and live exchange positions');
    const activeTrades = this.tradeRepo.getActiveTrades();

    if (activeTrades.length > 0) {
      logger.warn({ count: activeTrades.length }, 'Found active/unresolved trades in SQLite on startup');
      for (const t of activeTrades) {
        logger.warn({ tradeId: t.id, coin: t.coin, state: t.state }, 'Reconciling unresolved trade on startup');
        await this.telegram.sendAlert(
          'Restart Recovery Alert',
          `Bot restarted with unresolved trade ${t.id} (${t.coin}) in state ${t.state}`,
          'WARN'
        );
      }
    } else {
      logger.info('Startup reconciliation clean: No unresolved open trades');
    }
  }

  private async sendMarketAndPnLReport(trigger: 'STARTUP' | 'PERIODIC_4H', opportunities: any[]): Promise<void> {
    const isStartup = trigger === 'STARTUP';
    const title = isStartup ? 'Arbitrage Engine Online — Market & Profit Report' : '4-Hour Market & Performance Report';
    const mode = this.config.appConfig.app.mode.toUpperCase();
    const modeIcon = mode === 'LIVE' ? '🟢' : '🟡';

    // Daily summary stats
    const todaySummary = this.dailyRepo.getOrCreateToday();
    const activeTrades = this.tradeRepo.getActiveTrades();

    const top5 = opportunities.slice(0, 5);
    const top5Lines = top5.map((opp, idx) => {
      const coin = opp.mapping.normalized_symbol;
      const edgePct = (parseFloat(opp.fundingDiffPct.toString())).toFixed(4);
      const bRate = (parseFloat(opp.binanceRate.toString()) * 100).toFixed(4);
      const byRate = (parseFloat(opp.bybitRate.toString()) * 100).toFixed(4);
      const bSign = parseFloat(bRate) > 0 ? '+' : '';
      const bySign = parseFloat(byRate) > 0 ? '+' : '';
      const dirShort = opp.fundingDirection === 'SHORT_BINANCE_LONG_BYBIT' ? 'Short BI / Long BY' : 'Long BI / Short BY';
      return `${idx + 1}. *${coin}* | Diff: \`${edgePct}%\`\n   • Dir: \`${dirShort}\`\n   • BI: \`${bSign}${bRate}%\` | BY: \`${bySign}${byRate}%\``;
    });

    const tradeableCount = opportunities.filter((o) => {
      const minEdge = this.config.appConfig.strategy.minimum_funding_edge_pct;
      return parseFloat(o.fundingDiffPct.toString()) >= minEdge;
    }).length;

    const netPnlNum = parseFloat(todaySummary.net_pnl_usd);
    const pnlIcon = netPnlNum >= 0 ? '🟢' : '🔴';
    const pnlSign = netPnlNum >= 0 ? '+' : '';

    const lines = [
      `${modeIcon} *System Mode:* \`${mode}\``,
      `⏰ *Report Time:* \`${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC\``,
      '',
      `📊 *Top 5 Funding Discrepancies:*`,
      top5Lines.length > 0 ? top5Lines.join('\n') : '   _No active matched pairs found._',
      '',
      `🎯 *Tradeable Opportunities:* \`${tradeableCount}\` pairs (Edge ≥ ${this.config.appConfig.strategy.minimum_funding_edge_pct}%)`,
      `💼 *Active Open Trades:* \`${activeTrades.length}\``,
      '',
      `💰 *Performance Snapshot (Today):*`,
      `• Trades Executed: \`${todaySummary.trade_count}\``,
      `• Realized Funding: \`$${parseFloat(todaySummary.total_funding_pnl_usd).toFixed(2)}\``,
      `• Realized Trading: \`$${parseFloat(todaySummary.total_trading_pnl_usd).toFixed(2)}\``,
      `• Fees Paid: \`-$${parseFloat(todaySummary.total_fees_usd).toFixed(2)}\``,
      `• ${pnlIcon} *Net Realized P&L:* \`${pnlSign}$${netPnlNum.toFixed(2)}\``,
    ];

    await this.telegram.sendAlert(title, lines.join('\n'), 'INFO');
  }

  async start(): Promise<void> {
    this.acquireLock();
    this.isRunning = true;
    this.lastPeriodicReportTime = Date.now();
    logger.info({ mode: this.config.appConfig.app.mode }, 'Funding Arbitrage Bot started successfully');

    await this.startupReconciliation();

    // Initial symbol cache refresh
    const activeSymbols = await this.symbolCache.refreshIfExpired();

    // Start Telegram command listener if configured
    if (this.telegramCommander) {
      this.telegramCommander.start();
    }

    // Send formatted startup broadcast to Telegram
    const modeStr = this.config.appConfig.app.mode.toUpperCase();
    const isLive = this.config.appConfig.app.mode === 'live';
    const modeEmoji = isLive ? '🟢' : '🟡';

    const startupMessage = [
      `${modeEmoji} *Mode:* \`${modeStr}\``,
      `🔄 *Matched Pairs:* \`${activeSymbols.length}\` perpetuals`,
      `⚙️ *Max Leg Size:* \`$${this.config.appConfig.risk.maximum_notional_per_leg_usd}\``,
      `🛡️ *Leverage Cap:* \`${this.config.appConfig.risk.default_leverage_cap}x\``,
      `🛑 *Daily Loss Stop:* \`$${this.config.appConfig.risk.maximum_daily_loss_usd}\``,
      `⏱️ *Entry Window:* \`${this.config.appConfig.strategy.entry_lead_minutes}m\` pre-funding`,
      `📦 *Database:* \`HEALTHY (WAL mode)\``,
      `🚀 *Status:* Trading engine running and scanning...`,
    ].join('\n');

    await this.telegram.notifyEvent(
      'BOT_STARTED',
      `Arbitrage Engine Online [${modeStr}]`,
      startupMessage,
      'INFO'
    );

    // Main Scanning & Trading Loop
    while (this.isRunning) {
      try {
        if (this.killSwitch.isEngaged() || this.circuitBreaker.isTripped()) {
          logger.warn('Trading halted by KillSwitch or CircuitBreaker. Standing by...');
          await sleep(10000);
          continue;
        }

        // 1. Refresh symbol cache if expired
        const activeSymbols = await this.symbolCache.refreshIfExpired();

        // 2. Scan funding rates
        const opportunities = await this.scanner.scanOpportunities(activeSymbols);

        // Check if startup report has been sent, or 4 hours elapsed since last report
        const nowMs = Date.now();
        const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
        if (this.lastPeriodicReportTime === 0) {
          // Send on first full market scan after startup/restart
          this.lastPeriodicReportTime = nowMs;
          await this.sendMarketAndPnLReport('STARTUP', opportunities);
        } else if (nowMs - this.lastPeriodicReportTime >= FOUR_HOURS_MS) {
          this.lastPeriodicReportTime = nowMs;
          await this.sendMarketAndPnLReport('PERIODIC_4H', opportunities);
        }

        if (opportunities.length > 0) {
          const topOpp = opportunities[0]!;
          logger.info(
            {
              coin: topOpp.mapping.normalized_symbol,
              edge: `${topOpp.fundingDiffPct.toFixed(4)}%`,
              bRate: topOpp.binanceRate.toString(),
              byRate: topOpp.bybitRate.toString(),
            },
            'Top funding opportunity detected'
          );

          // 3. Check if within entry window
          const inWindow = FundingScheduler.isWithinEntryWindow(
            topOpp.targetFundingTimeMs,
            this.config.appConfig.strategy.entry_lead_minutes
          );

          if (inWindow) {
            logger.info({ coin: topOpp.mapping.normalized_symbol }, 'Opportunity is within entry window! Evaluating candidate...');
            const evaluated = await this.opportunityFilter.evaluateOpportunity(topOpp);

            if (evaluated.isApproved) {
              // Pre-trade risk check
              await this.riskManager.validatePreTrade(evaluated);

              // Build Top 5 funding spread snapshot text before entering
              const top5 = opportunities.slice(0, 5);
              const top5Lines = top5.map((opp, idx) => {
                const coin = opp.mapping.normalized_symbol;
                const edgePct = parseFloat(opp.fundingDiffPct.toString()).toFixed(4);
                const bRate = (parseFloat(opp.binanceRate.toString()) * 100).toFixed(4);
                const byRate = (parseFloat(opp.bybitRate.toString()) * 100).toFixed(4);
                const bSign = parseFloat(bRate) > 0 ? '+' : '';
                const bySign = parseFloat(byRate) > 0 ? '+' : '';
                const isSelected = coin === evaluated.opportunity.mapping.normalized_symbol ? ' 👈 *[SELECTED]*' : '';
                return `${idx + 1}. *${coin}* | Diff: \`${edgePct}%\`${isSelected}\n   • BI: \`${bSign}${bRate}%\` | BY: \`${bySign}${byRate}%\``;
              });

              // Detailed pre-trade execution breakdown
              const coin = evaluated.opportunity.mapping.normalized_symbol;
              const direction = evaluated.profitability.direction;
              const biAction = direction === 'SHORT_BINANCE_LONG_BYBIT' ? 'SHORT (SELL)' : 'LONG (BUY)';
              const byAction = direction === 'SHORT_BINANCE_LONG_BYBIT' ? 'LONG (BUY)' : 'SHORT (SELL)';
              const biQty = evaluated.sizing.binanceQuantity.toFixed(4);
              const byQty = evaluated.sizing.bybitQuantity.toFixed(4);
              const biNotional = evaluated.sizing.binanceActualNotionalUsd.toFixed(2);
              const byNotional = evaluated.sizing.bybitActualNotionalUsd.toFixed(2);
              const appliedLeverage = evaluated.sizing.appliedLeverage;
              const biMargin = evaluated.sizing.binanceActualNotionalUsd.dividedBy(appliedLeverage).toFixed(2);
              const byMargin = evaluated.sizing.bybitActualNotionalUsd.dividedBy(appliedLeverage).toFixed(2);
              const edgePct = parseFloat(evaluated.opportunity.fundingDiffPct.toString()).toFixed(4);
              const netProfitUsd = evaluated.profitability.expectedNetProfitUsd.toFixed(2);
              const biCashFlow = evaluated.profitability.expectedFundingCashFlowBinance.toFixed(3);
              const byCashFlow = evaluated.profitability.expectedFundingCashFlowBybit.toFixed(3);
              const estFees = evaluated.profitability.estimatedEntryFees.plus(evaluated.profitability.estimatedExitFees).toFixed(3);
              const estSlippage = evaluated.profitability.estimatedEntrySlippageUsd.plus(evaluated.profitability.estimatedExitSlippageUsd).toFixed(3);

              const alertText = [
                `🚨 *PRE-TRADE EXECUTION ALERT: ${coin}* 🚨`,
                `━━━━━━━━━━━━━━━━━━━━━━`,
                `🎯 *Selected Pair:* \`${coin}\` (Binance & Bybit)`,
                `🔄 *Strategy Direction:* \`${direction}\``,
                `⚖️ *Common Safe Leverage:* \`${appliedLeverage}x\` (Unified across both exchanges)`,
                '',
                `📊 *Detailed Leg Breakdown:*`,
                `• *Binance:* \`${biAction}\``,
                `   └ Notional: \`$${biNotional}\` | Qty: \`${biQty}\``,
                `   └ Margin Required: \`$${biMargin}\` (\`${appliedLeverage}x\`)`,
                `• *Bybit:* \`${byAction}\``,
                `   └ Notional: \`$${byNotional}\` | Qty: \`${byQty}\``,
                `   └ Margin Required: \`$${byMargin}\` (\`${appliedLeverage}x\`)`,
                '',
                `💰 *Profitability & Cash Flow Breakdown:*`,
                `• *Funding Spread (Edge):* \`${edgePct}%\``,
                `• *Binance Funding Cashflow:* \`$${biCashFlow}\``,
                `• *Bybit Funding Cashflow:* \`$${byCashFlow}\``,
                `• *Est. Trading Fees (Entry+Exit):* \`-$${estFees}\``,
                `• *Est. Slippage Cost:* \`-$${estSlippage}\``,
                `• *Expected Net PnL:* \`+$${netProfitUsd}\``,
                `• *Target Settlement In:* \`~${this.config.appConfig.strategy.entry_lead_minutes} minutes\``,
                '',
                `📋 *Top 5 Funding Spreads At Time of Entry:*`,
                top5Lines.join('\n'),
                `━━━━━━━━━━━━━━━━━━━━━━`,
                `🚀 *Orders are being submitted concurrently to both exchanges...*`
              ].join('\n');

              await this.telegram.sendAlert(
                `⚡ Arbitrage Entry: ${coin} (${direction})`,
                alertText,
                'INFO'
              );

              // Execute trade lifecycle
              const isSimulated = this.config.appConfig.app.mode === 'paper';
              await this.executionEngine.executeTrade(evaluated, isSimulated);
            } else {
              logger.debug({ reason: evaluated.rejectionReason }, 'Opportunity did not meet filter criteria');
            }
          } else {
            const msRemaining = FundingScheduler.msUntilEntryWindow(
              topOpp.targetFundingTimeMs,
              this.config.appConfig.strategy.entry_lead_minutes
            );
            logger.debug({ minutesRemaining: (msRemaining / 60000).toFixed(1) }, 'Opportunity waiting for entry window');
          }
        }

        // Sleep between scan cycles (e.g. 15s)
        await sleep(15000);
      } catch (err: any) {
        logger.error({ err: err?.message }, 'Error in main loop cycle');
        await sleep(5000);
      }
    }
  }

  stop(): void {
    logger.info('Stopping Funding Arbitrage Bot...');
    this.isRunning = false;
    if (this.telegramCommander) {
      this.telegramCommander.stop();
    }
    this.releaseLock();
    this.db.close();
  }

  getHealthMonitor(): SystemHealth {
    return this.health;
  }

  getMetricsCollector(): MetricsCollector {
    return this.metrics;
  }

  getKillSwitch(): KillSwitch {
    return this.killSwitch;
  }
}
