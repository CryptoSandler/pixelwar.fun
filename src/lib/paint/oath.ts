import { createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";
import { base58Decode } from "../base58";
import { execute, queryOne, transaction } from "../db";
import {
  RPC_BACKOFF_MAX_MS,
  RPC_BACKOFF_MS,
  RPC_MAX_ATTEMPTS,
  solanaRpcUrls,
} from "../payments/config";
import { validateAddress } from "../tokens/addresses";

/**
 * The sworn caste: a wallet that proved it holds the token it fights for.
 *
 * WHY THIS IS BUILT LIKE SECURITY AND THE RECRUIT'S LOCK IS NOT. A recruit's
 * allegiance is a signed cookie and migration 009 says plainly that this is
 * accepted rather than fought — it is a commitment device, and forging it
 * gains nothing anybody wants. This grants a mark other people can see, on
 * the strength of a claim about a wallet. A claim that can be forged is a
 * badge that means nothing, and a badge that means nothing is worse than no
 * badge: it launders sybils into credentials.
 *
 * WHAT THE PRODUCT GETS OUT OF IT (DESIGN.md §1a): the rung between recruit
 * and sworn is bought from the community, never from us. Proving you hold the
 * token is free; acquiring the token is the community's own ask. That is the
 * whole monetisation thesis expressed as a mechanic.
 */

/**
 * How long an issued nonce stays usable.
 *
 * Short, because the window is the only thing protecting a signature that
 * leaked before it was spent. Long enough that a wallet dialog, a hardware
 * confirmation and a slow phone all fit comfortably inside it — a payer
 * fighting a five-second timer signs whatever is in front of them, which is
 * the opposite of what asking for a signature is for.
 */
export const OATH_NONCE_TTL_MS = 5 * 60 * 1000;

/**
 * The SPKI prefix that turns a raw 32-byte Ed25519 public key into something
 * `crypto.createPublicKey` will accept.
 *
 * Node verifies Ed25519 natively and has since 12; what it will not do is
 * take a bare key. This is the fixed DER header for
 * `AlgorithmIdentifier { id-Ed25519 }` followed by a 32-byte BIT STRING, and
 * it is a constant rather than a computation because it is a constant.
 *
 * The alternative was pulling in tweetnacl to do what the runtime already
 * does. Twelve bytes of header is a better trade than a dependency in the
 * path that decides whether a badge is real.
 */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export type OathChallenge = { nonce: string; message: string; expiresAt: Date };

/**
 * Issues a challenge for one war.
 *
 * The message is stored, not reconstructed later. Rebuilding it at
 * verification time means two pieces of code agreeing on a format forever,
 * and the day they drift every oath fails with no way to tell a formatting
 * change from a forgery.
 *
 * It is also written to be read by a human in a wallet dialog. Somebody is
 * about to approve it, and a wallet that shows a blob of base64 has trained
 * that person to approve blobs of base64.
 */
export async function issueOathChallenge(input: {
  warId: string;
  warSlug: string;
  ticker: string;
}): Promise<OathChallenge> {
  const nonce = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + OATH_NONCE_TTL_MS);
  const message = [
    `pixelwar.fun — swear allegiance`,
    ``,
    `War: ${input.warSlug}`,
    `Token: ${input.ticker}`,
    `Nonce: ${nonce}`,
    `Expires: ${expiresAt.toISOString()}`,
    ``,
    `Signing this proves you control this wallet. It moves no funds.`,
  ].join("\n");

  await execute(
    `INSERT INTO oath_nonces (nonce, war_id, message, expires_at) VALUES ($1, $2, $3, $4)`,
    [nonce, input.warId, message, expiresAt],
  );

  return { nonce, message, expiresAt };
}

export type OathFailure =
  | "banned"
  | "unknown_nonce"
  | "nonce_spent"
  | "nonce_expired"
  | "wrong_war"
  | "bad_wallet"
  | "bad_signature"
  | "not_a_holder"
  | "already_committed"
  | "wallet_taken"
  | "rpc_unavailable";

export type OathResult =
  | { ok: true; wallet: string; warTokenId: string }
  | { ok: false; reason: OathFailure; message: string };

/**
 * Spends a nonce, exactly once.
 *
 * A conditional UPDATE rather than SELECT-then-UPDATE, for the reason every
 * claim in this codebase is: the read and the write have to be one statement
 * or two concurrent replays both pass the check. `used_at IS NULL` in the
 * WHERE clause is what makes "one signature, one use" true rather than
 * intended.
 *
 * Returns the stored message, because that is the only thing the signature is
 * checked against.
 *
 * `warId` is null for a challenge that belongs to no war — the link
 * challenge migration 013 opened the column for. The comparison is strict in
 * both directions, so a link nonce cannot be spent as an oath and an oath
 * nonce cannot be spent as a link. Exported for that one caller; the policy
 * around each kind of challenge lives with the thing it grants.
 */
export async function spendNonce(
  nonce: string,
  warId: string | null,
): Promise<{ ok: true; message: string } | { ok: false; reason: OathFailure }> {
  const existing = await queryOne<{
    war_id: string | null;
    message: string;
    expired: boolean;
    spent: boolean;
  }>(
    `SELECT war_id, message, (expires_at <= now()) AS expired, (used_at IS NOT NULL) AS spent
       FROM oath_nonces WHERE nonce = $1`,
    [nonce],
  );

  if (!existing) return { ok: false, reason: "unknown_nonce" };
  if ((existing.war_id ?? null) !== warId) return { ok: false, reason: "wrong_war" };
  if (existing.spent) return { ok: false, reason: "nonce_spent" };
  if (existing.expired) return { ok: false, reason: "nonce_expired" };

  const claimed = await execute(
    `UPDATE oath_nonces SET used_at = now()
      WHERE nonce = $1 AND used_at IS NULL AND expires_at > now()`,
    [nonce],
  );
  // Lost the race to a concurrent replay. The checks above already answered
  // for every other case, so this can only be that one.
  if (claimed !== 1) return { ok: false, reason: "nonce_spent" };

  return { ok: true, message: existing.message };
}

/**
 * Whether `signature` is this wallet's signature over `message`.
 *
 * Every input is untrusted and every one of them can be the wrong length, the
 * wrong alphabet, or not base58 at all — so this returns false rather than
 * throwing, and the caller gets one answer for every kind of wrong. Telling a
 * malformed signature apart from a valid signature by the wrong key is an
 * oracle and neither one is getting in.
 */
export function verifyWalletSignature(input: {
  wallet: string;
  message: string;
  signatureBase58: string;
}): boolean {
  try {
    const key = base58Decode(input.wallet);
    const signature = base58Decode(input.signatureBase58);
    if (!key || key.length !== 32) return false;
    if (!signature || signature.length !== 64) return false;

    const publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(key)]),
      format: "der",
      type: "spki",
    });

    return verifySignature(
      null,
      Buffer.from(input.message, "utf8"),
      publicKey,
      Buffer.from(signature),
    );
  } catch {
    return false;
  }
}

/** Injected by tests. Defaults to the same direct RPC path `verifyPayment` uses. */
export type HoldingFetcher = (wallet: string, mint: string) => Promise<bigint>;

/**
 * How much of `mint` this wallet holds, summed across its token accounts.
 *
 * SERVER-SIDE AND DIRECT, not through `/api/rpc`. That route exists so the
 * BROWSER can reach a paid provider without the key leaving the server — its
 * own doc comment says so — and routing a server-side security check through
 * a browser-facing, IP-rate-limited proxy would be pointless at best. More to
 * the point: a holdings check the browser performs and reports is a claim the
 * browser makes about itself, which is exactly the thing that must not be
 * trusted here.
 *
 * The whitelist is untouched. `getTokenAccountsByOwner` was already on it and
 * stays on it; nothing is added, because the server does not go through it.
 */
async function defaultFetchHolding(wallet: string, mint: string): Promise<bigint> {
  const endpoints = solanaRpcUrls();
  let lastError: unknown = new Error("No RPC endpoint configured");

  for (let attempt = 0; attempt < RPC_MAX_ATTEMPTS; attempt++) {
    const endpoint = endpoints[attempt % endpoints.length];
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTokenAccountsByOwner",
          params: [wallet, { mint }, { encoding: "jsonParsed" }],
        }),
      });
      if (!response.ok) throw new Error(`RPC ${response.status}`);
      const body = await response.json();
      if (body?.error) throw new Error(String(body.error?.message ?? "RPC error"));

      const accounts: unknown[] = body?.result?.value ?? [];
      let total = 0n;
      for (const account of accounts) {
        const amount = (account as {
          account?: { data?: { parsed?: { info?: { tokenAmount?: { amount?: string } } } } };
        })?.account?.data?.parsed?.info?.tokenAmount?.amount;
        if (typeof amount === "string" && /^\d+$/.test(amount)) total += BigInt(amount);
      }
      return total;
    } catch (error) {
      lastError = error;
      if (attempt < RPC_MAX_ATTEMPTS - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(RPC_BACKOFF_MS * 2 ** attempt, RPC_BACKOFF_MAX_MS)),
        );
      }
    }
  }

  throw lastError;
}

/**
 * Takes the oath: spends the nonce, checks the signature, checks the holding,
 * and marks this painter sworn.
 *
 * THE HOLDING IS CHECKED ONCE, AT THE OATH, AND NOT AGAIN. Selling afterwards
 * does not revoke the badge, and that is a product decision rather than an
 * omission: the oath was sworn with skin in the game and it is good for the
 * war. Re-verifying on every paint would put an RPC call in the hot path of
 * the one action that has to stay free and fast, and re-verifying on a
 * schedule is a different product. Periodic re-verification is recorded as an
 * open decision for after the first war — see docs/operations.md.
 *
 * ORDER MATTERS. The nonce is spent FIRST, before the signature is even
 * looked at, so a replay cannot burn RPC quota by failing verification over
 * and over against a nonce that stays alive.
 */
export async function swearOath(input: {
  warId: string;
  warTokenId: string;
  mint: string;
  painterKey: string;
  wallet: string;
  nonce: string;
  signatureBase58: string;
  fetchHolding?: HoldingFetcher;
}): Promise<OathResult> {
  const checked = validateAddress("solana", input.wallet);
  if (!checked.ok) {
    return { ok: false, reason: "bad_wallet", message: "That is not a Solana address." };
  }
  const wallet = checked.canonical;

  // A BANNED WALLET CANNOT SWEAR ITSELF BACK IN. Without this, banning a
  // wallet removes the badge and the offender re-swears with the same wallet
  // and gets it back — the ban would be a ceremony rather than a boundary.
  //
  // Checked BEFORE the nonce is spent, unlike the signature: a banned caller
  // should not be able to burn other people's challenges, and there is
  // nothing to learn from the timing here because the answer does not depend
  // on any secret.
  const banned = await queryOne<{ hit: number }>(
    `SELECT 1 AS hit FROM bans
      WHERE key_type = 'wallet' AND key = $1
        AND (expires_at IS NULL OR expires_at > now())`,
    [wallet],
  );
  if (banned) {
    return {
      ok: false,
      reason: "banned",
      // Says nothing about why or for how long. The operator sees the reason
      // in /admin; the banned wallet learns only that it cannot.
      message: "This wallet cannot swear in this war.",
    };
  }

  const spent = await spendNonce(input.nonce, input.warId);
  if (!spent.ok) {
    return {
      ok: false,
      reason: spent.reason,
      message:
        spent.reason === "nonce_expired"
          ? "That challenge expired. Ask for a new one."
          : "That challenge is not usable. Ask for a new one.",
    };
  }

  if (
    !verifyWalletSignature({
      wallet,
      message: spent.message,
      signatureBase58: input.signatureBase58,
    })
  ) {
    return { ok: false, reason: "bad_signature", message: "That signature does not match." };
  }

  let held: bigint;
  try {
    held = await (input.fetchHolding ?? defaultFetchHolding)(wallet, input.mint);
  } catch (error) {
    console.error("swearOath: holdings lookup failed", error);
    return {
      ok: false,
      reason: "rpc_unavailable",
      message: "Could not read your holdings just now. Try again in a moment.",
    };
  }

  if (held <= 0n) {
    return {
      ok: false,
      reason: "not_a_holder",
      // Does not say how much is needed, because any amount counts and a
      // threshold would be a number somebody has to defend.
      message: "This wallet does not hold that token.",
    };
  }

  return transaction(async (client) => {
    const existing = await client.query<{ war_token_id: string; wallet: string | null }>(
      `SELECT war_token_id, wallet FROM war_painters
        WHERE war_id = $1 AND painter_key = $2
        FOR UPDATE`,
      [input.warId, input.painterKey],
    );

    const current = existing.rows[0];
    if (current && current.war_token_id !== input.warTokenId) {
      return {
        ok: false as const,
        reason: "already_committed" as const,
        message: "You already fight for another token this war.",
      };
    }

    // One wallet, one side, per war — the half of the mechanic that IS
    // enforced. A recruit can start over by clearing a cookie; a wallet
    // cannot be re-sworn to the other army.
    const taken = await client.query(
      `SELECT 1 FROM war_painters
        WHERE war_id = $1 AND wallet = $2 AND painter_key <> $3`,
      [input.warId, wallet, input.painterKey],
    );
    if ((taken.rowCount ?? 0) > 0) {
      return {
        ok: false as const,
        reason: "wallet_taken" as const,
        message: "That wallet has already sworn in this war.",
      };
    }

    await client.query(
      `INSERT INTO war_painters (war_id, painter_key, war_token_id, wallet, sworn_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (war_id, painter_key) DO UPDATE
         SET wallet = EXCLUDED.wallet, sworn_at = now()`,
      [input.warId, input.painterKey, input.warTokenId, wallet],
    );

    return { ok: true as const, wallet, warTokenId: input.warTokenId };
  });
}
