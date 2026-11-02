import crypto from 'node:crypto';
export function signBinance(queryString, apiSecret) {
    return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
}
export function signBybit(apiKey, apiSecret, timestampMs, payload, // query string or json body string
recvWindow = 5000) {
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
//# sourceMappingURL=authentication.js.map