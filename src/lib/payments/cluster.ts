/**
 * Which Solana cluster a payment screen is really talking to, in words.
 *
 * Its own module because both answers here are decided in the browser and
 * both belong in a test: a component that reads `window.location` cannot be
 * asserted about from Node, and these two functions can.
 */

const CLUSTER_LABELS: Record<string, string> = {
  "solana:mainnet": "Solana mainnet",
  "solana:devnet": "Solana devnet",
  "solana:testnet": "Solana testnet",
  "solana:localnet": "Solana localnet",
};

/**
 * A Wallet Standard chain id as a name a payer can read.
 *
 * The fallback is prose, not the id. An unmapped chain would otherwise put
 * `solana:something` on the one panel this flow asks somebody to check before
 * signing, which is the machine-token-on-screen defect all over again.
 */
export function clusterLabel(chain: string): string {
  return CLUSTER_LABELS[chain] ?? "an unrecognised Solana cluster";
}

/**
 * Whether a page served from `hostname` is a development one.
 *
 * Asked directly instead of inferred from the RPC endpoint, because the
 * adapter's own mapping (`getChainForEndpoint`) answers `solana:mainnet` for
 * every endpoint it does not recognise — including `/api/rpc` on any real
 * host, and including `http://[::1]:3000/api/rpc`, which is as local as a
 * page gets and matches none of its patterns. A disclosure that leans on that
 * mapping is self-consistent rather than self-checking: it agrees with what
 * the wallet is told because it is the same call, and it is silent exactly
 * where it would need to speak.
 *
 * IPv6 loopback is spelled both ways because `window.location.hostname`
 * strips the brackets a URL puts around it while a URL string keeps them.
 */
export function isLocalHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    host.startsWith("127.") ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "0:0:0:0:0:0:0:1"
  );
}
