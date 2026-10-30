import { loadConfig } from '../src/config/env.js';
import { AppDatabase } from '../src/persistence/database.js';
import { runMigrations } from '../src/persistence/migrations.js';
import { DailySummaryRepository, TradeRepository } from '../src/persistence/repositories.js';

async function showStatus() {
  const config = loadConfig();
  const db = new AppDatabase(config.appConfig.persistence.path);
  const sqliteDb = db.connect();
  runMigrations(sqliteDb);

  const tradeRepo = new TradeRepository(sqliteDb);
  const dailyRepo = new DailySummaryRepository(sqliteDb);

  const activeTrades = tradeRepo.getActiveTrades();
  const todaySummary = dailyRepo.getOrCreateToday();

  // Query circuit breaker risk events
  const cbTripped = sqliteDb
    .prepare(`SELECT * FROM risk_events WHERE event_type = 'CIRCUIT_BREAKER_TRIPPED' ORDER BY timestamp DESC LIMIT 1`)
    .get();

  // DB integrity
  const integrityRow: any = sqliteDb.prepare('PRAGMA integrity_check').get();
  const integrityOk = integrityRow && (integrityRow.integrity_check === 'ok' || Object.values(integrityRow)[0] === 'ok');

  console.log('\n======================================================');
  console.log('       FUNDING ARBITRAGE BOT — SYSTEM STATUS          ');
  console.log('======================================================');
  console.log(`Operating Mode:        ${config.appConfig.app.mode.toUpperCase()}`);
  console.log(`Database Integrity:    ${integrityOk ? 'HEALTHY (OK)' : 'CORRUPTED / ERROR'}`);
  console.log(`Circuit Breaker:       ${cbTripped ? 'TRIPPED (TRADING HALTED)' : 'NORMAL (CLOSED)'}`);
  console.log(`Active Trades Count:   ${activeTrades.length}`);
  console.log('------------------------------------------------------');
  console.log(`Today Date:            ${todaySummary.date}`);
  console.log(`Today Trades Completed:${todaySummary.trade_count}`);
  console.log(`Today Funding PnL:     $${todaySummary.total_funding_pnl_usd}`);
  console.log(`Today Trading PnL:     $${todaySummary.total_trading_pnl_usd}`);
  console.log(`Today Fees Paid:       $${todaySummary.total_fees_usd}`);
  console.log(`Today Net PnL:         $${todaySummary.net_pnl_usd}`);
  console.log(`Daily Loss Limit Hit:  ${todaySummary.loss_limit_hit ? 'YES' : 'NO'}`);
  console.log('======================================================');

  if (activeTrades.length > 0) {
    console.log('\nACTIVE TRADES IN PROGRESS:');
    for (const t of activeTrades) {
      console.log(`- ID: ${t.id} | Coin: ${t.coin} | State: ${t.state} | Direction: ${t.direction}`);
      console.log(`  Notional: $${t.target_notional_usd} | Exp Net Profit: $${t.expected_net_profit_usd}`);
    }
  } else {
    console.log('\nNo active unresolved trades in database.');
  }

  console.log('\n');
  db.close();
}

showStatus().catch(console.error);
