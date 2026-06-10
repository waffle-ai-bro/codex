import WebSocket from "ws";
import { parseMicros } from "../../core/fixed.js";
import { Logger } from "../../core/logger.js";
import type { BookTop, TradeEvent } from "../../core/types.js";

/**
 * Polymarket CLOB market-channel WebSocket (public).
 * https://docs.polymarket.com/market-data/websocket/overview
 *
 * Emits normalized book tops and trades. Reconnects with backoff; the
 * consumer must treat a reconnect as a freshness gap (books go stale).
 */

const WS_URL =
  process.env["POLYMARKET_WS_MARKET_URL"] ?? "wss://ws-subscriptions-clob.polymarket.com/ws/market";

export interface MarketWsHandlers {
  onBook?: (top: BookTop) => void;
  onTrade?: (trade: TradeEvent) => void;
  onDisconnect?: () => void;
}

export class MarketWs {
  private ws: WebSocket | null = null;
  private closed = false;
  private backoffMs = 500;
  private pingTimer: NodeJS.Timeout | null = null;
  private readonly log = new Logger("polymarket-ws");

  constructor(
    private readonly assetIds: string[],
    private readonly handlers: MarketWsHandlers,
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
    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.on("open", () => {
      this.backoffMs = 500;
      ws.send(JSON.stringify({ type: "market", assets_ids: this.assetIds }));
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("PING");
      }, 10_000);
      this.log.info("connected", { assets: this.assetIds.length });
    });

    ws.on("message", (data: WebSocket.RawData) => {
      const text = data.toString();
      if (text === "PONG" || text.length === 0) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      const events = Array.isArray(parsed) ? parsed : [parsed];
      for (const ev of events) this.handleEvent(ev as Record<string, unknown>);
    });

    ws.on("close", () => this.scheduleReconnect());
    ws.on("error", (err: Error) => {
      this.log.warn("ws error", { message: err.message });
      ws.close();
    });
  }

  private scheduleReconnect(): void {
    this.handlers.onDisconnect?.();
    if (this.closed) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 15_000);
    this.log.warn("reconnecting", { delayMs: delay });
    setTimeout(() => {
      if (!this.closed) this.connect();
    }, delay);
  }

  private handleEvent(ev: Record<string, unknown>): void {
    const type = ev["event_type"];
    const nowMs = Date.now();
    try {
      if (type === "book") {
        const tokenId = String(ev["asset_id"] ?? "");
        const bids = (ev["bids"] ?? ev["buys"] ?? []) as Array<{ price: string; size: string }>;
        const asks = (ev["asks"] ?? ev["sells"] ?? []) as Array<{ price: string; size: string }>;
        let bestBid = 0;
        let bestBidSize = 0;
        for (const l of bids) {
          const p = parseMicros(l.price);
          if (p > bestBid) {
            bestBid = p;
            bestBidSize = parseMicros(l.size);
          }
        }
        let bestAsk = Number.MAX_SAFE_INTEGER;
        let bestAskSize = 0;
        for (const l of asks) {
          const p = parseMicros(l.price);
          if (p < bestAsk) {
            bestAsk = p;
            bestAskSize = parseMicros(l.size);
          }
        }
        this.handlers.onBook?.({
          tokenId,
          bidMicros: bestBid,
          askMicros: bestAsk,
          bidSizeMicros: bestBidSize,
          askSizeMicros: bestAskSize,
          tsMs: Number(ev["timestamp"] ?? nowMs) || nowMs,
        });
      } else if (type === "last_trade_price" || type === "trade") {
        const sideRaw = String(ev["side"] ?? "").toUpperCase();
        this.handlers.onTrade?.({
          tokenId: String(ev["asset_id"] ?? ""),
          priceMicros: parseMicros(String(ev["price"] ?? "0")),
          sizeMicros: parseMicros(String(ev["size"] ?? "0")),
          side: sideRaw === "SELL" ? "sell" : "buy",
          tsMs: Number(ev["timestamp"] ?? nowMs) || nowMs,
        });
      }
      // price_change events carry level deltas; the periodic book events are
      // sufficient for top-of-book strategy state at this stage.
    } catch (err) {
      this.log.warn("failed to parse ws event", { message: (err as Error).message });
    }
  }
}
