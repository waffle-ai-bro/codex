import { describe, expect, it } from "vitest";
import { loadRiskLimits } from "../src/core/config.js";
import { MICRO } from "../src/core/fixed.js";
import { RiskEngine } from "../src/risk/risk-engine.js";

function makeEngine(now: () => number = () => 0) {
  return new RiskEngine(
    loadRiskLimits({
      maxUsdPerOrderMicros: "5.00",
      maxUsdPerMarketMicros: "5.00",
      maxOpenOrders: 2,
      maxDailyLossUsdMicros: "25.00",
      maxOrdersPerMinute: 3,
    }),
    now,
  );
}

describe("RiskEngine", () => {
  it("passes a small order", () => {
    const r = makeEngine();
    // 5 shares at $0.95 = $4.75 <= $5
    expect(r.check("m1", 950_000, 5 * MICRO)).toEqual([]);
  });

  it("rejects order notional over limit", () => {
    const r = makeEngine();
    // 10 shares at $0.95 = $9.50 > $5
    expect(r.check("m1", 950_000, 10 * MICRO)).toContain("order notional over limit");
  });

  it("rejects when market exposure would exceed the cap", () => {
    const r = makeEngine();
    r.onFill("m1", 950_000, 5 * MICRO); // $4.75 already in m1
    expect(r.check("m1", 950_000, 2 * MICRO)).toContain("market exposure over limit");
    expect(r.check("m2", 950_000, 2 * MICRO)).toEqual([]); // other market fine
  });

  it("rejects when too many orders are open", () => {
    const r = makeEngine();
    r.onOrderPlaced();
    r.onOrderPlaced();
    expect(r.check("m1", 950_000, MICRO)).toContain("too many open orders");
    r.onOrderClosed();
    expect(r.check("m1", 950_000, MICRO)).toEqual([]);
  });

  it("trips the kill switch at the daily loss limit and requires manual reset", () => {
    const r = makeEngine();
    r.onRealizedPnl(-26 * MICRO);
    expect(r.tripped).toBe(true);
    const violations = r.check("m1", 950_000, MICRO);
    expect(violations.some((v) => v.includes("kill switch"))).toBe(true);
    expect(violations).toContain("daily loss limit reached");
    r.resetKillSwitch();
    // still over the daily loss, so still rejected even after unlock
    expect(r.check("m1", 950_000, MICRO)).toContain("daily loss limit reached");
  });

  it("enforces order rate limit per minute", () => {
    let now = 0;
    const r = makeEngine(() => now);
    for (let i = 0; i < 3; i++) {
      now += 1_000;
      r.onOrderPlaced();
      r.onOrderClosed();
    }
    expect(r.check("m1", 950_000, MICRO)).toContain("order rate limit");
    now += 61_000; // window rolls off
    expect(r.check("m1", 950_000, MICRO)).toEqual([]);
  });

  it("manual kill switch blocks everything", () => {
    const r = makeEngine();
    r.trip("operator");
    expect(r.check("m1", 950_000, MICRO).some((v) => v.includes("kill switch"))).toBe(true);
  });
});
