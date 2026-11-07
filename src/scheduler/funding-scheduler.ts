export class FundingScheduler {
  /**
   * Determines if the current time is within the entry window.
   * Entry window: strictly between `entryLeadMinutes` (default 2.5m = 2m30s) before funding and cutoffSeconds (default 20s) before funding.
   */
  static isWithinEntryWindow(
    targetFundingTimeMs: number,
    entryLeadMinutes: number = 2.5,
    cutoffSeconds: number = 20
  ): boolean {
    const now = Date.now();
    const leadMs = entryLeadMinutes * 60 * 1000;
    const cutoffMs = cutoffSeconds * 1000;

    const earliestEntry = targetFundingTimeMs - leadMs;
    const latestEntry = targetFundingTimeMs - cutoffMs;

    return now >= earliestEntry && now <= latestEntry;
  }

  /**
   * Returns milliseconds remaining until entry window opens.
   */
  static msUntilEntryWindow(targetFundingTimeMs: number, entryLeadMinutes: number = 2.5): number {
    const now = Date.now();
    const leadMs = entryLeadMinutes * 60 * 1000;
    const earliestEntry = targetFundingTimeMs - leadMs;
    return Math.max(0, earliestEntry - now);
  }
}
