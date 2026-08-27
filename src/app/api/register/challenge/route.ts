import { json, NO_STORE } from "../../../../lib/http";
import { issueLinkChallenge } from "../../../../lib/paint/registration";

export const dynamic = "force-dynamic";

/**
 * A challenge for claiming an existing registration on this browser.
 *
 * Issued to anybody who asks, like the oath's. Nothing is granted by holding
 * one: it is a random string that becomes useful only when a wallet signs it,
 * and the wallet it names has to have paid already.
 */
export async function POST(): Promise<Response> {
  const challenge = await issueLinkChallenge();
  return json(
    {
      nonce: challenge.nonce,
      message: challenge.message,
      expiresAt: challenge.expiresAt.toISOString(),
    },
    { headers: NO_STORE },
  );
}
