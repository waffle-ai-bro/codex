import { z } from "zod";
import { parseMicros } from "./fixed.js";

/** Decimal string -> micros, e.g. "0.95" -> 950000. */
const micros = z
  .union([z.string(), z.number().int()])
  .transform((v) => (typeof v === "string" ? parseMicros(v) : v));

export const SnipeConfigSchema = z.object({
  enabled: z.boolean().default(true),
  marketCadenceSec: z.union([z.literal(300), z.literal(900)]).default(300),
  /** Quote window measured backwards from market close. */
  tradeWindowStartSec: z.number().int().positive().default(60),
  tradeWindowEndSec: z.number().int().positive().default(4),
  maxEntryPriceMicros: micros.default("0.95"),
  minLockedPriceMicros: micros.default("0.95"),
  /** Required |oracle - strike| gap in bps of strike. */
  minOracleGapBps: z.number().int().nonnegative().default(8),
  /** Gap must be >= this multiple of recent per-window realized vol (bps). x100 fixed point: 250 = 2.5x. */
  minGapToVolRatioX100: z.number().int().positive().default(250),
  maxSpreadMicros: micros.default("0.03"),
  maxOrderUsdMicros: micros.default("5.00"),
  maxFillsPerMarket: z.number().int().positive().default(1),
  cancelOnFade: z.boolean().default(true),
  cancelIfLockedPriceBelowMicros: micros.default("0.94"),
  cancelIfOracleGapBelowBps: z.number().int().nonnegative().default(4),
  cancelIfFeedStaleMs: z.number().int().positive().default(2000),
  cancelBeforeResolutionMs: z.number().int().positive().default(3000),
  cooldownMarketsAfterLoss: z.number().int().nonnegative().default(10),
});

export type SnipeConfig = z.infer<typeof SnipeConfigSchema>;

export const RiskLimitsSchema = z.object({
  maxUsdPerOrderMicros: micros.default("5.00"),
  maxUsdPerMarketMicros: micros.default("5.00"),
  maxOpenOrders: z.number().int().positive().default(2),
  maxDailyLossUsdMicros: micros.default("25.00"),
  maxOrdersPerMinute: z.number().int().positive().default(10),
});

export type RiskLimits = z.infer<typeof RiskLimitsSchema>;

export function loadSnipeConfig(overrides: Partial<Record<string, unknown>> = {}): SnipeConfig {
  return SnipeConfigSchema.parse(overrides);
}

export function loadRiskLimits(overrides: Partial<Record<string, unknown>> = {}): RiskLimits {
  return RiskLimitsSchema.parse(overrides);
}
