/**
 * Custom DNS lookup callback function that can be used with `undici` Agent
 * and `ws` WebSocket ClientOptions to reliably resolve exchange endpoints.
 */
export declare function customDnsLookup(hostname: string, options: any, callback: (err: NodeJS.ErrnoException | null, address: any, family?: number) => void): void;
/**
 * Initializes undici global agent and Node DNS with public DNS fallback.
 */
export declare function initializeDns(): void;
//# sourceMappingURL=dns-resolver.d.ts.map