import { io, type Socket } from "socket.io-client";
import { MICRO, parseMicros } from "../../core/fixed.js";
import { Logger } from "../../core/logger.js";
import type { BookTop, OracleTick, TradeEvent } from "../../core/types.js";

/**
 * Limitless Socket.IO market-data feed.
 *
 * Verified against the official SDK (limitless-exchange-ts-sdk, 2026-06):
 *  - URL: wss://ws.limitless.exchange, namespace "/markets",
 *    transports: ['websocket'] only
 *  - subscribe channel: 'subscribe_market_prices' { marketSlugs: [...] }
 *  - events:
 *      orderbookUpdate  { marketSlug, orderbook: { bids, asks, tokenId,
 *                         adjustedMidpoint, maxSpread, minSize, timestamp } }
 *      oraclePriceData  { marketAddress, marketSlug, timestamp, value }
 *      orderEvent       (authenticated order lifecycle)
 *
 * NOTE: the public feed exposes orderbook updates and oracle prices but NO
 * public trade prints. Paper fill simulation on this venue therefore uses the
 * PaperExchange book-cross mode (see paper-exchange.ts).
 *
 * An onAny() fallback still routes unknown event names by pattern so schema
 * drift degrades gracefully instead of going silent.
 */

const WS_BASE = process.env["LIMITLESS_WS_BASE"] ?? "wss://ws.limitless.exchange";

export interface LimitlessSocketHandlers {
  onBook?: (top: BookTop) => void;
  onTrade?: (trade: TradeEvent) => void;
  onOracle?: (tick: OracleTick) => void;
  onDisconnect?: () => void;
}

function toMicros(v: string | number): number {
  return typeof v === "number" ? Math.round(v * MICRO) : parseMicros(v);
}

export class LimitlessSocket {
  private socket: Socket | null = null;
  private readonly log = new Logger("limitless-socket");
  private readonly handledEvents = new Set([
    "orderbookUpdate",
    "oraclePriceData",
    "connect",
    "disconnect",
    "error",
    "reconnect_attempt",
    "reconnect",
    "system",
  ]);

  constructor(
    private readonly marketSlug: string,
    private readonly tokenIds: { up: string; down: string },
    private readonly handlers: LimitlessSocketHandlers,
  ) {}

  start(): void {
    const socket = io(`${WS_BASE}/markets`, {
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 15_000,
    });
    this.socket = socket;

    socket.on("connect", () => {
      this.log.info("connected", { market: this.marketSlug });
      socket.emit("subscribe_market_prices", { marketSlugs: [this.marketSlug] });
    });

    socket.on("disconnect", (reason: string) => {
      this.log.warn("disconnected", { reason });
      this.handlers.onDisconnect?.();
    });

    socket.on("orderbookUpdate", (payload: unknown) => this.handleOrderbook(payload));
    socket.on("oraclePriceData", (payload: unknown) => this.handleOracle(payload));

    // Fallback routing for any event we didn't pin down.
    socket.onAny((event: string, ...args: unknown[]) => {
      if (this.handledEvents.has(event)) return;
      try {
        if (/orderbook|book/i.test(event)) this.handleOrderbook(args[0]);
        else if (/oracle|price/i.test(event)) this.handleOracle(args[0]);
        else if (/trade/i.test(event)) this.handleTrade(args[0]);
        else this.log.debug("unrouted event", { event });
      } catch (err) {
        this.log.debug("fallback routing failed", { event, message: (err as Error).message });
      }
    });
  }

  stop(): void {
    this.socket?.close();
    this.socket = null;
  }

  private handleOrderbook(payload: unknown): void {
    if (!payload || typeof payload !== "object") return;
    const outer = payload as Record<string, unknown>;
    if (outer["marketSlug"] !== undefined && outer["marketSlug"] !== this.marketSlug) return;
    // Official shape nests the book under `orderbook`; tolerate a flat shape too.
    const book = (outer["orderbook"] ?? outer) as Record<string, unknown>;
    const tokenId = String(book["tokenId"] ?? book["token_id"] ?? this.tokenIds.up);
    const bids = (book["bids"] ?? []) as Array<{ price: string | number; size: string | number }>;
    const asks = (book["asks"] ?? []) as Array<{ price: string | number; size: string | number }>;
    if (bids.length === 0 && asks.length === 0) return;

    let bestBid = 0;
    let bestBidSize = 0;
    for (const l of bids) {
      const price = toMicros(l.price);
      if (price > bestBid) {
        bestBid = price;
        bestBidSize = toMicros(l.size);
      }
    }
    let bestAsk = Number.MAX_SAFE_INTEGER;
    let bestAskSize = 0;
    for (const l of asks) {
      const price = toMicros(l.price);
      if (price < bestAsk) {
        bestAsk = price;
        bestAskSize = toMicros(l.size);
      }
    }
    const nowMs = Date.now();
    const top: BookTop = {
      tokenId,
      bidMicros: bestBid,
      askMicros: bestAsk,
      bidSizeMicros: bestBidSize,
      askSizeMicros: bestAskSize,
      tsMs: Number(book["timestamp"] ?? nowMs) || nowMs,
    };
    this.handlers.onBook?.(top);

    // Binary CLOB: the opposite token's book is the mirror image. Emit it so
    // the strategy always has both sides without a second subscription.
    if (tokenId === this.tokenIds.up && bestBid > 0 && bestAsk < Number.MAX_SAFE_INTEGER) {
      this.handlers.onBook?.({
        tokenId: this.tokenIds.down,
        bidMicros: MICRO - bestAsk,
        askMicros: MICRO - bestBid,
        bidSizeMicros: bestAskSize,
        askSizeMicros: bestBidSize,
        tsMs: top.tsMs,
      });
    }
  }

  private handleOracle(payload: unknown): void {
    if (!payload || typeof payload !== "object") return;
    const p = payload as Record<string, unknown>;
    if (p["marketSlug"] !== undefined && p["marketSlug"] !== this.marketSlug) return;
    const value = p["value"] ?? p["price"] ?? p["answer"];
    if (value === undefined) return;
    const nowMs = Date.now();
    this.handlers.onOracle?.({
      source: "limitless-oracle",
      symbol: String(p["symbol"] ?? p["marketSlug"] ?? "UNKNOWN"),
      valueMicros: toMicros(value as string | number),
      tsMs: Number(p["timestamp"] ?? nowMs) || nowMs,
    });
  }

  private handleTrade(payload: unknown): void {
    if (!payload || typeof payload !== "object") return;
    const p = payload as Record<string, unknown>;
    const tokenId = String(p["tokenId"] ?? p["token_id"] ?? "");
    if (!tokenId) return;
    const sideRaw = String(p["side"] ?? p["takerSide"] ?? "").toUpperCase();
    const nowMs = Date.now();
    this.handlers.onTrade?.({
      tokenId,
      priceMicros: toMicros((p["price"] ?? 0) as string | number),
      sizeMicros: toMicros((p["size"] ?? p["amount"] ?? 0) as string | number),
      side: sideRaw === "SELL" ? "sell" : "buy",
      tsMs: Number(p["timestamp"] ?? nowMs) || nowMs,
    });
  }
}
