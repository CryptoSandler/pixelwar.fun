/**
 * "Is this order paid yet?", asked of our own server.
 *
 * One copy, shared by both payment paths. It was two — `PayWithWallet` and
 * `PasteSignature` had the same six lines and the same doc comment — and
 * `base58.ts`'s own header records what happens next: two copies of a helper
 * drift inside a single batch, and the difference is found by whoever hits it.
 *
 * Never throws and never rejects. Both callers ask this at the one moment
 * where being wrong is expensive — after a signature came back
 * `signature_reused`, when the question is whether that means "your payment
 * already settled" or "somebody else claimed that signature" — so a network
 * blip must read as "cannot tell", never as "not paid".
 */
export async function orderStatus(orderId: string): Promise<string | null> {
  try {
    const response = await fetch(`/api/orders/${orderId}`);
    if (!response.ok) return null;
    const body = (await response.json()) as { status?: string };
    return body.status ?? null;
  } catch {
    return null;
  }
}
