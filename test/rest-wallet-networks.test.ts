import { beforeAll, describe, expect, it } from "vitest";
import { decodeFunctionData, hashTypedData, keccak256, parseAbi, type Address } from "viem";
import { walletOwnerSteps } from "../src/rest/wallet/ownerChains.js";
import { createWalletAuthorityContextFixture } from "./fixtures/wallet-authority-context.js";
import { walletNetworkCatalog, walletNetworkEntries, walletNetworksDocument, walletNetworkFamily } from "../src/rest/wallet/networks.js";
import type { WalletAuthorityContext } from "../src/rest/wallet/authority.js";

// The Base creation calldata carries no chain id: the same factory call reaches the same CREATE2
// address on every chain where the stack sits at the same addresses (verified on all eight).
const now = 1_800_000_120_000;
let base: WalletAuthorityContext;
beforeAll(async () => { base = await createWalletAuthorityContextFixture(now); });

describe("wallet networks", () => {
  it("offers Optimism, Arbitrum and the testnets with Center paying, and Ethereum only when the account pays", () => {
    const byId = Object.fromEntries(walletNetworkCatalog.map(network => [network.chainId, network]));
    expect(byId[10]).toMatchObject({ name: "Optimism", family: "mainnet", paymentChainId: 8453, centerPays: true, offered: true });
    expect(byId[42161]).toMatchObject({ name: "Arbitrum", family: "mainnet", paymentChainId: 8453, centerPays: true, offered: true });
    expect(byId[1]).toMatchObject({ name: "Ethereum", family: "mainnet", paymentChainId: 8453, centerPays: false, offered: false });
    for (const chainId of [11155111, 11155420, 421614, 84532])
      expect(byId[chainId]).toMatchObject({ family: "testnet", paymentChainId: 84532, centerPays: true, offered: true });
    expect(byId[8453]).toBeUndefined();
    expect(walletNetworkFamily([10, 42161])).toBe("mainnet");
    expect(() => walletNetworkFamily([10, 84532])).toThrow(/family/);
  });
  it("replays the exact creation call per chain, one family per bundle, in chain order", () => {
    const creation = base.enrollment.creation!;
    const entries = walletNetworkEntries(creation, [42161, 10]);
    expect(entries).toEqual([
      { chain: 10, target: creation.transaction.to, data: creation.transaction.data, value: "0" },
      { chain: 42161, target: creation.transaction.to, data: creation.transaction.data, value: "0" },
    ]);
    expect(entries.every(entry => !("virtual_nonce" in entry))).toBe(true);
    for (const chains of [[8453], [10, 10], [10, 84532], [1], [7], []] as number[][])
      expect(() => walletNetworkEntries(creation, chains)).toThrow();
  });
  it("binds the approval to the account, the bundle, the chains, the payment and the exact calldata", () => {
    const creation = base.enrollment.creation!;
    const input = { accountId: base.accountId, walletAddress: creation.address, bundleUuid: "a0a555ff-4444-4111-aaaa-333333333333",
      chainIds: [10, 42161], factory: creation.transaction.to, calldataHash: keccak256(creation.transaction.data),
      payment: { chainId: 8453, to: `0x${"1c".repeat(20)}` as const, value: "9007199254740993", deadline: "1800000420" },
      rpId: base.enrollment.intent.rpId, origin: base.enrollment.intent.origin, nonce: keccak256("0x01"), issuedAtMs: now, expiresAtMs: now + 300_000 };
    const document = walletNetworksDocument(input);
    expect(document.domain).toEqual({ name: "Juicebox Center Networks", version: "1", chainId: 8453, verifyingContract: creation.address });
    expect(document.message).toMatchObject({ purpose: "networks", accountId: base.accountId, bundleUuid: input.bundleUuid,
      chainIds: [10n, 42161n], paymentChainId: 8453n, paymentValue: 9007199254740993n, calldataHash: input.calldataHash });
    const digest = hashTypedData(document);
    expect(hashTypedData(walletNetworksDocument({ ...input, chainIds: [42161, 10] }))).not.toBe(digest);
    expect(hashTypedData(walletNetworksDocument({ ...input, payment: { ...input.payment, value: "1" } }))).not.toBe(digest);
  });
  it("brings a chain's owners to Base's with swaps first, then additions at the head, then removals, each from the right previous owner", () => {
    const abi = parseAbi(["function addOwnerWithThreshold(address owner,uint256 _threshold)", "function removeOwner(address prevOwner,address owner,uint256 _threshold)",
      "function swapOwner(address prevOwner,address oldOwner,address newOwner)"]);
    const [p0, p1, d1, d2, r] = ["0x" + "a0".repeat(20), "0x" + "a1".repeat(20), "0x" + "d1".repeat(20), "0x" + "d2".repeat(20), "0x" + "ee".repeat(20)].map(item => item.toLowerCase() as Address) as [Address, Address, Address, Address, Address];
    const sentinel = "0x0000000000000000000000000000000000000001";
    // Safe's linked list, applied step by step, must end at exactly the target owners.
    const apply = (owners: Address[], steps: `0x${string}`[]) => steps.reduce((list, step) => {
      const { functionName, args } = decodeFunctionData({ abi, data: step }), at = (owner: string) => list.findIndex(item => item.toLowerCase() === owner.toLowerCase());
      const prev = (owner: string) => at(owner) === 0 ? sentinel : list[at(owner) - 1]!.toLowerCase();
      if (functionName === "addOwnerWithThreshold") { expect(args[1]).toBe(1n); return [args[0].toLowerCase() as Address, ...list]; }
      if (functionName === "swapOwner") { expect(args[0].toLowerCase()).toBe(prev(args[1])); return list.map(item => item.toLowerCase() === args[1].toLowerCase() ? args[2].toLowerCase() as Address : item); }
      expect(args[0].toLowerCase()).toBe(prev(args[1])); expect(args[2]).toBe(1n);
      return list.filter(item => item.toLowerCase() !== args[1].toLowerCase());
    }, owners);
    const cases: [Address[], Address[], number][] = [[[p0, r], [p1, r], 1], [[p0, r], [p1, d1, r], 2], [[p0, d1, r], [p1, r], 2], [[d1, p0, r], [d2, p1, r], 2], [[p0, r], [p0, r], 0], [[r, p0], [r], 1]];
    for (const [from, to, count] of cases) {
      const steps = walletOwnerSteps(from, to);
      expect(steps).toHaveLength(count);
      expect(apply(from, steps).sort()).toEqual([...to].sort());
    }
  });
});
