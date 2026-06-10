import type { RiskLimits } from "../core/config.js";
import { notionalUsdMicros } from "../core/fixed.js";
import type { RiskGate } from "../strategies/resolution-maker-snipe.js";

/**
 * Deterministic pre-trade risk gate + global kill switch (spec §10).
 * Strategy code cannot bypass it: the runner only routes orders that pass.
 */
export class RiskEngine implements RiskGate {
  private killSwitch = false;
  private killReason = "";
  private dailyPnlUsdMicros = 0;
  private openOrders = 0;
  private orderTimestampsMs: number[] = [];
  private readonly marketExposure = new Map<string, number>();
  private now: () => number;

  constructor(
    private readonly limits: RiskLimits,
    now: () => number = () => Date.now(),
  ) {
    this.now = now;
  }

  check(marketId: string, priceMicros: number, sizeMicros: number): string[] {
    const violations: string[] = [];
    if (this.killSwitch) violations.push(`kill switch active (${this.killReason})`);
    const notional = notionalUsdMicros(priceMicros, sizeMicros);
    if (notional > this.limits.maxUsdPerOrderMicros) violations.push("order notional over limit");
    const exposure = (this.marketExposure.get(marketId) ?? 0) + notional;
    if (exposure > this.limits.maxUsdPerMarketMicros) violations.push("market exposure over limit");
    if (this.openOrders >= this.limits.maxOpenOrders) violations.push("too many open orders");
    if (-this.dailyPnlUsdMicros >= this.limits.maxDailyLossUsdMicros) {
      violations.push("daily loss limit reached");
    }
    const cutoff = this.now() - 60_000;
    this.orderTimestampsMs = this.orderTimestampsMs.filter((t) => t > cutoff);
    if (this.orderTimestampsMs.length >= this.limits.maxOrdersPerMinute) {
      violations.push("order rate limit");
    }
    return violations;
  }

  onOrderPlaced(): void {
    this.openOrders += 1;
    this.orderTimestampsMs.push(this.now());
  }

  onOrderClosed(): void {
    this.openOrders = Math.max(0, this.openOrders - 1);
  }

  onFill(marketId: string, priceMicros: number, sizeMicros: number): void {
    const notional = notionalUsdMicros(priceMicros, sizeMicros);
    this.marketExposure.set(marketId, (this.marketExposure.get(marketId) ?? 0) + notional);
  }

  onRealizedPnl(usdMicros: number): void {
    this.dailyPnlUsdMicros += usdMicros;
    if (-this.dailyPnlUsdMicros >= this.limits.maxDailyLossUsdMicros) {
      this.trip("daily loss limit");
    }
  }

  trip(reason: string): void {
    this.killSwitch = true;
    this.killReason = reason;
  }

  /** Manual unlock only (spec: kill switch requires manual reset). */
  resetKillSwitch(): void {
    this.killSwitch = false;
    this.killReason = "";
  }

  get tripped(): boolean {
    return this.killSwitch;
  }

  get dailyPnl(): number {
    return this.dailyPnlUsdMicros;
  }
}
