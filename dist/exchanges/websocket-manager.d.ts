export interface WebSocketOptions {
    url: string;
    pingIntervalMs?: number;
    reconnectDelayMs?: number;
    onMessage: (data: any) => void;
    onDisconnect?: () => void;
    onConnect?: () => void;
}
export declare class ResilientWebSocket {
    private readonly options;
    private ws;
    private isClosedIntentionally;
    private pingTimer;
    private reconnectAttempts;
    constructor(options: WebSocketOptions);
    connect(): void;
    private startHeartbeat;
    private cleanup;
    private scheduleReconnect;
    send(data: any): void;
    close(): void;
}
//# sourceMappingURL=websocket-manager.d.ts.map