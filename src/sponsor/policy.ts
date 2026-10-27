import type { Intent, RelayRequest } from "../types.js";
import type { SponsorPolicy } from "../rest/sponsorCaps.js";

export const SPONSORED_MAINNETS = [10, 8453, 42161] as const;
export const SPONSORED_TESTNETS = [11155111, 11155420, 84532, 421614] as const;

export type SponsorRuntime = {
  policy: SponsorPolicy;
  kick(): void;
  /** Absent while no lane is configured; the relay route then answers 503. */
  relay?: (intent: Intent, chainId: number) => Promise<RelayRequest>;
};

export function sponsorFamily(chainIds: number[]): "mainnet" | "testnet" | null {
  if (chainIds.length && chainIds.every((id) => (SPONSORED_MAINNETS as readonly number[]).includes(id))) {
    return "mainnet";
  }
  if (chainIds.length && chainIds.every((id) => (SPONSORED_TESTNETS as readonly number[]).includes(id))) {
    return "testnet";
  }
  return null;
}

/** The chains Center sponsors, in the order they were given. */
export function sponsoredChains(chainIds: readonly number[]): number[] {
  return chainIds.filter(
    (chainId) =>
      (SPONSORED_MAINNETS as readonly number[]).includes(chainId) ||
      (SPONSORED_TESTNETS as readonly number[]).includes(chainId),
  );
}

export function isSponsoredChain(chainId: number): boolean {
  return sponsoredChains([chainId]).length === 1;
}
