# Robust Binance–Bybit Funding Arbitrage Bot

A production-oriented cryptocurrency funding arbitrage trading engine engineered in **TypeScript (Node.js LTS)** utilizing **SQLite (better-sqlite3)** for local persistent storage and state recovery.

The bot autonomously scans matched perpetual contracts across **Binance USDⓈ-M Futures** and **Bybit USDT Perpetuals**, identifies funding-rate discrepancies, calculates net expected profitability factoring in dynamic order book slippage and actual commission tiers, executes delta-neutral market orders concurrently, tracks funding settlements, and verifies flat position closure.

---

## 1. Key Invariants & Safety Architecture

1. **Market Orders Only**: All entries, hedge recoveries, and exits use `MARKET` orders only. Limit, maker, or post-only orders are strictly prohibited in the engine.
2. **Paper Mode Default**: The system defaults to Paper Trading simulation. Live capital trading requires explicit operator activation and credential configuration.
3. **Matched USD Notional**: Sizing operates on matched USD dollar exposure across legs (e.g. $100 Binance, $100 Bybit), not matched coin quantities or margin.
4. **Resilient One-Leg Recovery**: If one leg rejects or partially fills, the engine enforces strict unhedged timeouts (`maximum_unhedged_seconds: 10s`). If hedge completion is unsafe, the filled leg is closed immediately via reduce-only market orders.
5. **Persistent State Machine**: State transitions (`IDLE` → `SCANNING` → `OPPORTUNITY_VALIDATED` → `RISK_APPROVED` → `EXECUTION_INTENT_SAVED` → `ENTRY_SUBMITTED` → `ENTRY_RECONCILIATION` → `BOTH_LEGS_HEDGED` → `WAITING_FOR_FUNDING` → `FUNDING_RECONCILIATION` → `EXIT_PENDING` → `CLOSING_POSITIONS` → `FLAT_VERIFICATION` → `COMPLETED`) are persisted transactionally in SQLite.
6. **No Float Arithmetic for Money**: All financial quantities and calculations use `Decimal.js` (30 decimal precision) and serialize as strings in SQLite.
7. **Single Instance Process Lock**: An OS file lock prevents multiple bot instances from running against the same database and trading accounts simultaneously.

---

## 2. Project Directory Structure

```
funding/
├── src/
│   ├── main.ts                     # Application entry point & graceful shutdown hooks
│   ├── app.ts                      # Core coordinator, lock management & main scan loop
│   ├── config/
│   │   ├── env.ts                  # Environment variable parser & config loader
│   │   └── schema.ts               # Zod schema for validated YAML configuration
│   ├── exchanges/
│   │   ├── types.ts                # Domain types (instruments, order books, positions)
│   │   ├── exchange.interface.ts   # IExchangeClient common contract
│   │   ├── binance.client.ts       # Binance USDⓈ-M Futures REST client
│   │   ├── bybit.client.ts         # Bybit V5 Linear Perpetuals REST client
│   │   ├── paper.client.ts         # High-fidelity paper trading simulation client
│   │   ├── authentication.ts       # HMAC SHA-256 signing for Binance and Bybit
│   │   ├── rate-limiter.ts         # Token-bucket rate limiter with exponential backoff
│   │   └── websocket-manager.ts    # Resilient WebSocket connection manager
│   ├── market-data/
│   │   ├── symbol-matcher.ts       # Cross-exchange contract compatibility matcher
│   │   ├── symbol-cache.ts         # 24-hour TTL SQLite cache for symbol specifications
│   │   ├── funding-scanner.ts      # Real-time multi-exchange funding rate scanner
│   │   ├── orderbook-manager.ts    # L2 depth walking & VWAP slippage estimation
│   │   └── market-health.ts        # Data freshness & server clock drift detection
│   ├── strategy/
│   │   ├── funding-calculator.ts   # Funding cash flow & trade direction engine
│   │   ├── position-sizing.ts      # Matched USD notional converter & step rounding
│   │   ├── profitability-engine.ts # Net expected profit calculator after fees & slippage
│   │   └── opportunity-filter.ts   # Multi-tier candidate approval pipeline
│   ├── risk/
│   │   ├── risk-manager.ts         # Pre-trade validations & risk constraint auditor
│   │   ├── exposure-manager.ts     # Total aggregate notional & delta exposure tracker
│   │   ├── circuit-breaker.ts      # Consecutive failure & loss limit circuit breaker
│   │   └── kill-switch.ts          # Emergency halt & reduce-only flattening
│   ├── execution/
│   │   ├── types.ts                # Execution context & reconciliation structures
│   │   ├── state-machine.ts        # Idempotent state machine with audit transitions
│   │   ├── order-manager.ts        # Pre-persisted MARKET order submission & recovery
│   │   ├── reconciliation.ts       # Live position & fill recorder
│   │   ├── hedge-recovery.ts       # One-leg failure abort & recovery engine
│   │   └── execution-engine.ts     # Full trade lifecycle orchestrator
│   ├── scheduler/
│   │   ├── funding-scheduler.ts    # Entry window timing evaluator (10m pre-funding)
│   │   └── exit-scheduler.ts       # Target exit timing evaluator (60s post-funding)
│   ├── persistence/
│   │   ├── database.ts             # better-sqlite3 with WAL mode, foreign keys & pragmas
│   │   ├── migrations.ts           # Versioned SQL migration engine
│   │   ├── models.ts               # Database table interfaces
│   │   └── repositories.ts         # Data access objects (DAOs) for SQLite
│   ├── notifications/
│   │   └── telegram.ts             # Telegram Bot API alert dispatcher
│   ├── monitoring/
│   │   ├── health.ts               # System health check (clock sync, DB integrity)
│   │   └── metrics.ts              # P&L, fees, and trade counters
│   └── utils/
│       ├── decimal.ts              # Decimal.js arithmetic wrappers & rounding
│       ├── time.ts                 # UTC timestamp helpers & alignment checks
│       ├── errors.ts               # Custom domain error hierarchy
│       └── logger.ts               # Pino structured logger with credential redaction
├── tests/
│   ├── unit/                       # Unit tests for strategy, math, state, and persistence
│   ├── execution/                  # Execution & one-leg recovery tests
│   └── safety/                     # Safety invariants & risk limit tests
├── scripts/
│   ├── status.ts                   # CLI status dashboard
│   ├── validate-credentials.ts     # Credential and API permission tester
│   ├── reconcile-positions.ts      # Live position auditor
│   └── emergency-flatten.ts        # Emergency manual position flattening tool
├── config/
│   └── config.example.yaml         # Master YAML configuration file
├── data/
│   └── .gitkeep                    # Storage for SQLite database
├── .env.example
├── tsconfig.json
├── vitest.config.ts
└── package.json
```

---

## 3. Installation & Quickstart

### Prerequisites
- Node.js LTS (v20+ or v22+, tested on v24)
- npm (v10+)
- Python / C++ build tools (optional; `better-sqlite3` uses prebuilt binaries on supported platforms)

### Setup Commands
```bash
# 1. Install dependencies
npm ci

# 2. Configure environment
cp .env.example .env

# 3. Run database migrations
npm run db:migrate

# 4. Verify TypeScript compilation
npm run typecheck

# 5. Run test suite
npm run test

# 6. Start in Paper Mode
npm run dev
```

---

## 4. Configuration Reference

Configuration is managed via `config/config.example.yaml` (or custom path defined in `CONFIG_PATH`):

```yaml
app:
  mode: paper                     # 'paper' (default) or 'live'
  log_level: INFO

persistence:
  driver: sqlite
  path: ./data/funding-bot.sqlite # Local SQLite database path

symbols:
  cache_ttl_hours: 24             # Invalidate matched contract metadata after 24h
  refresh_trading_status_seconds: 30

strategy:
  entry_lead_minutes: 10          # Evaluate entry 10 minutes prior to funding epoch
  target_exit_delay_seconds: 60   # Exit 60 seconds after funding settlement
  minimum_net_profit_usd: 0.50    # Minimum net expected profit after all fees & slippage
  minimum_funding_edge_pct: 0.05  # Minimum funding rate differential (0.05%)
  risk_buffer_usd: 0.10           # Deducted as margin of error from net profit calculation
  require_aligned_funding_events: true # Only trade when funding timestamps align within 60s

execution:
  order_type: MARKET              # Strictly MARKET
  parallel_entry: true            # Submit both orders concurrently via Promise.allSettled
  maximum_unhedged_seconds: 10    # Maximum time permitted for unhedged position
  maximum_recovery_seconds: 15    # Maximum duration for hedge recovery routine
  maximum_slippage_bps: 10        # Maximum tolerated slippage in basis points
  maximum_notional_mismatch_pct: 0.5 # Maximum allowed mismatch between legs (0.5%)
  reduce_only_exits: true         # Use reduce-only semantics when closing positions

risk:
  default_leverage_cap: 5         # Common leverage ceiling
  maximum_notional_per_leg_usd: 100 # Target USD exposure per leg
  maximum_concurrent_trades: 1    # Maximum simultaneous active arbitrage pairs
  maximum_daily_loss_usd: 5       # Trips circuit breaker if cumulative daily loss exceeds $5
  maximum_aggregate_notional_usd: 200 # Global dollar limit across both exchanges

monitoring:
  telegram_enabled: false         # Set to true and set .env credentials for alerts
```

---

## 5. CLI Operational Tools

The bot includes standalone operational commands:

| Command | Script | Description |
|---|---|---|
| `npm run status` | [status.ts](file:///c:/Users/yashp/Desktop/funding/scripts/status.ts) | Shows operating mode, database health, circuit breaker state, active trades, and daily P&L. |
| `npm run validate-credentials` | [validate-credentials.ts](file:///c:/Users/yashp/Desktop/funding/scripts/validate-credentials.ts) | Tests exchange API keys, checks permissions, available margin, and commission rates. |
| `npm run reconcile-positions` | [reconcile-positions.ts](file:///c:/Users/yashp/Desktop/funding/scripts/reconcile-positions.ts) | Audits open exchange positions against SQLite database records. |
| `npm run emergency-flatten` | [emergency-flatten.ts](file:///c:/Users/yashp/Desktop/funding/scripts/emergency-flatten.ts) | Engages kill switch and immediately market-closes all positions across Binance and Bybit. |
| `npm run trades:last` | [last-trades.ts](file:///c:/Users/yashp/Desktop/funding/src/scripts/last-trades.ts) | Displays the most recent 10 trades with directions, notionals, fees, slippage, and net P&L. |
| `npm run trade:details` | [last-trades.ts](file:///c:/Users/yashp/Desktop/funding/src/scripts/last-trades.ts) | Performs full audit inspection of a single trade (state transitions, orders, fills, snapshots). |
| `npm run telegram:test` | [test-telegram.ts](file:///c:/Users/yashp/Desktop/funding/scripts/test-telegram.ts) | Tests Telegram connectivity and sends a test message to your configured chat. |

---

## 6. Comprehensive Automated Testing

The testing suite uses **Vitest** with completely isolated in-memory or temporary SQLite databases. Automated tests **never submit live exchange orders** and **never modify or touch the production database**.

```bash
# Static type checking
npm run typecheck

# Run complete automated test suite (72+ tests)
npm test

# Run tests with V8 code coverage report
npm run test:coverage

# Run integration tests (Telegram dispatcher & Last Trades CLI)
npm run test:integration

# Run execution safety & failure scenario tests (Scenarios 1-12)
npm run test:safety
```

### Test Coverage Highlights
- **Symbol Matching (10 tests)**: BTCUSDT/ETHUSDT matching, rejecting spot and delivery contracts, settlement currency compatibility, suspended instrument rejection, 24-hour cache hits, cache invalidation, and malformed metadata handling.
- **Funding Calculation**: Both positive/negative funding, opposing signs, zero rate differentials, misaligned timestamps, and predicted rate shifts.
- **Fees & Profitability (10 tests)**: Entry/exit taker fees, dynamic order book VWAP slippage, depth exhaustion, risk buffer margin, and decimal precision.
- **Position Sizing & Risk**: Equal USD notional sizing, step size rounding, min lot enforcement, multiplier adjustments, leverage ceilings, daily loss limits.
- **SQLite Persistence**: Parent-child foreign key integrity, transactions, rollbacks, and recovery after abrupt restarts.
- **Execution Failures (Scenarios 1–12)**: Concurrent entries, Binance fills/Bybit rejects, Binance timeout with status recovery (no blind resubmissions), partial fills with hedge recovery, notional mismatch flattening, unconfirmed funding settlement, failed close orders, process locks, emergency kill switches, and rate limit backoff.

---

## 7. Telegram-Only Monitoring

The Telegram monitoring interface provides real-time notifications and daily performance summaries without requiring an external dashboard or web server.

### Environment Configuration
Configure the following in `.env`:
```bash
TELEGRAM_BOT_TOKEN="123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ"
TELEGRAM_CHAT_ID="987654321"
TELEGRAM_MONITORING_ENABLED=true
TELEGRAM_MONITORING_DURATION_DAYS=3
```

### Monitored Event Types (19 Total)
1. Bot startup / restart
2. Operating mode (Paper / Live)
3. Exchange connectivity
4. Symbol cache refresh
5. New eligible opportunity
6. Opportunity rejected & reason
7. Trade execution started
8. Both legs hedged
9. Partial fill / one-leg failure
10. Hedge recovery initiated
11. Emergency flatten triggered
12. Funding settlement verified
13. Trade closed and reconciled
14. Actual net P&L recorded
15. Unexpected open position
16. Daily loss limit reached
17. Kill switch engaged
18. Authentication failure
19. Monitoring window ended

### Daily Telegram Summary
Dispatched daily at **9:00 PM IST (15:30 UTC)** with breakdown of:
- Scanned pairs, eligible opportunities, attempted/completed/failed trades
- Confirmed funding received, funding paid, taker fees, slippage, realized trading P&L, net P&L
- Reconciled open exchange positions and risk status

### Expiration & Safety Guarantee
- When the configured monitoring window (1–7 days) expires, routine monitoring messages cease automatically and an expiration notification is sent.
- **Critical risk alerts** (kill switch engagement, unexpected open positions, unhedged recovery failures) **never expire** and continue firing as long as the bot runs.
- Expiration **does not close open trades or change the trading mode**.

---

## 8. Viewing Historical Trades CLI

Inspect the last N trades directly from local SQLite without querying the exchanges or modifying production data.

```bash
# View last 10 trades (default table format)
npm run trades:last

# View last 20 trades
npm run trades:last -- --limit 20

# Filter by trade status
npm run trades:last -- --status completed
npm run trades:last -- --status failed

# Filter by coin
npm run trades:last -- --coin BTCUSDT

# Output raw JSON array (for piping to jq or scripts)
npm run trades:last -- --format json

# Inspect complete audit lifecycle for a single trade
npm run trade:details -- --id <trade-uuid>
```

---

## 6. Linux VPS Deployment (Systemd)

For continuous production deployment on Linux VPS without Docker Compose:

1. Clone to `/opt/funding-bot` and run `npm ci && npm run build`.
2. Restrict `.env` permissions: `chmod 600 /opt/funding-bot/.env`.
3. Create systemd service unit `/etc/systemd/system/funding-bot.service`:

```ini
[Unit]
Description=Binance-Bybit Funding Arbitrage Bot
After=network.target

[Service]
Type=simple
User=trading
WorkingDirectory=/opt/funding-bot
ExecStart=/usr/bin/node dist/main.js
Restart=on-failure
RestartSec=10
LimitNOFILE=65535
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

4. Enable and start:
```bash
sudo systemctl daemon-reload
sudo systemctl enable funding-bot
sudo systemctl start funding-bot
sudo journalctl -u funding-bot -f
```

---

## 7. Pre-Flight Live Trading Checklist

Before switching `app.mode` from `paper` to `live`:
- [ ] Tested and verified Paper Trading over at least 3 full 8-hour funding cycles.
- [ ] Confirmed both Binance and Bybit API keys have **Futures / Linear Trading permissions ONLY** and **Withdrawal permissions DISABLED**.
- [ ] Restricted API keys to VPS static IP address on Binance and Bybit dashboards.
- [ ] Funded both accounts with sufficient USDT margin (at least 3x the intended notional).
- [ ] Ran `npm run validate-credentials` to verify balances and authenticated endpoints.
- [ ] Confirmed `npm run reconcile-positions` reports both accounts strictly flat.
- [ ] Configured Telegram Bot token and chat ID in `.env` to receive real-time execution alerts.
