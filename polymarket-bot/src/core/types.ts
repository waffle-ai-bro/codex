/** Shared domain types. All prices/sizes/PnL are fixed-point integers (see fixed.ts). */

export type Asset = "BTC" | "ETH" | "SOL" | "XRP";
export type UpDown = "UP" | "DOWN";

export interface MarketInfo {
  /** Internal id (venue:slug). */
  id: string;
  venue: "polymarket" | "sim";
  slug: string;
  asset: Asset;
  cadenceSec: 300 | 900;
  /** Strike ("price to beat") in micro-USD; resolves UP if settle > strike. */
  strikeMicros: number;
  openTsMs: number;
  closeTsMs: number;
  upTokenId: string;
  downTokenId: string;
  tickSizeMicros: number;
  negRisk: boolean;
}

export interface BookTop {
  tokenId: string;
  bidMicros: number;
  askMicros: number;
  bidSizeMicros: number;
  askSizeMicros: number;
  /** Exchange/source timestamp. */
  tsMs: number;
}

export interface TradeEvent {
  tokenId: string;
  priceMicros: number;
  sizeMicros: number;
  /** Aggressor side: "sell" means a seller hit the bid. */
  side: "buy" | "sell";
  tsMs: number;
}

export interface OracleTick {
  source: string;
  symbol: string;
  /** Underlying price in micro-USD. */
  valueMicros: number;
  tsMs: number;
}

export type OrderStatus = "open" | "filled" | "cancelled" | "rejected";

export interface PaperOrder {
  id: string;
  marketId: string;
  tokenId: string;
  side: "buy";
  priceMicros: number;
  sizeMicros: number;
  remainingMicros: number;
  postOnly: true;
  status: OrderStatus;
  placedTsMs: number;
  /** Visible size ahead of us in queue at placement (conservative). */
  queueAheadMicros: number;
  rejectReason?: string;
}

export interface PaperFill {
  orderId: string;
  marketId: string;
  tokenId: string;
  priceMicros: number;
  sizeMicros: number;
  tsMs: number;
}

export interface MarketResolution {
  marketId: string;
  winner: UpDown;
  settleValueMicros: number;
  tsMs: number;
}

/** Actions emitted by a strategy; the runner applies them to an exchange. */
export type StrategyAction =
  | {
      kind: "place";
      marketId: string;
      tokenId: string;
      priceMicros: number;
      sizeMicros: number;
      reason: string;
    }
  | { kind: "cancel"; orderId: string; reason: string };

export interface DecisionLog {
  tsMs: number;
  marketId: string;
  action: "place" | "cancel" | "skip";
  reason: string;
  detail?: Record<string, number | string | boolean>;
}
