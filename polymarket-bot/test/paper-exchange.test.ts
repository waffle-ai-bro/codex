import { describe, expect, it } from "vitest";
import { MICRO } from "../src/core/fixed.js";
import { PaperExchange } from "../src/execution/paper-exchange.js";
import type { BookTop, TradeEvent } from "../src/core/types.js";

const TOKEN = "tok-up";
const OTHER = "tok-down";
const MARKET = "m1";

function book(bid: number, ask: number, bidSize = 100 * MICRO): BookTop {
  return { tokenId: TOKEN, bidMicros: bid, askMicros: ask, bidSizeMicros: bidSize, askSizeMicros: 100 * MICRO, tsMs: 1_000 };
}

function sell(price: number, size: number, tsMs: number): TradeEvent {
  return { tokenId: TOKEN, priceMicros: price, sizeMicros: size, side: "sell", tsMs };
}

describe("PaperExchange conservative fill model", () => {
  it("rejects post-only orders that would cross", () => {
    const ex = new PaperExchange();
    ex.onBook(book(940_000, 950_000));
    const o = ex.placePostOnlyBuy({ marketId: MARKET, tokenId: TOKEN, priceMicros: 950_000, sizeMicros: MICRO, tsMs: 2_000 });
    expect(o.status).toBe("rejected");
  });

  it("never fills without an observed sell trade at or below our bid", () => {
    const ex = new PaperExchange();
    ex.onBook(book(940_000, 960_000, 0));
    const o = ex.placePostOnlyBuy({ marketId: MARKET, tokenId: TOKEN, priceMicros: 950_000, sizeMicros: 10 * MICRO, tsMs: 2_000 });
    expect(o.status).toBe("open");
    // a BUY print at our price does not fill us
    ex.onTrade({ tokenId: TOKEN, priceMicros: 950_000, sizeMicros: 50 * MICRO, side: "buy", tsMs: 5_000 });
    // a SELL print above our bid does not fill us
    ex.onTrade(sell(955_000, 50 * MICRO, 5_100));
    // a SELL on another token does not fill us
    ex.onTrade({ tokenId: OTHER, priceMicros: 940_000, sizeMicros: 50 * MICRO, side: "sell", tsMs: 5_200 });
    expect(ex.fills.length).toBe(0);
    expect(o.status).toBe("open");
  });

  it("respects the latency grace window after placement", () => {
    const ex = new PaperExchange(250);
    ex.onBook(book(940_000, 960_000, 0));
    ex.placePostOnlyBuy({ marketId: MARKET, tokenId: TOKEN, priceMicros: 950_000, sizeMicros: 10 * MICRO, tsMs: 2_000 });
    ex.onTrade(sell(945_000, 50 * MICRO, 2_100)); // inside grace -> no fill
    expect(ex.fills.length).toBe(0);
    ex.onTrade(sell(945_000, 50 * MICRO, 2_400)); // after grace -> fill
    expect(ex.fills.length).toBe(1);
  });

  it("queue ahead must be depleted before we fill when joining the bid", () => {
    const ex = new PaperExchange(0);
    ex.onBook(book(950_000, 960_000, 80 * MICRO)); // 80 shares ahead at best bid
    const o = ex.placePostOnlyBuy({ marketId: MARKET, tokenId: TOKEN, priceMicros: 950_000, sizeMicros: 10 * MICRO, tsMs: 2_000 });
    expect(o.queueAheadMicros).toBe(80 * MICRO);
    ex.onTrade(sell(950_000, 50 * MICRO, 3_000)); // eats queue only
    expect(ex.fills.length).toBe(0);
    ex.onTrade(sell(950_000, 50 * MICRO, 3_100)); // 30 more queue, then 10 to us, partial leftover
    expect(ex.fills.length).toBe(1);
    expect(ex.fills[0]!.sizeMicros).toBe(10 * MICRO);
    expect(o.status).toBe("filled");
  });

  it("price-improving bid has no queue ahead", () => {
    const ex = new PaperExchange(0);
    ex.onBook(book(940_000, 960_000, 500 * MICRO));
    const o = ex.placePostOnlyBuy({ marketId: MARKET, tokenId: TOKEN, priceMicros: 950_000, sizeMicros: 10 * MICRO, tsMs: 2_000 });
    expect(o.queueAheadMicros).toBe(0);
  });

  it("settles winners at $1 and losers at $0", () => {
    const ex = new PaperExchange(0);
    ex.onBook(book(940_000, 960_000, 0));
    ex.placePostOnlyBuy({ marketId: MARKET, tokenId: TOKEN, priceMicros: 950_000, sizeMicros: 10 * MICRO, tsMs: 2_000 });
    ex.onTrade(sell(950_000, 10 * MICRO, 3_000));
    expect(ex.fills.length).toBe(1);

    // win: 10 shares pay $10, cost $9.50 -> +$0.50
    const pnlWin = ex.settle(
      { marketId: MARKET, winner: "UP", settleValueMicros: 0, tsMs: 9_000 },
      TOKEN,
      OTHER,
    );
    expect(pnlWin).toBe(500_000);
    expect(ex.realizedPnl).toBe(500_000);
  });

  it("book-cross mode fills when the ask quotes through our bid", () => {
    const ex = new PaperExchange(0, true);
    ex.onBook(book(940_000, 960_000, 0));
    const o = ex.placePostOnlyBuy({ marketId: MARKET, tokenId: TOKEN, priceMicros: 950_000, sizeMicros: 10 * MICRO, tsMs: 2_000 });
    expect(o.status).toBe("open");
    // ask above our bid: no fill
    ex.onBook({ ...book(930_000, 955_000, 0), tsMs: 3_000 });
    expect(ex.fills.length).toBe(0);
    // ask drops through our level: fill at OUR price
    ex.onBook({ ...book(930_000, 945_000, 0), tsMs: 4_000 });
    expect(ex.fills.length).toBe(1);
    expect(ex.fills[0]!.priceMicros).toBe(950_000);
  });

  it("book-cross mode respects queue ahead and grace window", () => {
    const ex = new PaperExchange(250, true);
    ex.onBook(book(950_000, 960_000, 80 * MICRO)); // joining: 80 ahead
    ex.placePostOnlyBuy({ marketId: MARKET, tokenId: TOKEN, priceMicros: 950_000, sizeMicros: 10 * MICRO, tsMs: 2_000 });
    // inside grace: ignored
    ex.onBook({ tokenId: TOKEN, bidMicros: 940_000, askMicros: 945_000, bidSizeMicros: 0, askSizeMicros: 50 * MICRO, tsMs: 2_100 });
    expect(ex.fills.length).toBe(0);
    // after grace: 50 offered eats queue only (80 ahead)
    ex.onBook({ tokenId: TOKEN, bidMicros: 940_000, askMicros: 945_000, bidSizeMicros: 0, askSizeMicros: 50 * MICRO, tsMs: 3_000 });
    expect(ex.fills.length).toBe(0);
    // next crossing update: 30 left of queue, then we fill
    ex.onBook({ tokenId: TOKEN, bidMicros: 940_000, askMicros: 945_000, bidSizeMicros: 0, askSizeMicros: 50 * MICRO, tsMs: 3_500 });
    expect(ex.fills.length).toBe(1);
    expect(ex.fills[0]!.sizeMicros).toBe(10 * MICRO);
  });

  it("book-cross mode is off by default", () => {
    const ex = new PaperExchange(0);
    ex.onBook(book(940_000, 960_000, 0));
    ex.placePostOnlyBuy({ marketId: MARKET, tokenId: TOKEN, priceMicros: 950_000, sizeMicros: 10 * MICRO, tsMs: 2_000 });
    expect(ex.onBook({ ...book(930_000, 940_000, 0), tsMs: 3_000 })).toEqual([]);
    expect(ex.fills.length).toBe(0);
  });

  it("loss settles to -cost and open orders are cancelled at resolution", () => {
    const ex = new PaperExchange(0);
    ex.onBook(book(940_000, 960_000, 0));
    ex.placePostOnlyBuy({ marketId: MARKET, tokenId: TOKEN, priceMicros: 950_000, sizeMicros: 10 * MICRO, tsMs: 2_000 });
    ex.onTrade(sell(950_000, 10 * MICRO, 3_000));
    const second = ex.placePostOnlyBuy({ marketId: MARKET, tokenId: TOKEN, priceMicros: 940_000, sizeMicros: 5 * MICRO, tsMs: 4_000 });
    const pnl = ex.settle({ marketId: MARKET, winner: "DOWN", settleValueMicros: 0, tsMs: 9_000 }, OTHER, TOKEN);
    expect(pnl).toBe(-9_500_000); // lost the full $9.50
    expect(second.status).toBe("cancelled");
  });
});
