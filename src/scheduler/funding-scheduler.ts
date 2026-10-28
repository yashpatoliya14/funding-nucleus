export class FundingScheduler {
  /**
   * Determines if the current time is within the entry window.
   * Entry window: between `entryLeadMinutes` before funding and 60 seconds before funding.
   */
  static isWithinEntryWindow(
    targetFundingTimeMs: number,
    entryLeadMinutes: number = 10,
    cutoffSeconds: number = 60
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
  static msUntilEntryWindow(targetFundingTimeMs: number, entryLeadMinutes: number = 10): number {
    const now = Date.now();
    const leadMs = entryLeadMinutes * 60 * 1000;
    const earliestEntry = targetFundingTimeMs - leadMs;
    return Math.max(0, earliestEntry - now);
  }
}
