import WebSocket from "ws";
import { parseMicros } from "../../core/fixed.js";
import { Logger } from "../../core/logger.js";
import type { BookTop, TradeEvent } from "../../core/types.js";

/**
 * Polymarket CLOB market-channel WebSocket (public).
 * Endpoint + payloads verified against docs.polymarket.com and
 * Polymarket/agent-skills (2026-06).
 *
 * Latency design: top-of-book is updated from THREE event types, not just
 * full `book` snapshots — `price_change` entries carry best_bid/best_ask per
 * asset, and `best_bid_ask` (enabled via custom_feature_enabled) pushes top
 * updates directly. The strategy therefore reacts without waiting for the
 * next snapshot.
 *
 * Reliability: PING every 10s (server closes after ~10s silence), exponential
 * backoff reconnect, and onDisconnect notification so consumers treat books
 * as stale and cancel resting orders.
 */

const WS_URL =
  process.env["POLYMARKET_WS_MARKET_URL"] ?? "wss://ws-subscriptions-clob.polymarket.com/ws/market";

export interface MarketWsHandlers {
  onBook?: (top: BookTop) => void;
  onTrade?: (trade: TradeEvent) => void;
  onTickSizeChange?: (tokenId: string, newTickMicros: number) => void;
  onMarketResolved?: (conditionId: string) => void;
  onDisconnect?: () => void;
}

interface Level {
  price: string;
  size: string;
}

export class MarketWs {
  private ws: WebSocket | null = null;
  private closed = false;
  private backoffMs = 500;
  private pingTimer: NodeJS.Timeout | null = null;
  private readonly log = new Logger("polymarket-ws");
  /** Last known top per token so partial events can update prices without losing sizes. */
  private readonly lastTop = new Map<string, BookTop>();

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
      ws.send(
        JSON.stringify({
          type: "market",
          assets_ids: this.assetIds,
          custom_feature_enabled: true, // enables best_bid_ask + market_resolved
        }),
      );
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
    this.lastTop.clear(); // books are stale after a gap; rebuild from snapshots
    this.handlers.onDisconnect?.();
    if (this.closed) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 15_000);
    this.log.warn("reconnecting", { delayMs: delay });
    setTimeout(() => {
      if (!this.closed) this.connect();
    }, delay);
  }

  private emitTop(top: BookTop): void {
    this.lastTop.set(top.tokenId, top);
    this.handlers.onBook?.(top);
  }

  private handleEvent(ev: Record<string, unknown>): void {
    const type = ev["event_type"];
    const nowMs = Date.now();
    const evTs = (): number => {
      const ts = Number(ev["timestamp"] ?? nowMs);
      return Number.isFinite(ts) && ts > 1_000_000_000_000 ? ts : nowMs;
    };
    try {
      switch (type) {
        case "book": {
          const tokenId = String(ev["asset_id"] ?? "");
          const bids = (ev["bids"] ?? ev["buys"] ?? []) as Level[];
          const asks = (ev["asks"] ?? ev["sells"] ?? []) as Level[];
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
          this.emitTop({
            tokenId,
            bidMicros: bestBid,
            askMicros: bestAsk,
            bidSizeMicros: bestBidSize,
            askSizeMicros: bestAskSize,
            tsMs: evTs(),
          });
          break;
        }
        case "price_change": {
          // Per-asset deltas with fresh best_bid/best_ask — lower latency than
          // waiting for the next book snapshot.
          const changes = (ev["price_changes"] ?? []) as Array<Record<string, unknown>>;
          for (const ch of changes) {
            const tokenId = String(ch["asset_id"] ?? "");
            if (!tokenId) continue;
            const prev = this.lastTop.get(tokenId);
            const bestBid = ch["best_bid"] !== undefined ? parseMicros(String(ch["best_bid"])) : prev?.bidMicros;
            const bestAsk = ch["best_ask"] !== undefined ? parseMicros(String(ch["best_ask"])) : prev?.askMicros;
            if (bestBid === undefined || bestAsk === undefined) continue;
            // Sizes: keep previous knowledge when the touched level isn't the top.
            const chPrice = ch["price"] !== undefined ? parseMicros(String(ch["price"])) : -1;
            const chSize = ch["size"] !== undefined ? parseMicros(String(ch["size"])) : 0;
            this.emitTop({
              tokenId,
              bidMicros: bestBid,
              askMicros: bestAsk,
              bidSizeMicros: chPrice === bestBid ? chSize : prev?.bidMicros === bestBid ? (prev?.bidSizeMicros ?? 0) : 0,
              askSizeMicros: chPrice === bestAsk ? chSize : prev?.askMicros === bestAsk ? (prev?.askSizeMicros ?? 0) : 0,
              tsMs: evTs(),
            });
          }
          break;
        }
        case "best_bid_ask": {
          const tokenId = String(ev["asset_id"] ?? "");
          if (!tokenId) break;
          const prev = this.lastTop.get(tokenId);
          const bestBid = ev["best_bid"] !== undefined ? parseMicros(String(ev["best_bid"])) : prev?.bidMicros;
          const bestAsk = ev["best_ask"] !== undefined ? parseMicros(String(ev["best_ask"])) : prev?.askMicros;
          if (bestBid === undefined || bestAsk === undefined) break;
          this.emitTop({
            tokenId,
            bidMicros: bestBid,
            askMicros: bestAsk,
            bidSizeMicros: prev?.bidMicros === bestBid ? (prev?.bidSizeMicros ?? 0) : 0,
            askSizeMicros: prev?.askMicros === bestAsk ? (prev?.askSizeMicros ?? 0) : 0,
            tsMs: evTs(),
          });
          break;
        }
        case "last_trade_price":
        case "trade": {
          const sideRaw = String(ev["side"] ?? "").toUpperCase();
          this.handlers.onTrade?.({
            tokenId: String(ev["asset_id"] ?? ""),
            priceMicros: parseMicros(String(ev["price"] ?? "0")),
            sizeMicros: parseMicros(String(ev["size"] ?? "0")),
            side: sideRaw === "SELL" ? "sell" : "buy",
            tsMs: evTs(),
          });
          break;
        }
        case "tick_size_change": {
          // Critical: orders priced with a stale tick are rejected by the venue.
          const tokenId = String(ev["asset_id"] ?? "");
          const newTick = ev["new_tick_size"];
          if (tokenId && newTick !== undefined) {
            this.handlers.onTickSizeChange?.(tokenId, parseMicros(String(newTick)));
          }
          break;
        }
        case "market_resolved": {
          this.handlers.onMarketResolved?.(String(ev["market"] ?? ""));
          break;
        }
        default:
          break;
      }
    } catch (err) {
      this.log.warn("failed to parse ws event", { type: String(type), message: (err as Error).message });
    }
  }
}
