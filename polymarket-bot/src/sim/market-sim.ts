import { MICRO, clamp, floorToTick } from "../core/fixed.js";
import type { BookTop, MarketInfo, OracleTick, TradeEvent, UpDown } from "../core/types.js";
import { Rng, normCdf } from "./rng.js";

/**
 * Synthetic short-duration Up/Down market generator.
 *
 * Honest framing (spec addendum B6/G): a synthetic sim CANNOT prove real-world
 * edge — that requires recorded tick data. What it CAN do is (a) exercise the
 * full strategy/execution/risk pipeline end to end, and (b) measure how the
 * strategy's PnL responds to the one variable that decides everything:
 * adverse selection (the fraction of sellers who hit our bid because they
 * know the move before the book reprices).
 *
 * Model:
 *  - Underlying follows GBM at 250ms steps with per-market random vol plus
 *    occasional jumps. Strike = open price. UP wins iff close > strike.
 *  - The book prices the UP token at fair probability Phi(gap/sigma_remaining)
 *    computed from a LAGGED view of the underlying (bookLagMs), plus noise.
 *  - Uninformed sellers arrive randomly and hit the bid.
 *  - Informed sellers arrive when the TRUE (unlagged) fair probability is
 *    below the lagged book bid by a margin — exactly the flow that fills a
 *    $0.95 bid right before a reversal.
 */

export interface SimParams {
  seed: number;
  cadenceSec: 300 | 900;
  stepMs: number;
  /** Annualized vol range; each market draws uniformly. */
  sigmaAnnualLo: number;
  sigmaAnnualHi: number;
  /** Per-step probability of a price jump, and jump size in sigmas. */
  jumpProbPerStep: number;
  jumpSigmas: number;
  /** Book reprice lag and pricing noise (in probability units). */
  bookLagMs: number;
  bookNoise: number;
  /** Per-step probability of an uninformed sell hitting the bid. */
  uninformedSellProbPerStep: number;
  /** Per-step probability an informed seller acts when edge exists. */
  informedSellProbPerStep: number;
  /** Informed sellers act when trueFairP < bid - this margin. */
  informedEdgeMargin: number;
  tickSizeMicros: number;
  startPriceUsd: number;
}

export const DEFAULT_SIM_PARAMS: SimParams = {
  seed: 1,
  cadenceSec: 300,
  stepMs: 250,
  sigmaAnnualLo: 0.35,
  sigmaAnnualHi: 0.9,
  jumpProbPerStep: 0.0015,
  jumpSigmas: 6,
  bookLagMs: 750,
  bookNoise: 0.004,
  uninformedSellProbPerStep: 0.06,
  informedSellProbPerStep: 0.35,
  informedEdgeMargin: 0.02,
  tickSizeMicros: 1_000, // $0.001
  startPriceUsd: 100_000,
};

export type SimEvent =
  | { type: "oracle"; tick: OracleTick }
  | { type: "book"; marketId: string; top: BookTop }
  | { type: "trade"; marketId: string; trade: TradeEvent };

export interface SimMarket {
  info: MarketInfo;
  events: SimEvent[];
  winner: UpDown;
  settleValueMicros: number;
}

const MS_PER_YEAR = 365 * 24 * 3600 * 1000;

export function generateMarket(params: SimParams, index: number): SimMarket {
  const rng = new Rng(params.seed + index * 7919);
  const cadenceMs = params.cadenceSec * 1000;
  const steps = Math.floor(cadenceMs / params.stepMs);
  const openTsMs = 1_750_000_000_000 + index * cadenceMs;
  const closeTsMs = openTsMs + cadenceMs;

  const sigmaAnnual = rng.uniform(params.sigmaAnnualLo, params.sigmaAnnualHi);
  const sigmaPerStep = sigmaAnnual * Math.sqrt(params.stepMs / MS_PER_YEAR);

  // ---- price path ----
  const path: number[] = new Array(steps + 1);
  path[0] = params.startPriceUsd * rng.uniform(0.95, 1.05);
  for (let i = 1; i <= steps; i++) {
    let ret = sigmaPerStep * rng.gaussian();
    if (rng.bernoulli(params.jumpProbPerStep)) {
      ret += sigmaPerStep * params.jumpSigmas * (rng.bernoulli(0.5) ? 1 : -1);
    }
    path[i] = path[i - 1]! * Math.exp(ret);
  }
  const strike = path[0]!;
  const settle = path[steps]!;
  const winner: UpDown = settle > strike ? "UP" : "DOWN";

  const id = `sim:${params.cadenceSec}s-${index}`;
  const info: MarketInfo = {
    id,
    venue: "sim",
    slug: `btc-updown-${params.cadenceSec}s-${index}`,
    asset: "BTC",
    cadenceSec: params.cadenceSec,
    strikeMicros: Math.round(strike * MICRO),
    openTsMs,
    closeTsMs,
    upTokenId: `${id}:UP`,
    downTokenId: `${id}:DOWN`,
    tickSizeMicros: params.tickSizeMicros,
    negRisk: false,
  };

  const fairP = (priceUsd: number, msLeft: number): number => {
    if (msLeft <= 0) return priceUsd > strike ? 1 : 0;
    const sigmaRemaining = sigmaAnnual * Math.sqrt(msLeft / MS_PER_YEAR);
    const gap = Math.log(priceUsd / strike);
    return normCdf(gap / sigmaRemaining);
  };

  const lagSteps = Math.max(1, Math.round(params.bookLagMs / params.stepMs));
  const tick = params.tickSizeMicros;
  const events: SimEvent[] = [];

  for (let i = 0; i <= steps; i++) {
    const tsMs = openTsMs + i * params.stepMs;
    const msLeft = closeTsMs - tsMs;
    const price = path[i]!;

    events.push({
      type: "oracle",
      tick: {
        source: "sim-oracle",
        symbol: "BTCUSD",
        valueMicros: Math.round(price * MICRO),
        tsMs,
      },
    });

    // Book prices off a lagged underlying view + noise.
    const laggedPrice = path[Math.max(0, i - lagSteps)]!;
    const pBook = clamp(
      fairP(laggedPrice, msLeft + params.bookLagMs) + rng.gaussian() * params.bookNoise,
      0.002,
      0.998,
    );
    const halfSpread = Math.max(tick / MICRO, 0.001 + 0.012 * pBook * (1 - pBook));
    // Keep both sides of both books strictly inside (0, $1): UP ask <= 1-tick
    // and UP bid >= tick, so the mirrored DOWN book is also valid.
    let upBid = floorToTick(Math.round(clamp(pBook - halfSpread, 0.001, 0.998) * MICRO), tick);
    let upAsk = floorToTick(Math.round(clamp(pBook + halfSpread, 0.002, 0.999) * MICRO), tick) + tick;
    upAsk = Math.min(upAsk, MICRO - tick);
    if (upAsk <= upBid) upBid = upAsk - tick;
    if (upBid < tick) {
      upBid = tick;
      if (upAsk <= upBid) upAsk = upBid + tick;
    }
    const bidSize = rng.uniformInt(20, 400) * MICRO;
    const askSize = rng.uniformInt(20, 400) * MICRO;

    events.push({
      type: "book",
      marketId: id,
      top: { tokenId: info.upTokenId, bidMicros: upBid, askMicros: upAsk, bidSizeMicros: bidSize, askSizeMicros: askSize, tsMs },
    });
    events.push({
      type: "book",
      marketId: id,
      top: {
        tokenId: info.downTokenId,
        bidMicros: MICRO - upAsk,
        askMicros: MICRO - upBid,
        bidSizeMicros: askSize,
        askSizeMicros: bidSize,
        tsMs,
      },
    });

    // ---- seller flow on the UP token (mirrored flow on DOWN omitted: our
    // strategy only rests on the locked side; the DOWN-side equivalent is
    // covered because DOWN books mirror UP) ----
    const trueP = fairP(price, msLeft);

    if (rng.bernoulli(params.uninformedSellProbPerStep)) {
      events.push({
        type: "trade",
        marketId: id,
        trade: {
          tokenId: info.upTokenId,
          priceMicros: upBid,
          sizeMicros: rng.uniformInt(5, 120) * MICRO,
          side: "sell",
          tsMs: tsMs + Math.floor(rng.uniform(1, params.stepMs - 1)),
        },
      });
    }
    // Informed flow: seller knows true fair value is below the (stale) bid.
    if (trueP < upBid / MICRO - params.informedEdgeMargin && rng.bernoulli(params.informedSellProbPerStep)) {
      events.push({
        type: "trade",
        marketId: id,
        trade: {
          tokenId: info.upTokenId,
          priceMicros: upBid,
          sizeMicros: rng.uniformInt(50, 600) * MICRO,
          side: "sell",
          tsMs: tsMs + Math.floor(rng.uniform(1, params.stepMs - 1)),
        },
      });
    }
    // Mirror for DOWN token: informed sellers of DOWN when true DOWN value sank.
    const downBid = MICRO - upAsk;
    if (1 - trueP < downBid / MICRO - params.informedEdgeMargin && rng.bernoulli(params.informedSellProbPerStep)) {
      events.push({
        type: "trade",
        marketId: id,
        trade: {
          tokenId: info.downTokenId,
          priceMicros: downBid,
          sizeMicros: rng.uniformInt(50, 600) * MICRO,
          side: "sell",
          tsMs: tsMs + Math.floor(rng.uniform(1, params.stepMs - 1)),
        },
      });
    }
    if (rng.bernoulli(params.uninformedSellProbPerStep * 0.7)) {
      events.push({
        type: "trade",
        marketId: id,
        trade: {
          tokenId: info.downTokenId,
          priceMicros: downBid,
          sizeMicros: rng.uniformInt(5, 120) * MICRO,
          side: "sell",
          tsMs: tsMs + Math.floor(rng.uniform(1, params.stepMs - 1)),
        },
      });
    }
  }

  // Events must be chronological for the replay runner.
  events.sort((a, b) => eventTs(a) - eventTs(b));

  return { info, events, winner, settleValueMicros: Math.round(settle * MICRO) };
}

export function eventTs(e: SimEvent): number {
  switch (e.type) {
    case "oracle":
      return e.tick.tsMs;
    case "book":
      return e.top.tsMs;
    case "trade":
      return e.trade.tsMs;
  }
}
