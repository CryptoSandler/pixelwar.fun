import { identify, json, NO_STORE, refuseForeignOrigin } from "../../../lib/http";
import { classifyEndpoints } from "../../../lib/payments/cluster";
import { solanaRpcUrls } from "../../../lib/payments/config";
import { preflight, type PreflightFailure } from "../../../lib/payments/preflight";
import { recordVerificationAttempt, verifyRateLimited } from "../../../lib/payments/settle";
import { validateAddress } from "../../../lib/tokens/addresses";

export const dynamic = "force-dynamic";

/**
 * Would this payment work? Asked BEFORE the wallet is opened.
 *
 * WHY THE SERVER AND NOT THE BROWSER. The browser can only reach `/api/rpc`,
 * whose allowlist carries neither `getBalance` nor `simulateTransaction` —
 * and widening it would turn the proxy into a general relay, which is the one
 * thing its own comment says it must not become. The server holds the
 * connection, so the server asks.
 *
 * A REFUSAL HERE IS THE POINT, not a failure of it. Phantom shows "this
 * transaction may be malicious" for anything that fails simulation, including
 * a payer who is simply short of SOL — so the choice is between our sentence
 * and that one.
 *
 * A REFUSAL IS 200, DELIBERATELY. "You are short of SOL" is a successful
 * answer to the question this endpoint was asked; a 4xx would put it in the
 * same bucket as a malformed request and invite a client to treat it as an
 * outage. Only an unreadable request and an unreachable node are errors.
 */

/** A legacy transaction big enough to be real and small enough not to be an attack. */
const MAX_TRANSACTION_BASE64 = 4_000;

const STATUS: Record<PreflightFailure, number> = {
  unreadable: 400,
  insufficient_funds: 200,
  simulation_failed: 200,
  rpc_unavailable: 503,
};

export async function POST(request: Request): Promise<Response> {
  const foreign = refuseForeignOrigin(request);
  if (foreign) return foreign;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body must be JSON" }, { status: 400, headers: NO_STORE });
  }

  const { transaction, payer, lamports } = (body ?? {}) as Record<string, unknown>;
  if (
    typeof transaction !== "string" ||
    transaction === "" ||
    transaction.length > MAX_TRANSACTION_BASE64 ||
    typeof payer !== "string" ||
    typeof lamports !== "string" ||
    !/^\d{1,20}$/.test(lamports)
  ) {
    return json(
      { error: "transaction and payer must be strings and lamports a decimal string." },
      { status: 400, headers: NO_STORE },
    );
  }

  const checkedPayer = validateAddress("solana", payer);
  if (!checkedPayer.ok) {
    return json({ error: "That is not a Solana address." }, { status: 400, headers: NO_STORE });
  }

  // Same gate the money routes carry: a deployment that cannot settle on
  // mainnet must not encourage anybody to sign for it either.
  const cluster = classifyEndpoints(solanaRpcUrls());
  if (cluster !== "solana:mainnet") {
    console.error(`POST /api/preflight: refusing, upstream cluster is ${cluster}.`);
    return json(
      {
        ok: false,
        reason: "rpc_unavailable",
        message: "Payments are not available on this deployment right now.",
      },
      { status: 503, headers: NO_STORE },
    );
  }

  const caller = identify(request);
  if (!caller.ok) return json({ error: caller.message }, { status: 400, headers: NO_STORE });
  const cookie: Record<string, string> = caller.setCookie ? { "set-cookie": caller.setCookie } : {};

  // Two RPC calls per request against the same quota every checkout shares,
  // so it is metered like every other path that spends it.
  const key = `preflight:${checkedPayer.canonical}`;
  const limited = await verifyRateLimited(key, caller.ipHash);
  if (limited.limited) {
    return json(
      { error: "Checking too often. Wait a moment and try again." },
      { status: 429, headers: { ...NO_STORE, ...cookie } },
    );
  }
  await recordVerificationAttempt(key, caller.ipHash);

  const endpoint = solanaRpcUrls()[0];
  const result = await preflight({
    transactionBase64: transaction,
    payer: checkedPayer.canonical,
    lamports: BigInt(lamports),
    rpc: async (method, params) => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(12_000),
        cache: "no-store",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (!response.ok) throw new Error(`RPC responded ${response.status}`);
      const payload = await response.json();
      // The provider's own error text never travels: on a paid provider the
      // URL it echoes carries an api-key.
      if (payload?.error) throw new Error("RPC returned an error");
      return payload?.result;
    },
  });

  if (!result.ok) {
    return json(
      { ok: false, reason: result.reason, message: result.message },
      { status: STATUS[result.reason], headers: { ...NO_STORE, ...cookie } },
    );
  }

  return json(
    { ok: true, feeLamports: result.feeLamports.toString() },
    { headers: { ...NO_STORE, ...cookie } },
  );
}
