import { identify, json, NO_STORE, refuseForeignOrigin } from "../../../lib/http";
import { register } from "../../../lib/paint/registration";
import { classifyEndpoints } from "../../../lib/payments/cluster";
import { solanaRpcUrls } from "../../../lib/payments/config";
import { isSignatureShaped } from "../../../lib/payments/signature";
import { recordVerificationAttempt, verifyRateLimited } from "../../../lib/payments/settle";

export const dynamic = "force-dynamic";

const STATUS: Record<string, number> = {
  not_configured: 503,
  bad_wallet: 400,
  already_registered: 409,
  verification_failed: 400,
};

/**
 * Records a paid registration. DOES NOT DECIDE WHO PAINTS.
 *
 * THE SIGNATURE IS NOT A CREDENTIAL, and this route is written around that.
 * Every transfer to PAYMENT_WALLET is public, so the string in this body is
 * one anybody can copy off a block explorer. What it can do is move a wallet
 * from unregistered to registered — a state that helps only the wallet's own
 * owner. What it cannot do is bind a browser to that wallet: that is
 * `POST /api/register/link`, and it costs a wallet signature.
 *
 * The response says whether a registration now exists and nothing else. It
 * does not name the wallet: the payer already knows, and a caller holding
 * only a signature has no business being told whose money it was.
 */
export async function POST(request: Request): Promise<Response> {
  const foreign = refuseForeignOrigin(request);
  if (foreign) return foreign;

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

  // Shape first, and BEFORE the rate limiter, so a string that cannot be a
  // signature costs nothing at all: not an RPC call against the same quota
  // every live checkout shares, and not one of the attempts a real payer's
  // retry needs. The USDC path has always checked this; the SOL path did not,
  // which is what the audit found.
  if (!isSignatureShaped(signature)) {
    return json(
      { error: "That does not look like a Solana transaction signature." },
      { status: 400, headers: NO_STORE },
    );
  }

  /**
   * The chain this deployment settles on, decided HERE and not in the
   * browser.
   *
   * The payment screen already refuses to open a wallet when the cluster
   * cannot be identified as mainnet — but that is a courtesy the browser
   * performs, and a caller posting straight at this route never sees it. With
   * SOLANA_RPC_URL pointed anywhere else, a transfer of play money on that
   * chain would verify perfectly and register somebody for free.
   *
   * 503 rather than 400: nothing about the caller's request is wrong. The
   * deployment is not in a state where it can take money, and that is an
   * operator's problem, which is why it is also logged.
   */
  const cluster = classifyEndpoints(solanaRpcUrls());
  if (cluster !== "solana:mainnet") {
    console.error(`POST /api/register: refusing, upstream cluster is ${cluster}, not solana:mainnet.`);
    return json(
      { error: "Registration is not available on this deployment right now." },
      { status: 503, headers: NO_STORE },
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

  const result = await register({ signature });

  if (!result.ok) {
    return json(
      { error: result.message, reason: result.reason },
      { status: STATUS[result.reason] ?? 400, headers: { ...NO_STORE, ...cookie } },
    );
  }

  return json(
    {
      registered: true,
      alreadyRegistered: result.alreadyRegistered,
      // What the screen does next, said by the server so the client is not
      // the only place that knows this is a two-step flow.
      next: "link",
    },
    { headers: { ...NO_STORE, ...cookie } },
  );
}
