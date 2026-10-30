import { request } from 'undici';
import { loadConfig } from '../src/config/env.js';
import { BinanceClient } from '../src/exchanges/binance.client.js';
import { BybitClient } from '../src/exchanges/bybit.client.js';
import { initializeDns } from '../src/utils/dns-resolver.js';

interface IpInfo {
  ip: string;
  country?: string;
  city?: string;
  org?: string;
}

async function getPublicIp(): Promise<IpInfo> {
  const ipServices = [
    'https://api.ipify.org?format=json',
    'https://ifconfig.me/all.json',
    'https://ipinfo.io/json',
  ];

  for (const url of ipServices) {
    try {
      const res = await request(url, { headers: { Accept: 'application/json' } });
      if (res.statusCode === 200) {
        const data: any = await res.body.json();
        return {
          ip: data.ip || data.ip_addr || data.origin,
          country: data.country || data.country_code,
          city: data.city,
          org: data.org || data.asn_org,
        };
      }
    } catch {
      // Try next IP lookup provider
    }
  }

  return { ip: 'Unable to detect external IP' };
}

async function checkConnection() {
  initializeDns();

  console.log('\n================================================================');
  console.log('       EXCHANGE CONNECTIVITY & OUTBOUND IP AUDIT TOOL           ');
  console.log('================================================================\n');

  // 1. Detect public IP address of this machine / VM
  process.stdout.write('[1/3] Detecting Server / Machine Outbound IP Address... ');
  const ipInfo = await getPublicIp();
  console.log('Done.');
  console.log('----------------------------------------------------------------');
  console.log(`📡 Your Public IP:       \x1b[32m\x1b[1m${ipInfo.ip}\x1b[0m`);
  if (ipInfo.country) {
    console.log(`🌍 Location / ISP:       ${ipInfo.city ? ipInfo.city + ', ' : ''}${ipInfo.country} (${ipInfo.org || 'Unknown Org'})`);
  }
  console.log(`ℹ️  Note:                 If your API keys use IP restrictions, whitelist \x1b[33m${ipInfo.ip}\x1b[0m on Binance & Bybit.`);
  console.log('----------------------------------------------------------------\n');

  const config = loadConfig();

  // 2. Binance Futures Connection & Auth Check
  console.log('[2/3] Checking Binance Futures API (fapi.binance.com)...');
  const binance = new BinanceClient({
    apiKey: config.env.BINANCE_API_KEY,
    apiSecret: config.env.BINANCE_API_SECRET,
    testnet: config.env.BINANCE_TESTNET,
  });

  try {
    const t0 = Date.now();
    const serverTime = await binance.getServerTime();
    const latency = Date.now() - t0;
    console.log(`  [✓] Public Ping OK     | Latency: ${latency}ms | Server Time: ${new Date(serverTime).toISOString()}`);

    if (config.env.BINANCE_API_KEY && config.env.BINANCE_API_SECRET) {
      try {
        const balances = await binance.getBalances();
        const usdt = balances.find((b) => b.asset === 'USDT');
        const comm = await binance.getCommissionRates('BTCUSDT');

        console.log(`  [✓] Authentication OK  | API Key: ${config.env.BINANCE_API_KEY.slice(0, 6)}...${config.env.BINANCE_API_KEY.slice(-4)}`);
        console.log(`  [✓] Futures Balance    | Available: $${usdt ? usdt.availableBalance.toFixed(2) : '0.00'} USDT (Margin: $${usdt ? usdt.marginBalance.toFixed(2) : '0.00'})`);
        console.log(`  [✓] Fee Tier (BTC)     | Maker: ${comm.makerRate.times(100).toFixed(4)}% | Taker: ${comm.takerRate.times(100).toFixed(4)}%`);
      } catch (authErr: any) {
        console.log(`  [✗] Authentication Failed: ${authErr?.message || authErr}`);
        console.log(`      👉 Ensure IP \x1b[33m${ipInfo.ip}\x1b[0m is whitelisted in Binance API settings or set to "Unrestricted".`);
        console.log(`      👉 Ensure "Enable Futures" permission is checked in your Binance API dashboard.`);
      }
    } else {
      console.log(`  [!] Notice: BINANCE_API_KEY or BINANCE_API_SECRET is empty in .env (public endpoints still work).`);
    }
  } catch (netErr: any) {
    console.log(`  [✗] Binance Connection Failed: ${netErr?.message || netErr}`);
  }

  // 3. Bybit V5 Linear Connection & Auth Check
  console.log('\n[3/3] Checking Bybit V5 Linear API (api.bybit.com)...');
  const bybit = new BybitClient({
    apiKey: config.env.BYBIT_API_KEY,
    apiSecret: config.env.BYBIT_API_SECRET,
    testnet: config.env.BYBIT_TESTNET,
  });

  try {
    const t0 = Date.now();
    const serverTime = await bybit.getServerTime();
    const latency = Date.now() - t0;
    console.log(`  [✓] Public Ping OK     | Latency: ${latency}ms | Server Time: ${new Date(serverTime).toISOString()}`);

    if (config.env.BYBIT_API_KEY && config.env.BYBIT_API_SECRET) {
      try {
        const balances = await bybit.getBalances();
        const usdt = balances.find((b) => b.asset === 'USDT');
        const comm = await bybit.getCommissionRates('BTCUSDT');

        console.log(`  [✓] Authentication OK  | API Key: ${config.env.BYBIT_API_KEY.slice(0, 6)}...${config.env.BYBIT_API_KEY.slice(-4)}`);
        console.log(`  [✓] Futures Balance    | Available: $${usdt ? usdt.availableBalance.toFixed(2) : '0.00'} USDT`);
        console.log(`  [✓] Fee Tier (BTC)     | Maker: ${comm.makerRate.times(100).toFixed(4)}% | Taker: ${comm.takerRate.times(100).toFixed(4)}%`);
      } catch (authErr: any) {
        console.log(`  [✗] Authentication Failed: ${authErr?.message || authErr}`);
        console.log(`      👉 Ensure IP \x1b[33m${ipInfo.ip}\x1b[0m is whitelisted in Bybit API settings or set to "No IP restriction".`);
      }
    } else {
      console.log(`  [!] Notice: BYBIT_API_KEY or BYBIT_API_SECRET is empty in .env (public endpoints still work).`);
    }
  } catch (netErr: any) {
    console.log(`  [✗] Bybit Connection Failed: ${netErr?.message || netErr}`);
  }

  console.log('\n================================================================');
  console.log('                     AUDIT COMPLETE                             ');
  console.log('================================================================\n');
}

checkConnection().catch((err) => {
  console.error('[!] Fatal error during connection check:', err);
  process.exit(1);
});

