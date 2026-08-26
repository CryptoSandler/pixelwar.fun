import { describe, expect, it } from "vitest";
import { getChainForEndpoint } from "@solana/wallet-standard-util";
import {
  classifyEndpoint,
  classifyEndpoints,
  clusterLabel,
  isLocalHostname,
  paymentSafety,
} from "../cluster";

describe("naming a cluster", () => {
  it("names the four Solana chains", () => {
    expect(clusterLabel("solana:mainnet")).toBe("Solana mainnet");
    expect(clusterLabel("solana:localnet")).toBe("Solana localnet");
  });

  it("answers an unmapped chain with prose, never the machine id", () => {
    expect(clusterLabel("solana:something-new")).not.toContain("solana:");
  });
});

describe("spotting a development origin", () => {
  it("recognises every spelling of loopback", () => {
    for (const host of ["localhost", "LOCALHOST", "app.localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]", "0:0:0:0:0:0:0:1"]) {
      expect(isLocalHostname(host), host).toBe(true);
    }
  });

  it("does not mistake a real host for one", () => {
    for (const host of ["pixelwar.fun", "192.168.1.59", "localhost.example.com", "notlocalhost"]) {
      expect(isLocalHostname(host), host).toBe(false);
    }
  });

  // The reason this function exists rather than reading the chain the adapter
  // derives. `getChainForEndpoint` matches the literal mainnet URL, then
  // /\bdevnet\b/, /\btestnet\b/, then `localhost` or `127.0.0.1` — and
  // answers mainnet for everything else. IPv6 loopback matches none of them,
  // so the adapter's mapping calls the most local origin there is "mainnet".
  it("catches the local origin the adapter's own mapping calls mainnet", () => {
    expect(getChainForEndpoint("http://[::1]:3000/api/rpc")).toBe("solana:mainnet");
    expect(isLocalHostname("[::1]")).toBe(true);
  });
});

describe("classifying the proxy's own upstream", () => {
  it("reads the cluster out of the host or the path", () => {
    expect(classifyEndpoint("https://api.mainnet-beta.solana.com")).toBe("solana:mainnet");
    expect(classifyEndpoint("https://mainnet.helius-rpc.com/")).toBe("solana:mainnet");
    expect(classifyEndpoint("https://x.solana-mainnet.quiknode.pro/abc/")).toBe("solana:mainnet");
    expect(classifyEndpoint("https://api.devnet.solana.com")).toBe("solana:devnet");
    expect(classifyEndpoint("https://devnet.helius-rpc.com/")).toBe("solana:devnet");
    expect(classifyEndpoint("https://api.testnet.solana.com")).toBe("solana:testnet");
    expect(classifyEndpoint("http://127.0.0.1:8899")).toBe("solana:localnet");
  });

  it("says unknown rather than guessing mainnet", () => {
    // The whole point: an unmarked provider URL is the case that used to be
    // silently called mainnet, by the adapter's own mapping.
    expect(classifyEndpoint("https://example-rpc.io/abc123")).toBe("unknown");
    expect(classifyEndpoint("not a url")).toBe("unknown");
    expect(classifyEndpoint("")).toBe("unknown");
  });

  it("never reads the query string, where a provider's key lives", () => {
    // A key that happens to contain "devnet" must not decide the cluster, and
    // a mainnet host must not be reclassified by one.
    expect(classifyEndpoint("https://api.mainnet-beta.solana.com/?api-key=devnet-xyz")).toBe(
      "solana:mainnet",
    );
    expect(classifyEndpoint("https://example-rpc.io/?cluster=mainnet")).toBe("unknown");
  });

  it("refuses to name a cluster for a list that spans two", () => {
    expect(classifyEndpoints(["https://api.mainnet-beta.solana.com"])).toBe("solana:mainnet");
    expect(
      classifyEndpoints(["https://api.mainnet-beta.solana.com", "https://mainnet.helius-rpc.com"]),
    ).toBe("solana:mainnet");
    expect(
      classifyEndpoints(["https://api.mainnet-beta.solana.com", "https://api.devnet.solana.com"]),
    ).toBe("unknown");
    expect(classifyEndpoints([])).toBe("unknown");
  });
});

describe("deciding whether this screen can take a payment", () => {
  const live = {
    localOrigin: false,
    signingChain: "solana:mainnet",
    proxyCluster: "solana:mainnet",
  } as const;

  it("allows a real deployment on a real origin", () => {
    expect(paymentSafety(live)).toEqual({ ok: true });
  });

  // The hole this was built for: the browser only ever sees `/api/rpc`, so
  // before the server classified its own upstream, a deployment pointed at
  // devnet showed "Solana mainnet" and an enabled button.
  it("blocks a deployment whose proxy is on devnet while the wallet signs mainnet", () => {
    const verdict = paymentSafety({ ...live, proxyCluster: "solana:devnet" });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.message).toContain("Solana devnet");
    expect(verdict.message).toContain("Solana mainnet");
    expect(verdict.message).toContain("could not be credited");
  });

  it("blocks when the deployment's cluster cannot be identified", () => {
    const verdict = paymentSafety({ ...live, proxyCluster: "unknown" });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.message).toContain("could not be identified");
  });

  it("blocks a wallet that would sign somewhere the entry price does not exist", () => {
    const verdict = paymentSafety({
      localOrigin: true,
      signingChain: "solana:localnet",
      proxyCluster: "solana:localnet",
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.message).toContain("Solana localnet");
  });

  it("blocks a development origin even when everything else is mainnet", () => {
    const verdict = paymentSafety({ ...live, localOrigin: true });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.message).toContain("development machine");
  });

  it("never puts a machine chain id in a message", () => {
    for (const proxyCluster of ["solana:devnet", "unknown"] as const) {
      const verdict = paymentSafety({ ...live, proxyCluster });
      if (verdict.ok) continue;
      expect(verdict.message).not.toContain("solana:");
    }
  });
});
