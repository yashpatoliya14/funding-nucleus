interface CliArgs {
    limit: number;
    status?: string;
    format: 'table' | 'json';
    coin?: string;
    tradeId?: string;
    configPath?: string;
    dbPath?: string;
}
export declare function displayLastTrades(cliArgs: CliArgs): void;
export {};
//# sourceMappingURL=last-trades.d.ts.map