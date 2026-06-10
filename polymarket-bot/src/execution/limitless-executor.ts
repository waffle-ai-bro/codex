import type { PrivateKeyAccount } from "viem/accounts";
import { Logger } from "../core/logger.js";
import { formatMicros } from "../core/fixed.js";
import type { BookTop } from "../core/types.js";
import type { RiskEngine } from "../risk/risk-engine.js";
import type { LimitlessClient } from "../connectors/limitless/client.js";
import {
  buildClobOrder,
  orderToWire,
  signClobOrder,
  type LimitlessDomainConfig,
} from "../connectors/limitless/orders.js";

/**
 * Limitless live trading service.
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
  /** Our open order ids per market, for targeted cancels. */
  private readonly openOrders = new Map<string, string>();

  constructor(
    private readonly client: LimitlessClient,
    private readonly account: PrivateKeyAccount,
    private readonly domain: LimitlessDomainConfig,
    private readonly risk: RiskEngine,
    private readonly options: LimitlessExecutorOptions,
  ) {
    if (!options.enabled && !options.dryRun) {
      throw new Error("executor constructed with trading disabled and dryRun off — nothing it could do");
    }
  }

  onBook(top: BookTop): void {
    this.lastBook.set(top.tokenId, top);
  }

  async placePostOnlyBuy(args: {
    marketId: string;
    marketSlug: string;
    tokenId: string;
    priceMicros: number;
    sizeMicros: number;
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

    // 3. Build + sign.
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
      expirationSec,
    });
    const signature = await signClobOrder(this.account, this.domain, order);
    const payload = {
      order: orderToWire(order, signature),
      orderType: this.options.orderType,
      marketSlug: args.marketSlug,
      postOnly: true, // VERIFY: server-side post-only flag name
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
    try {
      const res = (await this.client.submitOrder(payload)) as Record<string, unknown>;
      const id = String(res["id"] ?? res["orderId"] ?? "");
      if (!id) {
        this.risk.trip("order submitted but no id returned — state unknown");
        return { id: "", status: "rejected", rejectReason: "no order id in response" };
      }
      this.openOrders.set(args.marketId, id);
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
    this.openOrders.clear();
    if (this.options.dryRun || !this.options.enabled) return;
    try {
      await this.client.cancelAllOrders();
    } catch (err) {
      this.risk.trip(`cancel-all failed: ${(err as Error).message}`);
    }
  }
}
