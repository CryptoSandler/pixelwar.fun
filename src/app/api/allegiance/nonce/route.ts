import { identify, json, NO_STORE, refuseForeignOrigin } from "../../../../lib/http";
import { issueOathChallenge, tooManyNonces } from "../../../../lib/paint/oath";
import { queryOne } from "../../../../lib/db";
import { advanceWar, warBySlug } from "../../../../lib/wars/lifecycle";

export const dynamic = "force-dynamic";

/**
 * Issues the challenge a wallet signs to swear allegiance.
 *
 * WHO CALLS THIS: the swear control on the war screen, immediately before it
 * asks the wallet to sign. Never earlier — a nonce has a five-minute life and
 * fetching one on page load spends most of it before anybody clicks.
 *
 * RATE LIMITED FOR REAL, since the audit. This comment used to say the route
 * was "rate limited by the same identify() every write path uses" —
 * `identify()` identifies and fails closed on the address; it has never
 * limited anything. Issuing a nonce writes a row, so an unbounded caller was
 * a table growing for free behind a sentence that stopped anybody looking.
 * The count is per `ip_hash` off `oath_nonces` itself (migration 014), on its
 * own budget rather than the payment verifier's — see `tooManyNonces`.
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

  const { warSlug, warTokenId } = (body ?? {}) as Record<string, unknown>;
  if (typeof warSlug !== "string" || typeof warTokenId !== "string") {
    return json(
      { error: "warSlug and warTokenId must be strings." },
      { status: 400, headers: NO_STORE },
    );
  }

  if (await tooManyNonces(caller.ipHash)) {
    return json(
      { error: "Too many signature requests from here recently. Wait a few minutes." },
      { status: 429, headers: { ...NO_STORE, ...(caller.setCookie ? { "set-cookie": caller.setCookie } : {}) } },
    );
  }

  const found = await warBySlug(warSlug);
  if (!found) return json({ error: "No such war." }, { status: 404, headers: NO_STORE });
  const war = await advanceWar(found);

  const token = await queryOne<{ ticker: string }>(
    `SELECT ticker FROM war_tokens WHERE id = $1 AND war_id = $2 AND status = 'active'`,
    [warTokenId, war.id],
  );
  if (!token) {
    return json({ error: "That token is not in this war." }, { status: 400, headers: NO_STORE });
  }

  const challenge = await issueOathChallenge({
    warId: war.id,
    warSlug: war.slug,
    ticker: token.ticker,
    ipHash: caller.ipHash,
  });

  return json(
    {
      nonce: challenge.nonce,
      // The exact bytes to sign. The server keeps its own copy and checks
      // against that, so a client that alters this only fails its own oath.
      message: challenge.message,
      expiresAt: challenge.expiresAt.toISOString(),
    },
    {
      headers: { ...NO_STORE, ...(caller.setCookie ? { "set-cookie": caller.setCookie } : {}) },
    },
  );
}
