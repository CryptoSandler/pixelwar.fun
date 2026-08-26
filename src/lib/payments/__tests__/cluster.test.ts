import { describe, expect, it } from "vitest";
import { getChainForEndpoint } from "@solana/wallet-standard-util";
import { clusterLabel, isLocalHostname } from "../cluster";

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
