import type { PrivateKeyAccount } from "viem/accounts";
import { mulDivCeil, notionalUsdMicros, MICRO } from "../../core/fixed.js";

/**
 * Limitless CLOB order construction + EIP-712 signing.
 *
 * Verified against the official SDK (limitless-exchange-ts-sdk, 2026-06):
 *  - domain: { name: "Limitless CTF Exchange", version: "1", chainId,
 *    verifyingContract } where the verifying contract is the market's
 *    venue exchange address (market.venue.exchange), NOT a global constant.
 *  - 12-field CTF Order struct, Side BUY=0/SELL=1, SignatureType EOA=0.
 *  - USDC + shares are 6-decimal (== our internal micros).
 *  - BUY: maker collateral rounds UP; SELL: taker collateral rounds DOWN.
 *  - Order types GTC (supports postOnly), FOK, FAK.
 *
 * Known Base mainnet constants (SDK):
 *  - USDC 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
 *  - CTF  0xC9c98965297Bc527861c898329Ee280632B76e18
 */

export const BASE_CHAIN_ID = 8453;

export interface LimitlessDomainConfig {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: `0x${string}`;
}

/**
 * Domain for a given exchange contract. The exchange address normally comes
 * from the market's venue data (market.venue.exchange); the env var
 * LIMITLESS_VERIFYING_CONTRACT acts as an override/pin.
 */
export function domainFor(exchangeAddress: string): LimitlessDomainConfig {
  const pinned = process.env["LIMITLESS_VERIFYING_CONTRACT"];
  const verifying = pinned && /^0x[0-9a-fA-F]{40}$/.test(pinned) ? pinned : exchangeAddress;
  if (!/^0x[0-9a-fA-F]{40}$/.test(verifying)) {
    throw new Error(`invalid Limitless exchange address: ${JSON.stringify(verifying)}`);
  }
  return {
    name: process.env["LIMITLESS_DOMAIN_NAME"] ?? "Limitless CTF Exchange",
    version: process.env["LIMITLESS_DOMAIN_VERSION"] ?? "1",
    chainId: Number(process.env["LIMITLESS_CHAIN_ID"] ?? BASE_CHAIN_ID),
    verifyingContract: verifying as `0x${string}`,
  };
}

/** Env-only domain (requires LIMITLESS_VERIFYING_CONTRACT). */
export function domainFromEnv(): LimitlessDomainConfig {
  const verifying = process.env["LIMITLESS_VERIFYING_CONTRACT"];
  if (!verifying) {
    throw new Error(
      "LIMITLESS_VERIFYING_CONTRACT not set; prefer passing the market's venue.exchange address to domainFor()",
    );
  }
  return domainFor(verifying);
}

export const ORDER_TYPES = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "taker", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "expiration", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "feeRateBps", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "signatureType", type: "uint8" },
  ],
} as const;

export const SIDE_BUY = 0;
export const SIDE_SELL = 1;
export const SIGNATURE_TYPE_EOA = 0;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export interface ClobOrder {
  salt: bigint;
  maker: `0x${string}`;
  signer: `0x${string}`;
  taker: `0x${string}`;
  tokenId: bigint;
  makerAmount: bigint;
  takerAmount: bigint;
  expiration: bigint;
  nonce: bigint;
  feeRateBps: bigint;
  side: number;
  signatureType: number;
}

export interface BuildOrderArgs {
  maker: `0x${string}`;
  tokenId: string;
  side: "BUY" | "SELL";
  priceMicros: number;
  sizeMicros: number;
  feeRateBps?: number;
  nonce?: bigint;
  /** Unix seconds; 0 = GTC (no expiration). */
  expirationSec?: number;
  /** Injectable for deterministic tests. */
  salt?: bigint;
}

/**
 * Build a CLOB order from price/size in micros.
 * BUY:  makerAmount = USDC paid (price*size, rounded UP per official SDK),
 *       takerAmount = shares received.
 * SELL: makerAmount = shares sold, takerAmount = USDC received (rounded down).
 * USDC and CTF shares are both 6-decimal, identical to our micros.
 */
export function buildClobOrder(args: BuildOrderArgs): ClobOrder {
  if (args.priceMicros <= 0 || args.priceMicros >= 1_000_000) {
    throw new Error(`price out of (0,1): ${args.priceMicros}`);
  }
  if (args.sizeMicros <= 0) throw new Error("size must be positive");
  const usdc =
    args.side === "BUY"
      ? BigInt(mulDivCeil(args.priceMicros, args.sizeMicros, MICRO))
      : BigInt(notionalUsdMicros(args.priceMicros, args.sizeMicros));
  const shares = BigInt(args.sizeMicros);
  return {
    salt: args.salt ?? randomSalt(),
    maker: args.maker,
    signer: args.maker,
    taker: ZERO_ADDRESS,
    tokenId: BigInt(args.tokenId),
    makerAmount: args.side === "BUY" ? usdc : shares,
    takerAmount: args.side === "BUY" ? shares : usdc,
    expiration: BigInt(args.expirationSec ?? 0),
    nonce: args.nonce ?? 0n,
    feeRateBps: BigInt(args.feeRateBps ?? 0),
    side: args.side === "BUY" ? SIDE_BUY : SIDE_SELL,
    signatureType: SIGNATURE_TYPE_EOA,
  };
}

function randomSalt(): bigint {
  // 128 bits of entropy is ample for order salts.
  const hi = BigInt(Math.floor(Math.random() * 2 ** 32));
  const lo = BigInt(Math.floor(Math.random() * 2 ** 32));
  return (hi << 96n) | (BigInt(Date.now()) << 32n) | lo;
}

export async function signClobOrder(
  account: PrivateKeyAccount,
  domain: LimitlessDomainConfig,
  order: ClobOrder,
): Promise<`0x${string}`> {
  return account.signTypedData({
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
  });
}

/** JSON-safe wire form for the REST API (bigints as decimal strings). */
export function orderToWire(order: ClobOrder, signature: `0x${string}`): Record<string, unknown> {
  return {
    salt: order.salt.toString(),
    maker: order.maker,
    signer: order.signer,
    taker: order.taker,
    tokenId: order.tokenId.toString(),
    makerAmount: order.makerAmount.toString(),
    takerAmount: order.takerAmount.toString(),
    expiration: order.expiration.toString(),
    nonce: order.nonce.toString(),
    feeRateBps: order.feeRateBps.toString(),
    side: order.side,
    signatureType: order.signatureType,
    signature,
  };
}
