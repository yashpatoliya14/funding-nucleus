import { loadConfig } from '../src/config/env.js';
import { BinanceClient } from '../src/exchanges/binance.client.js';
import { BybitClient } from '../src/exchanges/bybit.client.js';

async function validate() {
  console.log('\n======================================================');
  console.log('       EXCHANGE CREDENTIALS VALIDATION TOOL           ');
  console.log('======================================================\n');

  const config = loadConfig();

  if (!config.env.BINANCE_API_KEY || !config.env.BINANCE_API_SECRET) {
    console.warn('[!] BINANCE_API_KEY or BINANCE_API_SECRET is missing in .env');
  }
  if (!config.env.BYBIT_API_KEY || !config.env.BYBIT_API_SECRET) {
    console.warn('[!] BYBIT_API_KEY or BYBIT_API_SECRET is missing in .env');
  }

  // 1. Binance Validation
  console.log('[*] Testing Binance Futures API...');
  const binance = new BinanceClient({
    apiKey: config.env.BINANCE_API_KEY,
    apiSecret: config.env.BINANCE_API_SECRET,
    testnet: config.env.BINANCE_TESTNET,
  });

  try {
    const t0 = Date.now();
    const serverTime = await binance.getServerTime();
    const ping = Date.now() - t0;
    console.log(`[✓] Binance Public Connectivity OK (Latency: ${ping}ms, ServerTime: ${new Date(serverTime).toISOString()})`);

    if (config.env.BINANCE_API_KEY && config.env.BINANCE_API_SECRET) {
      const balances = await binance.getBalances();
      const usdt = balances.find((b) => b.asset === 'USDT');
      console.log(`[✓] Binance Auth OK. Available USDT: $${usdt ? usdt.availableBalance.toFixed(2) : '0.00'}`);
      const comm = await binance.getCommissionRates('BTCUSDT');
      console.log(`[✓] Binance BTCUSDT Fee Rates: Maker ${comm.makerRate.times(100).toFixed(4)}%, Taker ${comm.takerRate.times(100).toFixed(4)}%`);
    }
  } catch (err: any) {
    console.error(`[✗] Binance Validation Failed: ${err?.message}`);
  }

  // 2. Bybit Validation
  console.log('\n[*] Testing Bybit V5 Linear API...');
  const bybit = new BybitClient({
    apiKey: config.env.BYBIT_API_KEY,
    apiSecret: config.env.BYBIT_API_SECRET,
    testnet: config.env.BYBIT_TESTNET,
  });

  try {
    const t0 = Date.now();
    const serverTime = await bybit.getServerTime();
    const ping = Date.now() - t0;
    console.log(`[✓] Bybit Public Connectivity OK (Latency: ${ping}ms, ServerTime: ${new Date(serverTime).toISOString()})`);

    if (config.env.BYBIT_API_KEY && config.env.BYBIT_API_SECRET) {
      const balances = await bybit.getBalances();
      const usdt = balances.find((b) => b.asset === 'USDT');
      console.log(`[✓] Bybit Auth OK. Available USDT: $${usdt ? usdt.availableBalance.toFixed(2) : '0.00'}`);
      const comm = await bybit.getCommissionRates('BTCUSDT');
      console.log(`[✓] Bybit BTCUSDT Fee Rates: Maker ${comm.makerRate.times(100).toFixed(4)}%, Taker ${comm.takerRate.times(100).toFixed(4)}%`);
    }
  } catch (err: any) {
    console.error(`[✗] Bybit Validation Failed: ${err?.message}`);
  }

  console.log('\nValidation complete.\n');
}

validate().catch(console.error);
