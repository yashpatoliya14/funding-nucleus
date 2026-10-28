import { loadConfig } from '../src/config/env.js';
import { BinanceClient } from '../src/exchanges/binance.client.js';
import { BybitClient } from '../src/exchanges/bybit.client.js';
import { PaperClient } from '../src/exchanges/paper.client.js';
import { AppDatabase } from '../src/persistence/database.js';
import { TradeRepository } from '../src/persistence/repositories.js';

async function reconcile() {
  console.log('\n======================================================');
  console.log('       LIVE POSITION RECONCILIATION AUDIT             ');
  console.log('======================================================\n');

  const config = loadConfig();
  const db = new AppDatabase(config.appConfig.persistence.path);
  const sqliteDb = db.connect();
  const tradeRepo = new TradeRepository(sqliteDb);

  const isLive = config.appConfig.app.mode === 'live';
  const binance = isLive
    ? new BinanceClient({
        apiKey: config.env.BINANCE_API_KEY,
        apiSecret: config.env.BINANCE_API_SECRET,
        testnet: config.env.BINANCE_TESTNET,
      })
    : new PaperClient({ exchangeName: 'binance' });

  const bybit = isLive
    ? new BybitClient({
        apiKey: config.env.BYBIT_API_KEY,
        apiSecret: config.env.BYBIT_API_SECRET,
        testnet: config.env.BYBIT_TESTNET,
      })
    : new PaperClient({ exchangeName: 'bybit' });

  console.log(`[Mode: ${config.appConfig.app.mode.toUpperCase()}] Fetching live exchange positions...`);

  const [bPos, byPos] = await Promise.all([binance.getPositions(), bybit.getPositions()]);

  const openB = bPos.filter((p) => !p.quantity.isZero() && p.side !== 'FLAT');
  const openBy = byPos.filter((p) => !p.quantity.isZero() && p.side !== 'FLAT');

  console.log(`\nBinance Open Positions (${openB.length}):`);
  for (const p of openB) {
    console.log(`- ${p.symbol}: ${p.side} ${p.quantity.toString()} @ avg $${p.entryPrice.toFixed(2)} (Mark: $${p.markPrice.toFixed(2)})`);
  }

  console.log(`\nBybit Open Positions (${openBy.length}):`);
  for (const p of openBy) {
    console.log(`- ${p.symbol}: ${p.side} ${p.quantity.toString()} @ avg $${p.entryPrice.toFixed(2)} (Mark: $${p.markPrice.toFixed(2)})`);
  }

  const activeDbTrades = tradeRepo.getActiveTrades();
  console.log(`\nSQLite Active Trades in DB (${activeDbTrades.length}):`);
  for (const t of activeDbTrades) {
    console.log(`- Trade ${t.id} [${t.coin}] State: ${t.state} Direction: ${t.direction}`);
  }

  if (openB.length === 0 && openBy.length === 0) {
    console.log('\n[✓] VERIFIED: Both exchange accounts are completely FLAT.');
  } else {
    console.log('\n[!] WARNING: Non-zero open positions detected on exchange accounts!');
  }

  db.close();
  console.log('\n');
}

reconcile().catch(console.error);
