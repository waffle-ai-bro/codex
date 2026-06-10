import { describe, expect, it } from "vitest";
import { choosePostOnlyBid } from "../src/strategies/post-only-bid.js";

const TICK = 1_000; // $0.001
const MAX = 950_000; // $0.95

describe("choosePostOnlyBid (spec B3)", () => {
  it("improves toward the ask but never crosses", () => {
    // bid 0.940, ask 0.955 -> desired = min(0.95, 0.954) = 0.95
    expect(choosePostOnlyBid(940_000, 955_000, TICK, MAX)).toBe(950_000);
  });

  it("rests one tick under the ask when ask is below cap", () => {
    // bid 0.930, ask 0.945 -> 0.944
    expect(choosePostOnlyBid(930_000, 945_000, TICK, MAX)).toBe(944_000);
  });

  it("joins best bid rather than resting behind it", () => {
    // bid 0.948, ask 0.960 -> desired 0.95 < ask, >= bid -> 0.95 (improves)
    expect(choosePostOnlyBid(948_000, 960_000, TICK, MAX)).toBe(950_000);
    // bid 0.950, ask 0.960 -> desired = min(0.95, 0.959)=0.95 == bid -> join
    expect(choosePostOnlyBid(950_000, 960_000, TICK, MAX)).toBe(950_000);
  });

  it("returns null when joining best bid would exceed the cap", () => {
    // bid 0.960 > cap 0.95: desired would be pushed to 0.96 > cap
    expect(choosePostOnlyBid(960_000, 970_000, TICK, MAX)).toBeNull();
  });

  it("returns null when it would cross or lock the book", () => {
    // one-tick spread at the cap: desired = ask - tick = bid -> join bid is ok
    expect(choosePostOnlyBid(949_000, 950_000, TICK, MAX)).toBe(949_000);
    // crossed/locked book input is invalid
    expect(choosePostOnlyBid(950_000, 950_000, TICK, MAX)).toBeNull();
    expect(choosePostOnlyBid(960_000, 950_000, TICK, MAX)).toBeNull();
  });

  it("never returns a price above maxEntry", () => {
    for (let bid = 900_000; bid <= 980_000; bid += TICK) {
      const ask = bid + 5_000;
      const out = choosePostOnlyBid(bid, ask, TICK, MAX);
      if (out !== null) {
        expect(out).toBeLessThanOrEqual(MAX);
        expect(out).toBeLessThan(ask);
      }
    }
  });
});
