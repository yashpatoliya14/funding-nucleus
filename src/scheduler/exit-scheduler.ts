export class ExitScheduler {
  /**
   * Calculates the exact target exit timestamp (funding timestamp + target exit delay).
   */
  static calculateTargetExitTime(targetFundingTimeMs: number, targetExitDelaySeconds: number = 60): number {
    return targetFundingTimeMs + targetExitDelaySeconds * 1000;
  }

  /**
   * Checks if target exit time has arrived or passed.
   */
  static isExitDue(targetFundingTimeMs: number, targetExitDelaySeconds: number = 60): boolean {
    const exitTime = this.calculateTargetExitTime(targetFundingTimeMs, targetExitDelaySeconds);
    return Date.now() >= exitTime;
  }
}
