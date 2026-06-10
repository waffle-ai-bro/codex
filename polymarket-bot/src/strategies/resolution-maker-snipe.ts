import type { SnipeConfig } from "../core/config.js";
import { gapBps, midMicros, mulDiv, MICRO } from "../core/fixed.js";
import type {
  BookTop,
  DecisionLog,
  MarketInfo,
  OracleTick,
  PaperFill,
  StrategyAction,
  UpDown,
} from "../core/types.js";
import { choosePostOnlyBid } from "./post-only-bid.js";

/**
 * ResolutionMakerSnipe (spec addendum B1-B4).
 *
 * Last-minute passive maker bid on the side that looks decided, with strict
 * entry conditions and aggressive stand-down (cancel) guards. Post-only only;
 * never crosses the book. One fill per market by default.
 *
 * The strategy is a deterministic state machine: feed it book/oracle/fill
 * events plus a clock, call evaluate(), and apply the returned actions.
 * No I/O happens here, which makes it equally usable live and in replay.
 */

export interface OpenOrderView {
  id: string;
  tokenId: string;
  priceMicros: number;
  sizeMicros: number;
}

export interface RiskGate {
  /** Returns a list of violated rules (empty = pass). */
  check(marketId: string, priceMicros: number, sizeMicros: number): string[];
}

interface MarketState {
  info: MarketInfo;
  upBook?: BookTop;
  downBook?: BookTop;
  lastOracle?: OracleTick;
  /** Recent oracle values for realized-vol estimate: [tsMs, valueMicros]. */
  oracleWindow: Array<[number, number]>;
  fills: number;
  done: boolean;
}

export class ResolutionMakerSnipe {
  private readonly markets = new Map<string, MarketState>();
  private openOrder: (OpenOrderView & { marketId: string; lockedSide: UpDown }) | null = null;
  private cooldownRemaining = 0;
  readonly decisions: DecisionLog[] = [];

  constructor(
    private readonly cfg: SnipeConfig,
    private readonly risk: RiskGate,
    private readonly maxDecisionLog = 10_000,
  ) {}

  trackMarket(info: MarketInfo): void {
    if (!this.markets.has(info.id)) {
      this.markets.set(info.id, { info, oracleWindow: [], fills: 0, done: false });
    }
  }

  onBook(marketId: string, top: BookTop): void {
    const m = this.markets.get(marketId);
    if (!m) return;
    if (top.tokenId === m.info.upTokenId) m.upBook = top;
    else if (top.tokenId === m.info.downTokenId) m.downBook = top;
  }

  onOracle(marketId: string, tick: OracleTick): void {
    const m = this.markets.get(marketId);
    if (!m) return;
    m.lastOracle = tick;
    m.oracleWindow.push([tick.tsMs, tick.valueMicros]);
    // Keep ~30s of ticks for the vol estimate.
    const cutoff = tick.tsMs - 30_000;
    while (m.oracleWindow.length > 0 && m.oracleWindow[0]![0] < cutoff) m.oracleWindow.shift();
  }

  onFill(fill: PaperFill): void {
    const m = this.markets.get(fill.marketId);
    if (m) m.fills += 1;
    if (this.openOrder && this.openOrder.id === fill.orderId) this.openOrder = null;
  }

  onOrderClosed(orderId: string): void {
    if (this.openOrder && this.openOrder.id === orderId) this.openOrder = null;
  }

  /**
   * Call on every market resolution. `won` is true/false for markets we had a
   * position in, null otherwise. A loss starts the cooldown; every later
   * resolved market counts it down while we stand aside.
   */
  onResolution(marketId: string, won: boolean | null): void {
    const m = this.markets.get(marketId);
    if (m) m.done = true;
    if (won === false) this.cooldownRemaining = this.cfg.cooldownMarketsAfterLoss;
    else if (this.cooldownRemaining > 0) this.cooldownRemaining -= 1;
  }

  get inCooldown(): boolean {
    return this.cooldownRemaining > 0;
  }

  /** Realized vol of the oracle over the kept window, in bps of strike (stdev of total move). */
  private windowVolBps(m: MarketState): number {
    const w = m.oracleWindow;
    if (w.length < 5) return Number.MAX_SAFE_INTEGER; // not enough data -> treat as too noisy
    let sum = 0;
    let sumSq = 0;
    let n = 0;
    for (let i = 1; i < w.length; i++) {
      const d = gapBps(w[i]![1], w[i - 1]![1]);
      sum += d;
      sumSq += d * d;
      n += 1;
    }
    const mean = sum / n;
    const varPerTick = Math.max(0, sumSq / n - mean * mean);
    // Scale per-tick variance to the remaining-window horizon via sqrt(n).
    return Math.ceil(Math.sqrt(varPerTick * n));
  }

  /**
   * Evaluate one market at time nowMs. Returns actions (place/cancel).
   * Entry requires every condition in the spec checklist; any guard breach
   * cancels the resting order.
   */
  evaluate(marketId: string, nowMs: number): StrategyAction[] {
    const m = this.markets.get(marketId);
    if (!m || m.done || !this.cfg.enabled) return [];
    const actions: StrategyAction[] = [];

    const msToClose = m.info.closeTsMs - nowMs;
    const hasOrderHere = this.openOrder?.marketId === marketId;

    // ---- Determine locked side from the oracle ----
    const oracle = m.lastOracle;
    const oracleFresh = oracle !== undefined && nowMs - oracle.tsMs <= this.cfg.cancelIfFeedStaleMs;
    const oGapBps = oracle ? gapBps(oracle.valueMicros, m.info.strikeMicros) : 0;
    const lockedSide: UpDown | null = oracle ? (oGapBps > 0 ? "UP" : oGapBps < 0 ? "DOWN" : null) : null;
    const absGapBps = Math.abs(oGapBps);
    const book = lockedSide === "UP" ? m.upBook : lockedSide === "DOWN" ? m.downBook : undefined;
    const bookFresh = book !== undefined && nowMs - book.tsMs <= this.cfg.cancelIfFeedStaleMs;
    const spread = book ? book.askMicros - book.bidMicros : Number.MAX_SAFE_INTEGER;
    const mid = book ? midMicros(book.bidMicros, book.askMicros) : 0;

    // ---- Stand-down guards for a resting order (spec B4) ----
    if (hasOrderHere && this.cfg.cancelOnFade) {
      const o = this.openOrder!;
      const cancel = (reason: string): void => {
        actions.push({ kind: "cancel", orderId: o.id, reason });
        this.log(nowMs, marketId, "cancel", reason);
        this.openOrder = null;
      };
      if (msToClose <= this.cfg.cancelBeforeResolutionMs) {
        cancel("inside cancel-before-resolution window");
        return actions;
      }
      if (!oracleFresh) {
        cancel("oracle feed stale");
        return actions;
      }
      if (lockedSide === null || (lockedSide === "UP") !== (o.tokenId === m.info.upTokenId)) {
        cancel("locked side flipped");
        return actions;
      }
      if (absGapBps < this.cfg.cancelIfOracleGapBelowBps) {
        cancel("oracle gap collapsed");
        return actions;
      }
      if (!bookFresh) {
        cancel("book stale");
        return actions;
      }
      if (book && (mid < this.cfg.cancelIfLockedPriceBelowMicros || book.askMicros < this.cfg.cancelIfLockedPriceBelowMicros)) {
        cancel("locked price faded below threshold");
        return actions;
      }
      if (spread > this.cfg.maxSpreadMicros) {
        cancel("spread blew out");
        return actions;
      }
      return actions; // order healthy; leave it resting
    }

    // ---- Entry checklist ----
    const skip = (reason: string, detail?: Record<string, number | string | boolean>): StrategyAction[] => {
      this.log(nowMs, marketId, "skip", reason, detail);
      return actions;
    };

    if (this.openOrder !== null) return actions; // one market at a time
    if (this.cooldownRemaining > 0) return skip("cooldown after loss");
    if (m.fills >= this.cfg.maxFillsPerMarket) return skip("max fills reached for market");
    if (msToClose > this.cfg.tradeWindowStartSec * 1000) return actions; // before window: quiet
    if (msToClose < this.cfg.tradeWindowEndSec * 1000) return skip("past trade window end");
    if (!oracle || !oracleFresh) return skip("oracle missing/stale");
    if (lockedSide === null) return skip("no locked side (gap == 0)");
    if (absGapBps < this.cfg.minOracleGapBps) return skip("oracle gap too small", { absGapBps });

    const volBps = this.windowVolBps(m);
    // gap/vol ratio in x100 fixed point: require gap*100 >= ratio * vol
    if (volBps === Number.MAX_SAFE_INTEGER || absGapBps * 100 < this.cfg.minGapToVolRatioX100 * volBps) {
      return skip("gap not large enough vs realized vol", { absGapBps, volBps });
    }

    if (!book || !bookFresh) return skip("locked-side book missing/stale");
    if (spread > this.cfg.maxSpreadMicros) return skip("spread too wide", { spread });
    if (mid < this.cfg.minLockedPriceMicros && book.askMicros < this.cfg.minLockedPriceMicros) {
      return skip("locked side not priced as locked", { mid });
    }

    const bid = choosePostOnlyBid(
      book.bidMicros,
      book.askMicros,
      m.info.tickSizeMicros,
      this.cfg.maxEntryPriceMicros,
    );
    if (bid === null) return skip("no valid post-only bid (would cross or exceed cap)");

    // Size from max order notional at our bid price.
    const sizeMicros = mulDiv(this.cfg.maxOrderUsdMicros, MICRO, bid);
    if (sizeMicros <= 0) return skip("size rounds to zero");

    const riskViolations = this.risk.check(marketId, bid, sizeMicros);
    if (riskViolations.length > 0) return skip(`risk gate: ${riskViolations.join(", ")}`);

    const tokenId = lockedSide === "UP" ? m.info.upTokenId : m.info.downTokenId;
    actions.push({
      kind: "place",
      marketId,
      tokenId,
      priceMicros: bid,
      sizeMicros,
      reason: `snipe ${lockedSide} gap=${absGapBps}bps vol=${volBps}bps`,
    });
    this.log(nowMs, marketId, "place", "entry conditions met", {
      side: lockedSide,
      bid,
      absGapBps,
      volBps,
    });
    return actions;
  }

  /** The runner must call this after the exchange accepts a placement. */
  onOrderAccepted(order: OpenOrderView, marketId: string, lockedSide: UpDown): void {
    this.openOrder = { ...order, marketId, lockedSide };
  }

  private log(
    tsMs: number,
    marketId: string,
    action: DecisionLog["action"],
    reason: string,
    detail?: Record<string, number | string | boolean>,
  ): void {
    if (this.decisions.length >= this.maxDecisionLog) return;
    this.decisions.push({ tsMs, marketId, action, reason, ...(detail ? { detail } : {}) });
  }
}
