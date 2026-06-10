import { z } from "zod";
import { MICRO, parseMicros } from "../../core/fixed.js";
import { Logger } from "../../core/logger.js";
import type { Asset, BookTop, MarketInfo } from "../../core/types.js";

/**
 * Limitless Exchange (Base) REST client — market data + authenticated order
 * endpoints for the CLOB.
 *
 * API base: https://api.limitless.exchange
 * Docs/reference implementations:
 *   - https://github.com/moondevonyt/Limitless-Prediction-Market-Bots
 *   - Limitless API docs (https://docs.limitless.exchange)
 *
 * VERIFY-ON-FIRST-RUN: this client was written without live network access.
 * Field names are parsed defensively (zod + fallbacks) but the first connected
 * run must confirm: market list filters, orderbook field names, auth header
 * names, and the order submission payload. Every assumption is marked VERIFY.
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
    // tick size if exposed. VERIFY: default 0.001 for crypto markets.
    minTickSize: z.union([z.string(), z.number()]).optional(),
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

export interface LimitlessSession {
  /** Cookie header value returned by login (session auth). */
  cookie?: string;
  /** Extra headers (e.g. x-account) kept for authenticated calls. */
  headers: Record<string, string>;
}

export class LimitlessClient {
  constructor(
    private readonly base = LIMITLESS_API_BASE,
    private session: LimitlessSession = { headers: {} },
  ) {}

  setSession(session: LimitlessSession): void {
    this.session = session;
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const headers: Record<string, string> = {
      accept: "application/json",
      ...this.session.headers,
      ...((init.headers as Record<string, string>) ?? {}),
    };
    if (this.session.cookie) headers["cookie"] = this.session.cookie;
    if (init.body) headers["content-type"] = "application/json";
    const res = await fetch(`${this.base}${path}`, { ...init, headers });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`limitless ${init.method ?? "GET"} ${path} -> ${res.status} ${text.slice(0, 200)}`);
    }
    const ct = res.headers.get("content-type") ?? "";
    return ct.includes("json") ? res.json() : res.text();
  }

  /** Active markets, paginated. VERIFY endpoint/params on first run. */
  async fetchActiveMarkets(limit = 100, page = 1): Promise<LimitlessMarket[]> {
    const body = await this.request(`/markets/active?limit=${limit}&page=${page}`);
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

  /** CLOB orderbook for a market. VERIFY path (`/markets/{slug}/orderbook`). */
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

  /** Submit a signed CLOB order. VERIFY payload shape on first run. */
  async submitOrder(payload: Record<string, unknown>): Promise<unknown> {
    return this.request("/orders", { method: "POST", body: JSON.stringify(payload) });
  }

  async cancelOrder(orderId: string): Promise<unknown> {
    return this.request(`/orders/${encodeURIComponent(orderId)}`, { method: "DELETE" });
  }

  /** Cancel all open orders, optionally per market. VERIFY endpoint. */
  async cancelAllOrders(marketSlug?: string): Promise<unknown> {
    const qs = marketSlug ? `?market=${encodeURIComponent(marketSlug)}` : "";
    return this.request(`/orders/all${qs}`, { method: "DELETE" });
  }

  async fetchOpenOrders(marketSlug?: string): Promise<unknown> {
    const qs = marketSlug ? `?market=${encodeURIComponent(marketSlug)}` : "";
    return this.request(`/orders${qs}`);
  }
}
