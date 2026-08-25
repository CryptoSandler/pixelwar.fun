import { identify, json, NO_STORE } from "../../../../../lib/http";
import { paymentWallet, usdToBaseUnits } from "../../../../../lib/payments/config";
import { orderById } from "../../../../../lib/payments/orders";
import type { SettleFailureReason } from "../../../../../lib/payments/settle";
import { recordVerificationAttempt, settlePayment, verifyRateLimited } from "../../../../../lib/payments/settle";
import { verifyPayment } from "../../../../../lib/payments/solana";

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

  const verified = await verifyPayment({
    signature,
    expectedBaseUnits: usdToBaseUnits(order.amountUsd),
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
      amountUsd: order.amountUsd,
      amountReceivedBaseUnits: result.amountBaseUnits.toString(),
    },
    { headers: { ...NO_STORE, ...cookie } },
  );
}
