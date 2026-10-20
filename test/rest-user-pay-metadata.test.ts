import { describe, expect, it } from "vitest";
import { encodeAbiParameters, type Hex } from "viem";
import { createHookMetadata } from "@bananapus/nana-sdk-core";
import { buildUserPayMetadata } from "@bananapus/nana-sdk-core/v6";
import { passkeyPayMetadataSteps } from "../src/rest/userOperations/userPayMetadata.js";

const max = 2n ** 256n - 1n;
const buyback = (minimum: bigint) => encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "bool" }], [0n, minimum, true]);

describe("passkey pay metadata steps", () => {
  it("describes every Juicebox pay metadata, whatever its buyback minimum", () => {
    // skipSplits false (and hook 1.1.1) put the minimum on the swap plus leftover mint before the
    // reserved split, above the beneficiary's terminal minimum; it can only make the pay revert.
    const honoring = passkeyPayMetadataSteps(buildUserPayMetadata({ chainId: 8453, minimumSwapAmountOut: max, skipSplits: false }));
    expect(honoring).toHaveLength(1);
    expect(JSON.stringify(honoring)).toContain(String(max));
    expect(passkeyPayMetadataSteps(buildUserPayMetadata({ chainId: 8453, minimumSwapAmountOut: max }))).toHaveLength(1);
    const two = createHookMetadata(["0x11111111", "0x22222222"], [buyback(5n), buyback(9n)]);
    expect(passkeyPayMetadataSteps(two)).toHaveLength(2);
    expect(passkeyPayMetadataSteps("0X")).toEqual([]);
  });

  it("refuses what is not the resolver format", () => {
    expect(() => passkeyPayMetadataSteps("0x1234" as Hex)).toThrow();
  });
});
