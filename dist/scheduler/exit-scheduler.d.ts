export declare class ExitScheduler {
    /**
     * Calculates the exact target exit timestamp (funding timestamp + target exit delay).
     */
    static calculateTargetExitTime(targetFundingTimeMs: number, targetExitDelaySeconds?: number): number;
    /**
     * Checks if target exit time has arrived or passed.
     */
    static isExitDue(targetFundingTimeMs: number, targetExitDelaySeconds?: number): boolean;
}
//# sourceMappingURL=exit-scheduler.d.ts.map