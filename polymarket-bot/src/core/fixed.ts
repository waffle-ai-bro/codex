/**
 * Fixed-point math. No floats cross module boundaries for money/price values.
 *
 * Units:
 *   priceMicros : 1_000_000 == $1.00 (share price / probability)
 *   sizeMicros  : 1_000_000 == 1 share
 *   usdMicros   : 1_000_000 == $1.00
 *   bps         : 10_000 == 100%
 */

export const MICRO = 1_000_000;
export const PRICE_ONE = MICRO; // $1.00 in priceMicros

export function assertInt(n: number, label = "value"): number {
  if (!Number.isSafeInteger(n)) {
    throw new Error(`${label} must be a safe integer, got ${n}`);
  }
  return n;
}

/** Parse a decimal string like "0.95" into micros (exact, no float). */
export function parseMicros(s: string): number {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new Error(`cannot parse decimal: ${JSON.stringify(s)}`);
  const sign = m[1] === "-" ? -1 : 1;
  const whole = m[2]!;
  const frac = (m[3] ?? "").slice(0, 6).padEnd(6, "0");
  const value = Number(whole) * MICRO + Number(frac);
  return assertInt(sign * value, "parsed micros");
}

/** Format micros back to a decimal string (trim trailing zeros, keep >=2 dp). */
export function formatMicros(micros: number, minDp = 2): string {
  assertInt(micros, "micros");
  const sign = micros < 0 ? "-" : "";
  const abs = Math.abs(micros);
  const whole = Math.floor(abs / MICRO);
  let frac = String(abs % MICRO).padStart(6, "0");
  while (frac.length > minDp && frac.endsWith("0")) frac = frac.slice(0, -1);
  return `${sign}${whole}.${frac}`;
}

/** floor(a * b / c) on integers, guarding intermediate overflow via BigInt when needed. */
export function mulDiv(a: number, b: number, c: number): number {
  assertInt(a);
  assertInt(b);
  assertInt(c);
  if (c === 0) throw new Error("mulDiv: divide by zero");
  const product = a * b;
  if (Number.isSafeInteger(product)) {
    return Math.floor(product / c);
  }
  return Number((BigInt(a) * BigInt(b)) / BigInt(c));
}

/** Notional usdMicros for a fill: price * size. */
export function notionalUsdMicros(priceMicros: number, sizeMicros: number): number {
  return mulDiv(priceMicros, sizeMicros, MICRO);
}

/** Round price down to tick (bids round down so we never bid above intent). */
export function floorToTick(priceMicros: number, tickMicros: number): number {
  assertInt(priceMicros);
  assertInt(tickMicros);
  if (tickMicros <= 0) throw new Error("tick must be > 0");
  return Math.floor(priceMicros / tickMicros) * tickMicros;
}

export function ceilToTick(priceMicros: number, tickMicros: number): number {
  assertInt(priceMicros);
  assertInt(tickMicros);
  if (tickMicros <= 0) throw new Error("tick must be > 0");
  return Math.ceil(priceMicros / tickMicros) * tickMicros;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Relative gap between an oracle value and a strike, in basis points.
 * Positive when value > strike. Uses integer math: bps = (v - k) * 10_000 / k.
 */
export function gapBps(valueMicros: number, strikeMicros: number): number {
  assertInt(valueMicros);
  assertInt(strikeMicros);
  if (strikeMicros <= 0) throw new Error("strike must be > 0");
  return Number((BigInt(valueMicros - strikeMicros) * 10_000n) / BigInt(strikeMicros));
}

/** Midpoint of two prices in micros, floored. */
export function midMicros(bidMicros: number, askMicros: number): number {
  return Math.floor((assertInt(bidMicros) + assertInt(askMicros)) / 2);
}
