import { identify, json, NO_STORE } from "../../../../lib/http";
import { issueOathChallenge } from "../../../../lib/paint/oath";
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
 * Rate limited by the same `identify()` every write path uses, because
 * issuing nonces writes rows and an unbounded caller is a table that grows
 * for free. The limit is the caller's own; nothing about the wallet is known
 * yet at this point, and that is the whole reason the challenge exists.
 */
export async function POST(request: Request): Promise<Response> {
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
