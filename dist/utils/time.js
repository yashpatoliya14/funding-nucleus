export function nowUtcMs() {
    return Date.now();
}
export function nowUtcIso() {
    return new Date().toISOString();
}
export function toIsoUtc(timestampMs) {
    return new Date(timestampMs).toISOString();
}
export function parseTimestampMs(value) {
    if (typeof value === 'number')
        return value;
    if (value instanceof Date)
        return value.getTime();
    const parsed = Date.parse(value);
    if (isNaN(parsed))
        throw new Error(`Invalid date string: ${value}`);
    return parsed;
}
export function diffSeconds(laterMs, earlierMs) {
    return (laterMs - earlierMs) / 1000;
}
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * Checks if two funding timestamps are aligned within a given tolerance in seconds.
 * Standard perpetual funding epochs are every 8 hours (00:00, 08:00, 16:00 UTC) or 4/1 hour.
 */
export function areFundingTimesAligned(timeAMs, timeBMs, toleranceSeconds = 60) {
    return Math.abs(timeAMs - timeBMs) <= toleranceSeconds * 1000;
}
//# sourceMappingURL=time.js.map