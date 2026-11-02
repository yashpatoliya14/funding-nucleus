export declare class FundingScheduler {
    /**
     * Determines if the current time is within the entry window.
     * Entry window: between `entryLeadMinutes` before funding and 60 seconds before funding.
     */
    static isWithinEntryWindow(targetFundingTimeMs: number, entryLeadMinutes?: number, cutoffSeconds?: number): boolean;
    /**
     * Returns milliseconds remaining until entry window opens.
     */
    static msUntilEntryWindow(targetFundingTimeMs: number, entryLeadMinutes?: number): number;
}
//# sourceMappingURL=funding-scheduler.d.ts.map