export class ExitScheduler {
    /**
     * Calculates the exact target exit timestamp (funding timestamp + target exit delay).
     */
    static calculateTargetExitTime(targetFundingTimeMs, targetExitDelaySeconds = 60) {
        return targetFundingTimeMs + targetExitDelaySeconds * 1000;
    }
    /**
     * Checks if target exit time has arrived or passed.
     */
    static isExitDue(targetFundingTimeMs, targetExitDelaySeconds = 60) {
        const exitTime = this.calculateTargetExitTime(targetFundingTimeMs, targetExitDelaySeconds);
        return Date.now() >= exitTime;
    }
}
//# sourceMappingURL=exit-scheduler.js.map