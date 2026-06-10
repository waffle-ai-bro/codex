import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { verifyTypedData } from "viem";
import { MICRO } from "../src/core/fixed.js";
import {
  ORDER_TYPES,
  SIDE_BUY,
  SIDE_SELL,
  buildClobOrder,
  orderToWire,
  signClobOrder,
  type LimitlessDomainConfig,
} from "../src/connectors/limitless/orders.js";

// Well-known test vector key (anvil/hardhat account 0) — never use with funds.
const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const account = privateKeyToAccount(TEST_PK);

const domain: LimitlessDomainConfig = {
  name: "Limitless CTF Exchange",
  version: "1",
  chainId: 8453,
  verifyingContract: "0x0000000000000000000000000000000000000001",
};

describe("buildClobOrder", () => {
  it("BUY: makerAmount is USDC paid, takerAmount is shares", () => {
    // 10 shares at $0.95 -> pay 9.50 USDC for 10 shares
    const o = buildClobOrder({
      maker: account.address,
      tokenId: "123456",
      side: "BUY",
      priceMicros: 950_000,
      sizeMicros: 10 * MICRO,
      salt: 1n,
    });
    expect(o.makerAmount).toBe(9_500_000n);
    expect(o.takerAmount).toBe(10_000_000n);
    expect(o.side).toBe(SIDE_BUY);
    expect(o.signer).toBe(account.address);
    expect(o.expiration).toBe(0n); // GTC
  });

  it("SELL: makerAmount is shares, takerAmount is USDC received", () => {
    const o = buildClobOrder({
      maker: account.address,
      tokenId: "1",
      side: "SELL",
      priceMicros: 950_000,
      sizeMicros: 10 * MICRO,
      salt: 1n,
    });
    expect(o.makerAmount).toBe(10_000_000n);
    expect(o.takerAmount).toBe(9_500_000n);
    expect(o.side).toBe(SIDE_SELL);
  });

  it("rejects prices outside (0,1) and non-positive sizes", () => {
    const base = { maker: account.address, tokenId: "1", side: "BUY" as const, sizeMicros: MICRO };
    expect(() => buildClobOrder({ ...base, priceMicros: 0 })).toThrow();
    expect(() => buildClobOrder({ ...base, priceMicros: 1_000_000 })).toThrow();
    expect(() => buildClobOrder({ ...base, priceMicros: 500_000, sizeMicros: 0 })).toThrow();
  });
});

describe("signClobOrder", () => {
  it("produces a signature that verifies against the typed data", async () => {
    const order = buildClobOrder({
      maker: account.address,
      tokenId: "987654321",
      side: "BUY",
      priceMicros: 950_000,
      sizeMicros: 5 * MICRO,
      salt: 42n,
    });
    const signature = await signClobOrder(account, domain, order);
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);

    const valid = await verifyTypedData({
      address: account.address,
      domain: {
        name: domain.name,
        version: domain.version,
        chainId: domain.chainId,
        verifyingContract: domain.verifyingContract,
      },
      types: ORDER_TYPES,
      primaryType: "Order",
      message: {
        salt: order.salt,
        maker: order.maker,
        signer: order.signer,
        taker: order.taker,
        tokenId: order.tokenId,
        makerAmount: order.makerAmount,
        takerAmount: order.takerAmount,
        expiration: order.expiration,
        nonce: order.nonce,
        feeRateBps: order.feeRateBps,
        side: order.side,
        signatureType: order.signatureType,
      },
      signature,
    });
    expect(valid).toBe(true);
  });

  it("is deterministic for identical orders and differs across salts", async () => {
    const args = {
      maker: account.address,
      tokenId: "7",
      side: "BUY" as const,
      priceMicros: 940_000,
      sizeMicros: MICRO,
    };
    const a = await signClobOrder(account, domain, buildClobOrder({ ...args, salt: 1n }));
    const b = await signClobOrder(account, domain, buildClobOrder({ ...args, salt: 1n }));
    const c = await signClobOrder(account, domain, buildClobOrder({ ...args, salt: 2n }));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("orderToWire", () => {
  it("serializes bigints as decimal strings and keeps the signature", () => {
    const order = buildClobOrder({
      maker: account.address,
      tokenId: "123",
      side: "BUY",
      priceMicros: 950_000,
      sizeMicros: 2 * MICRO,
      salt: 99n,
    });
    const wire = orderToWire(order, "0xdeadbeef");
    expect(wire["salt"]).toBe("99");
    expect(wire["tokenId"]).toBe("123");
    expect(wire["makerAmount"]).toBe("1900000");
    expect(wire["takerAmount"]).toBe("2000000");
    expect(wire["signature"]).toBe("0xdeadbeef");
    expect(() => JSON.stringify(wire)).not.toThrow();
  });
});
