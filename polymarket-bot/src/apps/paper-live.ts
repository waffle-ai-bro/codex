/**
 * Live PAPER trading loop for Polymarket short-duration Up/Down markets.
 * Places NO real orders — all execution goes through the conservative
 * PaperExchange. Also records all ticks to data/*.jsonl for later replay.
 *
 * Requires outbound network access to Polymarket + Binance. Run:
 *   npm run paper:live -- --asset BTC --cadence 300
 *
 * Oracle: Polymarket RTDS `crypto_prices_chainlink` (the closest public proxy
 * to the actual Chainlink settlement feed) with Binance as fallback while the
 * RTDS stream is quiet (spec B5 source priority).
 */
import { mkdirSync, createWriteStream } from "node:fs";
import { loadRiskLimits, loadSnipeConfig } from "../core/config.js";
import { Logger } from "../core/logger.js";
import { formatMicros } from "../core/fixed.js";
import type { Asset, MarketInfo, OracleTick, UpDown } from "../core/types.js";
import { discoverUpDownMarkets } from "../connectors/polymarket/gamma.js";
import { MarketWs } from "../connectors/polymarket/ws-market.js";
import { RtdsOracle } from "../connectors/polymarket/rtds.js";
import { BinanceOracle } from "../oracle/binance.js";
import { PaperExchange } from "../execution/paper-exchange.js";
import { RiskEngine } from "../risk/risk-engine.js";
import { ResolutionMakerSnipe } from "../strategies/resolution-maker-snipe.js";

const log = new Logger("paper-live");

function parseArgs(): { asset: Asset; cadence: 300 | 900 } {
  const argv = process.argv.slice(2);
  let asset: Asset = "BTC";
  let cadence: 300 | 900 = 300;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--asset") asset = String(argv[++i]).toUpperCase() as Asset;
    else if (argv[i] === "--cadence") cadence = Number(argv[++i]) === 900 ? 900 : 300;
  }
  return { asset, cadence };
}

async function main(): Promise<void> {
  const { asset, cadence } = parseArgs();
  const snipeCfg = loadSnipeConfig();
  const risk = new RiskEngine(loadRiskLimits());
  const strategy = new ResolutionMakerSnipe(snipeCfg, risk);
  const exchange = new PaperExchange();

  mkdirSync("data", { recursive: true });
  const recorder = createWriteStream(`data/ticks-${asset}-${cadence}-${Date.now()}.jsonl`, { flags: "a" });
  const record = (kind: string, payload: unknown): void => {
    recorder.write(JSON.stringify({ kind, tsMs: Date.now(), payload }) + "\n");
  };

  let lastOracle: OracleTick | null = null;
  let lastRtdsMs = 0;
  const onOracle = (tick: OracleTick): void => {
    lastOracle = tick;
    record("oracle", tick);
    if (current) {
      if (current.strikeMicros === 0 && tick.tsMs >= current.openTsMs) {
        current = { ...current, strikeMicros: tick.valueMicros };
        strategy.trackMarket(current);
        log.info("strike set", { market: current.id, source: tick.source, strike: formatMicros(tick.valueMicros) });
      }
      strategy.onOracle(current.id, tick);
      applyActions();
    }
  };
  // Primary: RTDS Chainlink stream (settlement-adjacent). Fallback: Binance.
  const rtds = new RtdsOracle(asset, (tick) => {
    lastRtdsMs = Date.now();
    onOracle(tick);
  });
  rtds.start();
  const binance = new BinanceOracle(`${asset.toLowerCase()}usdt`, (tick) => {
    if (Date.now() - lastRtdsMs > 2_000) onOracle(tick);
  });
  binance.start();

  let current: MarketInfo | null = null;
  let ws: MarketWs | null = null;

  const applyActions = (): void => {
    if (!current) return;
    const actions = strategy.evaluate(current.id, Date.now());
    for (const action of actions) {
      if (action.kind === "place") {
        const order = exchange.placePostOnlyBuy({
          marketId: action.marketId,
          tokenId: action.tokenId,
          priceMicros: action.priceMicros,
          sizeMicros: action.sizeMicros,
          tsMs: Date.now(),
        });
        record("order", order);
        if (order.status === "open") {
          const side: UpDown = action.tokenId === current.upTokenId ? "UP" : "DOWN";
          strategy.onOrderAccepted(
            { id: order.id, tokenId: order.tokenId, priceMicros: order.priceMicros, sizeMicros: order.sizeMicros },
            action.marketId,
            side,
          );
          risk.onOrderPlaced();
          log.info("paper order placed", { id: order.id, price: formatMicros(order.priceMicros, 3), reason: action.reason });
        } else {
          log.info("paper order rejected", { reason: order.rejectReason ?? "unknown" });
        }
      } else {
        if (exchange.cancel(action.orderId)) {
          risk.onOrderClosed();
          record("cancel", { orderId: action.orderId, reason: action.reason });
          log.info("paper order cancelled", { id: action.orderId, reason: action.reason });
        }
      }
    }
  };

  const rollMarket = async (): Promise<void> => {
    try {
      const found = await discoverUpDownMarkets(asset, cadence);
      const next = found.find((f) => f.info.closeTsMs > Date.now() + 5_000);
      if (!next) {
        log.warn("no active market found; retrying in 10s");
        setTimeout(() => void rollMarket(), 10_000);
        return;
      }
      current = next.info;
      strategy.trackMarket(current);
      record("market", current);
      log.info("tracking market", { id: current.id, closesInSec: Math.round((current.closeTsMs - Date.now()) / 1000) });

      ws?.stop();
      ws = new MarketWs([current.upTokenId, current.downTokenId], {
        onBook: (top) => {
          if (!current) return;
          record("book", top);
          strategy.onBook(current.id, top);
          exchange.onBook(top);
          applyActions();
        },
        onTrade: (trade) => {
          if (!current) return;
          record("trade", trade);
          const fills = exchange.onTrade(trade);
          for (const f of fills) {
            strategy.onFill(f);
            risk.onFill(f.marketId, f.priceMicros, f.sizeMicros);
            risk.onOrderClosed();
            record("fill", f);
            log.info("paper FILL", { order: f.orderId, price: formatMicros(f.priceMicros, 3), size: formatMicros(f.sizeMicros) });
          }
          applyActions();
        },
        onTickSizeChange: (tokenId, newTickMicros) => {
          // Stale-tick orders get rejected by the venue; track the change.
          if (!current) return;
          if (tokenId === current.upTokenId || tokenId === current.downTokenId) {
            current = { ...current, tickSizeMicros: newTickMicros };
            strategy.trackMarket(current);
            log.info("tick size changed", { tokenId, newTickMicros });
          }
        },
        onDisconnect: () => {
          // Safety: a dead feed means stale state; cancel resting paper orders.
          const n = exchange.cancelAll();
          if (n > 0) log.warn("cancelled paper orders on disconnect", { count: n });
        },
      });
      ws.start();

      // Settle shortly after close using the proxy oracle value.
      const settleDelayMs = current.closeTsMs - Date.now() + 2_000;
      setTimeout(() => {
        if (!current || !lastOracle) return;
        const winner: UpDown = lastOracle.valueMicros > current.strikeMicros ? "UP" : "DOWN";
        const winnerToken = winner === "UP" ? current.upTokenId : current.downTokenId;
        const loserToken = winner === "UP" ? current.downTokenId : current.upTokenId;
        const pnl = exchange.settle(
          { marketId: current.id, winner, settleValueMicros: lastOracle.valueMicros, tsMs: Date.now() },
          winnerToken,
          loserToken,
        );
        risk.onRealizedPnl(pnl);
        const hadPosition = pnl !== 0;
        strategy.onResolution(current.id, hadPosition ? pnl > 0 : null);
        record("resolution", { marketId: current.id, winner, pnlUsdMicros: pnl });
        log.info("market resolved (paper)", {
          market: current.id,
          winner,
          pnl: formatMicros(pnl),
          totalPnl: formatMicros(exchange.realizedPnl),
          killSwitch: risk.tripped,
        });
        void rollMarket();
      }, Math.max(1_000, settleDelayMs));
    } catch (err) {
      log.error("rollMarket failed", { message: (err as Error).message });
      setTimeout(() => void rollMarket(), 10_000);
    }
  };

  process.on("SIGINT", () => {
    log.info("shutting down; cancelling paper orders", { cancelled: exchange.cancelAll() });
    ws?.stop();
    rtds.stop();
    binance.stop();
    recorder.end();
    process.exit(0);
  });

  await rollMarket();
}

void main();
