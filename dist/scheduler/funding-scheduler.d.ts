export declare class FundingScheduler {
    /**
     * Determines if the current time is within the entry window.
     * Entry window: strictly between `entryLeadMinutes` (default 2.5m = 2m30s) before funding and cutoffSeconds (default 20s) before funding.
     */
    static isWithinEntryWindow(targetFundingTimeMs: number, entryLeadMinutes?: number, cutoffSeconds?: number): boolean;
    /**
     * Returns milliseconds remaining until entry window opens.
     */
    static msUntilEntryWindow(targetFundingTimeMs: number, entryLeadMinutes?: number): number;
}
//# sourceMappingURL=funding-scheduler.d.ts.map