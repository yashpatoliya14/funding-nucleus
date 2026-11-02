export declare function nowUtcMs(): number;
export declare function nowUtcIso(): string;
export declare function toIsoUtc(timestampMs: number): string;
export declare function parseTimestampMs(value: string | number | Date): number;
export declare function diffSeconds(laterMs: number, earlierMs: number): number;
export declare function sleep(ms: number): Promise<void>;
/**
 * Checks if two funding timestamps are aligned within a given tolerance in seconds.
 * Standard perpetual funding epochs are every 8 hours (00:00, 08:00, 16:00 UTC) or 4/1 hour.
 */
export declare function areFundingTimesAligned(timeAMs: number, timeBMs: number, toleranceSeconds?: number): boolean;
//# sourceMappingURL=time.d.ts.map