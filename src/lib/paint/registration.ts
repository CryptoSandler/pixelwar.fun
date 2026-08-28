import type { PoolClient } from "pg";
import { randomBytes } from "node:crypto";
import { execute, queryOne, transaction } from "../db";
import {
  paymentWallet,
  registrationFeeLamports,
  registrationIsFree,
  RPC_BACKOFF_MAX_MS,
  RPC_BACKOFF_MS,
  RPC_MAX_ATTEMPTS,
  solanaRpcUrls,
} from "../payments/config";
import { verifySolTransfer } from "../payments/sol-transfer";
import type { SolanaTransaction, TransactionFetcher } from "../payments/solana";
import { validateAddress } from "../tokens/addresses";
import { OATH_NONCE_TTL_MS, spendNonce, verifyWalletSignature } from "./oath";

/**
 * Registration: paying once, ever, for the right to paint.
 *
 * TWO FACTS WITH DIFFERENT LIVES, and migration 012 keeps them in two tables
 * for that reason. A REGISTRATION belongs to a wallet and is permanent across
 * every war. A LINK is which browser is currently acting as that wallet, and
 * is disposable by design — clearing a cookie makes a new painter key, and a
 * registered wallet must be able to claim one WITHOUT paying again. The fee
 * buys the identity, not the session.
 *
 * THE PAYMENT PROVES THE PAYER. IT PROVES NOTHING ABOUT THE PRESENTER, and
 * that distinction is the whole shape of this module. Signing a transfer does
 * establish that the payer controls the wallet — but a transfer to
 * PAYMENT_WALLET is PUBLIC the moment it lands, so the signature is a string
 * anybody watching that address can copy. An earlier version of this file
 * linked the caller's browser on the strength of holding one, which meant
 * lifting a signature off a block explorer was enough to paint on somebody
 * else's paid identity — and to get them banned for it.
 *
 * SO REGISTERING AND LINKING ARE TWO STEPS, ALWAYS, AND ONLY THE SECOND ONE
 * DECIDES WHO PAINTS. The payment creates the registration, at wallet level,
 * derived from the chain. The link is proved by a wallet signature over a
 * server-issued challenge — the machinery `oath.ts` already had — and there
 * is no path to `painter_wallets` that skips it. `register` does not call
 * `linkPainter`, and that is not an omission: it is the fix.
 */

export type RegistrationFailure =
  | "not_configured"
  | "bad_wallet"
  | "already_registered"
  | "verification_failed";

export type RegistrationResult =
  /**
   * Deliberately says nothing about WHO. `alreadyRegistered` distinguishes
   * "this payment just registered a wallet" from "that signature had already
   * been used", which is all a client needs to know what to say next.
   */
  | { ok: true; alreadyRegistered: boolean }
  | { ok: false; reason: RegistrationFailure; message: string };

/** Whether this wallet has ever registered. Permanent; nothing expires it. */
export async function isRegistered(wallet: string): Promise<boolean> {
  const row = await queryOne<{ hit: number }>(
    `SELECT 1 AS hit FROM registrations WHERE wallet = $1`,
    [wallet],
  );
  return row !== null;
}

/** The wallet this browser is currently acting as, or null. */
export async function linkedWallet(painterKey: string): Promise<string | null> {
  const row = await queryOne<{ wallet: string }>(
    `SELECT wallet FROM painter_wallets WHERE painter_key = $1`,
    [painterKey],
  );
  return row?.wallet ?? null;
}

/**
 * Points this browser at an already-registered wallet.
 *
 * NOT EXPORTED, and that is load-bearing rather than tidy. `linkWallet` below
 * is the only caller, and it gets here only after a wallet signature over a
 * server-issued challenge has been verified. Exporting this would put a
 * second door next to the one with the lock on it, and the bug this file was
 * rewritten for was exactly a caller walking through such a door.
 *
 * ON CONFLICT DO UPDATE rather than refusing a second call: a person who
 * re-links after clearing cookies, or who links a second device, is doing the
 * ordinary thing. The painter key is the key, so one browser is one wallet at
 * a time, and one wallet may hold several links — a phone and a laptop are
 * one registration and two browsers, and charging twice for that would be a
 * toll on being the same person.
 */
async function linkPainter(painterKey: string, wallet: string): Promise<void> {
  await execute(
    `INSERT INTO painter_wallets (painter_key, wallet)
     VALUES ($1, $2)
     ON CONFLICT (painter_key) DO UPDATE SET wallet = EXCLUDED.wallet, linked_at = now()`,
    [painterKey, wallet],
  );
}

/**
 * Fetches a transaction, server-side and direct.
 *
 * The same path `verifyPayment` uses and for the same reason: `/api/rpc` is
 * the BROWSER's proxy, and a payment the browser verifies and reports is a
 * claim the browser makes about itself.
 */
async function defaultFetchTransaction(signature: string): Promise<SolanaTransaction> {
  const endpoints = solanaRpcUrls();
  let lastError: unknown = new Error("No RPC endpoint configured");

  for (let attempt = 0; attempt < RPC_MAX_ATTEMPTS; attempt++) {
    const endpoint = endpoints[attempt % endpoints.length];
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Bounded and uncached, like `solana.ts`'s fetcher: attempts are
        // sequential, so this is not about concurrency — it is about how long
        // one hung provider can hold a worker open.
        signal: AbortSignal.timeout(12_000),
        cache: "no-store",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTransaction",
          params: [signature, { encoding: "json", maxSupportedTransactionVersion: 0 }],
        }),
      });
      if (!response.ok) throw new Error(`RPC responded ${response.status}`);
      const body = await response.json();
      // The provider's own error TEXT is deliberately dropped rather than
      // wrapped: `SOLANA_RPC_URL` carries an api-key in its query string on
      // every paid provider, and provider errors routinely echo the request
      // they were given. This is the same refusal `/api/rpc` makes on the way
      // out, made here on the way in.
      if (body?.error) throw new Error("RPC returned an error");
      return body?.result ?? null;
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
 * Records that the wallet which paid is registered. LINKS NOTHING.
 *
 * There is no `painterKey` parameter, and the absence is the point: this
 * function cannot bind a browser to a wallet because it has no browser to
 * bind. Whoever presents the signature — the payer, a bot watching the
 * receiving address, anybody — moves the same wallet from unregistered to
 * registered and gains nothing else by it.
 *
 * IT ALSO RETURNS NO WALLET. The payer already knows which wallet they paid
 * from; a caller holding only a public signature does not need to be told
 * whose money it was, and an endpoint that answers that question is one more
 * way to turn a block explorer into a directory.
 *
 * IDEMPOTENT IN TWO DIRECTIONS, which are different situations:
 *
 *   The same SIGNATURE twice — a dropped response, a double click. The
 *   signature is UNIQUE, so the second call reports success rather than
 *   charging anybody twice or failing on a constraint.
 *
 *   An already-registered WALLET paying again — somebody who forgot. Refused
 *   with its own reason, because taking a second fee for a permanent thing
 *   is taking money for nothing. The payment is theirs and unspent; the
 *   message says so.
 */
export async function register(input: {
  signature: string;
  fetchTransaction?: TransactionFetcher;
}): Promise<RegistrationResult> {
  const recipient = paymentWallet();
  if (!recipient.ok) {
    console.error(`register: ${recipient.reason}`);
    return {
      ok: false,
      reason: "not_configured",
      message: "Registration is not open on this deployment yet.",
    };
  }

  // A signature already spent is answered BEFORE the chain is asked: it costs
  // an RPC call to learn nothing, and a retry after a dropped response is the
  // common case rather than an attack.
  const existing = await queryOne<{ wallet: string }>(
    `SELECT wallet FROM registrations WHERE signature = $1`,
    [input.signature],
  );
  if (existing) {
    // Answered before the chain is asked: an RPC call would learn nothing,
    // and a retry after a dropped response is the common case rather than an
    // attack. Nothing is linked here — it never was the caller's to claim.
    return { ok: true, alreadyRegistered: true };
  }

  const verified = await verifySolTransfer({
    signature: input.signature,
    recipient: recipient.address,
    minLamports: registrationFeeLamports(),
    fetchTransaction: input.fetchTransaction ?? defaultFetchTransaction,
  });

  if (!verified.ok) {
    return { ok: false, reason: "verification_failed", message: verified.message };
  }

  const checked = validateAddress("solana", verified.payer);
  if (!checked.ok) {
    return { ok: false, reason: "bad_wallet", message: "That payer is not a Solana address." };
  }
  const wallet = checked.canonical;

  return transaction(async (client) => {
    const already = await client.query<{ signature: string }>(
      `SELECT signature FROM registrations WHERE wallet = $1 FOR UPDATE`,
      [wallet],
    );
    if (already.rowCount && already.rows[0].signature !== input.signature) {
      return {
        ok: false as const,
        reason: "already_registered" as const,
        // Names what happened to their money, because it is theirs and it is
        // unspent. Registration is permanent and one payment is all it takes.
        message:
          "That wallet is already registered, so this transfer was not needed. " +
          "It has not been taken as a fee.",
      };
    }

    // ON CONFLICT DO NOTHING with no target, so it covers BOTH constraints on
    // this table rather than only the one this call expected to hit. The
    // SELECT above cannot lock a row that does not exist yet, so two
    // concurrent registrations of the same wallet with different signatures
    // both reach here — naming `(signature)` would let the wallet primary key
    // raise instead, and a race would surface as a 500 on somebody who had
    // just paid.
    const inserted = await client.query<{ wallet: string }>(
      `INSERT INTO registrations (wallet, signature, lamports)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING wallet`,
      [wallet, input.signature, verified.lamports.toString()],
    );

    if (inserted.rowCount === 0) {
      // Lost a race. Which race matters: the same signature arriving twice is
      // the retry this function promises to answer, and the same wallet
      // arriving with a second signature is the second payment it refuses.
      const existing = await client.query<{ signature: string }>(
        `SELECT signature FROM registrations WHERE wallet = $1`,
        [wallet],
      );
      if (existing.rowCount && existing.rows[0].signature !== input.signature) {
        return {
          ok: false as const,
          reason: "already_registered" as const,
          message:
            "That wallet is already registered, so this transfer was not needed. " +
            "It has not been taken as a fee.",
        };
      }
    }

    return { ok: true as const, alreadyRegistered: inserted.rowCount === 0 };
  });
}

/**
 * The wallet this browser paints as, read inside a caller's transaction.
 *
 * ONE ROW, NOT A JOIN, and the foreign key is why: `painter_wallets.wallet`
 * references `registrations.wallet`, so a link cannot exist without the
 * registration behind it. Confirming that in a join would be asking the
 * database to prove a constraint it enforces on every write.
 */
export async function paintingWallet(
  client: PoolClient,
  painterKey: string,
): Promise<string | null> {
  const result = await client.query<{ wallet: string }>(
    `SELECT wallet FROM painter_wallets WHERE painter_key = $1`,
    [painterKey],
  );
  return result.rows[0]?.wallet ?? null;
}

/**
 * Whether this browser may paint at all.
 *
 * WITH THE FEE SWITCHED OFF, a wallet is still required — registration
 * becomes a signature instead of a payment, not nothing. That keeps one code
 * path rather than two: `REGISTRATION_FEE_SOL=0` changes the price, never the
 * shape, so a deployment that switches the fee off is not running an
 * untested variant of the paint path.
 */
export async function mayPaint(painterKey: string): Promise<boolean> {
  const wallet = await linkedWallet(painterKey);
  if (!wallet) return false;
  return isRegistered(wallet);
}

/** Exposed so a screen can say what registering costs without duplicating the maths. */
export function registrationCost(): { lamports: bigint; free: boolean } {
  return { lamports: registrationFeeLamports(), free: registrationIsFree() };
}

/**
 * A challenge for claiming an existing registration on a new browser.
 *
 * NO WAR, and migration 013 is what allows that: a link says which browser
 * holds a registration, and a registration is not per-war. The case that
 * makes this concrete is a war ending while the panel is open — there is no
 * live war to name, and nothing about linking has changed.
 *
 * The message is stored rather than rebuilt at verification time, for the
 * reason `issueOathChallenge` gives: two pieces of code agreeing on a format
 * forever is two pieces of code that eventually disagree, and the day they
 * do, every link fails with no way to tell drift from forgery. It is also
 * written to be read in a wallet dialog by the person approving it.
 */
export async function issueLinkChallenge(ipHash?: string | null): Promise<{
  nonce: string;
  message: string;
  expiresAt: Date;
}> {
  const nonce = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + OATH_NONCE_TTL_MS);
  const message = [
    `pixelwar.fun — link this browser`,
    ``,
    `Nonce: ${nonce}`,
    `Expires: ${expiresAt.toISOString()}`,
    ``,
    `Signing this proves you control this wallet. It moves no funds, and it`,
    `does not register or pay for anything.`,
  ].join("\n");

  await execute(
    `INSERT INTO oath_nonces (nonce, war_id, message, expires_at, ip_hash)
     VALUES ($1, NULL, $2, $3, $4)`,
    [nonce, message, expiresAt, ipHash ?? null],
  );

  return { nonce, message, expiresAt };
}

export type LinkFailure =
  | "bad_wallet"
  | "bad_signature"
  | "not_registered"
  | "banned"
  | "unknown_nonce"
  | "nonce_spent"
  | "nonce_expired"
  | "wrong_war";

export type LinkResult =
  | { ok: true; wallet: string }
  | { ok: false; reason: LinkFailure; message: string };

/**
 * Claims an existing registration on this browser, proved by signature.
 *
 * THIS TAKES NO MONEY AND MUST NOT BE ABLE TO. It is the path that makes a
 * permanent registration actually permanent, and its only job is proving that
 * whoever is holding this cookie controls a wallet that already paid.
 *
 * ORDER, same as `swearOath` and for the same reasons: the ban is checked
 * before the nonce is spent, because a banned caller should not be able to
 * burn other people's challenges and there is no secret in that answer to
 * leak through timing. The nonce is spent before the signature is verified,
 * so a replay cannot keep a live nonce alive by failing verification at it.
 */
export async function linkWallet(input: {
  painterKey: string;
  wallet: string;
  nonce: string;
  signatureBase58: string;
}): Promise<LinkResult> {
  const checked = validateAddress("solana", input.wallet);
  if (!checked.ok) {
    return { ok: false, reason: "bad_wallet", message: "That is not a Solana address." };
  }
  const wallet = checked.canonical;

  const banned = await queryOne<{ hit: number }>(
    `SELECT 1 AS hit FROM bans
      WHERE key_type = 'wallet' AND key = $1
        AND (expires_at IS NULL OR expires_at > now())`,
    [wallet],
  );
  if (banned) {
    // Says nothing about why or for how long, like every other ban message.
    return { ok: false, reason: "banned", message: "This wallet cannot paint here." };
  }

  const spent = await spendNonce(input.nonce, null);
  if (!spent.ok) {
    return {
      ok: false,
      reason: spent.reason as LinkFailure,
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

  if (!(await isRegistered(wallet))) {
    // WITH THE FEE SWITCHED OFF, THIS PATH IS THE REGISTRATION. That is what
    // `REGISTRATION_FEE_SOL=0` promises — a wallet signature and no payment —
    // and a door that is documented but not wired is worse than no door: the
    // operator reaches for it in the one hour it matters and finds a screen
    // asking for a transfer of zero SOL.
    //
    // The signature column is NOT NULL and UNIQUE, so a free registration
    // stores a marker keyed to the wallet. It cannot collide with a real one:
    // a Solana signature is base58 and never contains a colon.
    if (registrationIsFree()) {
      await execute(
        `INSERT INTO registrations (wallet, signature, lamports)
         VALUES ($1, $2, 0)
         ON CONFLICT DO NOTHING`,
        [wallet, `free:${wallet}`],
      );
    } else {
      // A signature proves control of the wallet; it does not pay for
      // anything. The answer names what is missing rather than linking an
      // identity the paint gate would reject a moment later.
      return {
        ok: false,
        reason: "not_registered",
        message: "That wallet has not registered yet.",
      };
    }
  }

  await linkPainter(input.painterKey, wallet);
  return { ok: true, wallet };
}
