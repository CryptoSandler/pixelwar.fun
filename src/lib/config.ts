/**
 * Environment readers.
 *
 * Each one throws rather than defaulting. A default for any of these is a
 * production deploy that looks healthy while doing the wrong thing: an unsalted
 * hash, an unsigned cookie, or a rate limit anyone can opt out of.
 */

function required(name: string, why: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set. ${why}`);
  return value;
}

export function rateLimitSalt(): string {
  return required(
    "RATE_LIMIT_SALT",
    "An unsalted SHA-256 of an IPv4 address is reversible by brute force, so the " +
      "stored hashes would be visitor IP addresses in all but name.",
  );
}

export function painterCookieSecret(): string {
  return required(
    "PAINTER_COOKIE_SECRET",
    "Without it anyone can mint a painter identity per pixel and the cooldown means nothing.",
  );
}

export function trustedProxyHops(): number {
  const raw = process.env.TRUSTED_PROXY_HOPS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : 1;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export function allowUntrustedClientIp(): boolean {
  return process.env.ALLOW_UNTRUSTED_CLIENT_IP?.trim() === "true";
}

/**
 * Which platform header, if any, this deployment trusts as the caller's real
 * address.
 *
 * Unset by default: no platform header is trusted until we are told which
 * edge we are running behind, because a header is only unforgeable when that
 * platform's edge is the one writing it. `client-ip.ts` still validates the
 * value against the headers it actually knows how to use — this function only
 * reads the environment.
 */
export function trustedPlatformHeader(): string | null {
  return process.env.TRUSTED_PLATFORM_HEADER?.trim() || null;
}

/**
 * Paints allowed per subnet per window, before the burst cap bites.
 *
 * A function, not a constant: a module-level constant freezes the value at
 * import time, which makes it unreadable to any test that needs a different
 * cap and untunable without a redeploy.
 */
export function subnetBurst(): { cap: number; windowSeconds: number } {
  return {
    cap: positiveInt(process.env.PAINT_SUBNET_BURST, 60),
    windowSeconds: positiveInt(process.env.PAINT_SUBNET_WINDOW_SECONDS, 60),
  };
}

/** Beyond this many changes, a client is told to refetch the board instead. */
export function diffMaxChanges(): number {
  return positiveInt(process.env.DIFF_MAX_CHANGES, 8000);
}

/**
 * A positive integer from the environment, or the documented default.
 *
 * Unlike the rest of this file, a bad value here does not throw: these two
 * settings are tunable knobs, not secrets a missing value should block
 * startup over. But `Number.parseInt` on garbage — or on an unset variable
 * coerced through `??` — produces NaN, and NaN is not a fallback, it is a
 * value that reaches Postgres as an integer parameter and gets rejected,
 * 500ing every single paint. Falling back explicitly here is what makes a
 * typo in the environment merely wrong instead of an outage.
 */
function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = raw?.trim() ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
