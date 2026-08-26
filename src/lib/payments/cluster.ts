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

/** The four Solana clusters, plus the honest answer when we cannot tell. */
export type ProxyCluster =
  | "solana:mainnet"
  | "solana:devnet"
  | "solana:testnet"
  | "solana:localnet"
  | "unknown";

/**
 * Which cluster an RPC endpoint talks to, from its shape alone.
 *
 * **The URL never leaves the server, and neither does anything derived from it
 * except the five words this returns.** `/api/rpc` exists so that a paid
 * provider's endpoint — key and all — stays server-side, and a cluster
 * disclosure built by shipping the URL to the browser would undo that from a
 * different direction. So the classification happens here, on the server, and
 * only its answer is passed down.
 *
 * The query string is deliberately not read. That is where a provider puts
 * its API key, and nothing about which cluster this is needs it.
 *
 * `unknown` is a real answer, not a failure to try: a provider URL with no
 * cluster in its host or path — some do exist — is one this cannot identify,
 * and identifying it wrongly as mainnet is the entire defect this function
 * was added to prevent. The caller blocks on `unknown`, because refusing to
 * take a payment is the safe half of being unsure.
 */
export function classifyEndpoint(endpoint: string): ProxyCluster {
  let url: URL;
  try {
    url = new URL(endpoint.trim());
  } catch {
    return "unknown";
  }
  if (isLocalHostname(url.hostname)) return "solana:localnet";

  const subject = `${url.hostname}${url.pathname}`.toLowerCase();
  if (/\bdevnet\b/.test(subject)) return "solana:devnet";
  if (/\btestnet\b/.test(subject)) return "solana:testnet";
  // `mainnet-beta` and `solana-mainnet` both land here: a hyphen is not a word
  // character, so the boundary holds either side of it.
  if (/\bmainnet\b/.test(subject)) return "solana:mainnet";
  return "unknown";
}

/**
 * The cluster of a whole configured list, which is one answer only if they
 * agree.
 *
 * `SOLANA_RPC_URL` takes several endpoints, tried in order, and the verifier
 * uses all of them while the proxy uses the first. A list spanning two
 * clusters has no single truthful answer to "which network is this", so it
 * gets the answer that blocks.
 */
export function classifyEndpoints(endpoints: string[]): ProxyCluster {
  if (endpoints.length === 0) return "unknown";
  const [first, ...rest] = endpoints.map(classifyEndpoint);
  return rest.every((cluster) => cluster === first) ? first : "unknown";
}

export type PaymentSafety = { ok: true } | { ok: false; message: string };

/**
 * Whether this screen can honestly take a payment, and if not, the one
 * sentence that says why.
 *
 * One function, one answer, one message — so there is one disabled button and
 * one alert rather than a guard per hazard. The hazards are different facts
 * and each gets its own sentence, but a screen that refuses for two reasons
 * at once still refuses once.
 *
 * The order matters. "Cannot tell" comes before "they disagree", because an
 * unknown cluster cannot be compared with anything; disagreement comes before
 * "not mainnet", because naming both halves is more useful than naming one;
 * and the development origin comes last, since it is the only hazard where
 * everything else is genuinely fine.
 */
export function paymentSafety(input: {
  /** Served from a developer's machine — asked of the origin, not of the RPC URL. */
  localOrigin: boolean;
  /** The chain tag the wallet adapter will attach, from `getChainForEndpoint`. */
  signingChain: string;
  /** What this deployment's own proxy talks to, classified on the server. */
  proxyCluster: ProxyCluster;
}): PaymentSafety {
  const { localOrigin, signingChain, proxyCluster } = input;

  if (proxyCluster === "unknown") {
    return {
      ok: false,
      message:
        "This deployment's Solana connection could not be identified as mainnet, so paying is " +
        "turned off on this screen. Nothing has been charged.",
    };
  }

  if (proxyCluster !== signingChain) {
    return {
      ok: false,
      message:
        `This deployment settles payments on ${clusterLabel(proxyCluster)}, and your wallet ` +
        `would be asked to sign on ${clusterLabel(signingChain)}. A payment made here could not ` +
        "be credited, so paying is turned off on this screen.",
    };
  }

  if (signingChain !== "solana:mainnet") {
    return {
      ok: false,
      message:
        `Your wallet would be asked to sign on ${clusterLabel(signingChain)}. The entry price is ` +
        "mainnet USDC, so a payment made here could never be credited, and paying is turned off " +
        "on this screen.",
    };
  }

  if (localOrigin) {
    return {
      ok: false,
      message:
        "This page is served from a development machine. A payment from here would move real " +
        "USDC on Solana mainnet, so paying is turned off on this screen.",
    };
  }

  return { ok: true };
}
