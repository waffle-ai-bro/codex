import { describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { loadRiskLimits } from "../src/core/config.js";
import { MICRO } from "../src/core/fixed.js";
import { RiskEngine } from "../src/risk/risk-engine.js";
import { LimitlessExecutor } from "../src/execution/limitless-executor.js";
import type { LimitlessClient } from "../src/connectors/limitless/client.js";
import type { LimitlessDomainConfig } from "../src/connectors/limitless/orders.js";

const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const account = privateKeyToAccount(TEST_PK);
const domain: LimitlessDomainConfig = {
  name: "Limitless CTF Exchange",
  version: "1",
  chainId: 8453,
  verifyingContract: "0x0000000000000000000000000000000000000001",
};

function makeMockClient() {
  return {
    submitOrder: vi.fn(async () => ({ id: "venue-order-1" })),
    cancelOrder: vi.fn(async () => ({})),
    cancelAllOrders: vi.fn(async () => ({})),
  } as unknown as LimitlessClient & {
    submitOrder: ReturnType<typeof vi.fn>;
    cancelOrder: ReturnType<typeof vi.fn>;
    cancelAllOrders: ReturnType<typeof vi.fn>;
  };
}

function makeExecutor(opts: { enabled: boolean; dryRun: boolean }, client = makeMockClient()) {
  const risk = new RiskEngine(loadRiskLimits(), () => 0);
  const executor = new LimitlessExecutor(client, account, domain, risk, {
    ...opts,
    orderType: "GTC",
  });
  return { executor, risk, client };
}

const ORDER_ARGS = {
  marketId: "limitless:m1",
  marketSlug: "m1",
  tokenId: "123",
  priceMicros: 950_000,
  sizeMicros: 5 * MICRO, // $4.75 notional, under $5 default cap
};

function feedBook(executor: LimitlessExecutor, bid = 940_000, ask = 960_000): void {
  executor.onBook({
    tokenId: "123",
    bidMicros: bid,
    askMicros: ask,
    bidSizeMicros: 100 * MICRO,
    askSizeMicros: 100 * MICRO,
    tsMs: Date.now(),
  });
}

describe("LimitlessExecutor safety gating", () => {
  it("dry-run signs but never submits", async () => {
    const { executor, client } = makeExecutor({ enabled: false, dryRun: true });
    feedBook(executor);
    const placed = await executor.placePostOnlyBuy(ORDER_ARGS);
    expect(placed.status).toBe("dry-run");
    expect(client.submitOrder).not.toHaveBeenCalled();
  });

  it("submits when live trading is enabled", async () => {
    const { executor, client } = makeExecutor({ enabled: true, dryRun: false });
    feedBook(executor);
    const placed = await executor.placePostOnlyBuy(ORDER_ARGS);
    expect(placed.status).toBe("open");
    expect(placed.id).toBe("venue-order-1");
    expect(client.submitOrder).toHaveBeenCalledOnce();
    const payload = client.submitOrder.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload["postOnly"]).toBe(true);
    expect(payload["orderType"]).toBe("GTC");
  });

  it("rejects locally when the bid would cross the book", async () => {
    const { executor, client } = makeExecutor({ enabled: true, dryRun: false });
    feedBook(executor, 940_000, 950_000); // ask == our price -> cross
    const placed = await executor.placePostOnlyBuy(ORDER_ARGS);
    expect(placed.status).toBe("rejected");
    expect(placed.rejectReason).toMatch(/cross/);
    expect(client.submitOrder).not.toHaveBeenCalled();
  });

  it("rejects without book state", async () => {
    const { executor, client } = makeExecutor({ enabled: true, dryRun: false });
    const placed = await executor.placePostOnlyBuy(ORDER_ARGS);
    expect(placed.status).toBe("rejected");
    expect(client.submitOrder).not.toHaveBeenCalled();
  });

  it("enforces the shared risk gate", async () => {
    const { executor, client } = makeExecutor({ enabled: true, dryRun: false });
    feedBook(executor);
    const tooBig = { ...ORDER_ARGS, sizeMicros: 100 * MICRO }; // $95 > $5 cap
    const placed = await executor.placePostOnlyBuy(tooBig);
    expect(placed.status).toBe("rejected");
    expect(placed.rejectReason).toMatch(/risk/);
    expect(client.submitOrder).not.toHaveBeenCalled();
  });

  it("trips the kill switch when the venue returns no order id", async () => {
    const client = makeMockClient();
    client.submitOrder.mockResolvedValueOnce({});
    const { executor, risk } = makeExecutor({ enabled: true, dryRun: false }, client);
    feedBook(executor);
    const placed = await executor.placePostOnlyBuy(ORDER_ARGS);
    expect(placed.status).toBe("rejected");
    expect(risk.tripped).toBe(true);
  });

  it("trips the kill switch when a cancel fails", async () => {
    const client = makeMockClient();
    client.cancelOrder.mockRejectedValueOnce(new Error("venue 500"));
    const { executor, risk } = makeExecutor({ enabled: true, dryRun: false }, client);
    const ok = await executor.cancel("limitless:m1", "venue-order-1");
    expect(ok).toBe(false);
    expect(risk.tripped).toBe(true);
  });

  it("cancelAll is a no-op POST-wise in dry-run", async () => {
    const { executor, client } = makeExecutor({ enabled: false, dryRun: true });
    await executor.cancelAll();
    expect(client.cancelAllOrders).not.toHaveBeenCalled();
  });
});
