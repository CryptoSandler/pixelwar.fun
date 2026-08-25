/**
 * Payment configuration. We only ever RECEIVE: there is no private key, no
 * signing and no withdrawal path anywhere in this project. The wallet is
 * operated entirely outside it, and is supplied by environment.
 */

/**
 * The real USDC mint on Solana mainnet. Hardcoded on purpose: the whole point
 * of checking it is that anyone can deploy a token called "USDC", and a config
 * value for this would just move the attack one level out.
 */
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export const USDC_DECIMALS = 6;

/** How long an order's reservation holds its colour before it expires and has to be started again. */
export const PAYMENT_WINDOW_MINUTES = 30;

/**
 * How long after an order's payment window closes a late-arriving transfer
 * still gets a chance to settle against it, instead of going straight to
 * unmatched_payments. The colour is not held during this grace period — a
 * released reservation frees it immediately — so a late confirm still races
 * whoever else takes that colour in the meantime.
 */
export const LATE_CONFIRM_GRACE_MINUTES = 10;

/** Confirmations we require before treating a transfer as settled. */
export const RPC_COMMITMENT = "confirmed";

/**
 * Solana RPC endpoints, tried in order. Comma-separated so a paid provider can
 * be put in front of the public node without a code change; the public endpoint
 * is heavily rate limited and does not always serve historical transactions.
 */
export function solanaRpcUrls(): string[] {
  const configured = process.env.SOLANA_RPC_URL?.split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  return configured?.length ? configured : ["https://api.mainnet-beta.solana.com"];
}

/** Attempts per verification, across all configured endpoints. */
export const RPC_MAX_ATTEMPTS = 3;
/** First backoff step; doubles each retry, capped by RPC_BACKOFF_MAX_MS. */
export const RPC_BACKOFF_MS = 300;
/** Ceiling on a single backoff step, so a retry cannot hold a request open. */
export const RPC_BACKOFF_MAX_MS = 1_200;

/**
 * Tolerance when comparing a transaction's on-chain blockTime against an
 * order's own payment window. Our clock and the cluster's are not the same
 * clock; two minutes is generous for skew without meaningfully widening the
 * window a payment can land in.
 */
export const BLOCKTIME_SKEW_SECONDS = 120;

/**
 * Rate limits on verification. Without them, one order id could drive
 * unlimited RPC calls — checking a payment costs a real request to the
 * cluster, and that request is spent whether or not the payment turns out to
 * exist.
 */
export const VERIFY_LIMITS = {
  /** Attempts allowed against a single order within the window. */
  perOrder: 10,
  /** Attempts allowed from one caller within the window, across all orders. */
  perIp: 30,
  windowMinutes: 10,
  /** Minimum gap between two attempts on the same order, in seconds. */
  minIntervalSeconds: 3,
} as const;

/**
 * Where someone whose payment did not match is told to go. Not a promise that
 * it is automated — it is a human queue, and the copy says so.
 */
export function supportContact(): string | null {
  return process.env.SUPPORT_CONTACT?.trim() || null;
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

const BASE58_INDEX: Record<string, number> = {};
for (let i = 0; i < BASE58_ALPHABET.length; i++) BASE58_INDEX[BASE58_ALPHABET[i]] = i;

/**
 * Decodes a base58 string to bytes, or null when a character falls outside
 * the alphabet.
 *
 * This project speaks one chain. The sibling project's address checker covers
 * EVM, TRON and TON too, because it lists tokens across all of them; nothing
 * here ever needs those, so only the Solana case is carried across.
 */
function base58Decode(input: string): Uint8Array | null {
  const bytes: number[] = [0];
  for (const char of input) {
    const value = BASE58_INDEX[char];
    if (value === undefined) return null;

    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  // Every leading '1' is a leading zero byte.
  for (const char of input) {
    if (char !== BASE58_ALPHABET[0]) break;
    bytes.push(0);
  }

  return Uint8Array.from(bytes.reverse());
}

type AddressCheck = { ok: true; address: string } | { ok: false; reason: string };

/**
 * Shape-checks a Solana address: base58 that decodes to exactly 32 bytes.
 * Note: base58 is dense enough that lopping one character off a 44-character
 * address can still decode to 32 bytes, so this cannot catch every
 * truncation — only an on-chain lookup can.
 */
function checkSolanaAddress(raw: string): AddressCheck {
  if (!BASE58_RE.test(raw)) {
    return {
      ok: false,
      reason: "A Solana address is base58: no 0, O, I or l, and no 0x prefix.",
    };
  }
  const decoded = base58Decode(raw);
  if (!decoded || decoded.length !== 32) {
    return { ok: false, reason: "A Solana address decodes to 32 bytes (usually 32-44 characters)." };
  }
  return { ok: true, address: raw };
}

export type PaymentWalletResult = { ok: true; address: string } | { ok: false; reason: string };

/**
 * Read and validate the receiving wallet. Deliberately has no fallback: a
 * default here would mean a misconfigured deploy quietly collects payments to
 * somebody else's address.
 */
export function paymentWallet(): PaymentWalletResult {
  const raw = process.env.PAYMENT_WALLET?.trim();
  if (!raw) {
    return {
      ok: false,
      reason: "Payments are not configured on this deployment (PAYMENT_WALLET is unset).",
    };
  }

  const checked = checkSolanaAddress(raw);
  if (!checked.ok) {
    return { ok: false, reason: `PAYMENT_WALLET is not a valid Solana address: ${checked.reason}` };
  }

  return { ok: true, address: checked.address };
}

/**
 * Whole dollars to USDC base units.
 *
 * Entry prices are whole dollars. A fractional amount here means a caller is
 * inventing a price, and rounding it silently would take the wrong sum, so
 * anything that is not a non-negative integer throws rather than being
 * coerced.
 */
export function usdToBaseUnits(amountUsd: number): bigint {
  if (!Number.isInteger(amountUsd) || amountUsd < 0) {
    throw new RangeError(
      `usdToBaseUnits expects a non-negative whole-dollar amount, got ${amountUsd}.`,
    );
  }
  return BigInt(amountUsd) * 10n ** BigInt(USDC_DECIMALS);
}

/**
 * Renders USDC base units as a decimal string, always at least two decimal
 * places — this reads like a dollar amount. Precision above two decimals is
 * kept rather than rounded away: this is used to tell a payer what actually
 * arrived, and a mismatched payment is exactly the case where the real amount
 * matters.
 */
export function formatUsdc(baseUnits: bigint): string {
  const whole = baseUnits / 1_000_000n;
  const fraction = (baseUnits % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  const decimals = fraction.length < 2 ? fraction.padEnd(2, "0") : fraction;
  return `${whole}.${decimals}`;
}
