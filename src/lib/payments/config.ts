import { validateAddress } from "../tokens/addresses";

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
 * How long after an order's payment window closes a `/confirm` arriving late
 * still attempts to take its reservation's colour back, instead of going
 * straight to unmatched_payments.
 *
 * The colour frees the instant the reservation expires — this constant does
 * not hold it. A late confirm inside this window still tries to flip the
 * released row back to active, and loses the race if someone else already
 * took the colour; a late confirm outside this window skips the attempt
 * entirely and goes to unmatched_payments right away.
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

export type PaymentWalletResult = { ok: true; address: string } | { ok: false; reason: string };

/**
 * Read and validate the receiving wallet. Deliberately has no fallback: a
 * default here would mean a misconfigured deploy quietly collects payments to
 * somebody else's address.
 *
 * Address validation itself is not duplicated here. It used to be a private
 * base58 checker that had already drifted from the one in `solana.ts` — see
 * `src/lib/tokens/addresses.ts` for the shared check both this and every
 * chain's address input now go through.
 */
export function paymentWallet(): PaymentWalletResult {
  const raw = process.env.PAYMENT_WALLET?.trim();
  if (!raw) {
    return {
      ok: false,
      reason: "Payments are not configured on this deployment (PAYMENT_WALLET is unset).",
    };
  }

  const checked = validateAddress("solana", raw);
  if (!checked.ok) {
    return { ok: false, reason: `PAYMENT_WALLET is not a valid Solana address: ${checked.reason}` };
  }

  return { ok: true, address: checked.canonical };
}

/**
 * Whole dollars to USDC base units.
 *
 * Entry prices are whole dollars. A fractional amount here means a caller is
 * inventing a price, and rounding it silently would take the wrong sum, so
 * anything that is not a non-negative whole dollar amount throws rather than
 * being coerced.
 *
 * The guard is Number.isSafeInteger, not Number.isInteger: past 2**53 a
 * float no longer has a neighbour (2**60 === 2**60 + 1), so two different
 * intended dollar amounts would arrive as the same number and nothing
 * downstream could tell which was meant. Number.isSafeInteger already rejects
 * Infinity and NaN, since neither is an integer; -0 needs an explicit check,
 * since it IS a safe integer and `-0 < 0` is false, and a zero-dollar entry
 * is not a thing.
 */
export function usdToBaseUnits(amountUsd: number): bigint {
  if (!Number.isSafeInteger(amountUsd) || amountUsd < 0 || Object.is(amountUsd, -0)) {
    throw new RangeError(
      `usdToBaseUnits expects a non-negative, whole-dollar amount that a JS number can hold exactly, got ${amountUsd}.`,
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

/**
 * Lamports in one SOL. Not a setting.
 */
export const LAMPORTS_PER_SOL = 1_000_000_000n;

/**
 * What registering to paint costs, denominated in SOL.
 *
 * IN SOL AND NOT IN DOLLARS, and that was a deliberate refusal rather than a
 * shortcut. A dollar price charged in SOL needs a live SOL/USD rate, which
 * means an external price feed in the money path — with its own outage ("can
 * nobody register while the feed is down?"), its own staleness window, and
 * its own manipulation surface — to collect the equivalent of fifty cents.
 * The USDC checkout dodges the entire problem by using a dollar-pegged token;
 * this path cannot, so it does not pretend to. When SOL moves far enough to
 * matter, the operator moves this number, which is the same gesture the
 * amount already required.
 *
 * ZERO IS A VALID VALUE AND IT IS THE DOOR. Set it to 0 and registration
 * becomes a wallet signature with no payment — the whole fee switches off
 * with a variable and no deploy. It exists so a launch that shows the fee is
 * killing the volume can stop charging in a minute instead of a release.
 *
 * NEVER CALL IT A NETWORK FEE in copy. The network's own fee is under a
 * thousandth of a cent; this one is ours, and saying otherwise would be a
 * lie about who is being paid.
 */
export function registrationFeeLamports(): bigint {
  const raw = process.env.REGISTRATION_FEE_SOL?.trim();
  const sol = raw === undefined || raw === "" ? 0.003 : Number(raw);
  if (!Number.isFinite(sol) || sol < 0) {
    // A malformed value falls back to the default rather than to zero: a typo
    // that silently switches the fee off is a typo that costs money quietly,
    // and one that silently raises it is worse.
    console.error(`REGISTRATION_FEE_SOL is not a non-negative number: ${raw}. Using 0.003.`);
    return (LAMPORTS_PER_SOL * 3n) / 1000n;
  }
  // Rounded to whole lamports, which is what the chain moves.
  return BigInt(Math.round(sol * Number(LAMPORTS_PER_SOL)));
}

/**
 * Lamports as a SOL amount somebody can read.
 *
 * Trailing zeros trimmed, but never below two decimals, so the number on
 * screen looks like a price rather than like a float. The exact value is
 * kept: this quotes what a wallet is about to be asked for, and a rounded
 * quote next to an unrounded wallet dialog is the kind of small disagreement
 * that makes a payer close the tab.
 */
export function formatSol(lamports: bigint): string {
  const whole = lamports / LAMPORTS_PER_SOL;
  const fraction = (lamports % LAMPORTS_PER_SOL).toString().padStart(9, "0").replace(/0+$/, "");
  const decimals = fraction.length < 2 ? fraction.padEnd(2, "0") : fraction;
  return `${whole}.${decimals}`;
}

/** True when the operator has switched the fee off. */
export function registrationIsFree(): boolean {
  return registrationFeeLamports() === 0n;
}
