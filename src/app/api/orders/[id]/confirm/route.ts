import { identify, json, NO_STORE, refuseForeignOrigin } from "../../../../../lib/http";
import { classifyEndpoints } from "../../../../../lib/payments/cluster";
import { paymentWallet, solanaRpcUrls } from "../../../../../lib/payments/config";
import { orderById } from "../../../../../lib/payments/orders";
import type { SettleFailureReason } from "../../../../../lib/payments/settle";
import { recordVerificationAttempt, settlePayment, verifyRateLimited } from "../../../../../lib/payments/settle";
import { verifySolPayment } from "../../../../../lib/payments/sol-transfer";

export const dynamic = "force-dynamic";

/**
 * A defensive bound on the submitted signature, checked before it is ever
 * decoded. A real Solana signature is 64 bytes of base58 (87-88 characters);
 * this exists only to stop an oversized string reaching a decoder at all,
 * the same reasoning `POST /api/orders` applies to `contract`.
 */
const MAX_SIGNATURE_LENGTH = 128;

const FAILURE_STATUS: Record<SettleFailureReason, number> = {
  invalid_signature: 400,
  not_found: 404,
  not_confirmed: 409,
  failed_tx: 400,
  wrong_token: 400,
  wrong_destination: 400,
  insufficient_amount: 400,
  wrong_payer: 400,
  outside_bid_window: 400,
  no_block_time: 409,
  rpc_unavailable: 503,
  signature_reused: 409,
  already_settled: 409,
  unmatched: 409,
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

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
    return json(
      { error: "signature must be a non-empty string." },
      { status: 400, headers: NO_STORE },
    );
  }
  if (signature.length > MAX_SIGNATURE_LENGTH) {
    return json(
      { error: `signature must be at most ${MAX_SIGNATURE_LENGTH} characters.` },
      { status: 400, headers: NO_STORE },
    );
  }

  // Checked before anything else costs a round trip, same reasoning as
  // POST /api/orders: a deployment with no receiving wallet cannot have
  // taken this order's money either.
  const wallet = paymentWallet();
  if (!wallet.ok) {
    console.error(`POST /api/orders/${id}/confirm: ${wallet.reason}`);
    return json(
      { error: "Payments are not available on this deployment right now." },
      { status: 500, headers: NO_STORE },
    );
  }

  /**
   * The chain this deployment settles on, decided HERE and not in the
   * browser.
   *
   * `PayWithWallet` already refuses to open a wallet when the cluster is not
   * mainnet, and that refusal is real — but it is the BROWSER refusing, and a
   * caller posting straight at this route never runs it. With SOLANA_RPC_URL
   * pointed at devnet, play-money SOL would verify here exactly like the
   * real thing and settle an order for a colour somebody else paid for.
   *
   * 503, not 400: the request is fine and the deployment is not, which is why
   * this is also in the log where an operator will find it.
   */
  const cluster = classifyEndpoints(solanaRpcUrls());
  if (cluster !== "solana:mainnet") {
    console.error(
      `POST /api/orders/${id}/confirm: refusing, upstream cluster is ${cluster}, not solana:mainnet.`,
    );
    return json(
      { error: "Payments are not available on this deployment right now." },
      { status: 503, headers: NO_STORE },
    );
  }

  const caller = identify(request);
  if (!caller.ok) return json({ error: caller.message }, { status: 400, headers: NO_STORE });
  const cookie: Record<string, string> = caller.setCookie
    ? { "set-cookie": caller.setCookie }
    : {};

  const order = await orderById(id);
  if (!order) {
    return json({ error: "No such order." }, { status: 404, headers: { ...NO_STORE, ...cookie } });
  }

  // Rate-limited before the RPC call it exists to protect, never after:
  // there is no quota left to save once the call already happened.
  const rateLimit = await verifyRateLimited(order.id, caller.ipHash);
  if (rateLimit.limited) {
    return json(
      { error: rateLimit.message },
      { status: 429, headers: { ...NO_STORE, ...cookie } },
    );
  }
  await recordVerificationAttempt(order.id, caller.ipHash);

  const verified = await verifySolPayment({
    signature,
    expectedLamports: order.amountLamports,
    wallet: wallet.address,
    expectedPayer: order.payerPubkey ?? undefined,
    createdAtMs: order.createdAt.getTime(),
    expiresAtMs: order.expiresAt.getTime(),
  });

  const result = await settlePayment({ order, signature, verified });

  if (!result.ok) {
    return json(
      {
        error: result.message,
        reason: result.reason,
        ...(result.freeColours !== undefined ? { freeColours: result.freeColours } : {}),
        ...(result.supportContact !== undefined ? { supportContact: result.supportContact } : {}),
      },
      { status: FAILURE_STATUS[result.reason], headers: { ...NO_STORE, ...cookie } },
    );
  }

  return json(
    {
      status: "paid",
      amountLamports: order.amountLamports.toString(),
      amountReceivedBaseUnits: result.amountBaseUnits.toString(),
    },
    { headers: { ...NO_STORE, ...cookie } },
  );
}
