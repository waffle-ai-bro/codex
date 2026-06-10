# polymarket-bot

TypeScript prediction-market bot implementing the **ResolutionMakerSnipe** module from
`prediction_market_bot_build_spec_v2` + the Moon Dev / PolySnipe addendum: a last-minute
**post-only maker bid** on the locked side of Polymarket short-duration (5m/15m) BTC/ETH
Up/Down markets, with strict entry conditions, stand-down guards, risk gates, and a
deliberately conservative paper-trading engine.

**No live trading exists in this codebase.** All execution goes through a paper exchange.

## Layout

```
src/core/        fixed-point math (no floats for money), types, config (zod), logger
src/strategies/  resolution-maker-snipe.ts  - deterministic strategy state machine
                 post-only-bid.ts           - spec B3 price chooser
src/risk/        risk-engine.ts             - pre-trade gates + kill switch (manual unlock)
src/execution/   paper-exchange.ts          - conservative maker fill model
                 limitless-executor.ts      - live trading service (risk-gated, dry-run default)
src/connectors/  polymarket/gamma.ts        - market discovery (slug-based, 5m/15m windows)
                 polymarket/clob.ts         - public REST book fetch + normalization
                 polymarket/ws-market.ts    - market WebSocket (reconnect, normalize)
                 limitless/client.ts        - Limitless (Base) REST: discovery, books, orders
                 limitless/socket.ts        - Limitless Socket.IO feed (book/trade/oracle)
                 limitless/auth.ts          - wallet-signature session login (viem)
                 limitless/orders.ts        - EIP-712 CLOB order build + sign (CTF-style)
src/oracle/      binance.ts                 - PROXY oracle (NOT the settlement source)
src/sim/         market-sim.ts              - synthetic GBM markets w/ adverse-selection model
                 runner.ts, report.ts       - replay pipeline + profitability metrics
src/apps/        simulate.ts                - paper-trading profitability study (offline)
                 paper-live.ts              - live-data paper trading + tick recorder (Polymarket)
                 limitless-paper.ts         - live-data paper trading + tick recorder (Limitless)
                 record.ts                  - Phase-1 data recorder (no strategy)
test/            75 smoke/unit tests (vitest)
```

## Quick start

```bash
npm install
npm test                 # 54 tests: math, pricing, fills, guards, risk, sim pipeline
npm run typecheck

# offline profitability study (synthetic markets, deterministic by seed)
npm run simulate -- --markets 2000 --seed 42
npm run simulate -- --markets 1500 --grid        # adverse-selection x entry-price grid

# with outbound network access (Polymarket + Binance reachable):
npm run record    -- --asset BTC --cadence 300   # Phase 1: record real ticks, no strategy
npm run paper:live -- --asset BTC --cadence 300  # paper trade against live books

# Limitless (Base) — paper trade + record their 5m Up/Down markets:
npm run limitless:paper -- --asset BTC --cadence 300
```

## Limitless integration

Same strategy, second venue (spec addendum Priority 2). The connector layer mirrors
Polymarket's: REST discovery filters active markets down to short-duration crypto
"Up or Down" markets, the Socket.IO feed streams books/trades/oracle prices (their
`oraclePriceData`-style stream is preferred over the Binance proxy when present), and
`limitless-paper` runs the identical ResolutionMakerSnipe + PaperExchange pipeline,
recording everything to `data/limitless-*.jsonl`.

**Trading service** (`src/execution/limitless-executor.ts`): builds CTF-exchange-style
CLOB orders (USDC on Base, 6 decimals == our internal micros), signs them EIP-712 via
`viem`, and submits through the authenticated REST API. Defense in depth:

1. Hard-disabled unless `TRADING_ENABLED=true` **and** `LIMITLESS_TRADING_ENABLED=true`.
2. `LIMITLESS_DRY_RUN` defaults to **on**: orders are built, signed and logged, never POSTed.
3. Client-side post-only check — a buy that would cross the latest book is rejected locally.
4. Every order passes the shared `RiskEngine` (same caps as paper).
5. Failed cancels, missing order ids, and cancel-all failures trip the kill switch.
6. `LIMITLESS_VERIFYING_CONTRACT` has **no default** — live signing refuses to start
   until you set the real exchange contract address.

Env vars:

```bash
LIMITLESS_API_BASE=https://api.limitless.exchange     # default
LIMITLESS_WS_BASE=https://ws.limitless.exchange       # default
LIMITLESS_PRIVATE_KEY=__never_commit__                # EOA on Base, small funds only
LIMITLESS_VERIFYING_CONTRACT=                         # REQUIRED for live: CTF exchange addr
LIMITLESS_DOMAIN_NAME="Limitless CTF Exchange"        # VERIFY against docs/contract
LIMITLESS_CHAIN_ID=8453
TRADING_ENABLED=false
LIMITLESS_TRADING_ENABLED=false
LIMITLESS_DRY_RUN=true
LIMITLESS_ORDER_TYPE=GTC                              # or GTD + LIMITLESS_ORDER_TTL_SEC
```

### Limitless first-connected-run verification checklist

This integration was written **without** live API access (this build environment blocks
outbound traffic), against Limitless docs and public reference bots. Items marked
`VERIFY` in the source must be confirmed on the first networked run, in this order:

1. `GET /markets/active` — pagination params and response envelope (`data` vs array).
2. Market fields: `slug`, `deadline`, `tokens.{yes,no}` vs `clobTokenIds`, `minTickSize`.
3. `GET /markets/{slug}/orderbook` — path and level field names; whether the book is
   YES-token-denominated (the REST fallback derives the DOWN book as its mirror).
4. Socket.IO: run once with `LOG_LEVEL=debug`, capture real event names, pin them in
   `socket.ts` (currently routed by pattern: orderbook/trade/oracle).
5. Auth: signing-message header names (`x-account`/`x-signature`/`x-signing-message`)
   and session cookie behavior.
6. EIP-712 domain: name/version + the verifying contract address of their CTF exchange
   on Base; cross-check a signed order against their SDK or a known-good payload.
7. Order POST payload shape (`order`, `orderType`, `marketSlug`, post-only flag name).

Until 1–5 pass, run paper-only. Until 6–7 are cross-checked, keep `LIMITLESS_DRY_RUN=true`.

## Strategy in one paragraph

In the final 60s→4s of a 5-minute BTC Up/Down market, if the proxy oracle shows the
underlying clearly on one side of the strike (gap ≥ 8bps and ≥ 2.5× recent realized vol),
the locked side's book is priced ≥ $0.95 with a sane spread, and risk gates pass, rest a
**post-only** bid at `min($0.95, ask - tick)` (joining, never crossing). Cancel instantly
if the side flips, the gap collapses, the price fades, a feed goes stale, the spread blows
out, or resolution is < 3s away. One fill per market; after a loss, stand down for 10
markets.

## Paper-trading fill model (why results here are believable)

A paper bid only fills when an **observed SELL trade prints at ≤ our price, after our
placement timestamp + 250ms latency grace**, and only after the visible queue ahead at our
level is depleted. Post-only orders that would cross are rejected, never converted to
taker. This kills the classic backtest lie where every $0.95 bid fills.

## Simulation findings (synthetic, 5,000 markets/run, $5 max order)

| config | fills | win rate given fill | total PnL |
|---|---|---|---|
| maxEntry $0.95, seed 42, 2k mkts | 153 | 95.4% | **+$3.58** |
| maxEntry $0.95, seed 7, 5k mkts | 390 | 90.8% | **−$86.49** |
| maxEntry $0.97, seed 7, 5k mkts | 868 | 94.5% | −$112.16 |
| stricter gap/vol filters | 0–120 | ≤92.5% | ≤ −$12.61 |

Takeaways, consistent with the spec's warnings:

1. **Breakeven at $0.95 is a 95% fill-conditioned win rate.** The sim's adverse-selection
   drag (2–7pp between "all signals" and "given fill" win rates) is enough to flip the
   sign. Seed 42 looked profitable; seed 7 with more markets did not — the apparent edge
   is within tail-risk noise.
2. **Conditioning is the trap:** when a market is truly locked, the book trades at
   0.97–0.99 and a capped $0.95 bid can't be placed competitively; when your $0.95 bid is
   fillable, that's evidence the outcome is less locked than it looks. Tightening filters
   drove orders to zero rather than to profit.
3. One full loss erases ~19 wins at $0.95 (~32 at $0.97). Max drawdown reached ~24× the
   average win in losing runs.

**These are synthetic results.** They validate the pipeline and the *sensitivity* of the
strategy, not real-world PnL. The model's informed-seller intensity is an assumption; the
real number must be measured. Per spec section G, go/no-go for any real money requires
1,000+ **recorded** live markets (`npm run record`), fill-conditioned EV measured on real
trade prints, and positive EV surviving a safety haircut. The sim says: do not expect
the naive $0.95 snipe to clear that bar without an additional, real edge (e.g. a faster
oracle feed than the marginal seller).

## Live-data caveats

- `paper-live` settles using the **Binance proxy** feed. Polymarket actually settles
  short-duration crypto on **Chainlink Data Streams** — never assume they match (spec B5).
  Wire RTDS/Chainlink in before trusting paper PnL near ties.
- Connectors were written against documented schemas but could not be exercised against
  the live APIs from this build environment (no outbound network); verify
  `gamma.ts` field names and the WS event shapes on first connected run.
- Heartbeat/cancel-on-disconnect: paper-live cancels all paper orders on WS disconnect.
  A future live executor must use Polymarket's heartbeat facility and post-only GTC/GTD.
