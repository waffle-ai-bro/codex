import { formatMicros } from "../core/fixed.js";
import type { MarketResult } from "./runner.js";

/** Aggregate metrics required by spec addendum B6/G. */
export interface SimReport {
  markets: number;
  ordersPlaced: number;
  fills: number;
  fillRatePct: number;
  /** Win rate of all placed signals (had every bid filled). */
  signalWinRatePct: number;
  /** Win rate conditioned on actually getting filled — the number that matters. */
  winRateGivenFillPct: number;
  /** Adverse selection: signal win rate minus fill-conditioned win rate. */
  adverseSelectionPct: number;
  avgEntryPrice: string;
  totalPnlUsd: string;
  avgPnlPerFillUsd: string;
  avgWinUsd: string;
  avgLossUsd: string;
  largestLossUsd: string;
  maxDrawdownUsd: string;
  winsToRecoverOneLoss: number;
  expectedValuePerFillUsd: string;
}

export function buildReport(results: MarketResult[]): SimReport {
  const placed = results.filter((r) => r.placed);
  const filled = results.filter((r) => r.filled);
  const wins = filled.filter((r) => r.pnlUsdMicros > 0);
  const losses = filled.filter((r) => r.pnlUsdMicros < 0);

  const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
  const totalPnl = sum(results.map((r) => r.pnlUsdMicros));
  const avgEntry =
    filled.length > 0 ? Math.round(sum(filled.map((r) => r.entryPriceMicros ?? 0)) / filled.length) : 0;
  const avgWin = wins.length > 0 ? Math.round(sum(wins.map((r) => r.pnlUsdMicros)) / wins.length) : 0;
  const avgLoss =
    losses.length > 0 ? Math.round(sum(losses.map((r) => r.pnlUsdMicros)) / losses.length) : 0;

  let peak = 0;
  let cum = 0;
  let maxDd = 0;
  for (const r of results) {
    cum += r.pnlUsdMicros;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDd) maxDd = peak - cum;
  }

  const signalWins = placed.filter((r) => r.signalSideWon === true).length;
  const signalWinRate = placed.length > 0 ? (100 * signalWins) / placed.length : 0;
  const fillWinRate = filled.length > 0 ? (100 * wins.length) / filled.length : 0;

  return {
    markets: results.length,
    ordersPlaced: placed.length,
    fills: filled.length,
    fillRatePct: round2(placed.length > 0 ? (100 * filled.length) / placed.length : 0),
    signalWinRatePct: round2(signalWinRate),
    winRateGivenFillPct: round2(fillWinRate),
    adverseSelectionPct: round2(signalWinRate - fillWinRate),
    avgEntryPrice: formatMicros(avgEntry, 3),
    totalPnlUsd: formatMicros(totalPnl),
    avgPnlPerFillUsd: formatMicros(filled.length > 0 ? Math.round(totalPnl / filled.length) : 0),
    avgWinUsd: formatMicros(avgWin),
    avgLossUsd: formatMicros(avgLoss),
    largestLossUsd: formatMicros(losses.length > 0 ? Math.min(...losses.map((r) => r.pnlUsdMicros)) : 0),
    maxDrawdownUsd: formatMicros(maxDd),
    winsToRecoverOneLoss: avgWin > 0 ? round2(Math.abs(avgLoss) / avgWin) : 0,
    expectedValuePerFillUsd: formatMicros(filled.length > 0 ? Math.round(totalPnl / filled.length) : 0),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function renderReport(title: string, r: SimReport): string {
  const lines = [
    `=== ${title} ===`,
    `markets simulated        ${r.markets}`,
    `orders placed            ${r.ordersPlaced}`,
    `fills                    ${r.fills} (${r.fillRatePct}% of placed)`,
    `signal win rate          ${r.signalWinRatePct}%  (if every bid had filled)`,
    `win rate GIVEN fill      ${r.winRateGivenFillPct}%  <- the number that matters`,
    `adverse selection drag   ${r.adverseSelectionPct} pp`,
    `avg entry price          $${r.avgEntryPrice}`,
    `total PnL                $${r.totalPnlUsd}`,
    `avg PnL per fill         $${r.avgPnlPerFillUsd}`,
    `avg win / avg loss       $${r.avgWinUsd} / $${r.avgLossUsd}`,
    `largest loss             $${r.largestLossUsd}`,
    `max drawdown             $${r.maxDrawdownUsd}`,
    `wins to recover 1 loss   ${r.winsToRecoverOneLoss}`,
  ];
  return lines.join("\n");
}
