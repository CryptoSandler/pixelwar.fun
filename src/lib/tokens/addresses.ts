import { base58Decode } from "../base58";
import { getChain } from "./chains";

export type AddressFamily = "evm" | "solana" | "ton" | "tron";

export type AddressCheck =
  | { ok: true; canonical: string; display: string }
  | { ok: false; reason: string };

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
const TON_FRIENDLY_RE = /^[A-Za-z0-9_-]{48}$/;
const TON_RAW_RE = /^(-1|0):[0-9a-fA-F]{64}$/;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** CRC16/XMODEM — the checksum TON uses on user-friendly addresses. */
function crc16(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function decodeBase64Url(input: string): Uint8Array | null {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const binary =
      typeof atob === "function"
        ? atob(padded)
        : Buffer.from(padded, "base64").toString("binary");
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function checkEvm(raw: string): AddressCheck {
  if (!raw.startsWith("0x")) {
    return { ok: false, reason: "EVM addresses start with 0x." };
  }
  if (!EVM_RE.test(raw)) {
    return {
      ok: false,
      reason: "An EVM address is 0x followed by exactly 40 hex characters.",
    };
  }
  // Canonical key is lowercase: 0xAbC… and 0xabc… are the same contract.
  // Note: we validate shape only. EIP-55 checksum casing is not verified here.
  return { ok: true, canonical: raw.toLowerCase(), display: raw };
}

function checkSolana(raw: string): AddressCheck {
  if (!BASE58_RE.test(raw)) {
    return {
      ok: false,
      reason: "A Solana address is base58: no 0, O, I or l, and no 0x prefix.",
    };
  }
  const decoded = base58Decode(raw);
  if (!decoded || decoded.length !== 32) {
    return {
      ok: false,
      reason: "A Solana address decodes to 32 bytes (usually 32–44 characters).",
    };
  }
  return { ok: true, canonical: raw, display: raw };
}

function checkTron(raw: string): AddressCheck {
  if (!raw.startsWith("T") || raw.length !== 34 || !BASE58_RE.test(raw)) {
    return {
      ok: false,
      reason: "A TRON address starts with T and is 34 characters.",
    };
  }
  const decoded = base58Decode(raw);
  // 1 version byte + 20 address bytes + 4 checksum bytes.
  // Note: the trailing base58check checksum itself is not verified here.
  if (!decoded || decoded.length !== 25 || decoded[0] !== 0x41) {
    return { ok: false, reason: "That is not a valid TRON address." };
  }
  return { ok: true, canonical: raw, display: raw };
}

function checkTon(raw: string): AddressCheck {
  if (TON_RAW_RE.test(raw)) {
    const [workchain, hash] = raw.split(":");
    return {
      ok: true,
      canonical: `${workchain}:${hash.toLowerCase()}`,
      display: raw,
    };
  }

  if (!TON_FRIENDLY_RE.test(raw)) {
    return {
      ok: false,
      reason:
        "A TON address is 48 characters (usually starting EQ or UQ) or raw 0:<64 hex>.",
    };
  }

  const decoded = decodeBase64Url(raw);
  if (!decoded || decoded.length !== 36) {
    return { ok: false, reason: "That TON address does not decode correctly." };
  }

  const payload = decoded.slice(0, 34);
  const checksum = (decoded[34] << 8) | decoded[35];
  if (crc16(payload) !== checksum) {
    return {
      ok: false,
      reason: "That TON address fails its checksum. Check for a typo.",
    };
  }

  // Bounceable (EQ…) and non-bounceable (UQ…) encode the SAME account with a
  // different tag byte. Key on workchain + account hash so both collapse to one
  // entry instead of splitting a token's history across two rows.
  const workchain = payload[1] === 0xff ? -1 : payload[1];
  return {
    ok: true,
    canonical: `${workchain}:${toHex(payload.slice(2))}`,
    display: raw,
  };
}

export function checkAddress(family: AddressFamily, input: string): AddressCheck {
  const raw = input.trim();
  if (!raw) return { ok: false, reason: "Enter a contract address." };

  switch (family) {
    case "evm":
      return checkEvm(raw);
    case "solana":
      return checkSolana(raw);
    case "tron":
      return checkTron(raw);
    case "ton":
      return checkTon(raw);
  }
}

/**
 * Same check as `checkAddress`, keyed by chain id instead of address family —
 * what every caller outside this directory actually has on hand (a chain the
 * user picked, not the family it happens to share with other chains).
 *
 * This is also the one address validator in the codebase. `paymentWallet` in
 * `src/lib/payments/config.ts` calls this rather than keeping its own check,
 * so there is exactly one place a Solana address is judged well-formed.
 */
export function validateAddress(chainId: string, input: string): AddressCheck {
  const chain = getChain(chainId);
  if (!chain) return { ok: false, reason: `Unknown chain: ${chainId}.` };
  return checkAddress(chain.family, input);
}

export function shortenAddress(address: string, lead = 4, tail = 4): string {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}
