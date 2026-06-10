import { describe, expect, it } from "vitest";
import { loadSnipeConfig } from "../src/core/config.js";
import { MICRO } from "../src/core/fixed.js";
import type { BookTop, MarketInfo, OracleTick } from "../src/core/types.js";
import { ResolutionMakerSnipe, type RiskGate } from "../src/strategies/resolution-maker-snipe.js";

const CLOSE = 10_000_000;
const MARKET: MarketInfo = {
  id: "sim:test",
  venue: "sim",
  slug: "btc-updown-5m-test",
  asset: "BTC",
  cadenceSec: 300,
  strikeMicros: 100_000 * MICRO, // $100k strike
  openTsMs: CLOSE - 300_000,
  closeTsMs: CLOSE,
  upTokenId: "UPTOK",
  downTokenId: "DOWNTOK",
  tickSizeMicros: 1_000,
  negRisk: false,
};

const passGate: RiskGate = { check: () => [] };
const failGate: RiskGate = { check: () => ["blocked"] };

/** now = 30s before close (inside the 60s..4s window). */
const NOW = CLOSE - 30_000;

function makeStrategy(gate: RiskGate = passGate, cfgOverrides: Record<string, unknown> = {}) {
  const cfg = loadSnipeConfig(cfgOverrides);
  const s = new ResolutionMakerSnipe(cfg, gate);
  s.trackMarket(MARKET);
  return s;
}

/** Feed a calm oracle history ending at `endTs` with final value `usd`. */
function feedOracle(s: ResolutionMakerSnipe, usd: number, endTs: number, n = 8): void {
  for (let i = n - 1; i >= 0; i--) {
    const tick: OracleTick = {
      source: "test",
      symbol: "BTCUSD",
      valueMicros: Math.round(usd * MICRO),
      tsMs: endTs - i * 500,
    };
    s.onOracle(MARKET.id, tick);
  }
}

function upBook(bid: number, ask: number, tsMs: number, bidSize = 100 * MICRO): BookTop {
  return { tokenId: "UPTOK", bidMicros: bid, askMicros: ask, bidSizeMicros: bidSize, askSizeMicros: 100 * MICRO, tsMs };
}

function lockedUpSetup(s: ResolutionMakerSnipe, nowMs = NOW): void {
  feedOracle(s, 100_150, nowMs); // +15bps above strike, calm
  s.onBook(MARKET.id, upBook(945_000, 955_000, nowMs));
}

describe("ResolutionMakerSnipe entry", () => {
  it("places a post-only bid when every condition is met", () => {
    const s = makeStrategy();
    lockedUpSetup(s);
    const actions = s.evaluate(MARKET.id, NOW);
    expect(actions).toHaveLength(1);
    const a = actions[0]!;
    expect(a.kind).toBe("place");
    if (a.kind === "place") {
      expect(a.tokenId).toBe("UPTOK");
      expect(a.priceMicros).toBe(950_000); // min(cap, ask-tick) -> capped at 0.95
      expect(a.priceMicros).toBeLessThan(955_000);
    }
  });

  it("does nothing before the trade window opens", () => {
    const s = makeStrategy();
    const early = CLOSE - 120_000; // 2 min out, window starts at 60s
    feedOracle(s, 100_150, early);
    s.onBook(MARKET.id, upBook(945_000, 955_000, early));
    expect(s.evaluate(MARKET.id, early)).toHaveLength(0);
  });

  it("does not enter after the trade window end", () => {
    const s = makeStrategy();
    const late = CLOSE - 2_000; // windowEnd is 4s
    lockedUpSetup(s, late);
    expect(s.evaluate(MARKET.id, late)).toHaveLength(0);
  });

  it("skips when the oracle gap is too small", () => {
    const s = makeStrategy();
    feedOracle(s, 100_030, NOW); // +3bps < 8bps min
    s.onBook(MARKET.id, upBook(945_000, 955_000, NOW));
    expect(s.evaluate(MARKET.id, NOW)).toHaveLength(0);
  });

  it("skips when the oracle is stale", () => {
    const s = makeStrategy();
    feedOracle(s, 100_150, NOW - 10_000); // last tick 10s old, staleMs=2000
    s.onBook(MARKET.id, upBook(945_000, 955_000, NOW));
    expect(s.evaluate(MARKET.id, NOW)).toHaveLength(0);
  });

  it("skips when the locked side is not priced as locked", () => {
    const s = makeStrategy();
    feedOracle(s, 100_150, NOW);
    s.onBook(MARKET.id, upBook(880_000, 890_000, NOW)); // mid 0.885 < 0.95
    expect(s.evaluate(MARKET.id, NOW)).toHaveLength(0);
  });

  it("skips when spread is broken", () => {
    const s = makeStrategy();
    feedOracle(s, 100_150, NOW);
    s.onBook(MARKET.id, upBook(900_000, 990_000, NOW)); // 9c spread > 3c max
    expect(s.evaluate(MARKET.id, NOW)).toHaveLength(0);
  });

  it("respects the risk gate", () => {
    const s = makeStrategy(failGate);
    lockedUpSetup(s);
    expect(s.evaluate(MARKET.id, NOW)).toHaveLength(0);
  });

  it("does not re-enter after reaching max fills per market", () => {
    const s = makeStrategy();
    lockedUpSetup(s);
    const [first] = s.evaluate(MARKET.id, NOW);
    expect(first?.kind).toBe("place");
    s.onOrderAccepted({ id: "o1", tokenId: "UPTOK", priceMicros: 950_000, sizeMicros: MICRO }, MARKET.id, "UP");
    s.onFill({ orderId: "o1", marketId: MARKET.id, tokenId: "UPTOK", priceMicros: 950_000, sizeMicros: MICRO, tsMs: NOW + 100 });
    expect(s.evaluate(MARKET.id, NOW + 200)).toHaveLength(0);
  });

  it("stands down during cooldown after a loss", () => {
    const s = makeStrategy(passGate, { cooldownMarketsAfterLoss: 2 });
    s.onResolution("sim:other", false); // a loss elsewhere
    expect(s.inCooldown).toBe(true);
    lockedUpSetup(s);
    expect(s.evaluate(MARKET.id, NOW)).toHaveLength(0);
    s.onResolution("sim:other2", null);
    s.onResolution("sim:other3", null);
    expect(s.inCooldown).toBe(false);
  });
});

describe("ResolutionMakerSnipe stand-down guards", () => {
  function placedStrategy(): ResolutionMakerSnipe {
    const s = makeStrategy();
    lockedUpSetup(s);
    const [a] = s.evaluate(MARKET.id, NOW);
    expect(a?.kind).toBe("place");
    s.onOrderAccepted({ id: "o1", tokenId: "UPTOK", priceMicros: 950_000, sizeMicros: MICRO }, MARKET.id, "UP");
    return s;
  }

  it("cancels when the locked side flips", () => {
    const s = placedStrategy();
    feedOracle(s, 99_900, NOW + 1_000); // now below strike
    const actions = s.evaluate(MARKET.id, NOW + 1_000);
    expect(actions[0]).toMatchObject({ kind: "cancel", orderId: "o1" });
  });

  it("cancels when the oracle gap collapses", () => {
    const s = placedStrategy();
    feedOracle(s, 100_020, NOW + 1_000); // +2bps < cancelIfOracleGapBelowBps=4
    const actions = s.evaluate(MARKET.id, NOW + 1_000);
    expect(actions[0]).toMatchObject({ kind: "cancel" });
  });

  it("cancels when the locked price fades", () => {
    const s = placedStrategy();
    feedOracle(s, 100_150, NOW + 1_000);
    s.onBook(MARKET.id, upBook(900_000, 920_000, NOW + 1_000)); // mid 0.91 < 0.94
    const actions = s.evaluate(MARKET.id, NOW + 1_000);
    expect(actions[0]).toMatchObject({ kind: "cancel" });
  });

  it("cancels when the oracle goes stale", () => {
    const s = placedStrategy();
    const actions = s.evaluate(MARKET.id, NOW + 5_000); // last oracle tick is now 5s old
    expect(actions[0]).toMatchObject({ kind: "cancel" });
  });

  it("cancels inside the cancel-before-resolution window", () => {
    const s = placedStrategy();
    feedOracle(s, 100_150, CLOSE - 2_500);
    s.onBook(MARKET.id, upBook(945_000, 955_000, CLOSE - 2_500));
    const actions = s.evaluate(MARKET.id, CLOSE - 2_500); // cancelBeforeResolutionMs=3000
    expect(actions[0]).toMatchObject({ kind: "cancel" });
  });

  it("leaves a healthy order resting", () => {
    const s = placedStrategy();
    feedOracle(s, 100_150, NOW + 1_000);
    s.onBook(MARKET.id, upBook(945_000, 955_000, NOW + 1_000));
    expect(s.evaluate(MARKET.id, NOW + 1_000)).toHaveLength(0);
  });
});
