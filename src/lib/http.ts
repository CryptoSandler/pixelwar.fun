import { issuePainter, painterSetCookie, readPainter } from "./paint/painter";
import { clientIp, hashIp, subnetKey } from "./paint/client-ip";

/**
 * Who is calling, in one place.
 *
 * Fails closed on the address: without a trustworthy one there is no rate
 * limit, and a shared bucket for every anonymous caller is either an unlimited
 * allowance or a self-inflicted outage.
 */
export type Caller =
  | { ok: true; painterKey: string; ipHash: string; subnetKey: string; setCookie?: string }
  | { ok: false; message: string };

export function identify(request: Request): Caller {
  const identity = clientIp(request);
  if (!identity.ok) {
    // The operational detail (which env var to set, how many proxy hops are
    // configured) is for the server log, not the caller: it names
    // ALLOW_UNTRUSTED_CLIENT_IP, the variable that switches rate limiting
    // off, and this message is returned in a 400 body that the client
    // renders straight into the user's error pill.
    console.error(`identify: ${identity.reason}`);
    return {
      ok: false,
      message: "This request could not be verified. Please try again.",
    };
  }

  const existing = readPainter(request);
  if (existing) {
    return {
      ok: true,
      painterKey: existing,
      ipHash: hashIp(identity.ip),
      subnetKey: subnetKey(identity.ip),
    };
  }

  const issued = issuePainter();
  return {
    ok: true,
    painterKey: issued.painterKey,
    ipHash: hashIp(identity.ip),
    subnetKey: subnetKey(identity.ip),
    setCookie: painterSetCookie(issued.cookieValue),
  };
}

export const NO_STORE = { "cache-control": "no-store" };

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}
