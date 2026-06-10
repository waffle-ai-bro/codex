/**
 * Phase-1 data recorder (spec addendum E): record orderbook tops, trades and
 * proxy-oracle ticks for short-duration markets WITHOUT any strategy running.
 * Output: data/ticks-*.jsonl — the input for honest fill-simulation backtests.
 *
 *   npm run record -- --asset BTC --cadence 300
 */
import { mkdirSync, createWriteStream } from "node:fs";
import { Logger } from "../core/logger.js";
import type { Asset } from "../core/types.js";
import { discoverUpDownMarkets } from "../connectors/polymarket/gamma.js";
import { MarketWs } from "../connectors/polymarket/ws-market.js";
import { BinanceOracle } from "../oracle/binance.js";

const log = new Logger("recorder");

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
  mkdirSync("data", { recursive: true });
  const out = createWriteStream(`data/ticks-${asset}-${cadence}-${Date.now()}.jsonl`, { flags: "a" });
  const record = (kind: string, payload: unknown): void => {
    out.write(JSON.stringify({ kind, tsMs: Date.now(), payload }) + "\n");
  };

  const oracle = new BinanceOracle(`${asset.toLowerCase()}usdt`, (tick) => record("oracle", tick));
  oracle.start();

  let ws: MarketWs | null = null;
  const roll = async (): Promise<void> => {
    try {
      const found = await discoverUpDownMarkets(asset, cadence);
      const next = found.find((f) => f.info.closeTsMs > Date.now() + 5_000);
      if (!next) {
        setTimeout(() => void roll(), 10_000);
        return;
      }
      record("market", next.info);
      log.info("recording market", { id: next.info.id });
      ws?.stop();
      ws = new MarketWs([next.info.upTokenId, next.info.downTokenId], {
        onBook: (top) => record("book", top),
        onTrade: (trade) => record("trade", trade),
      });
      ws.start();
      setTimeout(() => void roll(), Math.max(1_000, next.info.closeTsMs - Date.now() + 2_000));
    } catch (err) {
      log.error("roll failed", { message: (err as Error).message });
      setTimeout(() => void roll(), 10_000);
    }
  };

  process.on("SIGINT", () => {
    ws?.stop();
    oracle.stop();
    out.end();
    process.exit(0);
  });

  await roll();
}

void main();
