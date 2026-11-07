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
import { MarginMonitor } from './risk/margin-monitor.js';
import { LiquidationSentinel } from './risk/liquidation-sentinel.js';
import { FundingHistoryService } from './analytics/funding-history.service.js';
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
  private marginMonitor: MarginMonitor;
  private sentinel: LiquidationSentinel;
  private historyService: FundingHistoryService;
  private executionEngine: ExecutionEngine;
  private telegram: TelegramNotifier;
  private telegramCommander?: TelegramCommander;
  private health: SystemHealth;
  private metrics: MetricsCollector;
  private tradeRepo: TradeRepository;
  private dailyRepo: DailySummaryRepository;
  private lockFilePath: string;
  private isRunning: boolean = false;
  private isAutoExecutionFrozen: boolean = false;
  private lastPeriodicReportTime: number = 0;

  constructor(private config: FullConfig) {
    const dataDir = path.dirname(path.resolve(process.cwd(), config.appConfig.persistence.path));
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    this.lockFilePath = path.join(dataDir, 'funding-bot.lock');
    this.isAutoExecutionFrozen = !config.appConfig.strategy.auto_execute_trades;

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
    this.historyService = new FundingHistoryService();
    this.opportunityFilter = new OpportunityFilter(
      this.binanceClient,
      this.bybitClient,
      config.appConfig,
      this.historyService
    );

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

    // 6. Notifications & Monitoring
    this.telegram = new TelegramNotifier({
      enabled: config.appConfig.monitoring.telegram_enabled,
      botToken: config.env.TELEGRAM_BOT_TOKEN,
      chatId: config.env.TELEGRAM_CHAT_ID,
    });

    // 7. Execution & Recovery
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

    this.marginMonitor = new MarginMonitor(
      this.binanceClient,
      this.bybitClient,
      this.telegram,
      config.appConfig.strategy.margin_rebalance_warning_usd,
      1.50,
      orderManager
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
      config.appConfig,
      this.marginMonitor,
      this.telegram
    );

    this.historyService = new FundingHistoryService();
    this.sentinel = new LiquidationSentinel({
      binanceClient: this.binanceClient,
      bybitClient: this.bybitClient,
      killSwitch: this.killSwitch,
      telegram: this.telegram,
      checkIntervalMs: 3000,
      minEmergencyMarginUsd: 2.0,
      tradeRepo: this.tradeRepo,
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
        evaluateOpportunity: async (opp: any) => {
          return this.opportunityFilter.evaluateOpportunity(opp);
        },
        entryLeadMinutes: config.appConfig.strategy.entry_lead_minutes,
        marginPerLegUsd: parseFloat(process.env.TRADE_MARGIN_PER_LEG_USD || '10') || 10,
        defaultLeverageCap: config.appConfig.risk.default_leverage_cap || 100,
        minFundingEdgePct: config.appConfig.strategy.minimum_funding_edge_pct || 0.08,
        historyService: this.historyService,
        sentinel: this.sentinel,
        symbolCache: this.symbolCache,
        isAutoExecutionFrozen: () => this.isAutoExecutionFrozen,
        freezeAutoExecution: () => this.freezeAutoExecution(),
        unfreezeAutoExecution: () => this.unfreezeAutoExecution(),
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
      const [binancePositions, bybitPositions] = await Promise.allSettled([
        this.binanceClient.getPositions(),
        this.bybitClient.getPositions(),
      ]);

      const hasBinanceOpen = binancePositions.status === 'fulfilled' && binancePositions.value.some((p) => p.side !== 'FLAT' && !p.quantity.isZero());
      const hasBybitOpen = bybitPositions.status === 'fulfilled' && bybitPositions.value.some((p) => p.side !== 'FLAT' && !p.quantity.isZero());

      if (!hasBinanceOpen && !hasBybitOpen) {
        for (const t of activeTrades) {
          logger.warn({ tradeId: t.id, coin: t.coin, state: t.state }, 'Auto-resolving stale SQLite trade (exchanges are flat)');
          this.tradeRepo.update({ id: t.id, state: 'COMPLETED', error_message: 'Cleaned up on startup: exchange positions are flat' });
        }
        logger.info('Successfully cleared stale SQLite trade records; trading slot freed');
      } else {
        for (const t of activeTrades) {
          logger.warn({ tradeId: t.id, coin: t.coin, state: t.state }, 'Reconciling unresolved trade on startup with open positions');
          await this.telegram.sendAlert(
            'Restart Recovery Alert',
            `Bot restarted with active exchange positions and unresolved trade ${t.id} (${t.coin}) in state ${t.state}`,
            'WARN'
          );
        }
      }
    } else {
      logger.info('Startup reconciliation clean: No unresolved open trades');
    }
  }

  

  async start(): Promise<void> {
    this.acquireLock();
    this.isRunning = true;
    this.lastPeriodicReportTime = Date.now();
    logger.info({ mode: this.config.appConfig.app.mode }, 'Funding Arbitrage Bot started successfully');

    await this.startupReconciliation();

    // Initial symbol cache refresh
    const activeSymbols = await this.symbolCache.refreshIfExpired();

    // Start Liquidation Sentinel and Telegram command listener
    this.sentinel.start();
    if (this.telegramCommander) {
      this.telegramCommander.start();
    }

    // Send formatted startup broadcast to Telegram
    const modeStr = this.config.appConfig.app.mode.toUpperCase();
    const isLive = this.config.appConfig.app.mode === 'live';
    const modeEmoji = isLive ? '🟢' : '🟡';

    const startupMessage = [
      `🤖 *Autonomous Funding Arbitrage Bot Online* (\`${modeStr}\`)`,
      '━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '⚡ *Execution Mode:* `🟢 100% Autonomous (Auto-Execution Active)`',
      '⚖️ *Leverage:* `Highest Common Dynamic Leverage`',
      '🛡️ *Liquidation Sentinel:* `Active (Auto-Closes Surviving Leg & Finds New Opportunity)`',
      `📈 *Min Spread Entry:* \`${this.config.appConfig.strategy.minimum_funding_edge_pct}%\``,
      `🔄 *Carry Retention:* \`${this.config.appConfig.strategy.carry_min_retention_edge_pct}%\``,
      '━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '💬 *6 Bot Commands:*',
      '1️⃣ /flatten — 🚨 Flatten for Emergency (100% USDT)',
      '2️⃣ /current — 📊 Current Trade Details & Positions',
      '3️⃣ /next — 🎯 Next Trade Plan & Sizing Forecast',
      '4️⃣ /top10 — 📈 Top 10 Cross-Exchange Funding Spreads',
      '5️⃣ /wallet — 💼 Binance & Bybit Balances & Margin',
      '6️⃣ /netpnl — 💰 Today Realized Net PnL & Performance',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `_Scanning ${activeSymbols.length} perpetuals across Binance & Bybit..._`
    ].join('\n');

    await this.telegram.sendMessage(startupMessage);

    // Main Scanning & Trading Loop
    while (this.isRunning) {
      try {
        if (this.killSwitch.isEngaged() || this.circuitBreaker.isTripped()) {
          logger.warn('Trading halted by KillSwitch or CircuitBreaker. Standing by...');
          await sleep(10000);
          continue;
        }

        // 1. Proactively monitor margin balances & check for unhedged orphan positions (liquidation guard)
        await this.marginMonitor.checkMarginBalance();
        await this.marginMonitor.checkAndRecoverOrphanPositions();

        // 2. Refresh symbol cache if expired
        const activeSymbols = await this.symbolCache.refreshIfExpired();

        // Runtime stale trade auto-reconciliation
        const currentActiveTrades = this.tradeRepo.getActiveTrades();
        if (currentActiveTrades.length > 0) {
          const [binancePos, bybitPos] = await Promise.all([
            this.binanceClient.getPositions(),
            this.bybitClient.getPositions(),
          ]);
          const hasB = binancePos.some((p) => p.side !== 'FLAT' && !p.quantity.isZero());
          const hasBy = bybitPos.some((p) => p.side !== 'FLAT' && !p.quantity.isZero());
          if (!hasB && !hasBy) {
            logger.info('Exchanges are verified flat. Auto-reconciling stale active DB trades to COMPLETED');
            for (const t of currentActiveTrades) {
              this.tradeRepo.update({
                id: t.id,
                state: 'COMPLETED',
                error_message: 'Cleaned up during runtime: exchanges are verified flat',
              });
            }
          }
        }

        // 3. Scan funding rates
        const opportunities = await this.scanner.scanOpportunities(activeSymbols);



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

          // 1. Filter opportunities currently within their active entry window.
          // Strict timing: Only punch within the configured lead window (2.5m = 2m30s before funding settlement).
          const effectiveLeadMinutes = this.config.appConfig.strategy.entry_lead_minutes;

          const inWindowCandidates = opportunities.filter((opp) =>
            FundingScheduler.isWithinEntryWindow(
              opp.targetFundingTimeMs,
              effectiveLeadMinutes,
              20
            )
          );

          let approvedCandidate: any = null;

          if (inWindowCandidates.length > 0) {
            logger.info({ count: inWindowCandidates.length }, 'Evaluating candidate opportunities in 2m30s funding entry window...');
            for (const opp of inWindowCandidates.slice(0, 50)) {
              try {
                const evaluated = await this.opportunityFilter.evaluateOpportunity(opp);
                if (evaluated.isApproved) {
                  approvedCandidate = evaluated;
                  break;
                } else {
                  logger.info({ coin: opp.mapping.normalized_symbol, reason: evaluated.rejectionReason }, 'Candidate rejected by filter');
                }
              } catch (evalErr: any) {
                logger.warn({ coin: opp.mapping.normalized_symbol, err: evalErr?.message }, 'Error evaluating candidate');
              }
            }
          } else {
            // Find closest upcoming funding settlement
            const upcoming = opportunities.filter((opp) => opp.targetFundingTimeMs > Date.now());
            if (upcoming.length > 0) {
              const soonest = upcoming.reduce((min, o) => o.targetFundingTimeMs < min.targetFundingTimeMs ? o : min, upcoming[0]!);
              const msRemaining = FundingScheduler.msUntilEntryWindow(
                soonest.targetFundingTimeMs,
                effectiveLeadMinutes
              );
              const minLeft = Math.floor(msRemaining / 60000);
              const secLeft = Math.floor((msRemaining % 60000) / 1000);
              logger.info(
                {
                  coin: soonest.mapping.normalized_symbol,
                  timeUntilWindow: `${minLeft}m ${secLeft}s`,
                  entryWindowLead: `${effectiveLeadMinutes}m (2m30s)`,
                  settlementIn: `${Math.floor((soonest.targetFundingTimeMs - Date.now()) / 60000)}m`,
                },
                'Standing by: Waiting for funding entry window (opens 2m 30s before settlement)'
              );
            }
          }

          if (approvedCandidate) {
            const evaluated = approvedCandidate;
            const coin = evaluated.opportunity.mapping.normalized_symbol;
            const edgePct = parseFloat(evaluated.opportunity.fundingDiffPct.toString()).toFixed(4);

            if (this.isAutoExecutionFrozen) {
              logger.info(
                { coin, edgePct: `${edgePct}%` },
                '❄️ [MANUAL MODE] Opportunity approved in entry window, but automated trade execution is FROZEN.'
              );
              await sleep(15000);
              continue;
            }

            // Pre-trade risk check with clear telegram alert on failure
            try {
              await this.riskManager.validatePreTrade(evaluated);
            } catch (riskErr: any) {
              logger.warn({ coin, err: riskErr?.message }, 'Pre-trade risk check rejected candidate');
              await this.telegram.sendMessage(
                `⚠️ *Trade Entry Blocked by Risk Guard: ${coin}*\n` +
                `• Reason: \`${riskErr?.message || riskErr}\`\n` +
                `• Will re-evaluate on next scan cycle.`
              );
              await sleep(15000);
              continue;
            }

              // Build Top 10 funding spread snapshot text before entering
              const top10 = opportunities.slice(0, 10);
              const top10Lines = top10.map((opp, idx) => {
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
              const netProfitUsd = evaluated.profitability.expectedNetProfitUsd.toFixed(2);
              const biCashFlow = evaluated.profitability.expectedFundingCashFlowBinance.toFixed(3);
              const byCashFlow = evaluated.profitability.expectedFundingCashFlowBybit.toFixed(3);
              const estFees = evaluated.profitability.estimatedEntryFees.plus(evaluated.profitability.estimatedExitFees).toFixed(3);
              const estSlippage = evaluated.profitability.estimatedEntrySlippageUsd.plus(evaluated.profitability.estimatedExitSlippageUsd).toFixed(3);

              const alertText = [
                `⚡ *TRADE EXECUTION SIGNAL: ALL VALIDATIONS PASSED* ⚡`,
                `━━━━━━━━━━━━━━━━━━━━━━`,
                `🎯 *Selected Pair:* \`${coin}\` (Binance & Bybit)`,
                `🔄 *Strategy Direction:* \`${direction}\``,
                `⚖️ *Leverage:* \`${appliedLeverage}x\` (Unified across exchanges)`,
                '',
                `✅ *Pre-Trade Validations Passed:*`,
                `• Aligned Settlement Epoch: \`Identical Minute\``,
                `• Dynamic Leverage Cap: \`${appliedLeverage}x\` approved`,
                `• Binance Margin: Required \`$${biMargin} USDT\` verified`,
                `• Bybit Margin: Required \`$${byMargin} USDT\` verified`,
                `• Net Profit Invariant: \`+$${netProfitUsd} USDT\` (Costs covered)`,
                `• Circuit Breaker & Kill Switch: \`Normal / Active\``,
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
                `• *Target Settlement In:* \`~${this.config.appConfig.strategy.entry_lead_minutes} minutes (2m 30s)\``,
                '',
                `📋 *Top 10 Funding Spreads At Time of Entry:*`,
                top10Lines.join('\n'),
                `━━━━━━━━━━━━━━━━━━━━━━`,
                `🚀 *Orders submitted concurrently. Will exit immediately after settlement.*`
              ].join('\n');

              await this.telegram.sendMessage(alertText);






              // Execute trade lifecycle
              const isSimulated = this.config.appConfig.app.mode === 'paper';
              await this.executionEngine.executeTrade(evaluated, isSimulated);
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
    if (this.sentinel) {
      this.sentinel.stop();
    }
    if (this.telegramCommander) {
      this.telegramCommander.stop();
    }
    this.releaseLock();
    this.db.close();
  }

  freezeAutoExecution(): void {
    this.isAutoExecutionFrozen = true;
    logger.warn('Automated trade execution FROZEN (Manual Mode Active)');
  }

  unfreezeAutoExecution(): void {
    this.isAutoExecutionFrozen = false;
    logger.warn('Automated trade execution UNFROZEN (Automatic Execution Active)');
  }

  isAutoExecutionFrozenState(): boolean {
    return this.isAutoExecutionFrozen;
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
