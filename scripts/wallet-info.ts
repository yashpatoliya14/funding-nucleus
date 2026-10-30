import { loadConfig } from '../src/config/env.js';
import { BinanceClient } from '../src/exchanges/binance.client.js';
import { BybitClient } from '../src/exchanges/bybit.client.js';
import { initializeDns } from '../src/utils/dns-resolver.js';

async function main() {
  initializeDns();

  console.log('\n================================================================');
  console.log('              EXCHANGE WALLET BALANCE & MARGIN AUDIT            ');
  console.log('================================================================\n');

  const config = loadConfig();

  // 1. Binance Wallet
  console.log('[1/2] Querying Binance Futures Wallet (fapi.binance.com)...');
  const binance = new BinanceClient({
    apiKey: config.env.BINANCE_API_KEY,
    apiSecret: config.env.BINANCE_API_SECRET,
    testnet: config.env.BINANCE_TESTNET,
  });

  let binanceUsdt = 0;
  try {
    const balances = await binance.getBalances();
    const usdt = balances.find((b) => b.asset === 'USDT');
    const usdc = balances.find((b) => b.asset === 'USDC');
    const bnb = balances.find((b) => b.asset === 'BNB');

    binanceUsdt = usdt ? parseFloat(usdt.availableBalance.toString()) : 0;
    const margin = usdt ? parseFloat(usdt.marginBalance.toString()) : 0;
    const total = usdt ? parseFloat(usdt.walletBalance.toString()) : 0;

    console.log(`  [✓] Binance Futures Connected!`);
    console.log(`      • Available USDT:   $${binanceUsdt.toFixed(2)}`);
    console.log(`      • Margin Balance:   $${margin.toFixed(2)}`);
    console.log(`      • Total Wallet:     $${total.toFixed(2)}`);
    if (usdc && usdc.availableBalance.gt(0)) {
      console.log(`      • Available USDC:   $${usdc.availableBalance.toFixed(2)}`);
    }
    if (bnb && bnb.walletBalance.gt(0)) {
      console.log(`      • BNB Balance:      ${bnb.walletBalance.toString()} BNB`);
    }
  } catch (err: any) {
    console.log(`  [✗] Binance Query Error: ${err?.message || err}`);
    console.log(`      (Make sure "Enable Futures" is checked and IP whitelisted on Binance)`);
  }

  // 2. Bybit Wallet
  console.log('\n[2/2] Querying Bybit Unified Trading Account (api.bybit.com)...');
  const bybit = new BybitClient({
    apiKey: config.env.BYBIT_API_KEY,
    apiSecret: config.env.BYBIT_API_SECRET,
    testnet: config.env.BYBIT_TESTNET,
  });

  let bybitUsdt = 0;
  try {
    const balances = await bybit.getBalances();
    const usdt = balances.find((b) => b.asset === 'USDT');
    const usdc = balances.find((b) => b.asset === 'USDC');

    bybitUsdt = usdt ? parseFloat(usdt.availableBalance.toString()) : 0;
    const total = usdt ? parseFloat(usdt.walletBalance.toString()) : 0;

    console.log(`  [✓] Bybit UTA Connected!`);
    console.log(`      • Available USDT:   $${bybitUsdt.toFixed(2)}`);
    console.log(`      • Total Wallet:     $${total.toFixed(2)}`);
    if (usdc && usdc.availableBalance.gt(0)) {
      console.log(`      • Available USDC:   $${usdc.availableBalance.toFixed(2)}`);
    }
  } catch (err: any) {
    console.log(`  [✗] Bybit Query Error: ${err?.message || err}`);
  }

  // Sizing Assessment
  console.log('\n================================================================');
  console.log('                 LIVE SIZING & LEVERAGE ANALYSIS                ');
  console.log('================================================================');
  const minWalletBalance = Math.min(binanceUsdt, bybitUsdt);
  console.log(`• Binance Available:  $${binanceUsdt.toFixed(2)} USDT`);
  console.log(`• Bybit Available:    $${bybitUsdt.toFixed(2)} USDT`);
  console.log(`• Limiting Balance:   $${minWalletBalance.toFixed(2)} USDT (Sizing bottleneck)`);

  const leverageCap = config.appConfig.risk.default_leverage_cap || 3;
  // Use 85% of limiting balance to reserve for fees and buffer
  const maxSafeNotional = Math.floor(minWalletBalance * 0.85 * leverageCap);

  console.log(`• Config Leverage:    ${leverageCap}x`);
  console.log(`• Safe Max Notional:  $${maxSafeNotional} per leg (matched $${maxSafeNotional * 2} total)`);

  if (minWalletBalance < 5) {
    console.log('\n⚠️  STATUS: INSUFFICIENT BALANCE FOR LIVE ORDERS');
    console.log('    Perpetual futures require minimum $5 to $10 notional per order.');
    console.log('    Please deposit at least $10-$20 USDT in BOTH exchange accounts.');
  } else {
    console.log('\n🟢 STATUS: READY FOR POSITION SIZING');
    console.log(`    Recommended maximum_notional_per_leg_usd: $${Math.max(10, maxSafeNotional)}`);
  }

  console.log('================================================================\n');
}

main().catch(console.error);

