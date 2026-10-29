import dnsSync from 'node:dns';
import dnsPromises from 'node:dns/promises';
import { Agent, setGlobalDispatcher } from 'undici';
import { logger } from './logger.js';

// Public DNS resolvers (Google & Cloudflare) to bypass local ISP DNS sinkholing/blocking
const PUBLIC_DNS = ['8.8.8.8', '1.1.1.1', '8.8.4.4', '1.0.0.1'];

// Known ISP DNS sinkhole/censorship IPs (e.g., Reliance Jio, Airtel in India)
const SINKHOLE_IPS = new Set([
  '49.44.79.236',
  '2405:200:1607:2820:41::36',
]);

let isInitialized = false;

/**
 * Custom DNS lookup callback function that can be used with `undici` Agent
 * and `ws` WebSocket ClientOptions to reliably resolve exchange endpoints.
 */
export function customDnsLookup(
  hostname: string,
  options: any,
  callback: (err: NodeJS.ErrnoException | null, address: any, family?: number) => void
): void {
  const cb = typeof options === 'function' ? options : callback;
  const opts = typeof options === 'object' ? options : {};

  // Bypass for local names
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return dnsSync.lookup(hostname, opts, cb);
  }

  // Attempt resolving via public DNS servers
  dnsPromises
    .resolve4(hostname)
    .then((addresses) => {
      const cleanAddresses = addresses.filter((ip) => !SINKHOLE_IPS.has(ip));
      const chosen = cleanAddresses.length > 0 ? cleanAddresses : addresses;

      if (chosen.length === 0) {
        return dnsSync.lookup(hostname, opts, cb);
      }

      if (opts.all) {
        cb(
          null,
          chosen.map((addr) => ({ address: addr, family: 4 })) as any
        );
      } else {
        cb(null, chosen[0]!, 4);
      }
    })
    .catch(() => {
      // Fallback to standard operating system DNS lookup
      dnsSync.lookup(hostname, opts, cb);
    });
}

/**
 * Initializes undici global agent and Node DNS with public DNS fallback.
 */
export function initializeDns(): void {
  if (isInitialized) return;
  isInitialized = true;

  try {
    dnsPromises.setServers(PUBLIC_DNS);
  } catch (err) {
    logger.debug({ err }, 'Could not set default dns server list');
  }

  const agent = new Agent({
    connect: {
      lookup: customDnsLookup,
    },
  });

  setGlobalDispatcher(agent);
}

