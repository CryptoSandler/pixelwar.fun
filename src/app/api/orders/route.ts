import { webcrypto } from "node:crypto";
import { base58Encode } from "../../../lib/base58";
import { queryOne } from "../../../lib/db";
import { identify, json, NO_STORE } from "../../../lib/http";
import type { CreateOrderFailureReason } from "../../../lib/payments/orders";
import { createOrder } from "../../../lib/payments/orders";
import { USDC_MINT, paymentWallet } from "../../../lib/payments/config";
import { validateAddress } from "../../../lib/tokens/addresses";
import { resolveToken } from "../../../lib/tokens/dexscreener";
import { PALETTE_SIZE } from "../../../lib/wars/palette";
import { warBySlug } from "../../../lib/wars/lifecycle";

export const dynamic = "force-dynamic";

const FAILURE_STATUS: Record<CreateOrderFailureReason, number> = {
  colour_taken: 409,
  already_entered: 409,
  war_full: 409,
  war_closed: 409,
};

/**
 * A defensive bound on `contract` and `payerPubkey`, checked before either
 * ever reaches `validateAddress`. Generous for every chain's real address
 * shape (the longest, TON's raw form, is 67 characters) — this exists only
 * to stop an oversized string from being handed to an address checker at
 * all, on top of the length gate `validateAddress` now enforces itself for
 * every future caller, not only this one.
 */
const MAX_RAW_ADDRESS_LENGTH = 128;

/**
 * Orders allowed per `ip_hash` inside the window below.
 *
 * A function, not a constant, for the same reason as everything in
 * `lib/config.ts`: a module-level constant freezes the value at import time,
 * which a test cannot then dial down without a process restart. Kept local to
 * this route rather than in `lib/payments/config.ts` because it governs a
 * route decision (how many POSTs this endpoint accepts), not a payment rule
 * `createOrder` or the verifier needs to know about.
 */
function orderRateLimit(): { max: number; windowMinutes: number } {
  const max = Number.parseInt(process.env.ORDER_RATE_LIMIT_MAX ?? "", 10);
  const windowMinutes = Number.parseInt(process.env.ORDER_RATE_LIMIT_WINDOW_MINUTES ?? "", 10);
  return {
    max: Number.isInteger(max) && max > 0 ? max : 8,
    windowMinutes: Number.isInteger(windowMinutes) && windowMinutes > 0 ? windowMinutes : 10,
  };
}

/**
 * Refuses order creation once a caller has opened too many within the
 * window, counting straight off `entry_orders.ip_hash` — a column that
 * already exists for this reason, so no new table earns its keep here.
 *
 * Not race-free the way `createOrder`'s colour and contract checks are: two
 * requests landing in the same instant could both count the same
 * under-the-limit total and both pass. That is an acceptable gap for a
 * defence-in-depth cap (the real scarcity — one colour, one seat — is still
 * enforced by `createOrder`'s own transaction, which cannot be raced past).
 * What this guards against is sustained abuse from one address, not a single
 * coincident pair of requests.
 */
async function tooManyOrders(ipHash: string): Promise<boolean> {
  const { max, windowMinutes } = orderRateLimit();
  const row = await queryOne<{ count: string }>(
    `SELECT count(*) AS count FROM entry_orders
      WHERE ip_hash = $1 AND created_at > now() - ($2 || ' minutes')::interval`,
    [ipHash, String(windowMinutes)],
  );
  return Number(row?.count ?? 0) >= max;
}

/**
 * The Solana Pay reference for this order: a fresh, unguessable public key
 * that goes onto the payment transaction as a read-only account, so a later
 * reconcile pass can find a payment whose payer never came back with the
 * signature (spec §5).
 *
 * This project holds no private key and never signs anything, and this
 * function is why. It generates an Ed25519 keypair and reads out only the
 * public half; the private `CryptoKey` is never exported, never serialised,
 * and never touched again after this call returns — it simply falls out of
 * scope. There is deliberately no `exportKey` call on it anywhere in this
 * file, or anywhere downstream: nothing here or in `createOrder` ever needed
 * to sign with it, so it was never read.
 *
 * Generated here, in the route, rather than inside `createOrder`, because a
 * store function that minted its own keypair could not be tested without
 * mocking randomness — `createOrder` takes the reference as a plain string
 * argument instead.
 */
async function generateReference(): Promise<string> {
  const keyPair = (await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as webcrypto.CryptoKeyPair;
  const rawPublicKey = await webcrypto.subtle.exportKey("raw", keyPair.publicKey);
  return base58Encode(new Uint8Array(rawPublicKey));
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body must be JSON" }, { status: 400, headers: NO_STORE });
  }

  const { warSlug, chainId, contract, colourSlot, payerPubkey } = (body ?? {}) as Record<
    string,
    unknown
  >;

  if (
    typeof warSlug !== "string" ||
    typeof chainId !== "string" ||
    typeof contract !== "string" ||
    typeof colourSlot !== "number" ||
    !Number.isInteger(colourSlot) ||
    colourSlot < 1 ||
    colourSlot > PALETTE_SIZE ||
    (payerPubkey !== undefined && typeof payerPubkey !== "string")
  ) {
    return json(
      {
        error:
          "warSlug, chainId and contract must be strings, colourSlot must be a whole " +
          `number between 1 and ${PALETTE_SIZE}, and payerPubkey, if present, must be a string.`,
      },
      { status: 400, headers: NO_STORE },
    );
  }

  // Capped before `validateAddress` is ever reached: the decoder behind it
  // is O(n^2) on a long enough input (see addresses.ts), and there is no
  // legitimate address anywhere near this long. A free, early rejection
  // here protects this route even if a future address family's shape check
  // were ever looser than it should be.
  if (
    contract.length > MAX_RAW_ADDRESS_LENGTH ||
    (payerPubkey !== undefined && payerPubkey.length > MAX_RAW_ADDRESS_LENGTH)
  ) {
    return json(
      { error: `contract and payerPubkey must be at most ${MAX_RAW_ADDRESS_LENGTH} characters.` },
      { status: 400, headers: NO_STORE },
    );
  }

  // Checked before anything else costs a round trip: a deployment with no
  // receiving wallet cannot quote a payTo address, so there is nothing an
  // order created now could tell a payer. The specific reason is for the
  // server log only, the same reasoning `identify()` uses for its own
  // operational detail — it names an environment variable, not something a
  // caller needs or should see.
  const wallet = paymentWallet();
  if (!wallet.ok) {
    console.error(`POST /api/orders: ${wallet.reason}`);
    return json(
      { error: "Payments are not available on this deployment right now." },
      { status: 500, headers: NO_STORE },
    );
  }

  const caller = identify(request);
  if (!caller.ok) return json({ error: caller.message }, { status: 400, headers: NO_STORE });

  // Validated before the DexScreener call below spends a network round trip
  // on an address that was never going to resolve.
  const checkedContract = validateAddress(chainId, contract);
  if (!checkedContract.ok) {
    return json({ error: checkedContract.reason }, { status: 400, headers: NO_STORE });
  }

  // Payment always moves as USDC on Solana regardless of which chain the
  // token itself lives on, so a connected wallet is checked against the
  // Solana address family specifically, not against `chainId`.
  let checkedPayer: string | undefined;
  if (payerPubkey !== undefined) {
    if (payerPubkey.trim() === "") {
      // validateAddress's empty-input message says "contract address" —
      // right for the token address, wrong for a wallet.
      return json({ error: "Enter a payer wallet address." }, { status: 400, headers: NO_STORE });
    }
    const result = validateAddress("solana", payerPubkey);
    if (!result.ok) return json({ error: result.reason }, { status: 400, headers: NO_STORE });
    checkedPayer = result.canonical;
  }

  if (await tooManyOrders(caller.ipHash)) {
    return json(
      { error: "Too many orders started from this address recently. Try again later." },
      { status: 429, headers: NO_STORE },
    );
  }

  const war = await warBySlug(warSlug);
  if (!war) return json({ error: "No such war." }, { status: 404, headers: NO_STORE });

  const resolved = await resolveToken(chainId, checkedContract.canonical);
  if (!resolved.ok) {
    const status = resolved.kind === "not_found" ? 404 : 503;
    return json({ error: resolved.message }, { status, headers: NO_STORE });
  }

  const reference = await generateReference();

  const result = await createOrder({
    warId: war.id,
    chainId,
    contract: checkedContract.display,
    contractKey: checkedContract.canonical,
    colourSlot,
    name: resolved.metadata.name,
    ticker: resolved.metadata.ticker,
    logoUrl: resolved.metadata.logoUrl ?? null,
    links: resolved.metadata.links,
    referencePubkey: reference,
    payerPubkey: checkedPayer,
    ipHash: caller.ipHash,
  });

  const cookie: Record<string, string> = caller.setCookie
    ? { "set-cookie": caller.setCookie }
    : {};

  if (!result.ok) {
    return json(
      { error: `That order could not be started: ${result.reason}.`, reason: result.reason },
      { status: FAILURE_STATUS[result.reason], headers: { ...NO_STORE, ...cookie } },
    );
  }

  return json(
    {
      orderId: result.order.id,
      amountUsd: result.order.amountUsd,
      payTo: wallet.address,
      mint: USDC_MINT,
      expiresAt: result.order.expiresAt.toISOString(),
      reference: result.order.referencePubkey,
    },
    { status: 201, headers: { ...NO_STORE, ...cookie } },
  );
}
