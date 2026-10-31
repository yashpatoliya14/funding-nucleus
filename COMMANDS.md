# 🚀 Arbitrage Engine - Complete Commands & Operations Guide

This document contains the complete list of CLI commands, scanners, diagnostics, safety kill-switches, and Linux systemd operations for the Binance-Bybit funding arbitrage engine.

---

## 📋 Table of Contents
1. [Market Scanners & Analysis](#1-market-scanners--analysis)
2. [Connection, IP & Wallet Audits](#2-connection-ip--wallet-audits)
3. [Bot Execution & Operating Modes](#3-bot-execution--operating-modes)
4. [Safety, Position Management & Kill Switches](#4-safety-position-management--kill-switches)
5. [Linux VM & Systemd Background Service Operations](#5-linux-vm--systemd-background-service-operations)
6. [Interactive Telegram Commands (Chat Control)](#6-interactive-telegram-commands-chat-control)
7. [Automated Telegram Alerts & Reports](#7-automated-telegram-alerts--reports)

---

## 1. Market Scanners & Analysis

### 🔍 Top Funding Rate Difference Scanner (Binance vs Bybit)
Scans all ~675 perpetual coins listed on both Binance and Bybit, computes real-time 8-hour funding rate spreads and APR, identifies optimal trade direction (Long vs Short), double-yield setups, and settlement countdowns.

```bash
# Scan and show the Top 5 highest funding rate spreads
npm run funding:diff

# Scan and show the Top 10 spreads
npm run funding:diff -- --top=10

# Inspect a specific coin's spread
npm run funding:diff PEPE

# Show all matching coin spreads
npm run funding:diff -- --all
```
*Output snapshot is automatically saved to:* `data/funding-diff-snapshot.json`

---

### 📊 Binance USDⓈ-M Futures Scanner
Fetches live funding rates for all 945+ active Binance USDⓈ-M Futures coins. Displays top positive rates (highest long yield), top negative rates (highest short yield), and major coins (BTC, ETH, SOL, BNB, etc.).

```bash
# Scan all Binance coins
npm run binance:funding

# Inspect funding rate for a specific coin on Binance
npm run binance:funding BTC
```
*Output snapshot is automatically saved to:* `data/binance-funding-rates.json`

---

### 📈 Statistical Correlation Scanner
Computes the Pearson correlation coefficient ($r$) across perpetual contracts using historical hourly klines (default 7 days). Identifies decoupled, inversely correlated, or synthetic hedge opportunities.

```bash
# Scan default top liquid assets (BTC, ETH, SOL, XRP, DOGE, BNB, SUI, etc.)
npm run correlation

# Inspect correlation for a specific target asset
npm run correlation SOL

# Adjust calculation lookback period (e.g. 14 days)
npm run correlation -- --days=14
```
*Output snapshot is automatically saved to:* `data/coin-correlation.json`

---

## 2. Connection, IP & Wallet Audits

### 🌐 IP & Exchange Connectivity Check
Detects your VPS external outbound public IPv4 address, tests low-latency ping to both Binance and Bybit REST and WebSocket endpoints, and validates API key signatures and trading permissions.

```bash
npm run check:connection
# or
npm run check:ip
```

---

### 💰 Wallet Balance & Position Sizing Calculator
Queries live available margin and wallet balances across both Binance and Bybit. Identifies capital bottlenecks and calculates the maximum safe trade notional size under your leverage cap (e.g. 3x or 5x).

```bash
npm run wallet:info
```
> **Formula**: $\text{Safe Leg Notional} = \min(\text{Binance USDT}, \text{Bybit USDT}) \times \text{Leverage Cap}$

---

### 🔑 Credentials & Fee Tier Validator
Tests API key signatures, HMAC SHA-256 generation, and retrieves your VIP maker/taker commission fee tiers on both exchanges.

```bash
npm run validate-credentials
```

---

### 📱 Telegram Bot Connectivity Test
Verifies Telegram Bot Token and Chat ID by sending an immediate diagnostic test message to your configured Telegram channel/group.

```bash
npm run telegram:test
```

---

## 3. Bot Execution & Operating Modes

### 📊 Real-Time Database & Circuit Breaker Status
Inspects the SQLite state database (`funding-bot-live.sqlite` or `funding-bot.sqlite`), displays open active positions, circuit breaker trips, today's realized profit/loss, and system health.

```bash
npm run status
```

---

### 🔴 Run Live Arbitrage Engine (Foreground Terminal)
Executes the trading engine directly in your terminal in `LIVE` mode (places real orders on Binance and Bybit).

```bash
npm run dev:live
```

---

### 🧪 Run Paper Simulation Mode (Foreground Terminal)
Executes the trading engine with simulated orders and mock fills against live market data.

```bash
npm run dev
```

---

### 🔨 Build Production Code
Compiles all TypeScript source files (`src/`) into optimized JavaScript in the `dist/` folder.

```bash
npm run build
```

---

### ⚡ Run Compiled Production Build
Runs the compiled `dist/main.js` with the live configuration.

```bash
npm run start:live
```

---

### 🧪 Test Futures Order Placement (CLI Script)
Submits a safe minimum order (e.g. ~$5 DOGEUSDT at 3x leverage) on futures and automatically closes it after 3 seconds via reduce-only order.

```bash
# Test on Binance (default)
npm run test:order

# Test specifically on Bybit
npm run test:order bybit

# Test on a specific coin (e.g. SOLUSDT or XRPUSDT)
npm run test:order bybit SOLUSDT
```

---

## 4. Safety, Position Management & Kill Switches

### 🚨 Emergency Position Flatten (Kill Switch)
Immediately cancels all open orders and liquidates/closes all open positions across both Binance and Bybit using market reduce-only orders.

```bash
npm run emergency-flatten
```

---

### ⚖️ Position Reconciliation & Orphan Audit
Audits active live exchange positions against the local SQLite state database. Flags and repairs any desynchronization, slippage mismatches, or orphaned one-legged exposure.

```bash
npm run reconcile-positions
```

---

## 5. Linux VM & Systemd Background Service Operations

When deployed on a Linux VPS (e.g. `root@vps-0nxr`), manage the automated background daemon using `systemd`:

### 🔄 Service Lifecycle Commands

```bash
# Start background trading daemon
systemctl start funding

# Stop background trading daemon
systemctl stop funding

# Restart background trading daemon (Triggers Telegram startup report)
systemctl restart funding

# Check running status and uptime
systemctl status funding

# Enable auto-start on server reboot
systemctl enable funding
```

---

### 📜 Real-Time Log Inspection on Server

```bash
# Stream live logs in real time (follow mode)
journalctl -u funding -f

# View the last 100 log lines without paginator
journalctl -u funding -n 100 --no-pager

# View error and fatal logs only
journalctl -u funding -p err -n 50 --no-pager
```

---

### 🛠️ Troubleshooting & Lock Clearance

If the service crashes due to an existing lock file after an abrupt reboot:
```bash
# 1. Check if another instance is running
ps aux | grep node

# 2. If no instance is active, remove stale lock
rm -f /root/funding-nucleus/data/funding-bot.lock

# 3. Reload systemd and restart service
systemctl daemon-reload
systemctl restart funding
```

---

## 6. Interactive Telegram Commands (Chat Control)

You can send commands directly in your Telegram chat to trigger actions on the running bot in real-time. No terminal access needed! Works with or without slash `/`.

| Telegram Message | Triggered Action | Response Summary |
| :--- | :--- | :--- |
| **`wallet`** (or `bal`) | Runs wallet & margin query | Shows Binance & Bybit USDT balances, margin availability, capital bottleneck, and maximum safe position size (at 3x & 5x). |
| **`top5`** (or `diff`, `rates`) | Scans live market spreads | Returns the Top 5 highest funding rate difference pairs across Binance & Bybit with live rates, spreads, and annualized APR. |
| **`status`** (or `health`) | Checks system vitals | Displays engine health (`HEALTHY`, `TRIPPED`, `KILL_SWITCH`), active trade count, today's trade count, funding income, fees, and net realized P&L. |
| **`trades`** (or `pos`) | Audits open trades | Details any currently active arbitrage pair, entry state, leg notionals, and expected net profit. |
| **`testorder`** (or `test`) | 🧪 Test Futures Order | Places a minimal test market order on futures and immediately auto-closes it after 3s with reduce-only. |
| **`flatten`** (or `kill`) | 🚨 Emergency Kill Switch | Immediately cancels all orders, executes market reduce-only liquidations on all open positions across both exchanges, and activates the kill switch. |
| **`help`** (or `menu`) | Help menu | Lists all available interactive Telegram commands. |

---

## 7. Automated Telegram Alerts & Reports

The engine automatically pushes alerts to your Telegram chat (`6218550123`):

| Trigger | Description |
| :--- | :--- |
| **Service Startup / Restart** | Sends full system status, active balances, circuit breaker state, and Top 5 highest funding rate spreads across all coins. |
| **Periodic 4-Hour Heartbeat** | Automatic 4-hour cycle report showing realized PnL, active open trades, and current Top 5 funding spread coins. |
| **Pre-Trade Opportunity Broadcast** | Dispatches a snapshot of the Top 5 funding spread coins immediately before executing an approved arbitrage trade. |
| **Trade Execution Alert** | Sends instant notification when Long and Short legs are filled with entry prices, size, and estimated net APR. |
| **Emergency / Circuit Breaker Alert** | Sends urgent notification if spread inverts, slippage exceeds threshold, or emergency flatten is triggered. |

