import { MICRO, notionalUsdMicros } from "../core/fixed.js";
import type {
  BookTop,
  MarketResolution,
  PaperFill,
  PaperOrder,
  TradeEvent,
} from "../core/types.js";

/**
 * Conservative paper exchange for post-only maker simulation (spec §14, addendum Phase 2).
 *
 * Fill rules — intentionally pessimistic:
 *  - Post-only: an order whose price >= current best ask is REJECTED (never
 *    converted to taker), matching the spec's post-only requirement.
 *  - A resting bid can only fill from an observed SELL trade printing at a
 *    price <= our bid, strictly after our placement timestamp.
 *  - Queue: at placement we assume the entire visible bid size at/above our
 *    price is ahead of us. Qualifying sell volume first depletes that queue.
 *  - Trades within `graceMs` of placement never fill us (network latency).
 *
 * Positions settle to $1 or $0 at resolution.
 *
 * Venues without a public trade-print stream (e.g. Limitless market-data
 * sockets expose orderbook updates only) can enable `fillOnBookCross`: a
 * resting bid fills when the best ASK drops to or below our price — i.e. the
 * market traded/quoted through our level, so a resting bid would have been
 * lifted. Queue-ahead still applies via the crossing ask's visible size.
 */
export class PaperExchange {
  private seq = 0;
  readonly orders = new Map<string, PaperOrder>();
  readonly fills: PaperFill[] = [];
  /** tokenId -> net shares held (micros). */
  readonly positions = new Map<string, number>();
  /** tokenId -> cost basis usdMicros. */
  private readonly costBasis = new Map<string, number>();
  private realizedPnlUsdMicros = 0;
  private readonly lastBook = new Map<string, BookTop>();

  constructor(
    private readonly graceMs = 250,
    private readonly fillOnBookCross = false,
  ) {}

  onBook(top: BookTop): PaperFill[] {
    this.lastBook.set(top.tokenId, top);
    if (!this.fillOnBookCross) return [];
    const out: PaperFill[] = [];
    for (const o of this.orders.values()) {
      if (o.status !== "open") continue;
      if (o.tokenId !== top.tokenId) continue;
      if (top.tsMs <= o.placedTsMs + this.graceMs) continue;
      if (top.askMicros > o.priceMicros) continue; // ask still above our bid
      // The book quoted through our level: treat the crossing ask's visible
      // size as the sell volume available to us, after queue ahead.
      let volume = top.askSizeMicros > 0 ? top.askSizeMicros : o.remainingMicros;
      if (o.queueAheadMicros > 0) {
        const eaten = Math.min(o.queueAheadMicros, volume);
        o.queueAheadMicros -= eaten;
        volume -= eaten;
      }
      if (volume <= 0) continue;
      const fillSize = Math.min(volume, o.remainingMicros);
      o.remainingMicros -= fillSize;
      if (o.remainingMicros === 0) o.status = "filled";
      const fill: PaperFill = {
        orderId: o.id,
        marketId: o.marketId,
        tokenId: o.tokenId,
        priceMicros: o.priceMicros,
        sizeMicros: fillSize,
        tsMs: top.tsMs,
      };
      this.fills.push(fill);
      out.push(fill);
      this.positions.set(o.tokenId, (this.positions.get(o.tokenId) ?? 0) + fillSize);
      this.costBasis.set(
        o.tokenId,
        (this.costBasis.get(o.tokenId) ?? 0) + notionalUsdMicros(o.priceMicros, fillSize),
      );
    }
    return out;
  }

  placePostOnlyBuy(args: {
    marketId: string;
    tokenId: string;
    priceMicros: number;
    sizeMicros: number;
    tsMs: number;
  }): PaperOrder {
    const id = `paper-${++this.seq}`;
    const book = this.lastBook.get(args.tokenId);
    const order: PaperOrder = {
      id,
      marketId: args.marketId,
      tokenId: args.tokenId,
      side: "buy",
      priceMicros: args.priceMicros,
      sizeMicros: args.sizeMicros,
      remainingMicros: args.sizeMicros,
      postOnly: true,
      status: "open",
      placedTsMs: args.tsMs,
      queueAheadMicros: 0,
    };
    if (book && args.priceMicros >= book.askMicros) {
      order.status = "rejected";
      order.rejectReason = "post-only would cross";
    } else if (book && args.priceMicros <= book.bidMicros) {
      // Joining (or behind) the best bid: visible size is ahead of us.
      order.queueAheadMicros = book.bidSizeMicros;
    }
    this.orders.set(id, order);
    return order;
  }

  cancel(orderId: string): boolean {
    const o = this.orders.get(orderId);
    if (!o || o.status !== "open") return false;
    o.status = "cancelled";
    return true;
  }

  /** Feed every observed trade. Returns fills generated (if any). */
  onTrade(trade: TradeEvent): PaperFill[] {
    const out: PaperFill[] = [];
    for (const o of this.orders.values()) {
      if (o.status !== "open") continue;
      if (o.tokenId !== trade.tokenId) continue;
      if (trade.side !== "sell") continue; // only sellers hit our bid
      if (trade.tsMs <= o.placedTsMs + this.graceMs) continue;
      if (trade.priceMicros > o.priceMicros) continue;
      let volume = trade.sizeMicros;
      // Deplete simulated queue ahead first.
      if (o.queueAheadMicros > 0) {
        const eaten = Math.min(o.queueAheadMicros, volume);
        o.queueAheadMicros -= eaten;
        volume -= eaten;
      }
      if (volume <= 0) continue;
      const fillSize = Math.min(volume, o.remainingMicros);
      o.remainingMicros -= fillSize;
      if (o.remainingMicros === 0) o.status = "filled";
      const fill: PaperFill = {
        orderId: o.id,
        marketId: o.marketId,
        tokenId: o.tokenId,
        priceMicros: o.priceMicros, // maker fills at our limit price
        sizeMicros: fillSize,
        tsMs: trade.tsMs,
      };
      this.fills.push(fill);
      out.push(fill);
      this.positions.set(o.tokenId, (this.positions.get(o.tokenId) ?? 0) + fillSize);
      this.costBasis.set(
        o.tokenId,
        (this.costBasis.get(o.tokenId) ?? 0) + notionalUsdMicros(o.priceMicros, fillSize),
      );
    }
    return out;
  }

  /**
   * Settle all positions in a market. winnerTokenId pays $1/share, the other $0.
   * Open orders in the market are cancelled. Returns realized PnL delta (usdMicros).
   */
  settle(resolution: MarketResolution, winnerTokenId: string, loserTokenId: string): number {
    for (const o of this.orders.values()) {
      if (o.marketId === resolution.marketId && o.status === "open") o.status = "cancelled";
    }
    let pnl = 0;
    for (const tokenId of [winnerTokenId, loserTokenId]) {
      const pos = this.positions.get(tokenId) ?? 0;
      if (pos === 0) continue;
      const payout = tokenId === winnerTokenId ? notionalUsdMicros(MICRO, pos) : 0;
      const basis = this.costBasis.get(tokenId) ?? 0;
      pnl += payout - basis;
      this.positions.delete(tokenId);
      this.costBasis.delete(tokenId);
    }
    this.realizedPnlUsdMicros += pnl;
    return pnl;
  }

  cancelAll(): number {
    let n = 0;
    for (const o of this.orders.values()) {
      if (o.status === "open") {
        o.status = "cancelled";
        n += 1;
      }
    }
    return n;
  }

  get realizedPnl(): number {
    return this.realizedPnlUsdMicros;
  }

  get openOrderCount(): number {
    let n = 0;
    for (const o of this.orders.values()) if (o.status === "open") n += 1;
    return n;
  }
}
