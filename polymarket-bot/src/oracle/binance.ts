import WebSocket from "ws";
import { MICRO } from "../core/fixed.js";
import { Logger } from "../core/logger.js";
import type { OracleTick } from "../core/types.js";

/**
 * Binance trade stream as a PROXY oracle.
 *
 * WARNING (spec addendum B5): Polymarket short-duration crypto markets settle
 * on Chainlink Data Streams, NOT Binance. This feed is a sanity-check proxy
 * for paper trading only. Never assume Binance close == settlement close.
 */

export class BinanceOracle {
  private ws: WebSocket | null = null;
  private closed = false;
  private backoffMs = 500;
  private readonly log = new Logger("binance-oracle");

  constructor(
    private readonly symbol: string, // e.g. "btcusdt"
    private readonly onTick: (tick: OracleTick) => void,
  ) {}

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    this.ws?.close();
  }

  private connect(): void {
    const url = `wss://stream.binance.com:9443/ws/${this.symbol}@trade`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      this.backoffMs = 500;
      this.log.info("connected", { symbol: this.symbol });
    });

    ws.on("message", (data: WebSocket.RawData) => {
      try {
        const ev = JSON.parse(data.toString()) as { p?: string; T?: number };
        if (!ev.p) return;
        this.onTick({
          source: "binance-proxy",
          symbol: this.symbol.toUpperCase(),
          valueMicros: Math.round(Number(ev.p) * MICRO),
          tsMs: ev.T ?? Date.now(),
        });
      } catch {
        // ignore malformed frames
      }
    });

    ws.on("close", () => {
      if (this.closed) return;
      const delay = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, 15_000);
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
