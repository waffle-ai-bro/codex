import type { SnipeConfig } from "../core/config.js";
import { gapBps } from "../core/fixed.js";
import type { PaperFill, UpDown } from "../core/types.js";
import { PaperExchange } from "../execution/paper-exchange.js";
import { RiskEngine } from "../risk/risk-engine.js";
import { ResolutionMakerSnipe } from "../strategies/resolution-maker-snipe.js";
import type { RiskLimits } from "../core/config.js";
import type { SimMarket } from "./market-sim.js";
import { eventTs } from "./market-sim.js";

/** Per-market outcome record used for the profitability report. */
export interface MarketResult {
  marketId: string;
  winner: UpDown;
  signaled: boolean;
  placed: boolean;
  filled: boolean;
  /** Side we bid on, if any. */
  side?: UpDown;
  entryPriceMicros?: number;
  fillSizeMicros?: number;
  /** Did the side we SIGNALED (placed an order on) end up winning? */
  signalSideWon?: boolean;
  pnlUsdMicros: number;
  /** Oracle gap (bps, signed toward our side) at fill and at close — toxicity probe. */
  gapAtFillBps?: number;
  gapAtCloseBps?: number;
}

export interface RunOutput {
  results: MarketResult[];
  totalPnlUsdMicros: number;
  killSwitchTripped: boolean;
}

/**
 * Replay markets chronologically through the full pipeline:
 * events -> strategy state -> evaluate -> risk-gated actions -> paper exchange.
 * The same loop shape is used by the live paper trader.
 */
export function runMarkets(
  markets: SimMarket[],
  snipeCfg: SnipeConfig,
  riskLimits: RiskLimits,
): RunOutput {
  let simNow = 0;
  const risk = new RiskEngine(riskLimits, () => simNow);
  const strategy = new ResolutionMakerSnipe(snipeCfg, risk);
  const exchange = new PaperExchange();
  const results: MarketResult[] = [];

  for (const market of markets) {
    const info = market.info;
    strategy.trackMarket(info);
    const result: MarketResult = {
      marketId: info.id,
      winner: market.winner,
      signaled: false,
      placed: false,
      filled: false,
      pnlUsdMicros: 0,
    };
    let fill: PaperFill | null = null;
    let lastOracleMicros = 0;

    for (const ev of market.events) {
      simNow = eventTs(ev);
      switch (ev.type) {
        case "oracle":
          strategy.onOracle(info.id, ev.tick);
          lastOracleMicros = ev.tick.valueMicros;
          break;
        case "book":
          strategy.onBook(info.id, ev.top);
          exchange.onBook(ev.top);
          break;
        case "trade": {
          const fills = exchange.onTrade(ev.trade);
          for (const f of fills) {
            strategy.onFill(f);
            risk.onFill(f.marketId, f.priceMicros, f.sizeMicros);
            risk.onOrderClosed();
            if (!fill) {
              fill = f;
              result.filled = true;
              result.entryPriceMicros = f.priceMicros;
              result.fillSizeMicros = f.sizeMicros;
              const side: UpDown = f.tokenId === info.upTokenId ? "UP" : "DOWN";
              const raw = gapBps(lastOracleMicros, info.strikeMicros);
              result.gapAtFillBps = side === "UP" ? raw : -raw;
            }
          }
          break;
        }
      }

      const actions = strategy.evaluate(info.id, simNow);
      for (const action of actions) {
        if (action.kind === "place") {
          const order = exchange.placePostOnlyBuy({
            marketId: action.marketId,
            tokenId: action.tokenId,
            priceMicros: action.priceMicros,
            sizeMicros: action.sizeMicros,
            tsMs: simNow,
          });
          if (order.status === "open") {
            const side: UpDown = action.tokenId === info.upTokenId ? "UP" : "DOWN";
            strategy.onOrderAccepted(
              { id: order.id, tokenId: order.tokenId, priceMicros: order.priceMicros, sizeMicros: order.sizeMicros },
              action.marketId,
              side,
            );
            risk.onOrderPlaced();
            result.signaled = true;
            result.placed = true;
            result.side = side;
          }
        } else {
          if (exchange.cancel(action.orderId)) risk.onOrderClosed();
        }
      }
    }

    // ---- resolution ----
    const winnerToken = market.winner === "UP" ? info.upTokenId : info.downTokenId;
    const loserToken = market.winner === "UP" ? info.downTokenId : info.upTokenId;
    const pnl = exchange.settle(
      { marketId: info.id, winner: market.winner, settleValueMicros: market.settleValueMicros, tsMs: info.closeTsMs },
      winnerToken,
      loserToken,
    );
    result.pnlUsdMicros = pnl;
    if (result.placed && result.side) result.signalSideWon = result.side === market.winner;
    if (result.filled && result.side) {
      const raw = gapBps(market.settleValueMicros, info.strikeMicros);
      result.gapAtCloseBps = result.side === "UP" ? raw : -raw;
    }
    risk.onRealizedPnl(pnl);
    strategy.onResolution(info.id, result.filled ? pnl > 0 : null);
    results.push(result);
  }

  return {
    results,
    totalPnlUsdMicros: exchange.realizedPnl,
    killSwitchTripped: risk.tripped,
  };
}
