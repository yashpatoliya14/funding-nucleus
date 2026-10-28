import { loadConfig } from '../src/config/env.js';
import { BinanceClient } from '../src/exchanges/binance.client.js';
import { BybitClient } from '../src/exchanges/bybit.client.js';
import { PaperClient } from '../src/exchanges/paper.client.js';
import { AppDatabase } from '../src/persistence/database.js';
import { RiskEventRepository } from '../src/persistence/repositories.js';
import { KillSwitch } from '../src/risk/kill-switch.js';

async function flatten() {
  console.log('\n======================================================');
  console.log('       EMERGENCY FLATTEN OPERATOR COMMAND             ');
  console.log('======================================================\n');

  const config = loadConfig();
  const db = new AppDatabase(config.appConfig.persistence.path);
  const sqliteDb = db.connect();
  const riskRepo = new RiskEventRepository(sqliteDb);

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

  const killSwitch = new KillSwitch(binance, bybit, riskRepo);
  killSwitch.activate('Manual operator execution of emergency-flatten script');

  console.log('[!] Submitting reduce-only MARKET close orders for all positions...');
  const result = await killSwitch.emergencyFlatten();

  console.log(`\nFlatten completed.`);
  console.log(`Positions Closed: ${result.flattenedCount}`);
  if (result.errors.length > 0) {
    console.error(`Errors encountered:`, result.errors);
  } else {
    console.log(`[✓] All positions successfully flattened and verified.`);
  }

  db.close();
}

flatten().catch(console.error);
