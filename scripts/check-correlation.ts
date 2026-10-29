import fs from 'node:fs';
import path from 'node:path';
import { request } from 'undici';
import { initializeDns } from '../src/utils/dns-resolver.js';

interface Ticker24h {
  symbol: string;
  quoteVolume: string;
  lastPrice: string;
  priceChangePercent: string;
}

interface KlineResponse {
  symbol: string;
  closes: number[];
  returns: number[];
}

interface FundingItem {
  symbol: string;
  lastFundingRate: string;
}

interface CorrelationPair {
  symbolA: string;
  symbolB: string;
  correlation: number;
  rateA_8h?: string;
  rateB_8h?: string;
  classification: string;
}

function pearsonCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 20) return 0;

  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i]!;
    sumY += y[i]!;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let numerator = 0;
  let denomX = 0;
  let denomY = 0;

  for (let i = 0; i < n; i++) {
    const diffX = x[i]! - meanX;
    const diffY = y[i]! - meanY;
    numerator += diffX * diffY;
    denomX += diffX * diffX;
    denomY += diffY * diffY;
  }

  const denominator = Math.sqrt(denomX) * Math.sqrt(denomY);
  if (denominator === 0) return 0;
  return Math.max(-1, Math.min(1, numerator / denominator));
}

function classifyCorrelation(r: number): string {
  if (r <= -0.7) return 'STRONG INVERSE';
  if (r <= -0.3) return 'MODERATE INVERSE';
  if (r < 0.0) return 'WEAK INVERSE';
  if (r < 0.3) return 'UNCORRELATED';
  if (r < 0.7) return 'MODERATE POSITIVE';
  return 'STRONG POSITIVE';
}

async function fetchWithRetry(url: string, retries = 3): Promise<any> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await request(url, {
        headers: { Accept: 'application/json' },
      });
      if (res.statusCode === 200) {
        return await res.body.json();
      }
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, 500 * (i + 1)));
    }
  }
  throw new Error(`Failed to fetch ${url}`);
}

async function fetchKlinesBatch(symbols: string[], interval: string, limit: number): Promise<Map<string, KlineResponse>> {
  const results = new Map<string, KlineResponse>();
  const batchSize = 10;

  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const promises = batch.map(async (symbol) => {
      try {
        const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
        const data = (await fetchWithRetry(url)) as any[];
        if (!Array.isArray(data) || data.length < 20) return;

        const closes = data.map((k) => parseFloat(k[4]));
        const returns: number[] = [];
        for (let j = 1; j < closes.length; j++) {
          const prev = closes[j - 1]!;
          const curr = closes[j]!;
          if (prev > 0 && curr > 0) {
            returns.push(Math.log(curr / prev));
          } else {
            returns.push(0);
          }
        }
        results.set(symbol, { symbol, closes, returns });
      } catch {
        // Skip failed symbols
      }
    });

    await Promise.all(promises);
    if (i + batchSize < symbols.length) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return results;
}

async function main() {
  initializeDns();

  console.log('\n================================================================');
  console.log('       BINANCE FUTURES — NEGATIVE CORRELATION SCANNER           ');
  console.log('================================================================\n');

  // Parse CLI flags
  const args = process.argv.slice(2);
  const targetCoinArg = args.find((a) => !a.startsWith('--'))?.toUpperCase();
  const targetCoinParam = args.find((a) => a.startsWith('--coin='))?.split('=')[1]?.toUpperCase();
  const targetSymbol = (targetCoinArg || targetCoinParam || 'BTC').replace(/USDT$/, '') + 'USDT';

  const daysArg = parseInt(args.find((a) => a.startsWith('--days='))?.split('=')[1] || '7', 10);
  const topArg = parseInt(args.find((a) => a.startsWith('--top='))?.split('=')[1] || '50', 10);
  const intervalArg = args.find((a) => a.startsWith('--interval='))?.split('=')[1] || '1h';

  // Calculate candle limit based on days and interval
  let candleLimit = daysArg * 24; // default 1h
  if (intervalArg === '4h') candleLimit = Math.ceil((daysArg * 24) / 4);
  else if (intervalArg === '15m') candleLimit = Math.min(1000, daysArg * 24 * 4);

  console.log(`[*] Configuration:`);
  console.log(`    - Benchmark / Target: ${targetSymbol}`);
  console.log(`    - Analysis Horizon:   ${daysArg} days (${candleLimit} candles @ ${intervalArg})`);
  console.log(`    - Liquidity Universe: Top ${topArg} USDT perpetual contracts by 24h volume\n`);

  // 1. Fetch 24h Tickers for ranking & volume
  process.stdout.write('[1/3] Fetching liquid futures universe & funding rates... ');
  const [tickersRaw, fundingRaw] = await Promise.all([
    fetchWithRetry('https://fapi.binance.com/fapi/v1/ticker/24hr'),
    fetchWithRetry('https://fapi.binance.com/fapi/v1/premiumIndex'),
  ]);

  const fundingMap = new Map<string, string>();
  for (const f of fundingRaw as FundingItem[]) {
    const rate = (parseFloat(f.lastFundingRate || '0') * 100).toFixed(4);
    fundingMap.set(f.symbol, (parseFloat(f.lastFundingRate) > 0 ? '+' : '') + rate + '%');
  }

  // Filter USDT perpetual contracts, sort by 24h quote volume
  const usdtTickers = (tickersRaw as Ticker24h[])
    .filter((t) => t.symbol.endsWith('USDT'))
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));

  const selectedSymbols = usdtTickers.slice(0, topArg).map((t) => t.symbol);

  // Ensure target symbol is always included
  if (!selectedSymbols.includes(targetSymbol)) {
    selectedSymbols.push(targetSymbol);
  }

  console.log(`Done (${selectedSymbols.length} contracts selected).`);

  // 2. Fetch K-line data
  process.stdout.write(`[2/3] Downloading price history (${intervalArg} klines)... `);
  const klineData = await fetchKlinesBatch(selectedSymbols, intervalArg, candleLimit);
  console.log(`Done (${klineData.size} symbols analyzed).\n`);

  if (!klineData.has(targetSymbol)) {
    console.error(`[✗] Unable to retrieve price history for target symbol: ${targetSymbol}`);
    process.exit(1);
  }

  const targetReturns = klineData.get(targetSymbol)!.returns;

  // 3. Compute Correlation vs Target (Benchmark)
  const vsTargetList: Array<{
    symbol: string;
    correlation: number;
    classification: string;
    fundingRate8h: string;
    quoteVolumeM: string;
  }> = [];

  for (const [symbol, data] of klineData.entries()) {
    if (symbol === targetSymbol) continue;
    const r = pearsonCorrelation(targetReturns, data.returns);
    const ticker = usdtTickers.find((t) => t.symbol === symbol);
    const volM = ticker ? (parseFloat(ticker.quoteVolume) / 1e6).toFixed(1) + 'M' : '-';

    vsTargetList.push({
      symbol,
      correlation: r,
      classification: classifyCorrelation(r),
      fundingRate8h: fundingMap.get(symbol) || '0.0000%',
      quoteVolumeM: volM,
    });
  }

  // Sort: lowest / most negative correlation first
  vsTargetList.sort((a, b) => a.correlation - b.correlation);

  // 4. Compute Pairwise Combinations for Top Inverse Pairs
  const allSymbols = Array.from(klineData.keys());
  const pairwiseList: CorrelationPair[] = [];

  for (let i = 0; i < allSymbols.length; i++) {
    for (let j = i + 1; j < allSymbols.length; j++) {
      const sA = allSymbols[i]!;
      const sB = allSymbols[j]!;
      const r = pearsonCorrelation(klineData.get(sA)!.returns, klineData.get(sB)!.returns);

      pairwiseList.push({
        symbolA: sA,
        symbolB: sB,
        correlation: r,
        rateA_8h: fundingMap.get(sA),
        rateB_8h: fundingMap.get(sB),
        classification: classifyCorrelation(r),
      });
    }
  }

  pairwiseList.sort((a, b) => a.correlation - b.correlation);

  // -------------------------------------------------------------
  // DISPLAY RESULTS
  // -------------------------------------------------------------

  console.log('================================================================');
  console.log(` COINS WITH MOST NEGATIVE / LOWEST CORRELATION VS ${targetSymbol}`);
  console.log('================================================================');

  const topNegativeVsTarget = vsTargetList.slice(0, 15);
  printBenchmarkTable(topNegativeVsTarget, targetSymbol);

  console.log('\n================================================================');
  console.log(` TOP 15 OVERALL MOST NEGATIVE CORRELATION PAIRS (PAIRWISE)`);
  console.log('================================================================');

  const topNegativePairs = pairwiseList.slice(0, 15);
  printPairTable(topNegativePairs);

  // Summary / Trading Insights
  console.log('\n----------------------------------------------------------------');
  console.log(' QUANTITATIVE HEDGING & ARBITRAGE INSIGHTS:');
  console.log('----------------------------------------------------------------');
  const strongInverses = pairwiseList.filter((p) => p.correlation <= -0.5);
  const btcInverses = vsTargetList.filter((c) => c.correlation < 0);

  console.log(`• Coins inversely correlated with ${targetSymbol} (r < 0): ${btcInverses.length} coin(s) found.`);
  if (btcInverses.length > 0) {
    console.log(
      `  Top inverse hedges: ${btcInverses
        .slice(0, 5)
        .map((c) => `${c.symbol} (r = ${c.correlation.toFixed(3)})`)
        .join(', ')}`
    );
  }

  console.log(`• Highly negative pairs (r ≤ -0.50): ${strongInverses.length} pair(s) found.`);
  if (strongInverses.length > 0) {
    const topPair = strongInverses[0]!;
    console.log(
      `  Best pair hedge: ${topPair.symbolA} + ${topPair.symbolB} (r = ${topPair.correlation.toFixed(3)})`
    );
  }

  // Save results to file
  const outputData = {
    timestamp: new Date().toISOString(),
    benchmark: targetSymbol,
    days: daysArg,
    interval: intervalArg,
    coinsVsBenchmark: vsTargetList,
    topNegativePairs: topNegativePairs.slice(0, 50),
  };

  try {
    const dataDir = path.resolve(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const outFile = path.join(dataDir, 'coin-correlation.json');
    fs.writeFileSync(outFile, JSON.stringify(outputData, null, 2));
    console.log(`\n[✓] Saved full correlation matrix and rankings to:`);
    console.log(`    ${outFile}`);
  } catch {}

  console.log('\nUsage Examples:');
  console.log('  - Analyze vs ETH:       npm run correlation ETH');
  console.log('  - Analyze vs SOL:       npm run correlation SOL');
  console.log('  - 14-day horizon:       npm run correlation -- --days=14');
  console.log('  - Top 100 universe:     npm run correlation -- --top=100\n');
}

function printBenchmarkTable(
  items: Array<{
    symbol: string;
    correlation: number;
    classification: string;
    fundingRate8h: string;
    quoteVolumeM: string;
  }>,
  benchmark: string
) {
  const colSymbol = 16;
  const colCorr = 14;
  const colClass = 18;
  const colFund = 12;
  const colVol = 12;

  const header =
    'Symbol'.padEnd(colSymbol) +
    `Corr vs ${benchmark.replace('USDT', '')}`.padStart(colCorr) +
    'Type'.padStart(colClass) +
    '8h Funding'.padStart(colFund) +
    '24h Vol'.padStart(colVol);

  console.log(header);
  console.log('-'.repeat(colSymbol + colCorr + colClass + colFund + colVol));

  for (const item of items) {
    const corrSign = item.correlation > 0 ? '+' : '';
    const corrStr = `${corrSign}${item.correlation.toFixed(4)}`;

    const row =
      item.symbol.padEnd(colSymbol) +
      corrStr.padStart(colCorr) +
      item.classification.padStart(colClass) +
      item.fundingRate8h.padStart(colFund) +
      item.quoteVolumeM.padStart(colVol);
    console.log(row);
  }
}

function printPairTable(items: CorrelationPair[]) {
  const colPair = 26;
  const colCorr = 14;
  const colClass = 18;
  const colFundA = 12;
  const colFundB = 12;

  const header =
    'Pair (Leg A / Leg B)'.padEnd(colPair) +
    'Correlation'.padStart(colCorr) +
    'Type'.padStart(colClass) +
    'Leg A 8h'.padStart(colFundA) +
    'Leg B 8h'.padStart(colFundB);

  console.log(header);
  console.log('-'.repeat(colPair + colCorr + colClass + colFundA + colFundB));

  for (const item of items) {
    const pairStr = `${item.symbolA} / ${item.symbolB}`;
    const corrSign = item.correlation > 0 ? '+' : '';
    const corrStr = `${corrSign}${item.correlation.toFixed(4)}`;

    const row =
      pairStr.padEnd(colPair) +
      corrStr.padStart(colCorr) +
      item.classification.padStart(colClass) +
      (item.rateA_8h || '-').padStart(colFundA) +
      (item.rateB_8h || '-').padStart(colFundB);
    console.log(row);
  }
}

main().catch((err) => {
  console.error('[!] Error running correlation scanner:', err);
  process.exit(1);
});

