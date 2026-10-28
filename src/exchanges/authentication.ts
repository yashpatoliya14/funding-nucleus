import crypto from 'node:crypto';

export interface BinanceAuthHeaders {
  'X-MBX-APIKEY': string;
}

export function signBinance(queryString: string, apiSecret: string): string {
  return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
}

export interface BybitAuthHeaders {
  'X-BAPI-API-KEY': string;
  'X-BAPI-TIMESTAMP': string;
  'X-BAPI-SIGN': string;
  'X-BAPI-RECV-WINDOW': string;
  'X-BAPI-SIGN-TYPE': string;
  'Content-Type': string;
}

export function signBybit(
  apiKey: string,
  apiSecret: string,
  timestampMs: number,
  payload: string, // query string or json body string
  recvWindow: number = 5000
): BybitAuthHeaders {
  const signString = `${timestampMs}${apiKey}${recvWindow}${payload}`;
  const signature = crypto.createHmac('sha256', apiSecret).update(signString).digest('hex');

  return {
    'X-BAPI-API-KEY': apiKey,
    'X-BAPI-TIMESTAMP': timestampMs.toString(),
    'X-BAPI-SIGN': signature,
    'X-BAPI-RECV-WINDOW': recvWindow.toString(),
    'X-BAPI-SIGN-TYPE': '2',
    'Content-Type': 'application/json',
  };
}
