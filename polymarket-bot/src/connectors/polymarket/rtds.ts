import WebSocket from "ws";
import { MICRO } from "../../core/fixed.js";
import { Logger } from "../../core/logger.js";
import type { Asset, OracleTick } from "../../core/types.js";

/**
 * Polymarket RTDS (real-time data service) — the official live data socket.
 * Endpoint and wire format verified against Polymarket/real-time-data-client
 * (2026-06): wss://ws-live-data.polymarket.com, subscribe via
 *   { action: "subscribe", subscriptions: [{ topic, type, filters }] }
 * keepalive: send "ping" every 5s.
 *
 * We subscribe to `crypto_prices_chainlink` — the Chainlink stream Polymarket
 * short-duration crypto markets resolve against. This is the closest public
 * proxy to the actual settlement feed (spec addendum B5 priority 1-2), far
 * better than a Binance price.
 */

const RTDS_URL = process.env["POLYMARKET_RTDS_URL"] ?? "wss://ws-live-data.polymarket.com";

const SYMBOLS: Record<Asset, string> = {
  BTC: "BTCUSDT",
  ETH: "ETHUSDT",
  SOL: "SOLUSDT",
  XRP: "XRPUSDT",
};

export class RtdsOracle {
  private ws: WebSocket | null = null;
  private closed = false;
  private backoffMs = 500;
  private pingTimer: NodeJS.Timeout | null = null;
  private readonly log = new Logger("polymarket-rtds");

  constructor(
    private readonly asset: Asset,
    private readonly onTick: (tick: OracleTick) => void,
  ) {}

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
  }

  private connect(): void {
    const ws = new WebSocket(RTDS_URL);
    this.ws = ws;
    const symbol = SYMBOLS[this.asset];

    ws.on("open", () => {
      this.backoffMs = 500;
      ws.send(
        JSON.stringify({
          action: "subscribe",
          subscriptions: [
            { topic: "crypto_prices_chainlink", type: "update", filters: JSON.stringify({ symbol }) },
          ],
        }),
      );
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("ping");
      }, 5_000);
      this.log.info("connected", { symbol });
    });

    ws.on("message", (data: WebSocket.RawData) => {
      const text = data.toString();
      if (!text.includes("payload")) return; // pongs / acks
      try {
        const msg = JSON.parse(text) as { topic?: string; payload?: unknown };
        const payloads = Array.isArray(msg.payload) ? msg.payload : [msg.payload];
        for (const p of payloads) {
          const tick = p as { symbol?: string; value?: number; timestamp?: number };
          if (tick?.value === undefined) continue;
          if (tick.symbol !== undefined && tick.symbol !== symbol) continue;
          this.onTick({
            source: "polymarket-rtds-chainlink",
            symbol: tick.symbol ?? symbol,
            valueMicros: Math.round(tick.value * MICRO),
            tsMs: tick.timestamp ?? Date.now(),
          });
        }
      } catch {
        // ignore malformed frames
      }
    });

    ws.on("close", () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (this.closed) return;
      const delay = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, 15_000);
      this.log.warn("reconnecting", { delayMs: delay });
      setTimeout(() => {
        if (!this.closed) this.connect();
      }, delay);
    });
    ws.on("error", (err: Error) => {
      this.log.warn("ws error", { message: err.message });
      ws.close();
    });
  }
}
