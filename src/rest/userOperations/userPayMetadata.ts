import { buildUserPayMetadata } from "@bananapus/nana-sdk-core/v6";

// The shape is the SDK's: these two encodings differ only in the minimum's word.
const zero = buildUserPayMetadata({ chainId: 8453 }).toLowerCase();
const full = buildUserPayMetadata({ chainId: 8453, minimumSwapAmountOut: 2n ** 256n - 1n }).toLowerCase();
const start = [...zero].findIndex((char, index) => char !== full[index]);

/** A passkey payment may carry empty metadata or exactly a pay card's `buildUserPayMetadata` on Base:
 * the buyback registry's `(0, minimum, skipSplits = true)` with no tiers, paid with a terminal
 * minimum at least that minimum (as `prepareUserPay` sets it), so the terminal minimum is the
 * payer's guarantee whatever the hook does. Returns the metadata minimum, `null` for empty
 * metadata, and throws for anything else. */
export function passkeyPayMinimumOf(metadata: string, minReturnedTokens: bigint): bigint | null {
  const value = metadata.toLowerCase();
  if (value === "0x") return null;
  if (value.length === zero.length) {
    const minimum = BigInt(`0x${value.slice(start, start + 64)}`);
    if (value === buildUserPayMetadata({ chainId: 8453, minimumSwapAmountOut: minimum }).toLowerCase() && minReturnedTokens >= minimum) return minimum;
  }
  throw new Error("A passkey payment carries only empty or pay-card buyback metadata, under a terminal minimum at least its own.");
}
