import { identify, json, NO_STORE, refuseForeignOrigin } from "../../../../lib/http";
import { linkWallet, type LinkFailure } from "../../../../lib/paint/registration";

export const dynamic = "force-dynamic";

const MAX_SIGNATURE_LENGTH = 128;

const STATUS: Record<LinkFailure, number> = {
  bad_wallet: 400,
  bad_signature: 400,
  not_registered: 402,
  banned: 403,
  unknown_nonce: 400,
  nonce_spent: 409,
  nonce_expired: 410,
  // A link nonce is not war-scoped, so this can only mean an oath's nonce was
  // presented here. Answered as the malformed request it is.
  wrong_war: 400,
};

/**
 * Claims a registration this browser does not yet hold, proved by signature.
 *
 * TAKES NO MONEY, and cannot: nothing in this path touches a transfer. It is
 * what makes "permanent per wallet" true after cookies are cleared or on a
 * second device.
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

  const { wallet, nonce, signature } = (body ?? {}) as Record<string, unknown>;
  if (
    typeof wallet !== "string" ||
    typeof nonce !== "string" ||
    typeof signature !== "string" ||
    wallet.trim() === "" ||
    nonce.trim() === "" ||
    signature.trim() === ""
  ) {
    return json(
      { error: "wallet, nonce and signature must be non-empty strings." },
      { status: 400, headers: NO_STORE },
    );
  }
  if (signature.length > MAX_SIGNATURE_LENGTH || wallet.length > MAX_SIGNATURE_LENGTH) {
    return json({ error: "That request is too long." }, { status: 400, headers: NO_STORE });
  }

  const caller = identify(request);
  if (!caller.ok) return json({ error: caller.message }, { status: 400, headers: NO_STORE });
  const cookie: Record<string, string> = caller.setCookie ? { "set-cookie": caller.setCookie } : {};

  const result = await linkWallet({
    painterKey: caller.painterKey,
    wallet,
    nonce,
    signatureBase58: signature,
  });

  if (!result.ok) {
    return json(
      { error: result.message, reason: result.reason },
      { status: STATUS[result.reason] ?? 400, headers: { ...NO_STORE, ...cookie } },
    );
  }

  return json({ wallet: result.wallet }, { headers: { ...NO_STORE, ...cookie } });
}
