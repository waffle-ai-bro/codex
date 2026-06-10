import { floorToTick } from "../core/fixed.js";

/**
 * Choose a post-only bid price (spec addendum B3):
 *   desired = min(maxEntry, bestAsk - tick)   // be competitive but never cross
 *   if desired < bestBid -> join best bid     // don't rest behind the market
 *   if desired >= bestAsk or > maxEntry -> null (would cross / violate cap)
 *
 * Returns priceMicros or null when no valid post-only bid exists.
 */
export function choosePostOnlyBid(
  bestBidMicros: number,
  bestAskMicros: number,
  tickMicros: number,
  maxEntryMicros: number,
): number | null {
  if (bestAskMicros <= 0 || bestBidMicros < 0 || bestAskMicros <= bestBidMicros) return null;
  let desired = Math.min(maxEntryMicros, bestAskMicros - tickMicros);
  desired = floorToTick(desired, tickMicros);
  if (desired < bestBidMicros) desired = bestBidMicros;
  if (desired >= bestAskMicros) return null; // would cross or lock the book
  if (desired > maxEntryMicros) return null; // joining best bid would exceed cap
  if (desired <= 0) return null;
  return desired;
}
