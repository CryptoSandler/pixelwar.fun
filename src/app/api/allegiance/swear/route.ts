import { queryOne } from "../../../../lib/db";
import { identify, json, NO_STORE, refuseForeignOrigin } from "../../../../lib/http";
import { swearOath } from "../../../../lib/paint/oath";
import { advanceWar, warBySlug } from "../../../../lib/wars/lifecycle";

export const dynamic = "force-dynamic";

/** Which failures are the caller's fault and which are ours. */
const STATUS: Record<string, number> = {
  banned: 403,
  unknown_nonce: 400,
  nonce_spent: 409,
  nonce_expired: 410,
  wrong_war: 400,
  bad_wallet: 400,
  bad_signature: 401,
  not_a_holder: 403,
  already_committed: 409,
  wallet_taken: 409,
  // Ours, not theirs — and worth a distinct code so a client can offer a
  // retry rather than telling somebody their wallet is wrong.
  rpc_unavailable: 503,
};

/**
 * Takes the oath.
 *
 * WHO CALLS THIS: the swear control on the war screen, with the signature the
 * wallet produced over the message `POST /api/allegiance/nonce` handed it.
 *
 * THE PAINTER IS IDENTIFIED BY COOKIE, THE HOLDER BY SIGNATURE, and the two
 * are deliberately different mechanisms answering different questions. The
 * cookie says which painter this is — soft, discardable, and that is accepted
 * (migration 009). The signature says which wallet this is — and that half is
 * real, because it is what a visible badge rests on.
 */
export async function POST(request: Request): Promise<Response> {
  const foreign = refuseForeignOrigin(request);
  if (foreign) return foreign;

  const caller = identify(request);
  if (!caller.ok) return json({ error: caller.message }, { status: 400, headers: NO_STORE });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body must be JSON" }, { status: 400, headers: NO_STORE });
  }

  const { warSlug, warTokenId, wallet, nonce, signature } = (body ?? {}) as Record<string, unknown>;
  if (
    typeof warSlug !== "string" ||
    typeof warTokenId !== "string" ||
    typeof wallet !== "string" ||
    typeof nonce !== "string" ||
    typeof signature !== "string"
  ) {
    return json(
      { error: "warSlug, warTokenId, wallet, nonce and signature must be strings." },
      { status: 400, headers: NO_STORE },
    );
  }

  const found = await warBySlug(warSlug);
  if (!found) return json({ error: "No such war." }, { status: 404, headers: NO_STORE });
  const war = await advanceWar(found);

  const token = await queryOne<{ contract: string; chain_id: string }>(
    `SELECT contract, chain_id FROM war_tokens
      WHERE id = $1 AND war_id = $2 AND status = 'active'`,
    [warTokenId, war.id],
  );
  if (!token) {
    return json({ error: "That token is not in this war." }, { status: 400, headers: NO_STORE });
  }
  // Holdings are read on Solana, so a token that lives on another chain has
  // no oath available. Said plainly rather than failing later in an RPC call
  // that would report something unhelpful.
  if (token.chain_id !== "solana") {
    return json(
      { error: "Swearing is only available for Solana tokens." },
      { status: 400, headers: NO_STORE },
    );
  }

  const result = await swearOath({
    warId: war.id,
    warTokenId,
    mint: token.contract,
    painterKey: caller.painterKey,
    wallet,
    nonce,
    signatureBase58: signature,
  });

  const cookie: Record<string, string> = caller.setCookie
    ? { "set-cookie": caller.setCookie }
    : {};

  if (!result.ok) {
    return json(
      { error: result.message, reason: result.reason },
      { status: STATUS[result.reason] ?? 400, headers: { ...NO_STORE, ...cookie } },
    );
  }

  return json(
    { sworn: true, wallet: result.wallet, warTokenId: result.warTokenId },
    { headers: { ...NO_STORE, ...cookie } },
  );
}
