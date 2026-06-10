import { z } from "zod";
import { MICRO, parseMicros } from "../../core/fixed.js";
import { Logger } from "../../core/logger.js";
import type { Asset, BookTop, MarketInfo } from "../../core/types.js";

/**
 * Limitless Exchange (Base) REST client — market data + authenticated order
 * endpoints for the CLOB.
 *
 * Verified against the official SDK (limitless-labs-group/
 * limitless-exchange-ts-sdk, 2026-06):
 *   - base URL https://api.limitless.exchange
 *   - GET  /markets/active?limit=&page=&sortBy=
 *   - GET  /markets/{slug}
 *   - GET  /markets/{slug}/orderbook
 *   - GET  /profiles/me                      (ownerId + feeRateBps for orders)
 *   - POST /orders, DELETE /orders/{id}, DELETE /orders/all/{marketSlug}
 *   - auth header: X-API-Key (env LIMITLESS_API_KEY)
 *   - exchange (EIP-712 verifying contract) comes from market venue data
 *
 * Remaining VERIFY markers are response-shape assumptions that zod parses
 * defensively; confirm them on the first connected run.
 */

const log = new Logger("limitless-client");

export const LIMITLESS_API_BASE =
  process.env["LIMITLESS_API_BASE"] ?? "https://api.limitless.exchange";

// ---------- schemas (defensive: passthrough + unions over observed shapes) ----------

const LimitlessMarketSchema = z
  .object({
    // CLOB markets are addressed by slug; AMM-era ones by address.
    slug: z.string().optional(),
    address: z.string().optional(),
    title: z.string().optional(),
    proxyTitle: z.string().nullable().optional(),
    deadline: z.union([z.string(), z.number()]).optional(), // close time
    createdAt: z.string().optional(),
    status: z.string().optional(),
    expired: z.boolean().optional(),
    // CLOB token ids for YES/NO — shape varies. VERIFY.
    tokens: z
      .object({ yes: z.union([z.string(), z.number()]), no: z.union([z.string(), z.number()]) })
      .optional(),
    clobTokenIds: z.array(z.union([z.string(), z.number()])).optional(),
    collateralToken: z.object({ symbol: z.string().optional() }).passthrough().optional(),
    tradeType: z.string().optional(), // e.g. "clob"
    marketType: z.string().optional(), // e.g. "single"
    priceOracleId: z.union([z.string(), z.number()]).optional(),
    // tick size if exposed. Official SDK default tick is 0.001.
    minTickSize: z.union([z.string(), z.number()]).optional(),
    // CLOB/NegRisk exchange contracts come from the venue system (SDK:
    // market.venue.exchange / market.venue.adapter).
    venue: z
      .object({
        exchange: z.string().optional(),
        adapter: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type LimitlessMarket = z.infer<typeof LimitlessMarketSchema>;

const LevelSchema = z.object({
  price: z.union([z.string(), z.number()]),
  size: z.union([z.string(), z.number()]),
});

const OrderbookSchema = z
  .object({
    bids: z.array(LevelSchema).default([]),
    asks: z.array(LevelSchema).default([]),
    lastTradePrice: z.union([z.string(), z.number()]).optional(),
    tokenId: z.union([z.string(), z.number()]).optional(),
    timestamp: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

export type LimitlessOrderbook = z.infer<typeof OrderbookSchema>;

// ---------- helpers ----------

function toMicros(v: string | number): number {
  return typeof v === "number" ? Math.round(v * MICRO) : parseMicros(v);
}

export function parseDeadlineMs(deadline: string | number | undefined): number | null {
  if (deadline === undefined) return null;
  if (typeof deadline === "number") {
    // Heuristic: seconds vs millis.
    return deadline > 1_000_000_000_000 ? deadline : deadline * 1000;
  }
  const parsed = Date.parse(deadline);
  return Number.isFinite(parsed) ? parsed : null;
}

const ASSET_RE: Array<[Asset, RegExp]> = [
  ["BTC", /\b(btc|bitcoin)\b/i],
  ["ETH", /\b(eth|ethereum)\b/i],
  ["SOL", /\b(sol|solana)\b/i],
  ["XRP", /\bxrp\b/i],
];

export function detectAsset(title: string): Asset | null {
  for (const [asset, re] of ASSET_RE) if (re.test(title)) return asset;
  return null;
}

/** True for short-duration crypto Up/Down style markets. */
export function isShortDurationUpDown(m: LimitlessMarket, cadenceSec: 300 | 900): boolean {
  const title = m.title ?? m.proxyTitle ?? "";
  if (!/\b(up or down|up\/down|above|higher|will .* be up)\b/i.test(title)) return false;
  if (detectAsset(title) === null) return false;
  const closeMs = parseDeadlineMs(m.deadline);
  if (closeMs === null) return false;
  const createdMs = m.createdAt ? Date.parse(m.createdAt) : NaN;
  if (Number.isFinite(createdMs)) {
    const durationSec = Math.round((closeMs - createdMs) / 1000);
    // Allow slack: markets are created slightly before the window opens.
    return Math.abs(durationSec - cadenceSec) <= cadenceSec / 2;
  }
  return true; // duration unknown: let the caller filter on close time
}

/**
 * Normalize to the shared MarketInfo. YES maps to UP for "Up or Down" markets.
 * strikeMicros is set later from the oracle feed at window open (same pattern
 * as the Polymarket connector).
 */
export function normalizeLimitlessMarket(
  m: LimitlessMarket,
  cadenceSec: 300 | 900,
  strikeMicros = 0,
): MarketInfo {
  const slug = m.slug ?? m.address;
  if (!slug) throw new Error("limitless market has neither slug nor address");
  const title = m.title ?? m.proxyTitle ?? "";
  const asset = detectAsset(title);
  if (!asset) throw new Error(`cannot detect asset from title: ${JSON.stringify(title)}`);
  const closeMs = parseDeadlineMs(m.deadline);
  if (closeMs === null) throw new Error("limitless market has no parseable deadline");

  let yesToken: string | undefined;
  let noToken: string | undefined;
  if (m.tokens) {
    yesToken = String(m.tokens.yes);
    noToken = String(m.tokens.no);
  } else if (m.clobTokenIds && m.clobTokenIds.length === 2) {
    // VERIFY: assumed order [yes, no].
    yesToken = String(m.clobTokenIds[0]);
    noToken = String(m.clobTokenIds[1]);
  }
  if (!yesToken || !noToken) throw new Error(`limitless market ${slug} missing CLOB token ids`);

  return {
    id: `limitless:${slug}`,
    venue: "limitless",
    slug,
    asset,
    cadenceSec,
    strikeMicros,
    openTsMs: closeMs - cadenceSec * 1000,
    closeTsMs: closeMs,
    upTokenId: yesToken, // YES == UP
    downTokenId: noToken,
    tickSizeMicros: m.minTickSize !== undefined ? toMicros(m.minTickSize) : 1_000,
    negRisk: false,
    ...(m.venue?.exchange ? { exchangeAddress: m.venue.exchange } : {}),
  };
}

export function normalizeLimitlessBook(
  tokenId: string,
  book: LimitlessOrderbook,
  receivedTsMs: number,
): BookTop {
  let bestBid = 0;
  let bestBidSize = 0;
  for (const lvl of book.bids) {
    const p = toMicros(lvl.price);
    if (p > bestBid) {
      bestBid = p;
      bestBidSize = toMicros(lvl.size);
    }
  }
  let bestAsk = Number.MAX_SAFE_INTEGER;
  let bestAskSize = 0;
  for (const lvl of book.asks) {
    const p = toMicros(lvl.price);
    if (p < bestAsk) {
      bestAsk = p;
      bestAskSize = toMicros(lvl.size);
    }
  }
  const ts = book.timestamp !== undefined ? Number(book.timestamp) : receivedTsMs;
  return {
    tokenId,
    bidMicros: bestBid,
    askMicros: bestAsk,
    bidSizeMicros: bestBidSize,
    askSizeMicros: bestAskSize,
    tsMs: Number.isFinite(ts) && ts > 1_000_000_000_000 ? ts : receivedTsMs,
  };
}

// ---------- client ----------

const ProfileSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    account: z.string().optional(),
    rank: z.object({ feeRateBps: z.union([z.string(), z.number()]).optional() }).passthrough().optional(),
  })
  .passthrough();

export interface LimitlessProfile {
  ownerId: number;
  account?: string;
  feeRateBps: number;
}

export class LimitlessClient {
  private readonly apiKey: string | undefined;

  constructor(
    private readonly base = LIMITLESS_API_BASE,
    apiKey = process.env["LIMITLESS_API_KEY"],
  ) {
    this.apiKey = apiKey;
  }

  get hasApiKey(): boolean {
    return this.apiKey !== undefined && this.apiKey.length > 0;
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const headers: Record<string, string> = {
      accept: "application/json",
      ...((init.headers as Record<string, string>) ?? {}),
    };
    if (this.apiKey) headers["X-API-Key"] = this.apiKey;
    if (init.body) headers["content-type"] = "application/json";
    const res = await fetch(`${this.base}${path}`, { ...init, headers });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`limitless ${init.method ?? "GET"} ${path} -> ${res.status} ${text.slice(0, 200)}`);
    }
    const ct = res.headers.get("content-type") ?? "";
    return ct.includes("json") ? res.json() : res.text();
  }

  /** Authenticated profile; `id` is the ownerId required on order payloads. */
  async fetchProfile(): Promise<LimitlessProfile> {
    const body = ProfileSchema.parse(await this.request("/profiles/me"));
    return {
      ownerId: Number(body.id),
      ...(body.account !== undefined ? { account: body.account } : {}),
      feeRateBps: Number(body.rank?.feeRateBps ?? 0),
    };
  }

  /** Active markets, paginated (SDK: limit/page/sortBy, e.g. "ending_soon"). */
  async fetchActiveMarkets(limit = 100, page = 1, sortBy = "ending_soon"): Promise<LimitlessMarket[]> {
    const body = await this.request(`/markets/active?limit=${limit}&page=${page}&sortBy=${sortBy}`);
    // Response may be an array or {data: [...]}.
    const arr = Array.isArray(body) ? body : ((body as { data?: unknown[] }).data ?? []);
    const out: LimitlessMarket[] = [];
    for (const item of arr) {
      const parsed = LimitlessMarketSchema.safeParse(item);
      if (parsed.success) out.push(parsed.data);
      else log.warn("unparseable market entry", { issues: parsed.error.issues.length });
    }
    return out;
  }

  async fetchMarket(slugOrAddress: string): Promise<LimitlessMarket> {
    const body = await this.request(`/markets/${encodeURIComponent(slugOrAddress)}`);
    return LimitlessMarketSchema.parse(body);
  }

  /** CLOB orderbook for a market (SDK-confirmed path). */
  async fetchOrderbook(slug: string): Promise<LimitlessOrderbook> {
    const body = await this.request(`/markets/${encodeURIComponent(slug)}/orderbook`);
    return OrderbookSchema.parse(body);
  }

  /** Discover current short-duration crypto Up/Down markets for an asset. */
  async discoverUpDownMarkets(
    asset: Asset,
    cadenceSec: 300 | 900,
    nowMs = Date.now(),
  ): Promise<Array<{ raw: LimitlessMarket; info: MarketInfo }>> {
    const markets = await this.fetchActiveMarkets(200);
    const out: Array<{ raw: LimitlessMarket; info: MarketInfo }> = [];
    for (const m of markets) {
      if (!isShortDurationUpDown(m, cadenceSec)) continue;
      try {
        const info = normalizeLimitlessMarket(m, cadenceSec);
        if (info.asset !== asset) continue;
        if (info.closeTsMs <= nowMs + 5_000) continue;
        out.push({ raw: m, info });
      } catch (err) {
        log.warn("skipping unnormalizable market", { message: (err as Error).message });
      }
    }
    out.sort((a, b) => a.info.closeTsMs - b.info.closeTsMs);
    return out;
  }

  // ---------- authenticated order endpoints (used by the executor) ----------

  /**
   * Submit a signed CLOB order. SDK-confirmed payload:
   * { order: {...unsignedOrder, signature}, orderType, marketSlug, ownerId, postOnly? }
   */
  async submitOrder(payload: Record<string, unknown>): Promise<unknown> {
    return this.request("/orders", { method: "POST", body: JSON.stringify(payload) });
  }

  async cancelOrder(orderId: string): Promise<unknown> {
    return this.request(`/orders/${encodeURIComponent(orderId)}`, { method: "DELETE" });
  }

  /** Cancel all open orders in a market (SDK: DELETE /orders/all/{marketSlug}). */
  async cancelAllOrders(marketSlug: string): Promise<unknown> {
    return this.request(`/orders/all/${encodeURIComponent(marketSlug)}`, { method: "DELETE" });
  }

  async fetchOpenOrders(marketSlug?: string): Promise<unknown> {
    const qs = marketSlug ? `?market=${encodeURIComponent(marketSlug)}` : "";
    return this.request(`/orders${qs}`);
  }
}
