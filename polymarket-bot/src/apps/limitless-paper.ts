/**
 * Limitless (Base) paper trading + tick recording for 5m/15m crypto Up/Down
 * markets, using the same ResolutionMakerSnipe strategy as Polymarket.
 *
 *   npm run limitless:paper -- --asset BTC --cadence 300
 *
 * Execution model:
 *  - All fills are simulated by the conservative PaperExchange.
 *  - If LIMITLESS_PRIVATE_KEY + LIMITLESS_VERIFYING_CONTRACT are set, every
 *    strategy action is ALSO mirrored to the LimitlessExecutor, which stays in
 *    dry-run (build + sign + log, no POST) unless LIMITLESS_DRY_RUN=false AND
 *    TRADING_ENABLED=true AND LIMITLESS_TRADING_ENABLED=true.
 *  - Oracle: Limitless socket oracle feed when seen, Binance proxy otherwise.
 */
import { mkdirSync, createWriteStream } from "node:fs";
import { loadRiskLimits, loadSnipeConfig } from "../core/config.js";
import { Logger } from "../core/logger.js";
import { formatMicros, MICRO } from "../core/fixed.js";
import type { Asset, BookTop, MarketInfo, OracleTick, UpDown } from "../core/types.js";
import { privateKeyToAccount } from "viem/accounts";
import { LimitlessClient } from "../connectors/limitless/client.js";
import { LimitlessSocket } from "../connectors/limitless/socket.js";
import { LimitlessExecutor, executorOptionsFromEnv } from "../execution/limitless-executor.js";
import { BinanceOracle } from "../oracle/binance.js";
import { PaperExchange } from "../execution/paper-exchange.js";
import { RiskEngine } from "../risk/risk-engine.js";
import { ResolutionMakerSnipe } from "../strategies/resolution-maker-snipe.js";

const log = new Logger("limitless-paper");

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

async function maybeBuildExecutor(client: LimitlessClient, risk: RiskEngine): Promise<LimitlessExecutor | null> {
  const pk = process.env["LIMITLESS_PRIVATE_KEY"];
  if (!pk) return null;
  try {
    if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("LIMITLESS_PRIVATE_KEY malformed");
    const account = privateKeyToAccount(pk as `0x${string}`);
    const options = executorOptionsFromEnv();
    const executor = new LimitlessExecutor(client, account, risk, options);
    if (options.enabled && !options.dryRun) {
      if (!client.hasApiKey) throw new Error("LIMITLESS_API_KEY required for live trading");
      await executor.loadProfile(); // ownerId is mandatory on order payloads
      log.warn("LIVE Limitless trading is ENABLED — orders will be submitted");
    } else {
      log.info("Limitless executor in dry-run (orders signed but not submitted)");
    }
    return executor;
  } catch (err) {
    log.warn("executor not started", { message: (err as Error).message });
    return null;
  }
}

async function main(): Promise<void> {
  const { asset, cadence } = parseArgs();
  const snipeCfg = loadSnipeConfig();
  const risk = new RiskEngine(loadRiskLimits());
  const strategy = new ResolutionMakerSnipe(snipeCfg, risk);
  // Limitless's public feed has no trade prints, so paper fills use the
  // book-cross mode: fill only when the ask quotes through our bid level.
  const exchange = new PaperExchange(250, true);
  const client = new LimitlessClient();
  const executor = await maybeBuildExecutor(client, risk);

  mkdirSync("data", { recursive: true });
  const recorder = createWriteStream(`data/limitless-${asset}-${cadence}-${Date.now()}.jsonl`, { flags: "a" });
  const record = (kind: string, payload: unknown): void => {
    recorder.write(JSON.stringify({ kind, tsMs: Date.now(), payload }) + "\n");
  };

  let current: MarketInfo | null = null;
  let socket: LimitlessSocket | null = null;
  let lastOracle: OracleTick | null = null;
  let lastSocketOracleMs = 0;
  let lastSocketBookMs = 0;
  let liveOrderId: string | null = null;

  const onOracle = (tick: OracleTick): void => {
    lastOracle = tick;
    record("oracle", tick);
    if (!current) return;
    if (current.strikeMicros === 0 && tick.tsMs >= current.openTsMs) {
      current = { ...current, strikeMicros: tick.valueMicros };
      strategy.trackMarket(current);
      log.info("strike set", { market: current.id, source: tick.source, strike: formatMicros(tick.valueMicros) });
    }
    strategy.onOracle(current.id, tick);
    applyActions();
  };

  // Binance proxy oracle: only used while the Limitless oracle stream is quiet.
  const binance = new BinanceOracle(`${asset.toLowerCase()}usdt`, (tick) => {
    if (Date.now() - lastSocketOracleMs > 2_000) onOracle(tick);
  });
  binance.start();

  const applyActions = (): void => {
    if (!current) return;
    const market = current;
    const actions = strategy.evaluate(market.id, Date.now());
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
          const side: UpDown = action.tokenId === market.upTokenId ? "UP" : "DOWN";
          strategy.onOrderAccepted(
            { id: order.id, tokenId: order.tokenId, priceMicros: order.priceMicros, sizeMicros: order.sizeMicros },
            action.marketId,
            side,
          );
          risk.onOrderPlaced();
          log.info("paper order placed", { id: order.id, price: formatMicros(order.priceMicros, 3) });
          if (executor) {
            void executor
              .placePostOnlyBuy({
                marketId: action.marketId,
                marketSlug: market.slug,
                tokenId: action.tokenId,
                priceMicros: action.priceMicros,
                sizeMicros: action.sizeMicros,
                ...(market.exchangeAddress ? { exchangeAddress: market.exchangeAddress } : {}),
              })
              .then((placed) => {
                record("live-order", placed);
                if (placed.status === "open") liveOrderId = placed.id;
              });
          }
        }
      } else {
        if (exchange.cancel(action.orderId)) {
          risk.onOrderClosed();
          record("cancel", { orderId: action.orderId, reason: action.reason });
          log.info("paper order cancelled", { id: action.orderId, reason: action.reason });
        }
        if (executor && liveOrderId) {
          void executor.cancel(market.id, liveOrderId);
          liveOrderId = null;
        }
      }
    }
  };

  const handleBook = (top: BookTop): void => {
    if (!current) return;
    record("book", top);
    strategy.onBook(current.id, top);
    // Book-cross mode: book updates can generate paper fills on this venue.
    const fills = exchange.onBook(top);
    for (const f of fills) {
      strategy.onFill(f);
      risk.onFill(f.marketId, f.priceMicros, f.sizeMicros);
      risk.onOrderClosed();
      record("fill", f);
      log.info("paper FILL (book-cross)", { order: f.orderId, price: formatMicros(f.priceMicros, 3) });
    }
    executor?.onBook(top);
    applyActions();
  };

  // REST orderbook polling fallback while socket book events are quiet.
  // VERIFY: assumes /markets/{slug}/orderbook returns the YES/UP-token book;
  // the DOWN book is derived as its mirror (shared binary CLOB liquidity).
  const pollBooks = async (): Promise<void> => {
    if (!current || Date.now() - lastSocketBookMs < 3_000) return;
    try {
      const { normalizeLimitlessBook } = await import("../connectors/limitless/client.js");
      const raw = await client.fetchOrderbook(current.slug);
      const upTop = normalizeLimitlessBook(current.upTokenId, raw, Date.now());
      handleBook(upTop);
      if (upTop.askMicros < Number.MAX_SAFE_INTEGER && upTop.bidMicros > 0) {
        handleBook({
          tokenId: current.downTokenId,
          bidMicros: MICRO - upTop.askMicros,
          askMicros: MICRO - upTop.bidMicros,
          bidSizeMicros: upTop.askSizeMicros,
          askSizeMicros: upTop.bidSizeMicros,
          tsMs: upTop.tsMs,
        });
      }
    } catch (err) {
      log.debug("orderbook poll failed", { message: (err as Error).message });
    }
  };
  const pollTimer = setInterval(() => void pollBooks(), 1_500);

  const rollMarket = async (): Promise<void> => {
    try {
      const found = await client.discoverUpDownMarkets(asset, cadence);
      const next = found[0];
      if (!next) {
        log.warn("no active limitless market found; retrying in 10s");
        setTimeout(() => void rollMarket(), 10_000);
        return;
      }
      current = next.info;
      strategy.trackMarket(current);
      record("market", current);
      log.info("tracking market", { id: current.id, closesInSec: Math.round((current.closeTsMs - Date.now()) / 1000) });

      socket?.stop();
      socket = new LimitlessSocket(
        current.slug,
        { up: current.upTokenId, down: current.downTokenId },
        {
          onBook: (top) => {
            lastSocketBookMs = Date.now();
            handleBook(top);
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
              log.info("paper FILL", { order: f.orderId, price: formatMicros(f.priceMicros, 3) });
            }
            applyActions();
          },
          onOracle: (tick) => {
            lastSocketOracleMs = Date.now();
            onOracle(tick);
          },
          onDisconnect: () => {
            const n = exchange.cancelAll();
            if (n > 0) log.warn("cancelled paper orders on disconnect", { count: n });
            void executor?.cancelAll();
          },
        },
      );
      socket.start();

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
        strategy.onResolution(current.id, pnl !== 0 ? pnl > 0 : null);
        record("resolution", { marketId: current.id, winner, pnlUsdMicros: pnl });
        log.info("market resolved (paper)", {
          market: current.id,
          winner,
          pnl: formatMicros(pnl),
          totalPnl: formatMicros(exchange.realizedPnl),
          killSwitch: risk.tripped,
        });
        liveOrderId = null;
        void rollMarket();
      }, Math.max(1_000, settleDelayMs));
    } catch (err) {
      log.error("rollMarket failed", { message: (err as Error).message });
      setTimeout(() => void rollMarket(), 10_000);
    }
  };

  process.on("SIGINT", () => {
    log.info("shutting down", { cancelledPaper: exchange.cancelAll() });
    void (async () => {
      await executor?.cancelAll();
      clearInterval(pollTimer);
      socket?.stop();
      binance.stop();
      recorder.end();
      process.exit(0);
    })();
  });

  await rollMarket();
}

void main();
