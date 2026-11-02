import { Database as BetterSqliteDatabase } from 'better-sqlite3';
export declare class AppDatabase {
    private db;
    private readonly dbPath;
    constructor(dbPath?: string);
    connect(): BetterSqliteDatabase;
    getDb(): BetterSqliteDatabase;
    close(): void;
    transaction<T>(fn: () => T): T;
}
//# sourceMappingURL=database.d.ts.map