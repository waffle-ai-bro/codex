import type { PrivateKeyAccount } from "viem/accounts";
import { privateKeyToAccount } from "viem/accounts";
import { Logger } from "../../core/logger.js";
import type { LimitlessClient, LimitlessSession } from "./client.js";

/**
 * Limitless wallet-signature session auth.
 *
 * Flow (VERIFY on first connected run — written from public reference bots):
 *   1. GET  /auth/signing-message      -> message text
 *   2. sign message with the EOA key
 *   3. POST /auth/login with headers:
 *        x-account:         checksummed address
 *        x-signature:       hex signature
 *        x-signing-message: base64(message)
 *   4. reuse returned session cookie on subsequent requests
 *
 * The private key never leaves this module and is never logged.
 */

const log = new Logger("limitless-auth");

export function accountFromEnv(): PrivateKeyAccount {
  const pk = process.env["LIMITLESS_PRIVATE_KEY"];
  if (!pk) throw new Error("LIMITLESS_PRIVATE_KEY is not set");
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("LIMITLESS_PRIVATE_KEY malformed");
  return privateKeyToAccount(pk as `0x${string}`);
}

export async function login(
  client: LimitlessClient,
  account: PrivateKeyAccount,
  base = process.env["LIMITLESS_API_BASE"] ?? "https://api.limitless.exchange",
): Promise<LimitlessSession> {
  const msgRes = await fetch(`${base}/auth/signing-message`);
  if (!msgRes.ok) throw new Error(`signing-message -> ${msgRes.status}`);
  const message = await msgRes.text();

  const signature = await account.signMessage({ message });
  const headers: Record<string, string> = {
    "x-account": account.address,
    "x-signature": signature,
    "x-signing-message": Buffer.from(message, "utf8").toString("base64"),
  };

  const loginRes = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ client: "eoa" }),
  });
  if (!loginRes.ok) {
    throw new Error(`limitless login failed: ${loginRes.status} ${(await loginRes.text()).slice(0, 200)}`);
  }
  const cookie = loginRes.headers.get("set-cookie") ?? undefined;
  const session: LimitlessSession = cookie !== undefined ? { cookie, headers } : { headers };
  client.setSession(session);
  log.info("limitless session established", { address: account.address, hasCookie: cookie !== undefined });
  return session;
}
