import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config/env.js';
import { BinanceClient } from '../src/exchanges/binance.client.js';
import { initializeDns } from '../src/utils/dns-resolver.js';
import { Decimal } from '../src/utils/decimal.js';

interface RawFundingItem {
  symbol: string;
  markPrice: string;
  indexPrice: string;
  estimatedSettlePrice: string;
  lastFundingRate: string;
  interestRate: string;
  nextFundingTime: number;
  time: number;
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return '00:00:00';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
}

function formatRate(rateStr: string): { rate8hPct: string; aprPct: string; rateNum: number } {
  const rate = parseFloat(rateStr) || 0;
  const rate8h = rate * 100;
  // 3 funding intervals per day * 365 days = 1095 intervals/year
  const apr = rate8h * 3 * 365;
  const sign = rate > 0 ? '+' : '';
  return {
    rate8hPct: `${sign}${rate8h.toFixed(4)}%`,
    aprPct: `${sign}${apr.toFixed(2)}%`,
    rateNum: rate,
  };
}

async function main() {
  // Ensure resilient public DNS is active
  initializeDns();

  console.log('\n================================================================');
  console.log('       BINANCE FUTURES — CONNECTION & FUNDING RATES CHECK       ');
  console.log('================================================================\n');

  const config = loadConfig();
  const apiKey = config.env.BINANCE_API_KEY?.trim() || '';
  const apiSecret = config.env.BINANCE_API_SECRET?.trim() || '';
  const isTestnet = config.env.BINANCE_TESTNET;

  console.log(`[*] Target Network:      ${isTestnet ? 'Binance Futures TESTNET' : 'Binance Futures MAINNET'}`);

  const binance = new BinanceClient({
    apiKey,
    apiSecret,
    testnet: isTestnet,
  });

  // 1. Connectivity Check
  console.log('\n[1/3] Checking Binance Connection & Server Time...');
  try {
    const t0 = Date.now();
    const serverTime = await binance.getServerTime();
    const latency = Date.now() - t0;
    console.log(`[✓] Binance Public API Connected!`);
    console.log(`    - Server Time: ${new Date(serverTime).toISOString()}`);
    console.log(`    - Latency:     ${latency}ms`);
  } catch (err: any) {
    console.error(`[✗] Binance Connection Failed: ${err?.message || err}`);
    process.exit(1);
  }

  // 2. Authentication Check
  console.log('\n[2/3] Checking API Key Authentication & Balance...');
  if (!apiKey || !apiSecret) {
    console.log(`[!] Notice: BINANCE_API_KEY or BINANCE_API_SECRET is currently EMPTY in .env`);
    console.log(`    -> Remember to paste and save (Ctrl+S) your Binance credentials in .env to enable trading and private balance checks.`);
    console.log(`    -> Public market data and funding rates do NOT require credentials and will proceed below.`);
  } else {
    try {
      const balances = await binance.getBalances();
      const usdt = balances.find((b) => b.asset === 'USDT');
      const btc = balances.find((b) => b.asset === 'BTC');
      const bnb = balances.find((b) => b.asset === 'BNB');

      console.log(`[✓] Binance Authentication Successful!`);
      console.log(`    - API Key:           ${apiKey.slice(0, 6)}...${apiKey.slice(-4)}`);
      console.log(`    - USDT Available:    $${usdt ? usdt.availableBalance.toFixed(2) : '0.00'}`);
      console.log(`    - USDT Margin Bal:   $${usdt ? usdt.marginBalance.toFixed(2) : '0.00'}`);
      if (btc && btc.walletBalance.gt(0)) {
        console.log(`    - BTC Balance:       ${btc.walletBalance.toString()} BTC`);
      }
      if (bnb && bnb.walletBalance.gt(0)) {
        console.log(`    - BNB Balance:       ${bnb.walletBalance.toString()} BNB (fee discount eligible)`);
      }

      // Check trading fee commission rates
      try {
        const comm = await binance.getCommissionRates('BTCUSDT');
        console.log(
          `    - BTCUSDT Fee Rates: Maker ${comm.makerRate.times(100).toFixed(4)}% | Taker ${comm.takerRate.times(100).toFixed(4)}%`
        );
      } catch (commErr: any) {
        console.log(`    - Commission check note: ${commErr?.message || commErr}`);
      }
    } catch (authErr: any) {
      console.error(`[✗] Binance Authentication Failed: ${authErr?.message || authErr}`);
      console.log(`    Please verify your BINANCE_API_KEY and BINANCE_API_SECRET permissions (Futures Trading enabled).`);
    }
  }

  // 3. Fetch Funding Rates
  console.log('\n[3/3] Fetching Funding Rates for All Futures Coins...');
  const tFetch0 = Date.now();
  let rawFunding: RawFundingItem[] = [];

  try {
    // Direct request to premiumIndex for full perpetual market overview
    const res = await (binance as any).requestApi('GET', '/fapi/v1/premiumIndex');
    rawFunding = res as RawFundingItem[];
  } catch (err: any) {
    console.error(`[✗] Failed to fetch funding rates: ${err?.message || err}`);
    process.exit(1);
  }

  const fetchLatency = Date.now() - tFetch0;
  console.log(`[✓] Retrieved ${rawFunding.length} futures instruments in ${fetchLatency}ms.\n`);

  // Parse command line arguments
  const args = process.argv.slice(2);
  const filterArg = args.find((a) => !a.startsWith('--'))?.toUpperCase();
  const showAll = args.includes('--all');
  const coinParam = args.find((a) => a.startsWith('--coin='))?.split('=')[1]?.toUpperCase();
  const symbolFilter = filterArg || coinParam;

  // Process data
  const now = Date.now();
  const processed = rawFunding
    .map((item) => {
      const { rate8hPct, aprPct, rateNum } = formatRate(item.lastFundingRate);
      const markPrice = parseFloat(item.markPrice) || 0;
      const timeLeftMs = Math.max(0, item.nextFundingTime - now);
      return {
        symbol: item.symbol,
        markPrice,
        rateNum,
        rate8hPct,
        aprPct,
        nextFundingTime: item.nextFundingTime,
        countdown: formatCountdown(timeLeftMs),
      };
    })
    .sort((a, b) => b.rateNum - a.rateNum);

  // If a specific symbol or coin was requested
  if (symbolFilter) {
    const matches = processed.filter(
      (p) => p.symbol === symbolFilter || p.symbol.startsWith(symbolFilter) || p.symbol.includes(symbolFilter)
    );

    console.log(`================================================================`);
    console.log(` SEARCH RESULTS FOR: "${symbolFilter}" (${matches.length} pairs matched)`);
    console.log(`================================================================`);
    printTable(matches);
  } else if (showAll) {
    console.log(`================================================================`);
    console.log(` ALL FUTURES INSTRUMENTS (${processed.length} pairs)`);
    console.log(`================================================================`);
    printTable(processed);
  } else {
    // Default overview:
    // 1. Top 10 positive funding rates (Short receives funding)
    const topPositive = processed.slice(0, 10);

    // 2. Top 10 negative funding rates (Long receives funding)
    const topNegative = [...processed].sort((a, b) => a.rateNum - b.rateNum).slice(0, 10);

    // 3. Major coins snapshot
    const majors = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'DOGEUSDT', 'XRPUSDT', 'ADAUSDT'];
    const majorItems = processed.filter((p) => majors.includes(p.symbol));

    console.log(`----------------------------------------------------------------`);
    console.log(` TOP 10 HIGHEST FUNDING RATES (Short receives, Long pays):`);
    console.log(`----------------------------------------------------------------`);
    printTable(topPositive);

    console.log(`\n----------------------------------------------------------------`);
    console.log(` TOP 10 LOWEST / NEGATIVE FUNDING RATES (Long receives, Short pays):`);
    console.log(`----------------------------------------------------------------`);
    printTable(topNegative);

    console.log(`\n----------------------------------------------------------------`);
    console.log(` MAJOR COINS FUNDING SNAPSHOT:`);
    console.log(`----------------------------------------------------------------`);
    printTable(majorItems);
  }

  // Save latest snapshot to data/binance-funding-rates.json
  try {
    const dataDir = path.resolve(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const outputPath = path.join(dataDir, 'binance-funding-rates.json');
    fs.writeFileSync(
      outputPath,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          totalSymbols: processed.length,
          symbols: processed,
        },
        null,
        2
      )
    );
    console.log(`\n[✓] Saved complete dataset (${processed.length} symbols) to:`);
    console.log(`    ${outputPath}`);
  } catch (err) {
    // Non-fatal if disk write fails
  }

  console.log(`\nUsage tips:`);
  console.log(`  - Check specific coin:  npm run binance:funding BTC`);
  console.log(`  - Check all symbols:    npm run binance:funding -- --all`);
  console.log(`  - Re-validate accounts: npm run validate-credentials\n`);
}

function printTable(
  items: Array<{
    symbol: string;
    markPrice: number;
    rate8hPct: string;
    aprPct: string;
    countdown: string;
  }>
) {
  if (items.length === 0) {
    console.log('No pairs matching.');
    return;
  }

  const colSymbol = 16;
  const colPrice = 14;
  const colRate8h = 14;
  const colApr = 14;
  const colNext = 14;

  const header =
    'Symbol'.padEnd(colSymbol) +
    'Mark Price'.padStart(colPrice) +
    '8h Rate'.padStart(colRate8h) +
    'Annualized APR'.padStart(colApr) +
    'Next Funding'.padStart(colNext);

  console.log(header);
  console.log('-'.repeat(colSymbol + colPrice + colRate8h + colApr + colNext));

  for (const item of items) {
    const priceStr =
      item.markPrice >= 1
        ? item.markPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })
        : item.markPrice.toFixed(6);

    const row =
      item.symbol.padEnd(colSymbol) +
      priceStr.padStart(colPrice) +
      item.rate8hPct.padStart(colRate8h) +
      item.aprPct.padStart(colApr) +
      item.countdown.padStart(colNext);
    console.log(row);
  }
}

main().catch((err) => {
  console.error('[!] Fatal error:', err);
  process.exit(1);
});

