import { IExchangeClient } from '../exchanges/exchange.interface.js';
import { roundToStep, toDecimal } from '../utils/decimal.js';
import { sleep } from '../utils/time.js';

export interface TestOrderOptions {
  symbol?: string;
  side?: 'BUY' | 'SELL';
  autoClose?: boolean;
  holdSeconds?: number;
  leverage?: number;
}

export interface TestOrderSummary {
  success: boolean;
  exchange: string;
  symbol: string;
  entryPrice: string;
  qty: string;
  notionalUsd: string;
  openStatus: string;
  closeStatus?: string;
  error?: string;
}

export async function executeTestOrder(
  exchange: IExchangeClient,
  options: TestOrderOptions = {}
): Promise<TestOrderSummary> {
  const symbol = (options.symbol || 'DOGEUSDT').toUpperCase();
  const side = options.side || 'BUY';
  const autoClose = options.autoClose !== false;
  const holdSeconds = options.holdSeconds ?? 4;
  const leverage = options.leverage ?? 3;

  const instruments = await exchange.getInstruments();
  const inst = instruments.find((i) => i.symbol === symbol);

  if (!inst) {
    throw new Error(`Perpetual instrument not found on ${exchange.exchangeName} for symbol: ${symbol}`);
  }

  // Set leverage
  if (exchange.setLeverage) {
    try {
      await exchange.setLeverage(symbol, leverage);
    } catch {
      // non-fatal
    }
  }

  // Get current book price
  const orderBook = await exchange.getOrderBook(symbol, 5);
  const bestAsk = orderBook.asks[0]?.price ?? toDecimal('0.1');
  const bestBid = orderBook.bids[0]?.price ?? toDecimal('0.1');
  const refPrice = side === 'BUY' ? bestAsk : bestBid;

  // Calculate minimum valid order quantity
  // Must satisfy: qty >= minQuantity AND qty * price >= minNotional (typically $5 on Binance, $1 on Bybit)
  const minNotional = inst.minNotional && inst.minNotional.gt(0) ? inst.minNotional : toDecimal('5.5');
  const rawQtyFromNotional = minNotional.times('1.05').dividedBy(refPrice.times(inst.contractMultiplier));
  let qty = roundToStep(rawQtyFromNotional, inst.quantityStep);

  if (qty.lt(inst.minQuantity)) {
    qty = inst.minQuantity;
  }

  const notionalUsd = qty.times(refPrice).times(inst.contractMultiplier).toFixed(2);
  const clientOrderId = `test_${exchange.exchangeName.slice(0, 2)}_${Date.now()}`;

  // 1. Submit test market entry order
  const entryResult = await exchange.placeMarketOrder({
    clientOrderId,
    symbol,
    side,
    orderType: 'MARKET',
    quantity: qty,
    reduceOnly: false,
  });

  const filledQty = entryResult.executedQuantity.gt(0) ? entryResult.executedQuantity : qty;
  const entryPrice = entryResult.averagePrice.gt(0) ? entryResult.averagePrice.toFixed(4) : refPrice.toFixed(4);

  const summary: TestOrderSummary = {
    success: true,
    exchange: exchange.exchangeName,
    symbol,
    entryPrice,
    qty: filledQty.toString(),
    notionalUsd,
    openStatus: entryResult.status,
  };

  // 2. If autoClose enabled, wait holdSeconds and submit reduce-only close order
  if (autoClose) {
    await sleep(holdSeconds * 1000);

    const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
    const closeClientOrderId = `test_close_${exchange.exchangeName.slice(0, 2)}_${Date.now()}`;

    try {
      const closeResult = await exchange.placeMarketOrder({
        clientOrderId: closeClientOrderId,
        symbol,
        side: closeSide,
        orderType: 'MARKET',
        quantity: filledQty,
        reduceOnly: true,
      });
      summary.closeStatus = closeResult.status;
    } catch (closeErr: any) {
      summary.closeStatus = `Close error: ${closeErr?.message || closeErr}`;
    }
  }

  return summary;
}

