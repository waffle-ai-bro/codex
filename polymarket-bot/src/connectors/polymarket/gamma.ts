import { z } from "zod";
import { MICRO, parseMicros } from "../../core/fixed.js";
import type { Asset, MarketInfo } from "../../core/types.js";

/**
 * Polymarket Gamma API discovery for short-duration crypto Up/Down markets.
 * Public, no auth. https://docs.polymarket.com/api-reference/introduction
 *
 * Short-duration markets use predictable slugs, e.g. `btc-updown-15m-1780821000`
 * where the suffix is the unix start time of the window.
 */

const GAMMA_BASE = process.env["POLYMARKET_GAMMA_BASE"] ?? "https://gamma-api.polymarket.com";

const GammaMarketSchema = z
  .object({
    id: z.string(),
    slug: z.string(),
    question: z.string().optional(),
    startDate: z.string().optional(),
    endDate: z.string(),
    clobTokenIds: z.string(), // JSON-encoded array: [upTokenId, downTokenId]
    outcomes: z.string().optional(), // JSON-encoded array of labels
    orderPriceMinTickSize: z.union([z.string(), z.number()]).optional(),
    negRisk: z.boolean().optional(),
    closed: z.boolean().optional(),
    active: z.boolean().optional(),
  })
  .passthrough();

export type GammaMarket = z.infer<typeof GammaMarketSchema>;

export function upDownSlug(asset: Asset, cadenceSec: 300 | 900, windowStartUnixSec: number): string {
  const cadence = cadenceSec === 300 ? "5m" : "15m";
  return `${asset.toLowerCase()}-updown-${cadence}-${windowStartUnixSec}`;
}

/** Unix start of the current (or +offset) cadence window. */
export function windowStartUnixSec(cadenceSec: 300 | 900, nowMs = Date.now(), offsetWindows = 0): number {
  const nowSec = Math.floor(nowMs / 1000);
  return Math.floor(nowSec / cadenceSec) * cadenceSec + offsetWindows * cadenceSec;
}

export async function fetchMarketBySlug(slug: string): Promise<GammaMarket | null> {
  const res = await fetch(`${GAMMA_BASE}/markets?slug=${encodeURIComponent(slug)}`);
  if (!res.ok) throw new Error(`gamma ${res.status} for slug ${slug}`);
  const body = (await res.json()) as unknown;
  const arr = z.array(GammaMarketSchema).parse(body);
  return arr[0] ?? null;
}

/**
 * Normalize a Gamma market into MarketInfo.
 * `strikeMicros` is unknown until the window opens (the "price to beat" comes
 * from the resolution oracle at open); callers set it from the oracle feed.
 */
export function normalizeGammaMarket(
  m: GammaMarket,
  asset: Asset,
  cadenceSec: 300 | 900,
  strikeMicros = 0,
): MarketInfo {
  const tokenIds = z.array(z.string()).parse(JSON.parse(m.clobTokenIds));
  if (tokenIds.length !== 2) throw new Error(`expected 2 clob token ids, got ${tokenIds.length}`);
  const outcomes = m.outcomes ? z.array(z.string()).parse(JSON.parse(m.outcomes)) : ["Up", "Down"];
  // Map token order to outcomes; "Up"/"Yes" first by convention, but verify.
  const upIdx = outcomes.findIndex((o) => /^(up|yes)$/i.test(o));
  const downIdx = upIdx === 0 ? 1 : 0;
  if (upIdx === -1) throw new Error(`cannot identify Up outcome in ${JSON.stringify(outcomes)}`);

  const endMs = Date.parse(m.endDate);
  const tickRaw = m.orderPriceMinTickSize;
  const tickMicros =
    tickRaw === undefined
      ? Math.round(0.01 * MICRO)
      : typeof tickRaw === "number"
        ? Math.round(tickRaw * MICRO)
        : parseMicros(tickRaw);

  return {
    id: `polymarket:${m.slug}`,
    venue: "polymarket",
    slug: m.slug,
    asset,
    cadenceSec,
    strikeMicros,
    openTsMs: endMs - cadenceSec * 1000,
    closeTsMs: endMs,
    upTokenId: tokenIds[upIdx]!,
    downTokenId: tokenIds[downIdx]!,
    tickSizeMicros: tickMicros,
    negRisk: m.negRisk ?? false,
  };
}

/** Discover the current and next Up/Down market for an asset/cadence. */
export async function discoverUpDownMarkets(
  asset: Asset,
  cadenceSec: 300 | 900,
  nowMs = Date.now(),
): Promise<Array<{ gamma: GammaMarket; info: MarketInfo }>> {
  const out: Array<{ gamma: GammaMarket; info: MarketInfo }> = [];
  for (const offset of [0, 1]) {
    const slug = upDownSlug(asset, cadenceSec, windowStartUnixSec(cadenceSec, nowMs, offset));
    const gamma = await fetchMarketBySlug(slug);
    if (gamma && gamma.closed !== true) {
      out.push({ gamma, info: normalizeGammaMarket(gamma, asset, cadenceSec) });
    }
  }
  return out;
}
