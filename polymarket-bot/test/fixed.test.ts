import { describe, expect, it } from "vitest";
import {
  MICRO,
  ceilToTick,
  floorToTick,
  formatMicros,
  gapBps,
  midMicros,
  mulDiv,
  notionalUsdMicros,
  parseMicros,
} from "../src/core/fixed.js";

describe("fixed-point math", () => {
  it("parses decimal strings exactly", () => {
    expect(parseMicros("0.95")).toBe(950_000);
    expect(parseMicros("1")).toBe(1_000_000);
    expect(parseMicros("0.001")).toBe(1_000);
    expect(parseMicros("104999.123456")).toBe(104_999_123_456);
    expect(parseMicros("-0.5")).toBe(-500_000);
    expect(() => parseMicros("abc")).toThrow();
    expect(() => parseMicros("1e5")).toThrow();
  });

  it("round-trips format/parse", () => {
    expect(formatMicros(950_000)).toBe("0.95");
    expect(formatMicros(1_000_000)).toBe("1.00");
    expect(formatMicros(-50_000)).toBe("-0.05");
    expect(parseMicros(formatMicros(123_456))).toBe(123_456);
  });

  it("mulDiv handles values past 2^53 via BigInt", () => {
    const big = 90_000_000_000_000; // 9e13
    expect(mulDiv(big, 1_000_000, 1_000_000)).toBe(big);
    expect(mulDiv(7, 3, 2)).toBe(10); // floor(21/2)
  });

  it("computes notional", () => {
    // 100 shares at $0.95 = $95
    expect(notionalUsdMicros(950_000, 100 * MICRO)).toBe(95 * MICRO);
  });

  it("tick rounding", () => {
    expect(floorToTick(954_999, 1_000)).toBe(954_000);
    expect(ceilToTick(954_001, 1_000)).toBe(955_000);
    expect(floorToTick(950_000, 10_000)).toBe(950_000);
  });

  it("gap in bps", () => {
    // 100_000 -> 100_100 is +10 bps
    expect(gapBps(100_100 * MICRO, 100_000 * MICRO)).toBe(10);
    expect(gapBps(99_900 * MICRO, 100_000 * MICRO)).toBe(-10);
    expect(gapBps(100_000 * MICRO, 100_000 * MICRO)).toBe(0);
  });

  it("midpoint", () => {
    expect(midMicros(940_000, 960_000)).toBe(950_000);
  });
});
