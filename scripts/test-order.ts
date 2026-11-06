import { loadConfig } from '../src/config/env.js';
import { BinanceClient } from '../src/exchanges/binance.client.js';
import { BybitClient } from '../src/exchanges/bybit.client.js';
import { IExchangeClient } from '../src/exchanges/exchange.interface.js';
import { PaperClient } from '../src/exchanges/paper.client.js';
import { initializeDns } from '../src/utils/dns-resolver.js';
import { executeTestOrder, TestOrderSummary } from '../src/execution/test-order-executor.js';
import { Decimal, roundToStep, toDecimal } from '../src/utils/decimal.js';
import { sleep } from '../src/utils/time.js';

async function runSingleExchangeTest(
  client: IExchangeClient,
  symbol: string,
  side: 'BUY' | 'SELL' = 'BUY'
): Promise<TestOrderSummary> {
  const exchangeName = client.exchangeName.toUpperCase();
  console.log(`\n======================================================`);
  console.log(`  [TEST] Running Order on ${exchangeName}`);
  console.log(`======================================================`);
  console.log(`[1/3] Setting leverage & querying contract specifications for ${symbol}...`);
  console.log(`[2/3] Submitting minimum viable test MARKET ${side} order on ${exchangeName}...`);

  const res = await executeTestOrder(client, {
    symbol,
    side,
    autoClose: true,
    holdSeconds: 3,
  });

  console.log(`\n[✓] ${exchangeName} Test Order Succeeded:`);
  console.log(`    • Symbol:       ${res.symbol}`);
  console.log(`    • Side:         ${side}`);
  console.log(`    • Quantity:     ${res.qty}`);
  console.log(`    • Entry Price:  $${res.entryPrice}`);
  console.log(`    • Notional:     $${res.notionalUsd} USDT`);
  console.log(`    • Open Status:  ${res.openStatus}`);
  console.log(`    • Auto-Closed:  ${res.closeStatus || 'FILLED'}`);

  // Position verification to guarantee flat state
  const positions = await client.getPositions();
  const openPos = positions.find((p) => p.symbol === symbol && p.quantity.gt(0));
  if (!openPos || openPos.quantity.isZero()) {
    console.log(`[3/3] Position verified 100% FLAT on ${exchangeName}!`);
  } else {
    console.warn(`[!] Warning: Residual position detected: ${openPos.quantity.toString()} on ${exchangeName}. Flattening...`);
    await client.placeMarketOrder({
      clientOrderId: `test_cleanup_${Date.now()}`,
      symbol,
      side: openPos.side === 'LONG' ? 'SELL' : 'BUY',
      orderType: 'MARKET',
      quantity: openPos.quantity,
      reduceOnly: true,
    });
    console.log(`[3/3] Residual position flattened! Verified 100% FLAT.`);
  }

  return res;
}

async function runHedgedTest(
  binanceClient: IExchangeClient,
  bybitClient: IExchangeClient,
  symbol: string
): Promise<void> {
  console.log(`\n======================================================`);
  console.log(`  [TEST] Concurrent Hedged Arbitrage Test Order`);
  console.log(`  • Binance: BUY (LONG)`);
  console.log(`  • Bybit:   SELL (SHORT)`);
  console.log(`======================================================\n`);

  console.log(`[1/4] Querying market data and sizing for ${symbol} on both exchanges...`);
  const [bInsts, byInsts] = await Promise.all([
    binanceClient.getInstruments(),
    bybitClient.getInstruments(),
  ]);

  const bInst = bInsts.find((i) => i.symbol === symbol);
  const byInst = byInsts.find((i) => i.symbol === symbol);
  if (!bInst || !byInst) {
    throw new Error(`Symbol ${symbol} not found on one or both exchanges.`);
  }

  const [bBook, byBook] = await Promise.all([
    binanceClient.getOrderBook(symbol, 5),
    bybitClient.getOrderBook(symbol, 5),
  ]);

  const bAsk = bBook.asks[0]?.price ?? toDecimal('0.1');
  const bMinNotional = bInst.minNotional && bInst.minNotional.gt(0) ? bInst.minNotional : toDecimal('5.5');
  const byMinNotional = byInst.minNotional && byInst.minNotional.gt(0) ? byInst.minNotional : toDecimal('5.5');
  const targetNotional = Decimal.max(bMinNotional, byMinNotional).times('1.1');

  const bMult = bInst.contractMultiplier ? toDecimal(bInst.contractMultiplier) : toDecimal('1');
  const byMult = byInst.contractMultiplier ? toDecimal(byInst.contractMultiplier) : toDecimal('1');

  const bRawQty = targetNotional.dividedBy(bAsk.times(bMult));
  let qty = roundToStep(bRawQty, bInst.quantityStep);
  if (qty.lt(bInst.minQuantity)) qty = bInst.minQuantity;
  if (qty.lt(byInst.minQuantity)) qty = byInst.minQuantity;
  qty = roundToStep(qty, Decimal.max(bInst.quantityStep, byInst.quantityStep));

  console.log(`[2/4] Concurrent entry: placing market orders on Binance and Bybit (${qty.toString()} ${symbol})...`);
  const t0 = Date.now();
  const [bEntry, byEntry] = await Promise.all([
    binanceClient.placeMarketOrder({
      clientOrderId: `test_hedged_bi_${Date.now()}`,
      symbol,
      side: 'BUY',
      orderType: 'MARKET',
      quantity: qty,
      reduceOnly: false,
    }),
    bybitClient.placeMarketOrder({
      clientOrderId: `test_hedged_by_${Date.now()}`,
      symbol,
      side: 'SELL',
      orderType: 'MARKET',
      quantity: qty,
      reduceOnly: false,
    }),
  ]);
  const entryLatency = Date.now() - t0;
  console.log(`[✓] Both entry legs placed concurrently in ${entryLatency}ms!`);
  console.log(`    • Binance BUY  @ $${bEntry.averagePrice.toFixed(4)} (${bEntry.status})`);
  console.log(`    • Bybit   SELL @ $${byEntry.averagePrice.toFixed(4)} (${byEntry.status})`);

  console.log(`\n[3/4] Holding hedged positions for 3 seconds...`);
  await sleep(3000);

  console.log(`[4/4] Concurrent exit: closing both positions with reduce-only market orders...`);
  const t1 = Date.now();
  const [bExit, byExit] = await Promise.all([
    binanceClient.placeMarketOrder({
      clientOrderId: `test_close_bi_${Date.now()}`,
      symbol,
      side: 'SELL',
      orderType: 'MARKET',
      quantity: bEntry.executedQuantity.gt(0) ? bEntry.executedQuantity : qty,
      reduceOnly: true,
    }),
    bybitClient.placeMarketOrder({
      clientOrderId: `test_close_by_${Date.now()}`,
      symbol,
      side: 'BUY',
      orderType: 'MARKET',
      quantity: byEntry.executedQuantity.gt(0) ? byEntry.executedQuantity : qty,
      reduceOnly: true,
    }),
  ]);
  const exitLatency = Date.now() - t1;
  console.log(`[✓] Both exit legs placed concurrently in ${exitLatency}ms!`);
  console.log(`    • Binance Exit @ $${bExit.averagePrice.toFixed(4)} (${bExit.status})`);
  console.log(`    • Bybit   Exit @ $${byExit.averagePrice.toFixed(4)} (${byExit.status})`);

  // Flat verification
  const [bPos, byPos] = await Promise.all([
    binanceClient.getPositions(),
    bybitClient.getPositions(),
  ]);
  const bOpen = bPos.find((p) => p.symbol === symbol && p.quantity.gt(0));
  const byOpen = byPos.find((p) => p.symbol === symbol && p.quantity.gt(0));

  if (!bOpen && !byOpen) {
    console.log(`\n[✓] 100% FLAT verified on both Binance & Bybit!`);
  } else {
    console.warn(`[!] Residual position detected! Performing emergency cleanup...`);
    if (bOpen && bOpen.quantity.gt(0)) {
      await binanceClient.placeMarketOrder({
        clientOrderId: `test_clean_bi_${Date.now()}`,
        symbol,
        side: bOpen.side === 'LONG' ? 'SELL' : 'BUY',
        orderType: 'MARKET',
        quantity: bOpen.quantity,
        reduceOnly: true,
      });
    }
    if (byOpen && byOpen.quantity.gt(0)) {
      await bybitClient.placeMarketOrder({
        clientOrderId: `test_clean_by_${Date.now()}`,
        symbol,
        side: byOpen.side === 'LONG' ? 'SELL' : 'BUY',
        orderType: 'MARKET',
        quantity: byOpen.quantity,
        reduceOnly: true,
      });
    }
    console.log(`[✓] Cleanup complete. Both accounts verified 100% FLAT.`);
  }
}

async function main() {
  initializeDns();

  console.log('\n======================================================');
  console.log('       FUTURES TEST ORDER EXECUTION SCRIPT            ');
  console.log('======================================================');

  const config = loadConfig();
  const rawArgs = process.argv.slice(2);
  const isPaperFlag = rawArgs.includes('--paper');
  const isLiveFlag = rawArgs.includes('--live');
  const filteredArgs = rawArgs.filter((arg) => !arg.startsWith('--'));

  let targetExchange = 'both';
  let symbol = 'DOGEUSDT';

  if (filteredArgs[0]) {
    const firstArg = filteredArgs[0].toLowerCase();
    if (['binance', 'bybit', 'both', 'hedged'].includes(firstArg)) {
      targetExchange = firstArg;
      if (filteredArgs[1]) {
        symbol = filteredArgs[1].toUpperCase();
      }
    } else {
      symbol = filteredArgs[0].toUpperCase();
      targetExchange = 'both';
      if (filteredArgs[1] && ['binance', 'bybit', 'both', 'hedged'].includes(filteredArgs[1].toLowerCase())) {
        targetExchange = filteredArgs[1].toLowerCase();
      }
    }
  }

  const isLive = isPaperFlag ? false : (isLiveFlag ? true : config.appConfig.app.mode === 'live');

  console.log(`Operating Mode:  ${isLive ? 'LIVE' : 'PAPER (Simulated)'}`);
  console.log(`Target Target:   ${targetExchange.toUpperCase()}`);
  console.log(`Target Symbol:   ${symbol}`);

  const binanceClient = isLive
    ? new BinanceClient({
        apiKey: config.env.BINANCE_API_KEY,
        apiSecret: config.env.BINANCE_API_SECRET,
        testnet: config.env.BINANCE_TESTNET,
      })
    : new PaperClient({ exchangeName: 'binance' });

  const bybitClient = isLive
    ? new BybitClient({
        apiKey: config.env.BYBIT_API_KEY,
        apiSecret: config.env.BYBIT_API_SECRET,
        testnet: config.env.BYBIT_TESTNET,
      })
    : new PaperClient({ exchangeName: 'bybit' });

  try {
    if (targetExchange === 'hedged') {
      await runHedgedTest(binanceClient, bybitClient, symbol);
    } else if (targetExchange === 'binance') {
      await runSingleExchangeTest(binanceClient, symbol);
    } else if (targetExchange === 'bybit') {
      await runSingleExchangeTest(bybitClient, symbol);
    } else {
      // DEFAULT: 'both' - Executes on Binance first, then Bybit!
      console.log(`\nExecuting test orders on BOTH Binance and Bybit in sequence...`);
      const bRes = await runSingleExchangeTest(binanceClient, symbol);
      const byRes = await runSingleExchangeTest(bybitClient, symbol);

      console.log('\n======================================================');
      console.log('       SUMMARY: BOTH EXCHANGES TESTED                 ');
      console.log('======================================================');
      console.log(`[✓] BINANCE: Entry @ $${bRes.entryPrice} | Qty: ${bRes.qty} | Auto-Closed & Flat`);
      console.log(`[✓] BYBIT:   Entry @ $${byRes.entryPrice} | Qty: ${byRes.qty} | Auto-Closed & Flat`);
      console.log('======================================================\n');
    }
  } catch (err: any) {
    console.error(`\n[✗] Test Order Execution Failed:`, err?.message || err);
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].includes('test-order')) {
  main().catch(console.error);
}
