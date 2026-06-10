import { describe, expect, it } from "vitest";
import { normalizeGammaMarket, upDownSlug, windowStartUnixSec } from "../src/connectors/polymarket/gamma.js";
import { normalizeBookTop } from "../src/connectors/polymarket/clob.js";

describe("gamma normalization", () => {
  const fixture = {
    id: "123",
    slug: "btc-updown-5m-1780821000",
    question: "BTC Up or Down?",
    endDate: "2026-06-10T00:05:00Z",
    clobTokenIds: JSON.stringify(["tok-up-1", "tok-down-1"]),
    outcomes: JSON.stringify(["Up", "Down"]),
    orderPriceMinTickSize: "0.001",
    negRisk: false,
    active: true,
  };

  it("normalizes a gamma market into MarketInfo", () => {
    const info = normalizeGammaMarket(fixture, "BTC", 300);
    expect(info.upTokenId).toBe("tok-up-1");
    expect(info.downTokenId).toBe("tok-down-1");
    expect(info.tickSizeMicros).toBe(1_000);
    expect(info.closeTsMs).toBe(Date.parse("2026-06-10T00:05:00Z"));
    expect(info.openTsMs).toBe(info.closeTsMs - 300_000);
    expect(info.id).toBe("polymarket:btc-updown-5m-1780821000");
  });

  it("maps tokens by outcome label, not position", () => {
    // If outcomes arrive as ["Down","Up"], the second token is the Up token.
    const flipped = {
      ...fixture,
      outcomes: JSON.stringify(["Down", "Up"]),
      clobTokenIds: JSON.stringify(["tok-A", "tok-B"]),
    };
    const info = normalizeGammaMarket(flipped, "BTC", 300);
    expect(info.upTokenId).toBe("tok-B");
    expect(info.downTokenId).toBe("tok-A");
  });

  it("rejects markets with unrecognizable outcomes", () => {
    const bad = { ...fixture, outcomes: JSON.stringify(["Foo", "Bar"]) };
    expect(() => normalizeGammaMarket(bad, "BTC", 300)).toThrow();
  });

  it("rejects markets without two tokens", () => {
    const bad = { ...fixture, clobTokenIds: JSON.stringify(["only-one"]) };
    expect(() => normalizeGammaMarket(bad, "BTC", 300)).toThrow();
  });

  it("builds slugs and window starts", () => {
    expect(upDownSlug("BTC", 300, 1780821000)).toBe("btc-updown-5m-1780821000");
    expect(upDownSlug("ETH", 900, 1780821000)).toBe("eth-updown-15m-1780821000");
    // 2026-06-10T00:03:20Z = 1780704200 -> floor to 300s = 1780704000
    expect(windowStartUnixSec(300, 1_780_704_200_000)).toBe(1_780_704_000);
    expect(windowStartUnixSec(300, 1_780_704_200_000, 1)).toBe(1_780_704_300);
  });
});

describe("clob book normalization", () => {
  it("finds best bid/ask by scanning all levels", () => {
    const top = normalizeBookTop(
      "tok",
      {
        bids: [
          { price: "0.90", size: "100" },
          { price: "0.95", size: "40" },
          { price: "0.92", size: "10" },
        ],
        asks: [
          { price: "0.99", size: "5" },
          { price: "0.96", size: "20" },
        ],
      },
      1_750_000_000_123,
    );
    expect(top.bidMicros).toBe(950_000);
    expect(top.bidSizeMicros).toBe(40_000_000);
    expect(top.askMicros).toBe(960_000);
    expect(top.askSizeMicros).toBe(20_000_000);
    expect(top.tsMs).toBe(1_750_000_000_123);
  });
});
