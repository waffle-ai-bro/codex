import type { PrivateKeyAccount } from "viem/accounts";
import { Logger } from "../core/logger.js";
import { formatMicros } from "../core/fixed.js";
import type { BookTop } from "../core/types.js";
import type { RiskEngine } from "../risk/risk-engine.js";
import type { LimitlessClient, LimitlessProfile } from "../connectors/limitless/client.js";
import {
  buildClobOrder,
  domainFor,
  orderToWire,
  signClobOrder,
  type LimitlessDomainConfig,
} from "../connectors/limitless/orders.js";

/**
 * Limitless live trading service.
 *
 * Order payload verified against the official SDK (2026-06):
 *   POST /orders { order: {...signed}, orderType, marketSlug, ownerId, postOnly? }
 * ownerId comes from GET /profiles/me; the EIP-712 verifying contract comes
 * from the market's venue exchange address.
 *
 * Safety model (spec §10):
 *  - DISABLED unless both TRADING_ENABLED=true and LIMITLESS_TRADING_ENABLED=true.
 *  - dryRun mode builds + signs + logs but never POSTs (use for verification).
 *  - Post-only enforced client-side: a buy that would cross the latest known
 *    ask is rejected locally and never submitted.
 *  - Every order passes the shared RiskEngine first; strategy code cannot
 *    bypass it because the runner only routes through this class.
 *  - cancelAll() is wired to feed-disconnect and kill-switch paths.
 */

export interface LimitlessExecutorOptions {
  enabled: boolean;
  dryRun: boolean;
  orderType: "GTC" | "GTD";
  /** For GTD: how long orders live. */
  ttlSec?: number;
}

export function executorOptionsFromEnv(): LimitlessExecutorOptions {
  const enabled =
    process.env["TRADING_ENABLED"] === "true" && process.env["LIMITLESS_TRADING_ENABLED"] === "true";
  return {
    enabled,
    dryRun: process.env["LIMITLESS_DRY_RUN"] !== "false", // dry-run unless explicitly disabled
    orderType: process.env["LIMITLESS_ORDER_TYPE"] === "GTD" ? "GTD" : "GTC",
    ttlSec: Number(process.env["LIMITLESS_ORDER_TTL_SEC"] ?? 120),
  };
}

export interface PlacedOrder {
  /** Venue order id when live; `dry-run` otherwise. */
  id: string;
  status: "open" | "rejected" | "dry-run";
  rejectReason?: string;
}

export class LimitlessExecutor {
  private readonly log = new Logger("limitless-executor");
  private readonly lastBook = new Map<string, BookTop>();
  /** marketId -> { orderId, slug } for targeted and bulk cancels. */
  private readonly openOrders = new Map<string, { orderId: string; slug: string }>();
  private profile: LimitlessProfile | null = null;

  constructor(
    private readonly client: LimitlessClient,
    private readonly account: PrivateKeyAccount,
    private readonly risk: RiskEngine,
    private readonly options: LimitlessExecutorOptions,
    /** Fallback domain when a market carries no venue exchange address. */
    private readonly defaultDomain: LimitlessDomainConfig | null = null,
  ) {
    if (!options.enabled && !options.dryRun) {
      throw new Error("executor constructed with trading disabled and dryRun off — nothing it could do");
    }
  }

  /** Fetch ownerId/feeRateBps once after auth. Required before live orders. */
  async loadProfile(): Promise<LimitlessProfile> {
    this.profile = await this.client.fetchProfile();
    this.log.info("profile loaded", { ownerId: this.profile.ownerId, feeRateBps: this.profile.feeRateBps });
    return this.profile;
  }

  /** Test hook / cached-profile injection. */
  setProfile(profile: LimitlessProfile): void {
    this.profile = profile;
  }

  onBook(top: BookTop): void {
    this.lastBook.set(top.tokenId, top);
  }

  private resolveDomain(exchangeAddress?: string): LimitlessDomainConfig {
    if (exchangeAddress) return domainFor(exchangeAddress);
    if (this.defaultDomain) return this.defaultDomain;
    throw new Error("no exchange address: market venue data missing and no default domain configured");
  }

  async placePostOnlyBuy(args: {
    marketId: string;
    marketSlug: string;
    tokenId: string;
    priceMicros: number;
    sizeMicros: number;
    /** market.venue.exchange — the EIP-712 verifying contract. */
    exchangeAddress?: string;
  }): Promise<PlacedOrder> {
    // 1. Risk gate (shared engine, same limits as paper).
    const violations = this.risk.check(args.marketId, args.priceMicros, args.sizeMicros);
    if (violations.length > 0) {
      return { id: "", status: "rejected", rejectReason: `risk: ${violations.join(", ")}` };
    }

    // 2. Client-side post-only check against the freshest book we have.
    const book = this.lastBook.get(args.tokenId);
    if (!book) return { id: "", status: "rejected", rejectReason: "no book state for token" };
    if (args.priceMicros >= book.askMicros) {
      return { id: "", status: "rejected", rejectReason: "post-only would cross" };
    }

    // 3. Build + sign with the market's venue exchange as verifying contract.
    let domain: LimitlessDomainConfig;
    try {
      domain = this.resolveDomain(args.exchangeAddress);
    } catch (err) {
      return { id: "", status: "rejected", rejectReason: (err as Error).message };
    }
    const expirationSec =
      this.options.orderType === "GTD"
        ? Math.floor(Date.now() / 1000) + (this.options.ttlSec ?? 120)
        : 0;
    const order = buildClobOrder({
      maker: this.account.address,
      tokenId: args.tokenId,
      side: "BUY",
      priceMicros: args.priceMicros,
      sizeMicros: args.sizeMicros,
      feeRateBps: this.profile?.feeRateBps ?? 0,
      expirationSec,
    });
    const signature = await signClobOrder(this.account, domain, order);
    const payload: Record<string, unknown> = {
      order: orderToWire(order, signature),
      orderType: this.options.orderType === "GTD" ? "GTC" : this.options.orderType, // venue enum: GTC/FOK/FAK
      marketSlug: args.marketSlug,
      ownerId: this.profile?.ownerId,
      postOnly: true,
    };

    this.log.info("order built", {
      market: args.marketSlug,
      price: formatMicros(args.priceMicros, 3),
      size: formatMicros(args.sizeMicros),
      dryRun: this.options.dryRun,
    });

    // 4. Submit (or stop at dry-run).
    if (this.options.dryRun || !this.options.enabled) {
      return { id: `dry-${Date.now()}`, status: "dry-run" };
    }
    if (this.profile === null) {
      return { id: "", status: "rejected", rejectReason: "profile not loaded (ownerId required)" };
    }
    try {
      const res = (await this.client.submitOrder(payload)) as Record<string, unknown>;
      const id = String(res["id"] ?? res["orderId"] ?? "");
      if (!id) {
        this.risk.trip("order submitted but no id returned — state unknown");
        return { id: "", status: "rejected", rejectReason: "no order id in response" };
      }
      this.openOrders.set(args.marketId, { orderId: id, slug: args.marketSlug });
      this.risk.onOrderPlaced();
      return { id, status: "open" };
    } catch (err) {
      const message = (err as Error).message;
      this.log.error("order submit failed", { message });
      return { id: "", status: "rejected", rejectReason: message };
    }
  }

  async cancel(marketId: string, orderId: string): Promise<boolean> {
    this.openOrders.delete(marketId);
    if (this.options.dryRun || !this.options.enabled) return true;
    try {
      await this.client.cancelOrder(orderId);
      this.risk.onOrderClosed();
      return true;
    } catch (err) {
      // A failed cancel near resolution is a serious state problem.
      this.risk.trip(`cancel failed for ${orderId}: ${(err as Error).message}`);
      return false;
    }
  }

  /** Used by kill-switch and disconnect paths. Best effort, then verify. */
  async cancelAll(): Promise<void> {
    const slugs = new Set<string>();
    for (const { slug } of this.openOrders.values()) slugs.add(slug);
    this.openOrders.clear();
    if (this.options.dryRun || !this.options.enabled) return;
    for (const slug of slugs) {
      try {
        await this.client.cancelAllOrders(slug);
      } catch (err) {
        this.risk.trip(`cancel-all failed for ${slug}: ${(err as Error).message}`);
      }
    }
  }
}
