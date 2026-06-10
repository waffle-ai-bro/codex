import { describe, expect, it } from "vitest";
import {
  detectAsset,
  isShortDurationUpDown,
  normalizeLimitlessBook,
  normalizeLimitlessMarket,
  parseDeadlineMs,
} from "../src/connectors/limitless/client.js";

const CLOSE_ISO = "2026-06-10T00:05:00.000Z";
const CLOSE_MS = Date.parse(CLOSE_ISO);

const baseMarket = {
  slug: "btc-up-or-down-jun-10-0000",
  title: "BTC Up or Down? Jun 10, 00:00-00:05 UTC",
  deadline: CLOSE_ISO,
  createdAt: new Date(CLOSE_MS - 300_000).toISOString(),
  status: "FUNDED",
  tokens: { yes: "111", no: "222" },
  tradeType: "clob",
  minTickSize: "0.001",
};

describe("limitless market normalization", () => {
  it("normalizes a tokens-shaped CLOB market (YES=UP)", () => {
    const info = normalizeLimitlessMarket(baseMarket, 300);
    expect(info.venue).toBe("limitless");
    expect(info.id).toBe("limitless:btc-up-or-down-jun-10-0000");
    expect(info.asset).toBe("BTC");
    expect(info.upTokenId).toBe("111");
    expect(info.downTokenId).toBe("222");
    expect(info.closeTsMs).toBe(CLOSE_MS);
    expect(info.openTsMs).toBe(CLOSE_MS - 300_000);
    expect(info.tickSizeMicros).toBe(1_000);
  });

  it("supports clobTokenIds array shape", () => {
    const { tokens: _omit, ...rest } = baseMarket;
    const m = { ...rest, clobTokenIds: ["333", "444"] };
    const info = normalizeLimitlessMarket(m, 300);
    expect(info.upTokenId).toBe("333");
    expect(info.downTokenId).toBe("444");
  });

  it("rejects markets without token ids or deadline", () => {
    const { tokens: _omit, ...noTokens } = baseMarket;
    expect(() => normalizeLimitlessMarket(noTokens, 300)).toThrow(/token ids/);
    const { deadline: _omit2, ...noDeadline } = baseMarket;
    expect(() => normalizeLimitlessMarket(noDeadline, 300)).toThrow(/deadline/);
  });

  it("parses second and millisecond unix deadlines", () => {
    expect(parseDeadlineMs(1_780_704_300)).toBe(1_780_704_300_000);
    expect(parseDeadlineMs(1_780_704_300_000)).toBe(1_780_704_300_000);
    expect(parseDeadlineMs(CLOSE_ISO)).toBe(CLOSE_MS);
    expect(parseDeadlineMs("garbage")).toBeNull();
  });

  it("detects assets from titles", () => {
    expect(detectAsset("Will Bitcoin be up at 00:05 UTC?")).toBe("BTC");
    expect(detectAsset("ETH Up or Down?")).toBe("ETH");
    expect(detectAsset("Will it rain in NYC?")).toBeNull();
  });

  it("filters short-duration up/down markets by title and duration", () => {
    expect(isShortDurationUpDown(baseMarket, 300)).toBe(true);
    // wrong cadence: 1h market
    const hourly = {
      ...baseMarket,
      createdAt: new Date(CLOSE_MS - 3_600_000).toISOString(),
    };
    expect(isShortDurationUpDown(hourly, 300)).toBe(false);
    // non-crypto market
    expect(isShortDurationUpDown({ ...baseMarket, title: "Will it rain? Up or Down" }, 300)).toBe(false);
    // non-updown market
    expect(isShortDurationUpDown({ ...baseMarket, title: "BTC weekly close prediction" }, 300)).toBe(false);
  });
});

describe("limitless orderbook normalization", () => {
  it("handles numeric and string levels, scans for best", () => {
    const top = normalizeLimitlessBook(
      "111",
      {
        bids: [
          { price: 0.91, size: 100 },
          { price: "0.95", size: "40" },
        ],
        asks: [
          { price: "0.99", size: "5" },
          { price: 0.96, size: 20 },
        ],
      },
      1_750_000_000_500,
    );
    expect(top.bidMicros).toBe(950_000);
    expect(top.bidSizeMicros).toBe(40_000_000);
    expect(top.askMicros).toBe(960_000);
    expect(top.askSizeMicros).toBe(20_000_000);
    expect(top.tsMs).toBe(1_750_000_000_500);
  });
});
