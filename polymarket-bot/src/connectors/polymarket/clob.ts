import { z } from "zod";
import { parseMicros } from "../../core/fixed.js";
import type { BookTop } from "../../core/types.js";

/**
 * Polymarket CLOB public REST (no auth needed for market data).
 * https://docs.polymarket.com/api-reference/introduction
 */

const CLOB_BASE = process.env["POLYMARKET_CLOB_HOST"] ?? "https://clob.polymarket.com";

const LevelSchema = z.object({ price: z.string(), size: z.string() });
const BookSchema = z
  .object({
    asset_id: z.string().optional(),
    bids: z.array(LevelSchema),
    asks: z.array(LevelSchema),
    timestamp: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

export type ClobBook = z.infer<typeof BookSchema>;

export async function fetchBook(tokenId: string): Promise<ClobBook> {
  const res = await fetch(`${CLOB_BASE}/book?token_id=${encodeURIComponent(tokenId)}`);
  if (!res.ok) throw new Error(`clob book ${res.status} for token ${tokenId}`);
  return BookSchema.parse((await res.json()) as unknown);
}

/** Reduce a full book to best bid/ask in micros. Polymarket sorts are not guaranteed; scan. */
export function normalizeBookTop(tokenId: string, book: ClobBook, receivedTsMs: number): BookTop {
  let bestBid = 0;
  let bestBidSize = 0;
  for (const lvl of book.bids) {
    const p = parseMicros(lvl.price);
    if (p > bestBid) {
      bestBid = p;
      bestBidSize = parseMicros(lvl.size);
    }
  }
  let bestAsk = Number.MAX_SAFE_INTEGER;
  let bestAskSize = 0;
  for (const lvl of book.asks) {
    const p = parseMicros(lvl.price);
    if (p < bestAsk) {
      bestAsk = p;
      bestAskSize = parseMicros(lvl.size);
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
