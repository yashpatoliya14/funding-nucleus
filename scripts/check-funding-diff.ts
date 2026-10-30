import fs from 'node:fs';
import path from 'node:path';
import { request } from 'undici';
import { initializeDns } from '../src/utils/dns-resolver.js';

interface RawBinancePremium {
  symbol: string;
  markPrice: string;
  lastFundingRate: string;
  nextFundingTime: number;
}

interface RawBybitTicker {
  symbol: string;
  markPrice: string;
  fundingRate: string;
  nextFundingTime: string;
  fundingIntervalHour?: string;
  turnover24h?: string;
}

export interface DiffOpportunity {
  symbol: string;
  baseCoin: string;
  binanceRatePct: number;
  bybitRatePct: number;
  diffPct: number;
  aprPct: number;
  direction: 'LONG Binance / SHORT Bybit' | 'SHORT Binance / LONG Bybit';
  isDoubleYield: boolean;
  nextFundingTimeMs: number;
  countdown: string;
  binanceMarkPrice: number;
  bybitMarkPrice: number;
  priceDivergencePct: number;
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return '00:00:00';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
}

async function main() {
  initializeDns();

  console.log('\n================================================================');
  console.log('       BINANCE vs BYBIT — CROSS-EXCHANGE FUNDING DIFF           ');
  console.log('================================================================\n');

  process.stdout.write('[*] Fetching live perpetual rates from Binance and Bybit... ');
  const t0 = Date.now();

  let bData: RawBinancePremium[] = [];
  let byList: RawBybitTicker[] = [];

  try {
    const [bRes, byRes] = await Promise.all([
      request('https://fapi.binance.com/fapi/v1/premiumIndex', {
        headers: { Accept: 'application/json' },
      }),
      request('https://api.bybit.com/v5/market/tickers?category=linear', {
        headers: { Accept: 'application/json' },
      }),
    ]);

    bData = (await bRes.body.json()) as RawBinancePremium[];
    const byJson: any = await byRes.body.json();
    byList = byJson.result?.list || [];
  } catch (err: any) {
    console.error(`\n[✗] Failed to fetch rates: ${err?.message || err}`);
    process.exit(1);
  }

  const fetchMs = Date.now() - t0;
  console.log(`Done in ${fetchMs}ms.`);
  console.log(`    - Binance contracts: ${bData.length}`);
  console.log(`    - Bybit contracts:   ${byList.length}`);

  // Build Bybit map
  const byMap = new Map<string, RawBybitTicker>();
  for (const item of byList) {
    if (item.symbol?.endsWith('USDT')) {
      byMap.set(item.symbol, item);
    }
  }

  const now = Date.now();
  const opportunities: DiffOpportunity[] = [];

  for (const b of bData) {
    if (!b.symbol?.endsWith('USDT')) continue;
    const by = byMap.get(b.symbol);
    if (!by) continue;

    const bRate = parseFloat(b.lastFundingRate || '0');
    const byRate = parseFloat(by.fundingRate || '0');
    const diff = bRate - byRate;
    const absDiff = Math.abs(diff);

    const bRatePct = bRate * 100;
    const byRatePct = byRate * 100;
    const diffPct = absDiff * 100;

    // Annualized: 3 intervals per day * 365 days = 1095 intervals
    const aprPct = diffPct * 3 * 365;

    // Direction logic
    // If bRate > byRate:
    //   Short Binance (receives bRate), Long Bybit (pays byRate) -> Net: (bRate - byRate) > 0
    // If bRate < byRate:
    //   Long Binance (pays bRate / receives -bRate), Short Bybit (receives byRate) -> Net: (byRate - bRate) > 0
    const direction =
      bRate > byRate
        ? ('SHORT Binance / LONG Bybit' as const)
        : ('LONG Binance / SHORT Bybit' as const);

    // Double yield occurs when one rate is negative and the other is positive!
    // e.g. bRate = -0.28% (Long receives) AND byRate = +0.01% (Short receives)
    const isDoubleYield = (bRate < 0 && byRate > 0) || (bRate > 0 && byRate < 0);

    const bMark = parseFloat(b.markPrice || '0');
    const byMark = parseFloat(by.markPrice || '0');
    const priceDivPct = bMark > 0 && byMark > 0 ? (Math.abs(bMark - byMark) / bMark) * 100 : 0;

    const nextFundingMs = Number(b.nextFundingTime) || Number(by.nextFundingTime);
    const countdown = formatCountdown(Math.max(0, nextFundingMs - now));

    opportunities.push({
      symbol: b.symbol,
      baseCoin: b.symbol.replace(/USDT$/, ''),
      binanceRatePct: bRatePct,
      bybitRatePct: byRatePct,
      diffPct,
      aprPct,
      direction,
      isDoubleYield,
      nextFundingTimeMs: nextFundingMs,
      countdown,
      binanceMarkPrice: bMark,
      bybitMarkPrice: byMark,
      priceDivergencePct: priceDivPct,
    });
  }

  // Sort descending by highest funding rate difference
  opportunities.sort((a, b) => b.diffPct - a.diffPct);

  console.log(`    - Matched USDT pairs: ${opportunities.length}\n`);

  // Parse CLI arguments
  const args = process.argv.slice(2);
  const filterArg = args.find((a) => !a.startsWith('--'))?.toUpperCase();
  const topArg = parseInt(args.find((a) => a.startsWith('--top='))?.split('=')[1] || '5', 10);
  const showAll = args.includes('--all');

  if (filterArg) {
    const filtered = opportunities.filter(
      (o) => o.symbol.includes(filterArg) || o.baseCoin.includes(filterArg)
    );
    console.log(`================================================================`);
    console.log(` SEARCH RESULTS FOR "${filterArg}" (${filtered.length} pairs matched)`);
    console.log(`================================================================`);
    printTable(filtered);
  } else if (showAll) {
    console.log(`================================================================`);
    console.log(` ALL MATCHED FUNDING DIFFERENCE OPPORTUNITIES (${opportunities.length} pairs)`);
    console.log(`================================================================`);
    printTable(opportunities);
  } else {
    // Show Top N
    const topOpportunities = opportunities.slice(0, topArg);

    console.log(`================================================================`);
    console.log(` TOP ${topArg} COINS WITH BIGGEST FUNDING RATE DIFFERENCE`);
    console.log(`================================================================`);
    printTable(topOpportunities);

    // Also display major coins funding diff snapshot
    const majors = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'DOGEUSDT', 'XRPUSDT'];
    const majorItems = opportunities.filter((o) => majors.includes(o.symbol));

    console.log(`\n----------------------------------------------------------------`);
    console.log(` MAJOR COINS FUNDING SPREAD (Binance vs Bybit):`);
    console.log(`----------------------------------------------------------------`);
    printTable(majorItems);
  }

  // Save latest snapshot to data/funding-diff-snapshot.json
  try {
    const dataDir = path.resolve(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const outFile = path.join(dataDir, 'funding-diff-snapshot.json');
    fs.writeFileSync(
      outFile,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          totalMatched: opportunities.length,
          topOpportunities: opportunities.slice(0, 50),
        },
        null,
        2
      )
    );
    console.log(`\n[✓] Saved complete snapshot to:`);
    console.log(`    ${outFile}`);
  } catch {}

  console.log(`\nUsage tips:`);
  console.log(`  - See Top 10:          npm run funding:diff -- --top=10`);
  console.log(`  - Check specific coin: npm run funding:diff PEPE`);
  console.log(`  - See all pairs:       npm run funding:diff -- --all\n`);
}

function printTable(items: DiffOpportunity[]) {
  if (items.length === 0) {
    console.log('No matched pairs found.');
    return;
  }

  const colSym = 15;
  const colDiff = 13;
  const colApr = 13;
  const colBi = 13;
  const colBy = 13;
  const colDir = 30;
  const colNext = 12;

  const header =
    'Symbol'.padEnd(colSym) +
    'Diff (8h)'.padStart(colDiff) +
    'Annual APR'.padStart(colApr) +
    'Binance'.padStart(colBi) +
    'Bybit'.padStart(colBy) +
    'Strategy Direction'.padStart(colDir) +
    'Next Pay'.padStart(colNext);

  console.log(header);
  console.log('-'.repeat(colSym + colDiff + colApr + colBi + colBy + colDir + colNext));

  for (const item of items) {
    const biSign = item.binanceRatePct > 0 ? '+' : '';
    const bySign = item.bybitRatePct > 0 ? '+' : '';
    const biStr = `${biSign}${item.binanceRatePct.toFixed(4)}%`;
    const byStr = `${bySign}${item.bybitRatePct.toFixed(4)}%`;
    const diffStr = `${item.diffPct.toFixed(4)}%`;
    const aprStr = `${item.aprPct.toFixed(1)}%`;

    const doubleYieldTag = item.isDoubleYield ? ' ★' : '';
    const dirStr = `${item.direction}${doubleYieldTag}`;

    const row =
      item.symbol.padEnd(colSym) +
      diffStr.padStart(colDiff) +
      aprStr.padStart(colApr) +
      biStr.padStart(colBi) +
      byStr.padStart(colBy) +
      dirStr.padStart(colDir) +
      item.countdown.padStart(colNext);

    console.log(row);
  }
}

main().catch((err) => {
  console.error('[!] Fatal error in funding diff scanner:', err);
  process.exit(1);
});
