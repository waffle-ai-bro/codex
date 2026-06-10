/**
 * Paper-trading profitability study on synthetic markets.
 *
 * Usage:
 *   npm run simulate -- --markets 2000 --seed 42
 *   npm run simulate -- --markets 2000 --grid          # sweep adverse-selection / entry-price grid
 *
 * IMPORTANT: synthetic results validate mechanics and sensitivity, not
 * real-world edge. Go/no-go for real money requires recorded live tick data
 * (spec addendum section G).
 */
import { loadRiskLimits, loadSnipeConfig } from "../core/config.js";
import { DEFAULT_SIM_PARAMS, generateMarket, type SimMarket, type SimParams } from "../sim/market-sim.js";
import { buildReport, renderReport, type SimReport } from "../sim/report.js";
import { runMarkets } from "../sim/runner.js";

interface CliArgs {
  markets: number;
  seed: number;
  grid: boolean;
  maxEntry: string;
  informed: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { markets: 1000, seed: 42, grid: false, maxEntry: "0.95", informed: DEFAULT_SIM_PARAMS.informedSellProbPerStep };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--markets") args.markets = Number(argv[++i]);
    else if (a === "--seed") args.seed = Number(argv[++i]);
    else if (a === "--grid") args.grid = true;
    else if (a === "--max-entry") args.maxEntry = String(argv[++i]);
    else if (a === "--informed") args.informed = Number(argv[++i]);
  }
  return args;
}

function generate(params: SimParams, n: number): SimMarket[] {
  const out: SimMarket[] = [];
  for (let i = 0; i < n; i++) out.push(generateMarket(params, i));
  return out;
}

function runOnce(markets: SimMarket[], maxEntry: string): SimReport {
  const cfg = loadSnipeConfig({ maxEntryPriceMicros: maxEntry, minLockedPriceMicros: maxEntry });
  // Generous limits for the study so the kill switch doesn't censor tail losses.
  const limits = loadRiskLimits({ maxUsdPerOrderMicros: "5.00", maxUsdPerMarketMicros: "5.00", maxDailyLossUsdMicros: "100000.00" });
  const { results } = runMarkets(markets, cfg, limits);
  return buildReport(results);
}

const args = parseArgs(process.argv.slice(2));

if (!args.grid) {
  const params: SimParams = { ...DEFAULT_SIM_PARAMS, seed: args.seed, informedSellProbPerStep: args.informed };
  const markets = generate(params, args.markets);
  const upWins = markets.filter((m) => m.winner === "UP").length;
  console.log(`generated ${markets.length} markets (UP wins ${upWins}, DOWN wins ${markets.length - upWins})`);
  const report = runOnce(markets, args.maxEntry);
  console.log(renderReport(`ResolutionMakerSnipe @ maxEntry=$${args.maxEntry}, informedFlow=${args.informed}`, report));
} else {
  // Sensitivity grid: the strategy's fate is decided by adverse selection.
  const informedLevels = [0, 0.1, 0.35, 0.7];
  const entries = ["0.90", "0.93", "0.95", "0.97"];
  console.log(`grid: ${args.markets} markets per cell, seed ${args.seed}`);
  console.log("");
  const rows: string[][] = [["informed\\maxEntry", ...entries.map((e) => `$${e}`)]];
  for (const informed of informedLevels) {
    const params: SimParams = { ...DEFAULT_SIM_PARAMS, seed: args.seed, informedSellProbPerStep: informed };
    const markets = generate(params, args.markets);
    const row: string[] = [String(informed)];
    for (const entry of entries) {
      const r = runOnce(markets, entry);
      row.push(`$${r.totalPnlUsd} (${r.fills}f, ${r.winRateGivenFillPct}%)`);
    }
    rows.push(row);
  }
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)));
  for (const row of rows) {
    console.log(row.map((cell, c) => cell.padEnd(widths[c]! + 2)).join(""));
  }
  console.log("\ncells: total PnL (fills, win rate given fill) at $5 max order notional");
}
