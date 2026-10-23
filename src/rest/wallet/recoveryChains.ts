import type { Pool } from "pg";
import { getAddress, type Address, type Hex } from "viem";
import { RestError, type RestRpc } from "../core.js";
import { SIGNA_HOME_CHAIN_ID, signaChainName } from "./chains.js";
import type { createWalletNetworks } from "./networks.js";
import { readWalletSafe } from "./ownerState.js";
import { approveWalletOwnerChains, createWalletOwnerChains, recordWalletOwnerChain, walletOwnerChainDestinations, walletOwnerChainRows, walletOwnerChainView,
  type WalletOwnerChain, type WalletOwnerChainState } from "./ownerChains.js";
import type { WalletRecoveryCandidate } from "./recovery.js";
import { prepareWalletRecoveryRotation, verifyWalletRecoveryRotation, type WalletRecoveryRotation } from "./recoveryRotation.js";

export type WalletRecoveryChainState = WalletOwnerChainState;
export type WalletRecoveryChain = WalletOwnerChain;
const same = (owners: readonly Address[], owner: Address) => owners.some(item => item.toLowerCase() === owner.toLowerCase());
function changed(): never { throw new RestError(409, "WALLET_RECOVERY_CHAINS_CHANGED", "The networks to update changed. Review the replacement again."); }

/** Recovery on the account's other chains. Each chain gets the same swap as Base, signed by the recovery
 * owner for that chain's own Safe nonce in the same approval. Nothing is sent before Base's own swap is on
 * chain; then Center's networks payer funds one Relayr bundle per family (`ownerChains.ts`). */
export function createWalletRecoveryChains(options: { pool: Pool; rpc: RestRpc;
  networks?: Pick<ReturnType<typeof createWalletNetworks>, "quoteOwnerCalls" | "payOwnerCalls" | "ownerCallsStatus">;
  /** How long a chain waits between checks; each check reads the chain and Relayr. */
  checkIntervalMs?: number; now?: () => number }) {
  const { pool, rpc } = options, now = options.now ?? Date.now;
  const owners = createWalletOwnerChains(options);
  const rows = (id: string) => walletOwnerChainRows<WalletRecoveryRotation>(pool, id);
  const safe = (candidate: WalletRecoveryCandidate) => getAddress(candidate.intent.accountId.slice(`eip155:${SIGNA_HOME_CHAIN_ID}:`.length));
  const read = (candidate: WalletRecoveryCandidate, chainId: number) => readWalletSafe({ account: safe(candidate), chainId, rpc, now });
  const rotated = (owners: readonly Address[], candidate: WalletRecoveryCandidate) => same(owners, candidate.signerAddress) && !same(owners, candidate.intent.priorSigner);
  const deployed = (candidate: WalletRecoveryCandidate) => walletOwnerChainDestinations(pool, candidate.intent.accountId, () => {
    throw new RestError(503, "WALLET_RECOVERY_CHAIN_UNAVAILABLE", "A network is still being added to this account. Try again shortly.");
  });

  return {
    /** Reads every other deployed chain and returns the swaps the recovery owner signs with Base's. A chain
     * already showing the new passkey is updated; one whose owners are not the account's original pair fails. */
    async prepare(candidate: WalletRecoveryCandidate, repair = false): Promise<WalletRecoveryRotation[]> {
      const id = candidate.intent.id, known = await rows(id);
      // A chain that failed is read again too: where the old passkey still holds it, the user can approve a fresh swap.
      const fresh = (await deployed(candidate)).filter(chainId => ["review", "failed"].includes(known.find(row => Number(row.chain_id) === chainId)?.state ?? "review"));
      const states = await Promise.all(fresh.map(chainId => read(candidate, chainId).catch(() => {
        throw new RestError(503, "WALLET_RECOVERY_CHAIN_UNAVAILABLE", `${signaChainName(chainId)} could not be read. Try again shortly.`);
      })));
      for (const [index, chainId] of fresh.entries()) {
        const state = states[index]!, { priorSigner, recoveryOwner } = candidate.intent;
        let review: WalletRecoveryRotation | null = null, next: "review" | "updated" | "failed" = "failed";
        if (rotated(state.owners, candidate)) next = "updated";
        else if (same(state.owners, priorSigner) && same(state.owners, recoveryOwner) && state.threshold === 1n) {
          try { review = prepareWalletRecoveryRotation(candidate, { owners: state.owners, threshold: 1, safeNonce: state.nonce.toString() }, chainId); next = "review"; }
          catch { /* An owner list the swap cannot be built from. */ }
        }
        await recordWalletOwnerChain(pool, { changeId: id, kind: "recovery", accountId: candidate.intent.accountId, chainId, state: next, review,
          target: review && { safeNonce: review.safeNonce, requires: [priorSigner], add: [candidate.signerAddress], remove: [priorSigner] },
          reason: next === "failed" ? "owners-differ" : null, now: now() });
      }
      // A repair after activation leaves chains already approved to the worker.
      return (await rows(id)).filter(row => row.state === "review" || (!repair && row.state === "approved")).map(row => row.review!);
    },
    /** Records the recovery owner's signature for every chain under review, all or none. Each is checked
     * against the stored swap before it is kept; a chain deployed since the review sends the user back to it. */
    async approve(candidate: WalletRecoveryCandidate, input: unknown, repair = false): Promise<void> {
      const id = candidate.intent.id, known = await rows(id), open = known.filter(row => row.state === "review" || (!repair && row.state === "approved"));
      if ((await deployed(candidate)).some(chainId => !known.some(row => Number(row.chain_id) === chainId))) changed();
      if (!Array.isArray(input) || input.length !== open.length) changed();
      const signatures = new Map<number, Hex>();
      for (const item of input as unknown[]) {
        const value = item as { chainId?: unknown; signature?: unknown };
        if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== "chainId,signature" || typeof value.chainId !== "number"
          || typeof value.signature !== "string" || signatures.has(value.chainId)) changed();
        signatures.set(value.chainId, value.signature as Hex);
      }
      if (open.some(row => !signatures.has(Number(row.chain_id)))) changed();
      const approvals = await Promise.all(open.filter(row => row.state === "review").map(async row => {
        const verified = await verifyWalletRecoveryRotation(candidate, row.review!, signatures.get(Number(row.chain_id))!);
        return { chainId: Number(row.chain_id), review: row.review, approval: { calls: [verified.createSigner, verified.rotateOwner], safeTxHash: verified.safeTxHash } };
      }));
      try { await approveWalletOwnerChains(pool, id, approvals, now()); } catch (error) { if (error instanceof RestError) changed(); throw error; }
    },
    /** Every other chain the account is on. One deployed since the review has no row yet and waits for the user's approval. */
    async status(id: string): Promise<WalletRecoveryChain[]> {
      const unreviewed = (await pool.query<{ chain_id: string }>(`SELECT n.chain_id FROM rest_wallet_networks n JOIN rest_wallet_recoveries r ON r.account_id=n.account_id
        WHERE r.id=$1 AND n.state='deployed' AND n.chain_id<>$2 AND NOT EXISTS (SELECT 1 FROM rest_wallet_owner_chains c WHERE c.change_id=r.id AND c.chain_id=n.chain_id)`,
        [id, SIGNA_HOME_CHAIN_ID])).rows.map(row => ({ chain_id: row.chain_id, state: "review" as const }));
      return [...await rows(id), ...unreviewed].map(walletOwnerChainView).sort((a, b) => a.chainId - b.chainId);
    },
    tick: owners.tick,
  };
}
