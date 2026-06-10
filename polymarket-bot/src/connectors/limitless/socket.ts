import { io, type Socket } from "socket.io-client";
import { MICRO, parseMicros } from "../../core/fixed.js";
import { Logger } from "../../core/logger.js";
import type { BookTop, OracleTick, TradeEvent } from "../../core/types.js";

/**
 * Limitless Socket.IO market-data feed (spec addendum B5/F: Limitless exposes
 * a Socket.IO WSS plus oracle price data usable for same-oracle setups).
 *
 * VERIFY-ON-FIRST-RUN: event names and payload shapes are routed defensively
 * via onAny() with pattern matching, because they could not be confirmed
 * offline. Run with LOG_LEVEL=debug once to see the raw event names and then
 * pin them down.
 */

const WS_BASE = process.env["LIMITLESS_WS_BASE"] ?? "https://ws.limitless.exchange";

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

  constructor(
    private readonly marketSlug: string,
    private readonly tokenIds: { up: string; down: string },
    private readonly handlers: LimitlessSocketHandlers,
  ) {}

  start(): void {
    const socket = io(WS_BASE, {
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 15_000,
    });
    this.socket = socket;

    socket.on("connect", () => {
      this.log.info("connected", { market: this.marketSlug });
      // Common subscription shapes; harmless extras are ignored server-side.
      socket.emit("subscribe", { market: this.marketSlug });
      socket.emit("join", `market:${this.marketSlug}`);
    });

    socket.on("disconnect", (reason: string) => {
      this.log.warn("disconnected", { reason });
      this.handlers.onDisconnect?.();
    });

    socket.onAny((event: string, ...args: unknown[]) => {
      try {
        this.route(event, args[0]);
      } catch (err) {
        this.log.debug("unhandled event", { event, message: (err as Error).message });
      }
    });
  }

  stop(): void {
    this.socket?.close();
    this.socket = null;
  }

  private route(event: string, payload: unknown): void {
    if (payload === undefined || payload === null) return;
    const p = payload as Record<string, unknown>;
    const nowMs = Date.now();

    if (/orderbook|book/i.test(event)) {
      const tokenId = String(p["tokenId"] ?? p["token_id"] ?? "");
      const bids = (p["bids"] ?? []) as Array<{ price: string | number; size: string | number }>;
      const asks = (p["asks"] ?? []) as Array<{ price: string | number; size: string | number }>;
      if (!tokenId || (bids.length === 0 && asks.length === 0)) return;
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
      this.handlers.onBook?.({
        tokenId,
        bidMicros: bestBid,
        askMicros: bestAsk,
        bidSizeMicros: bestBidSize,
        askSizeMicros: bestAskSize,
        tsMs: Number(p["timestamp"] ?? nowMs) || nowMs,
      });
      return;
    }

    if (/trade/i.test(event)) {
      const tokenId = String(p["tokenId"] ?? p["token_id"] ?? "");
      if (!tokenId) return;
      const sideRaw = String(p["side"] ?? p["takerSide"] ?? "").toUpperCase();
      this.handlers.onTrade?.({
        tokenId,
        priceMicros: toMicros((p["price"] ?? 0) as string | number),
        sizeMicros: toMicros((p["size"] ?? p["amount"] ?? 0) as string | number),
        side: sideRaw === "SELL" ? "sell" : "buy",
        tsMs: Number(p["timestamp"] ?? nowMs) || nowMs,
      });
      return;
    }

    if (/oracle|price.*data/i.test(event)) {
      // oraclePriceData-style payload: the same feed Limitless settles from,
      // which makes it strictly better than the Binance proxy when present.
      const value = p["price"] ?? p["value"] ?? p["answer"];
      if (value === undefined) return;
      this.handlers.onOracle?.({
        source: "limitless-oracle",
        symbol: String(p["symbol"] ?? p["feed"] ?? "UNKNOWN"),
        valueMicros: toMicros(value as string | number),
        tsMs: Number(p["timestamp"] ?? nowMs) || nowMs,
      });
    }
  }
}
