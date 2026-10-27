import { getAddress, type Abi, type Address, type Hex, type PublicClient } from "viem";
import type { EtherscanAbiSource } from "./reviewedCalls.js";

// EIP-1967 implementation slot, which transparent and UUPS proxies share.
const IMPLEMENTATION_SLOT: Hex = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const MAXIMUM_ABI_BYTES = 2_000_000, MAXIMUM_CACHED = 2048, TIMEOUT_MS = 5_000;

/** Etherscan V2 verified ABIs, fetched by Signa. A proxy's implementation is read on-chain at every
 * lookup; only verified ABIs are cached, per chain and address, in this process. No key, an
 * unreachable or rate-limited Etherscan, or an unreadable answer is a failed lookup, never a decode.
 * The key goes only into the request URL and is never logged or returned. */
export function etherscanAbiSource(input: { apiKey: string | undefined; client: (chainId: number) => Pick<PublicClient, "getStorageAt">;
  fetch?: typeof fetch }): EtherscanAbiSource {
  const { apiKey, client } = input, fetcher = input.fetch ?? fetch;
  const cache = new Map<string, Abi>();
  return {
    async abiFor({ chainId, address }) {
      if (!apiKey) return { ok: false, reason: "lookup-failed" };
      let implementation: Address | undefined;
      try {
        const word = await client(chainId).getStorageAt({ address, slot: IMPLEMENTATION_SLOT });
        if (word && !/^0x0*$/.test(word)) implementation = getAddress(`0x${word.slice(-40)}`);
      } catch { return { ok: false, reason: "lookup-failed" }; }
      const target = (implementation ?? address).toLowerCase(), key = `${chainId}:${target}`;
      let abi = cache.get(key);
      if (!abi) {
        const url = new URL("https://api.etherscan.io/v2/api");
        for (const [name, value] of Object.entries({ chainid: String(chainId), module: "contract", action: "getabi", address: target, apikey: apiKey }))
          url.searchParams.set(name, value);
        try {
          const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
          if (!response.ok) return { ok: false, reason: "lookup-failed" };
          const text = await cappedText(response);
          if (text === undefined) return { ok: false, reason: "lookup-failed" };
          const body = JSON.parse(text) as { status?: unknown; result?: unknown };
          if (body.status !== "1" || typeof body.result !== "string")
            return { ok: false, reason: typeof body.result === "string" && /not verified/i.test(body.result) ? "no-abi" : "lookup-failed" };
          const parsed: unknown = JSON.parse(body.result);
          if (!Array.isArray(parsed)) return { ok: false, reason: "lookup-failed" };
          abi = parsed as Abi;
        } catch { return { ok: false, reason: "lookup-failed" }; }
        if (cache.size >= MAXIMUM_CACHED) cache.delete(cache.keys().next().value!);
        cache.set(key, abi);
      }
      return { ok: true, abi, ...(implementation ? { implementation } : {}) };
    },
  };
}

// The fetch timeout signal also bounds this read; the cap stops buffering at the first byte over.
async function cappedText(response: Response): Promise<string | undefined> {
  if (!response.body) return "";
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks).toString("utf8");
    length += value.byteLength;
    if (length > MAXIMUM_ABI_BYTES) { void reader.cancel().catch(() => {}); return undefined; }
    chunks.push(value);
  }
}
