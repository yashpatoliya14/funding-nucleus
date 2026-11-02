import { Database as BetterSqliteDatabase } from 'better-sqlite3';
interface Migration {
    version: number;
    name: string;
    up: (db: BetterSqliteDatabase) => void;
}
export declare const migrations: Migration[];
export declare function runMigrations(db: BetterSqliteDatabase): void;
export {};
//# sourceMappingURL=migrations.d.ts.map