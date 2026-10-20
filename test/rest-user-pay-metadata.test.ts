import { describe, expect, it } from "vitest";
import { encodeAbiParameters, type Hex } from "viem";
import { createHookMetadata } from "@bananapus/nana-sdk-core";
import { buildUserPayMetadata } from "@bananapus/nana-sdk-core/v6";
import { passkeyPayMetadataSteps } from "../src/rest/userOperations/userPayMetadata.js";

const max = 2n ** 256n - 1n;
const buyback = (minimum: bigint) => encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "bool" }], [0n, minimum, true]);

// Pins the coupling to the SDK decoder's wording: a renamed label would let a minimum through.
describe("passkey pay metadata steps", () => {
  it("holds every buyback minimum the decoder reads to the terminal minimum", () => {
    expect(passkeyPayMetadataSteps(buildUserPayMetadata({ chainId: 8453, minimumSwapAmountOut: max }), max)).toHaveLength(1);
    expect(() => passkeyPayMetadataSteps(buildUserPayMetadata({ chainId: 8453, minimumSwapAmountOut: max }), max - 1n)).toThrow();
    const two = createHookMetadata(["0x11111111", "0x22222222"], [buyback(5n), buyback(9n)]);
    expect(passkeyPayMetadataSteps(two, 9n)).toHaveLength(2);
    expect(() => passkeyPayMetadataSteps(two, 8n)).toThrow();
    expect(() => passkeyPayMetadataSteps(two.toUpperCase().replace("0X", "0x") as Hex, 8n)).toThrow();
    expect(passkeyPayMetadataSteps("0X", 0n)).toEqual([]);
  });
});
