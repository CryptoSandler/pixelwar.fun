import { identify, json, NO_STORE, refuseForeignOrigin } from "../../../../lib/http";
import { tooManyNonces } from "../../../../lib/paint/oath";
import { issueLinkChallenge } from "../../../../lib/paint/registration";

export const dynamic = "force-dynamic";

/**
 * A challenge for claiming an existing registration on this browser.
 *
 * Issued to anybody who asks, like the oath's. Nothing is granted by holding
 * one: it is a random string that becomes useful only when a wallet signs it,
 * and the wallet it names has to have paid already.
 */
export async function POST(request: Request): Promise<Response> {
  const foreign = refuseForeignOrigin(request);
  if (foreign) return foreign;

  // Issuing a challenge WRITES A ROW, so it needs a caller that can be held
  // to an address like every other write. This route had neither guard when
  // the audit ran: a bare POST with no cookie and no trustworthy client
  // address inserted a nonce, for free, forever.
  const caller = identify(request);
  if (!caller.ok) return json({ error: caller.message }, { status: 400, headers: NO_STORE });

  // Same budget and same counter as the oath's challenge: both write into
  // `oath_nonces`, so one limit over that table is the honest shape rather
  // than two allowances a caller can spend in turn.
  if (await tooManyNonces(caller.ipHash)) {
    return json(
      { error: "Too many signature requests from here recently. Wait a few minutes." },
      { status: 429, headers: { ...NO_STORE, ...(caller.setCookie ? { "set-cookie": caller.setCookie } : {}) } },
    );
  }

  const challenge = await issueLinkChallenge(caller.ipHash);
  return json(
    {
      nonce: challenge.nonce,
      message: challenge.message,
      expiresAt: challenge.expiresAt.toISOString(),
    },
    {
      headers: { ...NO_STORE, ...(caller.setCookie ? { "set-cookie": caller.setCookie } : {}) },
    },
  );
}
