import WebSocket from 'ws';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/time.js';
import { customDnsLookup } from '../utils/dns-resolver.js';

export interface WebSocketOptions {
  url: string;
  pingIntervalMs?: number;
  reconnectDelayMs?: number;
  onMessage: (data: any) => void;
  onDisconnect?: () => void;
  onConnect?: () => void;
}

export class ResilientWebSocket {
  private ws: WebSocket | null = null;
  private isClosedIntentionally: boolean = false;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts: number = 0;

  constructor(private readonly options: WebSocketOptions) {}

  public connect(): void {
    this.isClosedIntentionally = false;
    try {
      this.ws = new WebSocket(this.options.url, { lookup: customDnsLookup });

      this.ws.on('open', () => {
        logger.info({ url: this.options.url }, 'WebSocket connected');
        this.reconnectAttempts = 0;
        this.startHeartbeat();
        this.options.onConnect?.();
      });

      this.ws.on('message', (raw) => {
        try {
          const parsed = JSON.parse(raw.toString());
          this.options.onMessage(parsed);
        } catch (err) {
          logger.warn({ err, raw: raw.toString().slice(0, 100) }, 'Failed to parse WS message');
        }
      });

      this.ws.on('close', (code, reason) => {
        logger.warn({ code, reason: reason.toString(), url: this.options.url }, 'WebSocket closed');
        this.cleanup();
        this.options.onDisconnect?.();
        if (!this.isClosedIntentionally) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (err) => {
        logger.error({ err, url: this.options.url }, 'WebSocket error');
      });
    } catch (err) {
      logger.error({ err, url: this.options.url }, 'Failed to initiate WebSocket connection');
      this.scheduleReconnect();
    }
  }

  private startHeartbeat(): void {
    const interval = this.options.pingIntervalMs || 20000;
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, interval);
  }

  private cleanup(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws = null;
    }
  }

  private async scheduleReconnect(): Promise<void> {
    this.cleanup();
    this.reconnectAttempts++;
    const delay = Math.min(30000, (this.options.reconnectDelayMs || 1000) * Math.pow(1.5, this.reconnectAttempts));
    logger.info({ attempt: this.reconnectAttempts, delayMs: delay }, 'Scheduling WebSocket reconnect');
    await sleep(delay);
    if (!this.isClosedIntentionally) {
      this.connect();
    }
  }

  public send(data: any): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(typeof data === 'string' ? data : JSON.stringify(data));
    } else {
      logger.warn({ readyState: this.ws?.readyState }, 'Attempted to send over non-open WebSocket');
    }
  }

  public close(): void {
    this.isClosedIntentionally = true;
    this.cleanup();
    if (this.ws) {
      this.ws.close();
    }
  }
}
