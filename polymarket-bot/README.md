# polymarket-bot

TypeScript prediction-market bot for **short-duration (5m/15m) crypto Up/Down markets** on
**Polymarket** and **Limitless (Base)**, implementing the **ResolutionMakerSnipe** strategy
from the build spec + Moon Dev / PolySnipe addendum: a last-minute **post-only maker bid**
on the locked side, with strict entry conditions, stand-down guards, shared risk gates, and
a deliberately conservative paper-trading engine.

**Live trading is off by default and triple-gated.** Everything runs as paper trading until
you explicitly flip the switches described below.

---

## 1. Install

Requirements: **Node.js >= 22** (uses native `fetch`), npm.

```bash
cd polymarket-bot
npm install
cp .env.example .env        # then edit .env (only needed for live data / trading)
```

Verify the build:

```bash
npm run typecheck           # tsc strict mode, no emit
npm test                    # 85 unit/smoke tests
```

## 2. Run

### Offline profitability study (no network, no keys)

```bash
npm run simulate -- --markets 2000 --seed 42          # single run
npm run simulate -- --markets 1500 --grid             # adverse-selection x entry-price grid
npm run simulate -- --markets 5000 --max-entry 0.97   # custom entry cap
```

### Record real market data (network, no keys) — do this first

Phase 1 of the spec: capture tick data for the go/no-go analysis.

```bash
npm run record -- --asset BTC --cadence 300           # Polymarket 5m BTC, no strategy
```

Output: `data/ticks-*.jsonl` (markets, book tops, trades, oracle ticks).

### Paper trade against live books (network, no keys)

```bash
npm run paper:live      -- --asset BTC --cadence 300  # Polymarket
npm run limitless:paper -- --asset BTC --cadence 300  # Limitless (Base)
```

Both run the full strategy + risk engine + paper exchange against live data, log every
decision, and record all ticks. `limitless:paper` additionally mirrors strategy actions
through the live executor **in dry-run** (orders are built and EIP-712-signed but never
submitted) when `LIMITLESS_PRIVATE_KEY` is set — useful for verifying payloads.

### Live trading (Limitless; only after the checklist in §6)

All three must be set, deliberately:

```bash
TRADING_ENABLED=true LIMITLESS_TRADING_ENABLED=true LIMITLESS_DRY_RUN=false \
  npm run limitless:paper -- --asset BTC --cadence 300
```

There is intentionally **no Polymarket live executor yet** (spec stages paper → tiny live).

## 3. Environment variables

Public market data needs **no keys** on either venue. Copy `.env.example` and fill in what
you use:

| Variable | Default | Purpose |
|---|---|---|
| `LOG_LEVEL` | `info` | `debug` shows raw WS event routing |
| `TRADING_ENABLED` | `false` | Master live-trading switch (both venues) |
| `LIMITLESS_TRADING_ENABLED` | `false` | Second switch required for Limitless live orders |
| `LIMITLESS_DRY_RUN` | `true` | Build + sign + log orders without submitting |
| `POLYMARKET_GAMMA_BASE` | gamma-api.polymarket.com | Market discovery REST |
| `POLYMARKET_CLOB_HOST` | clob.polymarket.com | CLOB REST (books) |
| `POLYMARKET_WS_MARKET_URL` | ws-subscriptions-clob…/ws/market | Market WS channel |
| `POLYMARKET_RTDS_URL` | ws-live-data.polymarket.com | RTDS (Chainlink crypto prices) |
| `LIMITLESS_API_BASE` | api.limitless.exchange | REST |
| `LIMITLESS_WS_BASE` | ws.limitless.exchange | Socket.IO (`/markets` namespace) |
| `LIMITLESS_API_KEY` | — | `X-API-Key` for authenticated REST (profile/orders) |
| `LIMITLESS_PRIVATE_KEY` | — | EOA key, signs orders only; dedicated small hot wallet |
| `LIMITLESS_VERIFYING_CONTRACT` | — | Optional pin; normally read from `market.venue.exchange` |
| `LIMITLESS_DOMAIN_NAME` | `Limitless CTF Exchange` | EIP-712 domain (SDK-verified) |
| `LIMITLESS_CHAIN_ID` | `8453` | Base mainnet |
| `LIMITLESS_ORDER_TYPE` | `GTC` | `GTD` = GTC + expiration (`LIMITLESS_ORDER_TTL_SEC`) |

Secret hygiene: keys are read from env only, never logged (the logger redacts
`key|secret|signature|token|…` fields), and never required for paper mode.

## 4. Layout

```
src/core/        fixed-point math (no floats for money), types, config (zod), logger
src/strategies/  resolution-maker-snipe.ts  - deterministic strategy state machine
                 post-only-bid.ts           - spec B3 price chooser
src/risk/        risk-engine.ts             - pre-trade gates + kill switch (manual unlock)
src/execution/   paper-exchange.ts          - conservative maker fill model (trade-print
                                              mode + book-cross mode)
                 limitless-executor.ts      - live trading service (risk-gated, dry-run default)
src/connectors/  polymarket/gamma.ts        - market discovery (slug-based, 5m/15m windows)
                 polymarket/clob.ts         - public REST book fetch + normalization
                 polymarket/ws-market.ts    - market WS: book, price_change, best_bid_ask,
                                              tick_size_change, last_trade_price
                 polymarket/rtds.ts         - RTDS crypto_prices_chainlink oracle feed
                 limitless/client.ts        - REST: discovery, books, profile, orders
                 limitless/socket.ts        - Socket.IO /markets: orderbookUpdate, oraclePriceData
                 limitless/orders.ts        - EIP-712 CTF order build + sign (Base 8453)
src/oracle/      binance.ts                 - fallback proxy oracle (NOT a settlement source)
src/sim/         market-sim.ts              - synthetic GBM markets w/ adverse-selection model
                 runner.ts, report.ts       - replay pipeline + profitability metrics
src/apps/        simulate.ts, paper-live.ts, limitless-paper.ts, record.ts
test/            85 unit/smoke tests (vitest)
```

## 5. Design notes: speed and reliability

What the hot path does on every event (no I/O, no allocation-heavy work, no LLMs):

```
WS event -> normalize to integers -> update in-memory state -> evaluate strategy
         -> risk gate -> (paper|live) order action -> async JSONL log
```

Speed decisions, informed by what the official clients and public Polymarket bots
(py-clob-client-v2, poly-market-maker, poly-websockets) do:

- **Top-of-book from three event types, not just snapshots.** The Polymarket WS client
  consumes `price_change` (carries `best_bid`/`best_ask` per asset) and `best_bid_ask`
  (via `custom_feature_enabled: true`) in addition to `book` snapshots, so the strategy
  reacts without waiting for the next full snapshot.
- **Settlement-adjacent oracle.** Polymarket short-duration crypto markets resolve on
  Chainlink; the bot subscribes to RTDS `crypto_prices_chainlink` (official feed) and
  falls back to Binance only while RTDS is quiet.
- **Fixed-point integers end to end.** Prices/sizes/PnL are integer micros; strings are
  parsed once at the edge. No float drift, no Decimal allocations in the hot path.
- **Persistent sockets + heartbeats.** WS `PING` every 10s (server drops silent
  connections), RTDS `ping` every 5s, Socket.IO websocket-only transport; exponential
  backoff reconnect everywhere.
- **Stale-state safety over uptime.** On any disconnect, books are wiped, resting paper
  orders are cancelled, and the live executor's `cancelAll` fires. A feed gap can never
  leave a stale maker order resting (spec B4).
- **`tick_size_change` handling.** Polymarket rejects orders priced with a stale tick;
  the WS client surfaces the event and the strategy updates its tick immediately.
- **One strategy evaluation per event, per market**, with all state in memory; decision
  logs are bounded and JSONL writes are async.

Reliability gates (cannot be bypassed by strategy code): per-order/market notional caps,
open-order and rate limits, daily loss limit, kill switch requiring manual unlock,
post-loss cooldown, and client-side post-only rejection in both the paper exchange and
the live executor.

## 6. API verification status

Verified against official sources on 2026-06-10:

| Area | Status | Source |
|---|---|---|
| Polymarket WS URL, subscribe format, `book`/`price_change`/`best_bid_ask`/`last_trade_price`/`tick_size_change` payloads, PING/PONG | ✅ verified | docs.polymarket.com, Polymarket/agent-skills |
| Prices can arrive without leading zero (".48") | ✅ handled | Polymarket/agent-skills examples |
| RTDS URL, subscribe wire format, `crypto_prices_chainlink` topic, 5s ping | ✅ verified | Polymarket/real-time-data-client |
| Limitless REST: `/markets/active`, `/markets/{slug}`, `/markets/{slug}/orderbook`, `/profiles/me`, `POST /orders`, `DELETE /orders/{id}`, `DELETE /orders/all/{slug}` | ✅ verified | limitless-exchange-ts-sdk |
| Limitless auth: `X-API-Key` header | ✅ verified | limitless-exchange-ts-sdk |
| Limitless EIP-712: domain `Limitless CTF Exchange` v1, 12-field CTF order, BUY=0/SELL=1, EOA=0, verifying contract from `market.venue.exchange`, BUY collateral rounds up | ✅ verified | SDK signer.ts/builder.ts |
| Limitless order payload `{order, orderType, marketSlug, ownerId, postOnly}` | ✅ verified | SDK orders/client.ts |
| Limitless WS: `wss://ws.limitless.exchange` `/markets` ns, `subscribe_market_prices {marketSlugs}`, `orderbookUpdate`, `oraclePriceData` | ✅ verified | SDK websocket/client.ts + types |
| Limitless market list response field names (`tokens` vs `clobTokenIds`, `deadline`, `minTickSize`) | ⚠️ VERIFY on first run | parsed defensively with fallbacks |
| Limitless 5m Up/Down market title/duration filter heuristics | ⚠️ VERIFY on first run | tune `isShortDurationUpDown` |
| Polymarket gamma 5m/15m slug pattern (`btc-updown-5m-<unixStart>`) | ⚠️ VERIFY on first run | derived from documented 15m example |

Notable structural fact: Limitless's public feed exposes **orderbook updates and oracle
prices but no public trade prints**, so paper fills there use the PaperExchange
**book-cross mode** (fill only when the ask quotes through our bid, queue-ahead still
applied). Polymarket paper fills use observed `last_trade_price` prints.

## 7. Strategy in one paragraph

In the final 60s→4s of a 5-minute BTC Up/Down market, if the oracle shows the underlying
clearly on one side of the strike (gap ≥ 8bps and ≥ 2.5× recent realized vol), the locked
side's book is priced ≥ $0.95 with a sane spread, and risk gates pass, rest a **post-only**
bid at `min($0.95, ask − tick)` (joining, never crossing). Cancel instantly if the side
flips, the gap collapses, the price fades, a feed goes stale, the spread blows out, or
resolution is < 3s away. One fill per market; after a loss, stand down for 10 markets.

## 8. Paper-trading fill model (why results here are believable)

A paper bid only fills when observed market activity proves it would have: a SELL print at
≤ our price (Polymarket) or the book quoting through our level (Limitless), after our
placement timestamp + 250ms latency grace, and only after the visible queue ahead at our
level is depleted. Post-only orders that would cross are rejected, never converted to
taker. This kills the classic backtest lie where every $0.95 bid fills.

## 9. Simulation findings (synthetic, $5 max order)

| config | fills | win rate given fill | total PnL |
|---|---|---|---|
| maxEntry $0.95, seed 42, 2k mkts | 153 | 95.4% | **+$3.58** |
| maxEntry $0.95, seed 7, 5k mkts | 390 | 90.8% | **−$86.49** |
| maxEntry $0.97, seed 7, 5k mkts | 868 | 94.5% | −$112.16 |
| stricter gap/vol filters | 0–120 | ≤92.5% | ≤ −$12.61 |

Takeaways, consistent with the spec's warnings:

1. **Breakeven at $0.95 is a 95% fill-conditioned win rate.** Simulated adverse-selection
   drag (2–7pp between "all signals" and "given fill" win rates) flips the sign; the
   seed-42 profit is tail-risk noise, not edge.
2. **Conditioning is the trap:** when a market is truly locked the book trades 0.97–0.99
   and a capped $0.95 bid can't compete; when your bid IS fillable, the outcome is less
   locked than it looks. Tightening filters drove orders to zero rather than to profit.
3. One full loss erases ~19 wins at $0.95 (~32 at $0.97).

**These are synthetic results** — they validate the pipeline and sensitivity, not
real-world PnL. Per spec §G, go/no-go for real money needs 1,000+ recorded live markets
(`npm run record`), fill-conditioned EV measured on real prints, and positive EV after a
safety haircut.

## 10. Go-live checklist (Limitless)

1. Run `limitless:paper` with `LOG_LEVEL=debug`; confirm the ⚠️ VERIFY items in §6.
2. Confirm `/profiles/me` returns your `ownerId` with `LIMITLESS_API_KEY` set.
3. Keep `LIMITLESS_DRY_RUN=true` and inspect a logged signed order against the official
   SDK output for the same inputs.
4. Fund a **dedicated** hot wallet with pocket change; approve USDC for the venue
   exchange contract (the address from `market.venue.exchange`).
5. Flip `TRADING_ENABLED=true LIMITLESS_TRADING_ENABLED=true LIMITLESS_DRY_RUN=false`
   with default risk caps ($5/order, $5/market, $25 daily loss).
6. Verify the first live order's lifecycle end to end (place → cancel → balance check)
   before letting it run unattended.
