import { identify, json, NO_STORE } from "../../../lib/http";
import { register, registrationCost } from "../../../lib/paint/registration";
import { recordVerificationAttempt, verifyRateLimited } from "../../../lib/payments/settle";

export const dynamic = "force-dynamic";

/**
 * A defensive bound on the submitted signature, checked before it is decoded.
 * A real Solana signature is 64 bytes of base58 — 87 or 88 characters. Same
 * reasoning as the confirm route: this stops an oversized string reaching a
 * decoder at all.
 */
const MAX_SIGNATURE_LENGTH = 128;

const STATUS: Record<string, number> = {
  not_configured: 503,
  bad_wallet: 400,
  already_registered: 409,
  verification_failed: 400,
};

/**
 * Registering to paint: one transfer, verified here, once per wallet.
 *
 * THE BROWSER SENDS A SIGNATURE AND NOTHING ELSE. Not the wallet, not the
 * amount. Both are read off the chain by `verifySolTransfer`, so a caller who
 * submits somebody else's transfer registers THEM — which is a strange
 * favour to do a stranger and not an attack. A caller who claims a wallet
 * they did not pay from gets nothing, because nothing they send is believed.
 */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body must be JSON" }, { status: 400, headers: NO_STORE });
  }

  const { signature } = (body ?? {}) as Record<string, unknown>;
  if (typeof signature !== "string" || signature.trim() === "") {
    return json({ error: "signature must be a non-empty string." }, { status: 400, headers: NO_STORE });
  }
  if (signature.length > MAX_SIGNATURE_LENGTH) {
    return json(
      { error: `signature must be at most ${MAX_SIGNATURE_LENGTH} characters.` },
      { status: 400, headers: NO_STORE },
    );
  }

  const caller = identify(request);
  if (!caller.ok) return json({ error: caller.message }, { status: 400, headers: NO_STORE });
  const cookie: Record<string, string> = caller.setCookie ? { "set-cookie": caller.setCookie } : {};

  // Rate-limited before the RPC call it exists to protect, never after: there
  // is no quota left to save once the call already happened.
  //
  // THE SAME COUNTER THE CHECKOUT USES, keyed by this signature where an
  // order would key by its id. Deliberate: it is the same rate-limited RPC
  // endpoint being spent, so one shared budget is what is actually true. The
  // limiter's own message names an order, so it is not shown — this answers
  // in its own words.
  // ponytail: shared counter, split it if registration ever needs a limit of
  // its own rather than a share of the checkout's.
  const key = `registration:${signature}`;
  const limited = await verifyRateLimited(key, caller.ipHash);
  if (limited.limited) {
    return json(
      { error: "Checking too often. Wait a moment and try again." },
      { status: 429, headers: { ...NO_STORE, ...cookie } },
    );
  }
  await recordVerificationAttempt(key, caller.ipHash);

  const result = await register({ signature, painterKey: caller.painterKey });

  if (!result.ok) {
    return json(
      { error: result.message, reason: result.reason },
      { status: STATUS[result.reason] ?? 400, headers: { ...NO_STORE, ...cookie } },
    );
  }

  return json(
    {
      wallet: result.wallet,
      lamports: result.lamports.toString(),
      alreadyRegistered: result.alreadyRegistered,
      feeLamports: registrationCost().lamports.toString(),
    },
    { headers: { ...NO_STORE, ...cookie } },
  );
}
