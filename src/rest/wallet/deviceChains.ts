import type { Pool } from "pg";
import { getAddress, type Address } from "viem";
import { RestError, type RestRpc } from "../core.js";
import { SIGNA_HOME_CHAIN_ID, signaChainName } from "./chains.js";
import { prepareWalletDeviceAddition, verifyWalletDeviceAddition, type WalletDeviceAddition, type WalletDeviceCandidate, type WalletDevicePrimary } from "./deviceAddition.js";
import { readWalletSafe } from "./ownerState.js";
import type { createWalletNetworks } from "./networks.js";
import { approveWalletOwnerChains, createWalletOwnerChains, recordWalletOwnerChain, walletOwnerChainDestinations, walletOwnerChainRows, walletOwnerChainView, type WalletOwnerChain } from "./ownerChains.js";
import type { WalletAssertion } from "./webauthn.js";

const includes = (owners: readonly Address[], owner: Address) => owners.some(item => item.toLowerCase() === owner.toLowerCase());
function changed(): never { throw new RestError(409, "WALLET_DEVICE_CHAINS_CHANGED", "The networks to add the device on changed. Review them again."); }

/** Adding a device on the account's other chains: the primary passkey approves the same addition there, one
 * prompt per chain, each for that chain's own Safe nonce. Nothing is sent before Base shows the device; the
 * owner-chains worker then sends them (`ownerChains.ts`). */
export function createWalletDeviceChains(options: { pool: Pool; rpc: RestRpc;
  networks?: Pick<ReturnType<typeof createWalletNetworks>, "quoteOwnerCalls" | "payOwnerCalls" | "ownerCallsStatus">; checkIntervalMs?: number; now?: () => number }) {
  const { pool, rpc } = options, now = options.now ?? Date.now, owners = createWalletOwnerChains(options);
  const rows = (id: string) => walletOwnerChainRows<WalletDeviceAddition>(pool, id);
  const deployed = (accountId: string) => walletOwnerChainDestinations(pool, accountId, () => {
    throw new RestError(503, "WALLET_DEVICE_CHAIN_UNAVAILABLE", "A network is still being added to this account. Try again shortly.");
  });
  return {
    /** Reads every other deployed chain and returns the additions the primary passkey approves with Base's. A chain
     * already showing the device is updated; one whose owners are not the account's recorded owners fails. */
    async prepare(candidate: WalletDeviceCandidate): Promise<WalletDeviceAddition[]> {
      const { intent } = candidate, known = await rows(intent.id);
      const fresh = (await deployed(intent.accountId)).filter(chainId => ["review", "failed"].includes(known.find(row => Number(row.chain_id) === chainId)?.state ?? "review"));
      const account = getAddress(intent.accountId.slice(`eip155:${SIGNA_HOME_CHAIN_ID}:`.length));
      const states = await Promise.all(fresh.map(chainId => readWalletSafe({ account, chainId, rpc, now }).catch(() => {
        throw new RestError(503, "WALLET_DEVICE_CHAIN_UNAVAILABLE", `${signaChainName(chainId)} could not be read. Try again shortly.`);
      })));
      for (const [index, chainId] of fresh.entries()) {
        const state = states[index]!;
        let review: WalletDeviceAddition | null = null, next: "review" | "updated" | "failed" = "failed";
        if (includes(state.owners, candidate.signerAddress)) next = "updated";
        else {
          try { review = prepareWalletDeviceAddition(candidate, { owners: state.owners, threshold: Number(state.threshold), safeNonce: state.nonce.toString() }, chainId); next = "review"; }
          catch { /* Owners other than the account's recorded ones: the addition cannot be built here. */ }
        }
        await recordWalletOwnerChain(pool, { changeId: intent.id, kind: "device", accountId: intent.accountId, chainId, state: next, review,
          target: review && { safeNonce: review.safeNonce, requires: [intent.primarySigner], add: [candidate.signerAddress], remove: [] },
          reason: next === "failed" ? "owners-differ" : null, now: now() });
      }
      return (await rows(intent.id)).filter(row => row.state === "review").map(row => row.review!);
    },
    /** Keeps the primary passkey's approval for every chain under review, all or none, each checked against its stored addition. */
    async approve(candidate: WalletDeviceCandidate, input: unknown, primary: WalletDevicePrimary): Promise<void> {
      const id = candidate.intent.id, known = await rows(id), open = known.filter(row => row.state === "review");
      if ((await deployed(candidate.intent.accountId)).some(chainId => !known.some(row => Number(row.chain_id) === chainId))) changed();
      if (!Array.isArray(input) || input.length !== open.length) changed();
      const assertions = new Map<number, WalletAssertion>();
      for (const item of input as unknown[]) {
        const value = item as { chainId?: unknown; assertion?: unknown };
        if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== "assertion,chainId" || typeof value.chainId !== "number"
          || !value.assertion || assertions.has(value.chainId)) changed();
        assertions.set(value.chainId, value.assertion as WalletAssertion);
      }
      if (open.some(row => !assertions.has(Number(row.chain_id)))) changed();
      const approvals = open.map(row => {
        const calls = verifyWalletDeviceAddition(candidate, row.review!, assertions.get(Number(row.chain_id))!, primary);
        return { chainId: Number(row.chain_id), review: row.review, approval: { calls: [calls.createSigner, calls.addOwner], safeTxHash: calls.safeTxHash } };
      });
      await approveWalletOwnerChains(pool, id, approvals, now());
    },
    async status(id: string): Promise<WalletOwnerChain[]> { return (await rows(id)).map(walletOwnerChainView); },
    tick: owners.tick,
  };
}
