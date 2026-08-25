import type { AddressFamily } from "./addresses";

export type ChainId =
  | "solana"
  | "bnb"
  | "robinhood"
  | "base"
  | "ethereum"
  | "ton"
  | "tron"
  | "hyperliquid";

export type Chain = {
  id: ChainId;
  name: string;
  /** Short form used in tight UI, e.g. a row badge. */
  short: string;
  family: AddressFamily;
  /**
   * DexScreener's own identifier for this chain, which is not always what you
   * would guess — Hyperliquid is "hyperevm" and BNB Chain is "bsc". Getting
   * this wrong makes every lookup on the chain silently return nothing: no
   * error, just an empty answer that reads as "token not found".
   */
  dexscreenerId: string;
  /** Explains the expected format, shown under the input. */
  addressHint: string;
  /** A shape-of-the-thing sample, shown inside the input. */
  addressPlaceholder: string;
};

export const CHAINS: Chain[] = [
  {
    id: "solana",
    dexscreenerId: "solana",
    name: "Solana",
    short: "SOL",
    family: "solana",
    addressHint: "Base58 mint address, 32–44 characters.",
    addressPlaceholder: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  },
  {
    id: "bnb",
    dexscreenerId: "bsc",
    name: "BNB Chain",
    short: "BNB",
    family: "evm",
    addressHint: "0x plus 40 hex characters.",
    addressPlaceholder: "0x0000000000000000000000000000000000000000",
  },
  {
    id: "robinhood",
    dexscreenerId: "robinhood",
    name: "Robinhood Chain",
    short: "RHC",
    // An Arbitrum L2 with no native token — gas is paid in ETH — so
    // addresses are ordinary EVM addresses.
    family: "evm",
    addressHint: "0x plus 40 hex characters.",
    addressPlaceholder: "0x0000000000000000000000000000000000000000",
  },
  {
    id: "base",
    dexscreenerId: "base",
    name: "Base",
    short: "BASE",
    family: "evm",
    addressHint: "0x plus 40 hex characters.",
    addressPlaceholder: "0x0000000000000000000000000000000000000000",
  },
  {
    id: "ethereum",
    dexscreenerId: "ethereum",
    name: "Ethereum",
    short: "ETH",
    family: "evm",
    addressHint: "0x plus 40 hex characters.",
    addressPlaceholder: "0x0000000000000000000000000000000000000000",
  },
  {
    id: "ton",
    dexscreenerId: "ton",
    name: "TON",
    short: "TON",
    family: "ton",
    addressHint: "User-friendly EQ…/UQ… form, or raw 0:<64 hex>.",
    addressPlaceholder: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs",
  },
  {
    id: "tron",
    dexscreenerId: "tron",
    name: "TRON",
    short: "TRX",
    family: "tron",
    addressHint: "Starts with T, 34 characters.",
    addressPlaceholder: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
  },
  {
    id: "hyperliquid",
    dexscreenerId: "hyperevm",
    name: "Hyperliquid",
    short: "HYPE",
    family: "evm",
    addressHint: "0x plus 40 hex characters (HyperEVM).",
    addressPlaceholder: "0x0000000000000000000000000000000000000000",
  },
];

const BY_ID = new Map(CHAINS.map((chain) => [chain.id, chain]));

export function getChain(id: string): Chain | undefined {
  return BY_ID.get(id as ChainId);
}

export function isChainId(value: string): value is ChainId {
  return BY_ID.has(value as ChainId);
}

/**
 * DexScreener's page for a token, built from the chain and the address.
 *
 * Constructed rather than stored, so every row has this link even when the
 * token carries no metadata at all: DexScreener resolves a token address to its
 * pairs itself, and a token that could be listed here was found there already.
 */
export function dexscreenerTokenUrl(chainId: string, contract: string): string | null {
  const chain = getChain(chainId);
  if (!chain) return null;
  return `https://dexscreener.com/${chain.dexscreenerId}/${encodeURIComponent(contract)}`;
}
