export interface BinanceAuthHeaders {
    'X-MBX-APIKEY': string;
}
export declare function signBinance(queryString: string, apiSecret: string): string;
export interface BybitAuthHeaders {
    'X-BAPI-API-KEY': string;
    'X-BAPI-TIMESTAMP': string;
    'X-BAPI-SIGN': string;
    'X-BAPI-RECV-WINDOW': string;
    'X-BAPI-SIGN-TYPE': string;
    'Content-Type': string;
}
export declare function signBybit(apiKey: string, apiSecret: string, timestampMs: number, payload: string, // query string or json body string
recvWindow?: number): BybitAuthHeaders;
//# sourceMappingURL=authentication.d.ts.map