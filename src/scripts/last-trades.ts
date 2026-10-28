import fs from 'node:fs';
import path from 'node:path';
import DatabaseConstructor from 'better-sqlite3';
import { loadConfig } from '../config/env.js';
import {
  DbFill,
  DbFundingEvent,
  DbFundingTransaction,
  DbOrder,
  DbPositionSnapshot,
  DbStateTransition,
  DbTrade,
} from '../persistence/models.js';
import { toDecimal } from '../utils/decimal.js';

interface CliArgs {
  limit: number;
  status?: string;
  format: 'table' | 'json';
  coin?: string;
  tradeId?: string;
  configPath?: string;
  dbPath?: string;
}

function parseArgs(args: string[]): CliArgs {
  const result: CliArgs = {
    limit: 10,
    format: 'table',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--limit' && args[i + 1]) {
      result.limit = parseInt(args[++i]!, 10) || 10;
    } else if (arg === '--status' && args[i + 1]) {
      result.status = args[++i]!.toUpperCase();
    } else if (arg === '--format' && args[i + 1]) {
      result.format = args[++i] === 'json' ? 'json' : 'table';
    } else if (arg === '--coin' && args[i + 1]) {
      result.coin = args[++i]!.toUpperCase();
    } else if ((arg === '--id' || arg === '--trade-id') && args[i + 1]) {
      result.tradeId = args[++i];
    } else if (arg === '--config' && args[i + 1]) {
      result.configPath = args[++i];
    } else if (arg === '--db' && args[i + 1]) {
      result.dbPath = args[++i];
    }
  }

  return result;
}

export function displayLastTrades(cliArgs: CliArgs) {
  let config;
  try {
    config = loadConfig(cliArgs.configPath);
  } catch (err: any) {
    console.error(`Error loading configuration: ${err?.message}`);
    process.exit(1);
  }

  const rawDbPath = cliArgs.dbPath || config.appConfig.persistence.path;
  const resolvedDbPath = path.resolve(process.cwd(), rawDbPath);

  // Requirement: If configured database is missing, show configured path and error.
  // Never silently create a new empty database file!
  if (!fs.existsSync(resolvedDbPath)) {
    console.error(`\n[!] Error: Configured SQLite database does not exist at:`);
    console.error(`    ${resolvedDbPath}`);
    console.error(`Please verify your CONFIG_PATH or initialize the database using: npm run db:migrate\n`);
    process.exit(1);
  }

  let db;
  try {
    db = new DatabaseConstructor(resolvedDbPath, { readonly: true, fileMustExist: true });
  } catch (err: any) {
    console.error(`\n[!] Error opening database at ${resolvedDbPath}: ${err?.message}\n`);
    process.exit(1);
  }

  try {
    // Detailed single trade inspection
    if (cliArgs.tradeId) {
      showTradeDetails(db, cliArgs.tradeId, cliArgs.format);
      return;
    }

    // Build query for list of trades
    let sql = 'SELECT * FROM trades';
    const params: any[] = [];
    const whereClauses: string[] = [];

    if (cliArgs.status && cliArgs.status !== 'ALL') {
      whereClauses.push('state = ?');
      params.push(cliArgs.status);
    }

    if (cliArgs.coin) {
      whereClauses.push('(coin = ? OR binance_symbol = ? OR bybit_symbol = ?)');
      params.push(cliArgs.coin, cliArgs.coin, cliArgs.coin);
    }

    if (whereClauses.length > 0) {
      sql += ' WHERE ' + whereClauses.join(' AND ');
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(cliArgs.limit);

    const trades: DbTrade[] = db.prepare(sql).all(...params) as DbTrade[];

    if (trades.length === 0) {
      if (cliArgs.format === 'json') {
        console.log(JSON.stringify([], null, 2));
      } else {
        console.log(`\nLAST ${cliArgs.limit} FUNDING ARBITRAGE TRADES`);
        console.log(`Database: ${rawDbPath}\n`);
        console.log('No trades found matching the criteria.\n');
      }
      return;
    }

    if (cliArgs.format === 'json') {
      console.log(JSON.stringify(trades, null, 2));
      return;
    }

    // Format Table output matching prompt section 4.3
    console.log(`\nLAST ${trades.length} FUNDING ARBITRAGE TRADES`);
    console.log(`Database: ${rawDbPath}\n`);

    const header = `${'ID'.padEnd(10)} ${'COIN'.padEnd(10)} ${'BINANCE'.padEnd(9)} ${'BYBIT'.padEnd(9)} ${'STATUS'.padEnd(14)} ${'NET P&L'.padEnd(10)}`;
    console.log(header);
    console.log('-'.repeat(header.length + 5));

    let completedCount = 0;
    let failedCount = 0;
    let recoveryCount = 0;
    let totalConfirmedNetPnl = toDecimal('0');
    let openTradesCount = 0;

    for (const t of trades) {
      const shortId = t.id.length > 8 ? t.id.slice(0, 8) : t.id;
      const bDir = t.direction.includes('SHORT_BINANCE') ? 'SHORT' : 'LONG';
      const byDir = t.direction.includes('LONG_BYBIT') ? 'LONG' : 'SHORT';
      const netPnlNum = toDecimal(t.net_pnl_usd);
      const sign = netPnlNum.isPositive() && !netPnlNum.isZero() ? '+' : '';
      const formattedNet = `${sign}${netPnlNum.toFixed(2)}`;

      console.log(
        `${shortId.padEnd(10)} ${t.coin.padEnd(10)} ${bDir.padEnd(9)} ${byDir.padEnd(9)} ${t.state.padEnd(14)} ${formattedNet.padEnd(10)}`
      );

      if (t.state === 'COMPLETED') {
        completedCount++;
        totalConfirmedNetPnl = totalConfirmedNetPnl.plus(netPnlNum);
      } else if (t.state === 'FAILED' || t.state === 'REJECTED') {
        failedCount++;
        totalConfirmedNetPnl = totalConfirmedNetPnl.plus(netPnlNum); // Include realized losses if any
      } else {
        openTradesCount++;
      }

      if (t.state === 'RECOVERY_REQUIRED' || t.state === 'ABORT_AND_FLATTEN' || t.error_message?.includes('recovery')) {
        recoveryCount++;
      }
    }

    console.log('\nSummary:');
    console.log(`Completed:                          ${completedCount}`);
    console.log(`Failed:                             ${failedCount}`);
    console.log(`Recovery required:                  ${recoveryCount}`);
    const sign = totalConfirmedNetPnl.isPositive() && !totalConfirmedNetPnl.isZero() ? '+' : '';
    console.log(`Total confirmed net realized P&L:   ${sign}$${totalConfirmedNetPnl.toFixed(4)}`);
    console.log(`Open or unresolved trades:          ${openTradesCount}\n`);
  } finally {
    db.close();
  }
}

function showTradeDetails(db: any, tradeId: string, format: 'table' | 'json') {
  // Query trade and associated relations
  const trade: DbTrade = db.prepare('SELECT * FROM trades WHERE id = ? OR id LIKE ?').get(tradeId, `${tradeId}%`) as DbTrade;

  if (!trade) {
    console.error(`\n[!] Trade with ID "${tradeId}" not found in database.\n`);
    return;
  }

  const fundingEvent: DbFundingEvent = db.prepare('SELECT * FROM funding_events WHERE id = ?').get(trade.funding_event_id) as DbFundingEvent;
  const orders: DbOrder[] = db.prepare('SELECT * FROM orders WHERE trade_id = ? ORDER BY created_at ASC').all(trade.id) as DbOrder[];
  const fills: DbFill[] = db.prepare('SELECT * FROM fills WHERE trade_id = ? ORDER BY timestamp ASC').all(trade.id) as DbFill[];
  const fundingTxs: DbFundingTransaction[] = db.prepare('SELECT * FROM funding_transactions WHERE trade_id = ? ORDER BY timestamp ASC').all(trade.id) as DbFundingTransaction[];
  const snapshots: DbPositionSnapshot[] = db.prepare('SELECT * FROM position_snapshots WHERE trade_id = ? ORDER BY timestamp ASC').all(trade.id) as DbPositionSnapshot[];
  const transitions: DbStateTransition[] = db.prepare('SELECT * FROM state_transitions WHERE trade_id = ? ORDER BY timestamp ASC').all(trade.id) as DbStateTransition[];

  const detailedRecord = {
    trade,
    fundingEvent,
    orders,
    fills,
    fundingTxs,
    snapshots,
    transitions,
  };

  if (format === 'json') {
    console.log(JSON.stringify(detailedRecord, null, 2));
    return;
  }

  console.log('\n======================================================');
  console.log(`       TRADE AUDIT INSPECTION — ID: ${trade.id}       `);
  console.log('======================================================');
  console.log(`Coin:                     ${trade.coin}`);
  console.log(`Direction:                ${trade.direction}`);
  console.log(`State:                    ${trade.state}`);
  console.log(`Target Notional:          $${trade.target_notional_usd}`);
  console.log(`Expected Net Profit:      $${trade.expected_net_profit_usd} (Edge: ${trade.expected_funding_edge_pct}%)`);
  console.log(`Realized Trading PnL:     $${trade.realized_pnl_usd}`);
  console.log(`Funding PnL:              $${trade.total_funding_usd}`);
  console.log(`Total Fees Paid:          $${trade.total_fees_usd}`);
  console.log(`Net Realized PnL:         $${trade.net_pnl_usd}`);
  console.log(`Started At:               ${trade.created_at}`);
  console.log(`Completed At:             ${trade.completed_at || 'In-Progress / Unfinished'}`);
  if (trade.error_message) {
    console.log(`Error / Failure Note:     ${trade.error_message}`);
  }

  console.log('\n--- State Transition Audit History ---');
  for (const tr of transitions) {
    console.log(`[${tr.timestamp}] ${tr.from_state} -> ${tr.to_state} | Reason: ${tr.reason}`);
  }

  console.log('\n--- Orders Executed ---');
  for (const o of orders) {
    console.log(`[${o.exchange.toUpperCase()}] ${o.side} ${o.order_type} Qty: ${o.requested_quantity} (Filled: ${o.executed_quantity} @ avg ${o.average_price}) Status: ${o.status} | ClientID: ${o.client_order_id}`);
  }

  console.log('\n--- Fills & Fees ---');
  if (fills.length === 0) {
    console.log('No fills recorded.');
  } else {
    for (const f of fills) {
      console.log(`[${f.exchange.toUpperCase()}] Qty: ${f.quantity} @ $${f.price} | Fee: ${f.fee} ${f.fee_currency}`);
    }
  }

  console.log('\n--- Funding Transactions ---');
  if (fundingTxs.length === 0) {
    console.log('No funding transactions recorded.');
  } else {
    for (const ft of fundingTxs) {
      console.log(`[${ft.exchange.toUpperCase()}] Rate: ${ft.funding_rate} Notional: $${ft.position_notional} Payment: $${ft.payment_amount}`);
    }
  }
  console.log('======================================================\n');
}

// Standalone execution
if (process.argv[1]?.includes('last-trades.ts') || process.argv[1]?.includes('last-trades.js')) {
  const args = parseArgs(process.argv.slice(2));
  displayLastTrades(args);
}
