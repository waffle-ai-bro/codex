import { describe, expect, it } from "vitest";
import { loadRiskLimits, loadSnipeConfig } from "../src/core/config.js";
import { DEFAULT_SIM_PARAMS, eventTs, generateMarket } from "../src/sim/market-sim.js";
import { buildReport } from "../src/sim/report.js";
import { runMarkets } from "../src/sim/runner.js";

describe("synthetic market generator", () => {
  it("is deterministic for a given seed", () => {
    const a = generateMarket({ ...DEFAULT_SIM_PARAMS, seed: 7 }, 3);
    const b = generateMarket({ ...DEFAULT_SIM_PARAMS, seed: 7 }, 3);
    expect(a.winner).toBe(b.winner);
    expect(a.settleValueMicros).toBe(b.settleValueMicros);
    expect(a.events.length).toBe(b.events.length);
    const c = generateMarket({ ...DEFAULT_SIM_PARAMS, seed: 8 }, 3);
    expect(
      a.settleValueMicros !== c.settleValueMicros || a.events.length !== c.events.length,
    ).toBe(true);
  });

  it("emits chronologically ordered events with sane books", () => {
    const m = generateMarket({ ...DEFAULT_SIM_PARAMS, seed: 11 }, 0);
    let prev = -Infinity;
    for (const ev of m.events) {
      const ts = eventTs(ev);
      expect(ts).toBeGreaterThanOrEqual(prev);
      prev = ts;
      if (ev.type === "book") {
        expect(ev.top.bidMicros).toBeGreaterThan(0);
        expect(ev.top.askMicros).toBeGreaterThan(ev.top.bidMicros);
        expect(ev.top.askMicros).toBeLessThanOrEqual(1_000_000);
      }
    }
  });

  it("winner matches settle vs strike", () => {
    for (let i = 0; i < 20; i++) {
      const m = generateMarket({ ...DEFAULT_SIM_PARAMS, seed: 123 }, i);
      expect(m.winner).toBe(m.settleValueMicros > m.info.strikeMicros ? "UP" : "DOWN");
    }
  });
});

describe("end-to-end paper pipeline smoke", () => {
  it("runs the full strategy/risk/exchange loop and produces a coherent report", () => {
    const markets = Array.from({ length: 120 }, (_, i) =>
      generateMarket({ ...DEFAULT_SIM_PARAMS, seed: 42 }, i),
    );
    const cfg = loadSnipeConfig();
    const limits = loadRiskLimits({ maxDailyLossUsdMicros: "100000.00" });
    const out = runMarkets(markets, cfg, limits);
    expect(out.results).toHaveLength(120);

    const report = buildReport(out.results);
    expect(report.fills).toBeLessThanOrEqual(report.ordersPlaced);
    expect(report.ordersPlaced).toBeGreaterThan(0); // strategy does engage
    // every fill respects the entry cap
    for (const r of out.results) {
      if (r.filled) {
        expect(r.entryPriceMicros!).toBeLessThanOrEqual(cfg.maxEntryPriceMicros);
      }
    }
    // PnL accounting consistency
    const sum = out.results.reduce((a, r) => a + r.pnlUsdMicros, 0);
    expect(sum).toBe(out.totalPnlUsdMicros);
  });

  it("is reproducible end to end with the same seed", () => {
    const make = () =>
      runMarkets(
        Array.from({ length: 40 }, (_, i) => generateMarket({ ...DEFAULT_SIM_PARAMS, seed: 9 }, i)),
        loadSnipeConfig(),
        loadRiskLimits({ maxDailyLossUsdMicros: "100000.00" }),
      );
    const a = make();
    const b = make();
    expect(a.totalPnlUsdMicros).toBe(b.totalPnlUsdMicros);
    expect(a.results.filter((r) => r.filled).length).toBe(b.results.filter((r) => r.filled).length);
  });
});
