export function nowUtcMs(): number {
  return Date.now();
}

export function nowUtcIso(): string {
  return new Date().toISOString();
}

export function toIsoUtc(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

export function parseTimestampMs(value: string | number | Date): number {
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  if (isNaN(parsed)) throw new Error(`Invalid date string: ${value}`);
  return parsed;
}

export function diffSeconds(laterMs: number, earlierMs: number): number {
  return (laterMs - earlierMs) / 1000;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Checks if two funding timestamps are aligned within a given tolerance in seconds.
 * Standard perpetual funding epochs are every 8 hours (00:00, 08:00, 16:00 UTC) or 4/1 hour.
 */
export function areFundingTimesAligned(timeAMs: number, timeBMs: number, toleranceSeconds: number = 60): boolean {
  return Math.abs(timeAMs - timeBMs) <= toleranceSeconds * 1000;
}
