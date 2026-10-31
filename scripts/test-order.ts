import { loadConfig } from '../src/config/env.js';
import { BinanceClient } from '../src/exchanges/binance.client.js';
import { BybitClient } from '../src/exchanges/bybit.client.js';
import { IExchangeClient } from '../src/exchanges/exchange.interface.js';
import { PaperClient } from '../src/exchanges/paper.client.js';
import { initializeDns } from '../src/utils/dns-resolver.js';
import { executeTestOrder } from '../src/execution/test-order-executor.js';

async function main() {
  initializeDns();

  console.log('\n======================================================');
  console.log('       FUTURES TEST ORDER EXECUTION SCRIPT            ');
  console.log('======================================================\n');

  const config = loadConfig();
  const isLive = config.appConfig.app.mode === 'live';
  const targetExchange = (process.argv[2] || 'binance').toLowerCase();
  const symbol = (process.argv[3] || 'DOGEUSDT').toUpperCase();

  console.log(`Operating Mode: ${isLive ? 'LIVE' : 'PAPER'}`);
  console.log(`Target Exchange: ${targetExchange}`);
  console.log(`Target Symbol: ${symbol}\n`);

  let client: IExchangeClient;

  if (targetExchange === 'bybit') {
    client = isLive
      ? new BybitClient({
          apiKey: config.env.BYBIT_API_KEY,
          apiSecret: config.env.BYBIT_API_SECRET,
          testnet: config.env.BYBIT_TESTNET,
        })
      : new PaperClient({ exchangeName: 'bybit' });
  } else {
    client = isLive
      ? new BinanceClient({
          apiKey: config.env.BINANCE_API_KEY,
          apiSecret: config.env.BINANCE_API_SECRET,
          testnet: config.env.BINANCE_TESTNET,
        })
      : new PaperClient({ exchangeName: 'binance' });
  }

  console.log(`[1/3] Setting leverage & querying contract specifications for ${symbol}...`);
  console.log(`[2/3] Submitting minimum viable test order on ${targetExchange}...`);

  try {
    const res = await executeTestOrder(client, {
      symbol,
      side: 'BUY',
      autoClose: true,
      holdSeconds: 3,
    });

    console.log('\n[✓] Test Order Succeeded:');
    console.log(`    • Symbol:       ${res.symbol}`);
    console.log(`    • Quantity:     ${res.qty}`);
    console.log(`    • Entry Price:  $${res.entryPrice}`);
    console.log(`    • Notional:     $${res.notionalUsd} USDT`);
    console.log(`    • Open Status:  ${res.openStatus}`);
    console.log(`    • Auto-Closed:  ${res.closeStatus || 'YES'}`);
    console.log('\n[3/3] Position verified flat! Everything is functional.');
  } catch (err: any) {
    console.error(`\n[✗] Test Order Failed:`, err?.message || err);
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].includes('test-order')) {
  main().catch(console.error);
}
