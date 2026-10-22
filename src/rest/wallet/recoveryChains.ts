import type { Pool } from "pg";
import { getAddress, type Address, type Hex } from "viem";
import { RestError, type RestRpc } from "../core.js";
import { SIGNA_HOME_CHAIN_ID, signaChainName, signaChains } from "./chains.js";
import type { createWalletNetworks } from "./networks.js";
import { PostgresWalletNetworksStore } from "./networksPostgres.js";
import { readWalletSafe } from "./ownerState.js";
import type { WalletRecoveryCandidate } from "./recovery.js";
import { prepareWalletRecoveryRotation, verifyWalletRecoveryRotation, type WalletRecoveryRotation, type WalletRecoveryRotationCall } from "./recoveryRotation.js";

/** review: waiting for the recovery owner; approved: signed, waiting for Base; submitted: paid to Relayr;
 * updated: the chain shows the new passkey and not the old one; failed: this recovery cannot change it. */
export type WalletRecoveryChainState = "review" | "approved" | "submitted" | "updated" | "failed";
export interface WalletRecoveryChain { chainId: number; name: string; state: WalletRecoveryChainState }
type Row = { chain_id: string; state: WalletRecoveryChainState; review: WalletRecoveryRotation | null;
  approval: { createSigner: WalletRecoveryRotationCall; ownerChange: WalletRecoveryRotationCall } | null; bundle_id: string | null; attempts: number };
/** Each paid Relayr bundle for a chain is an attempt; a chain that fails this many is reported, not retried. */
const maximumAttempts = 3;
const same = (owners: readonly Address[], owner: Address) => owners.some(item => item.toLowerCase() === owner.toLowerCase());
function changed(): never { throw new RestError(409, "WALLET_RECOVERY_CHAINS_CHANGED", "The networks to update changed. Review the replacement again."); }

/** Recovery on the account's other chains. Each chain gets the same swap as Base, signed by the recovery
 * owner for that chain's own Safe nonce in the same approval. Nothing is sent before Base's own swap is on
 * chain; then Center's networks payer funds one Relayr bundle per family. The chain's owners, never a
 * provider's word, decide when a chain is updated. */
export function createWalletRecoveryChains(options: { pool: Pool; rpc: RestRpc;
  networks?: Pick<ReturnType<typeof createWalletNetworks>, "quoteOwnerCalls" | "payOwnerCalls" | "ownerCallsStatus">;
  /** How long a chain waits between checks; each check reads the chain and Relayr. */
  checkIntervalMs?: number; now?: () => number }) {
  const { pool, rpc } = options, interval = options.checkIntervalMs ?? 10_000, now = options.now ?? Date.now;
  const networkRows = new PostgresWalletNetworksStore(pool);
  const rows = async (id: string) => (await pool.query<Row>("SELECT chain_id,state,review,approval,bundle_id,attempts FROM rest_wallet_recovery_chains WHERE recovery_id=$1 ORDER BY chain_id", [id])).rows;
  const safe = (candidate: WalletRecoveryCandidate) => getAddress(candidate.intent.accountId.slice(`eip155:${SIGNA_HOME_CHAIN_ID}:`.length));
  const read = (candidate: WalletRecoveryCandidate, chainId: number, signal?: AbortSignal) => readWalletSafe({ account: safe(candidate), chainId, rpc, now, ...(signal ? { signal } : {}) });
  const rotated = (owners: readonly Address[], candidate: WalletRecoveryCandidate) => same(owners, candidate.signerAddress) && !same(owners, candidate.intent.priorSigner);
  /** The chains to update. A deployment with a signed payment could already be on chain, so it holds the review until it settles. */
  async function deployed(candidate: WalletRecoveryCandidate) {
    const accountId = candidate.intent.accountId, networks = (await networkRows.listNetworks(accountId)).filter(row => row.chainId !== SIGNA_HOME_CHAIN_ID);
    if (networks.some(row => row.state === "pending") || (await networkRows.listBundles(accountId)).some(bundle => !bundle.purpose && bundle.state === "paying")) throw new RestError(503, "WALLET_RECOVERY_CHAIN_UNAVAILABLE", "A network is still being added to this account. Try again shortly.");
    return networks.filter(row => row.state === "deployed").map(row => row.chainId);
  }
  async function set(id: string, chainId: number, from: WalletRecoveryChainState[], state: WalletRecoveryChainState, reason: string | null) {
    await pool.query("UPDATE rest_wallet_recovery_chains SET state=$3,reason=$4,updated_at_ms=$5 WHERE recovery_id=$1 AND chain_id=$2 AND state=ANY($6)",
      [id, chainId, state, reason, now(), from]);
  }

  /** One pass over a recovery's open chains, by one worker at a time. */
  async function progress(id: string, signal?: AbortSignal) {
    const candidate = (await pool.query<{ candidate: WalletRecoveryCandidate }>("SELECT candidate FROM rest_wallet_recoveries WHERE id=$1", [id])).rows[0]?.candidate;
    await pool.query("UPDATE rest_wallet_recovery_chains SET checked_at_ms=$2 WHERE recovery_id=$1 AND state IN ('approved','submitted')", [id, now()]);
    const open = (await rows(id)).filter(row => row.state === "approved" || row.state === "submitted");
    if (!candidate || !open.length) return;
    // A signed payment is sent or settled before anything else is read, so it never holds the payer's nonce.
    const outcomes = new Map<string, Awaited<ReturnType<NonNullable<typeof options.networks>["ownerCallsStatus"]>> | null>();
    for (const bundleId of new Set(open.flatMap(row => row.state === "submitted" ? [row.bundle_id!] : [])))
      outcomes.set(bundleId, await options.networks?.ownerCallsStatus(candidate.intent.accountId, bundleId).catch(() => null) ?? null);
    // Every other chain follows Base: nothing is sent until Base's own swap is on chain.
    if (!rotated((await read(candidate, SIGNA_HOME_CHAIN_ID, signal)).owners, candidate)) return;
    const states = await Promise.all(open.map(row => read(candidate, Number(row.chain_id), signal).catch(() => null)));
    // A bundle that failed before any payment was signed for it costs no attempt.
    const resend: Row[] = [], unpaid = new Set<number>();
    // The signed swap still applies only while the old passkey is an owner and the Safe nonce is the one signed.
    const live = open.map((row, index) => !!states[index] && same(states[index].owners, candidate.intent.priorSigner) && states[index].nonce.toString() === row.review!.safeNonce);
    const payable = (bundleId: string) => open.every((row, index) => row.bundle_id !== bundleId || live[index]);
    for (const [index, row] of open.entries()) {
      const chainId = Number(row.chain_id), state = states[index], outcome = row.state === "submitted" ? outcomes.get(row.bundle_id!) : undefined;
      // A chain stays open while its payment is unsettled or unread, so the payment keeps being reconciled.
      if (!state || (row.state === "submitted" && (!outcome || outcome.state === "paying"))) continue;
      if (rotated(state.owners, candidate)) { await set(id, chainId, ["approved", "submitted"], "updated", null); continue; }
      if (outcome) {
        // A quote is funded only while every swap it carries still applies; otherwise its live chains are quoted again.
        if (outcome.state === "quoted" && payable(row.bundle_id!)) { await options.networks!.payOwnerCalls(candidate.intent.accountId, row.bundle_id!).catch(() => undefined); continue; }
        if (outcome.state !== "quoted" && outcome.state !== "failed" && !outcome.failed.includes(chainId)) { if (!live[index]) await set(id, chainId, ["submitted"], "failed", "approval-stale"); continue; }
        if (!outcome.paid) unpaid.add(chainId);
      }
      if (!live[index]) { await set(id, chainId, ["approved", "submitted"], "failed", "approval-stale"); continue; }
      if (row.attempts >= maximumAttempts && !unpaid.has(chainId)) { await set(id, chainId, ["approved", "submitted"], "failed", "attempts-exhausted"); continue; }
      resend.push(row);
    }
    // One bundle per family carries every chain still to update there.
    for (const family of ["mainnet", "testnet"] as const) {
      const batch = resend.filter(row => signaChains.find(chain => chain.chainId === Number(row.chain_id))?.family === family);
      if (!batch.length) continue;
      let bundleId: string;
      try {
        if (!options.networks) throw new RestError(503, "WALLET_NETWORKS_UNAVAILABLE", "Network funding is not configured.");
        bundleId = await options.networks.quoteOwnerCalls({ accountId: candidate.intent.accountId, recoveryId: id,
          calls: batch.flatMap(row => [{ chainId: Number(row.chain_id), ...row.approval!.createSigner }, { chainId: Number(row.chain_id), ...row.approval!.ownerChange }]) });
      } catch (error) {
        // Nothing was paid; a later pass quotes again.
        const reason = error instanceof RestError ? error.code : "quote-unavailable";
        for (const row of batch) await pool.query("UPDATE rest_wallet_recovery_chains SET reason=$3 WHERE recovery_id=$1 AND chain_id=$2", [id, row.chain_id, reason]);
        continue;
      }
      // The bundle is on record against every one of its chains before any payment is signed for it. A row another
      // worker moved since this pass read it leaves the bundle unpaid.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const row of batch) {
          const written = await client.query(`UPDATE rest_wallet_recovery_chains SET state='submitted',bundle_id=$3,attempts=attempts+$7,reason=NULL,updated_at_ms=$4
            WHERE recovery_id=$1 AND chain_id=$2 AND state=$5 AND bundle_id IS NOT DISTINCT FROM $6 AND attempts=$8`,
            [id, row.chain_id, bundleId, now(), row.state, row.bundle_id, unpaid.has(Number(row.chain_id)) ? 0 : 1, row.attempts]);
          if (written.rowCount !== 1) throw new Error("recovery chain moved");
        }
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
      await options.networks!.payOwnerCalls(candidate.intent.accountId, bundleId).catch(() => undefined);
    }
  }

  return {
    /** Reads every other deployed chain and returns the swaps the recovery owner signs with Base's. A chain
     * already showing the new passkey is updated; one whose owners are not the account's original pair fails. */
    async prepare(candidate: WalletRecoveryCandidate): Promise<WalletRecoveryRotation[]> {
      const id = candidate.intent.id, known = await rows(id);
      const fresh = (await deployed(candidate)).filter(chainId => (known.find(row => Number(row.chain_id) === chainId)?.state ?? "review") === "review");
      const states = await Promise.all(fresh.map(chainId => read(candidate, chainId).catch(() => {
        throw new RestError(503, "WALLET_RECOVERY_CHAIN_UNAVAILABLE", `${signaChainName(chainId)} could not be read. Try again shortly.`);
      })));
      for (const [index, chainId] of fresh.entries()) {
        const state = states[index]!, { priorSigner, recoveryOwner } = candidate.intent;
        let review: WalletRecoveryRotation | null = null, next: WalletRecoveryChainState = "failed";
        if (rotated(state.owners, candidate)) next = "updated";
        else if (same(state.owners, priorSigner) && same(state.owners, recoveryOwner) && state.threshold === 1n) {
          try { review = prepareWalletRecoveryRotation(candidate, { owners: state.owners, threshold: 1, safeNonce: state.nonce.toString() }, chainId); next = "review"; }
          catch { /* An owner list the swap cannot be built from. */ }
        }
        await pool.query(`INSERT INTO rest_wallet_recovery_chains(recovery_id,chain_id,state,review,reason,updated_at_ms) VALUES($1,$2,$3,$4,$5,$6)
          ON CONFLICT(recovery_id,chain_id) DO UPDATE SET state=EXCLUDED.state,review=EXCLUDED.review,reason=EXCLUDED.reason,updated_at_ms=EXCLUDED.updated_at_ms
          WHERE rest_wallet_recovery_chains.state='review'`, [id, chainId, next, review, next === "failed" ? "owners-differ" : null, now()]);
      }
      return (await rows(id)).filter(row => row.state === "review" || row.state === "approved").map(row => row.review!);
    },
    /** Records the recovery owner's signature for every chain under review, all or none. Each is checked
     * against the stored swap before it is kept; a chain deployed since the review sends the user back to it. */
    async approve(candidate: WalletRecoveryCandidate, input: unknown): Promise<void> {
      const id = candidate.intent.id, known = await rows(id), open = known.filter(row => row.state === "review" || row.state === "approved");
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
        return { row, approval: { createSigner: verified.createSigner, ownerChange: verified.rotateOwner, safeTxHash: verified.safeTxHash } };
      }));
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const { row, approval } of approvals) {
          const written = await client.query(`UPDATE rest_wallet_recovery_chains SET state='approved',approval=$3,updated_at_ms=$4
            WHERE recovery_id=$1 AND chain_id=$2 AND state='review' AND review=$5::jsonb`, [id, row.chain_id, approval, now(), JSON.stringify(row.review)]);
          if (written.rowCount !== 1) changed();
        }
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    },
    async status(id: string): Promise<WalletRecoveryChain[]> {
      return (await rows(id)).map(row => ({ chainId: Number(row.chain_id), name: signaChainName(Number(row.chain_id)), state: row.state }));
    },
    /** The worker step: every recovery with a chain due for a check gets one pass, one worker per recovery. */
    async tick(signal?: AbortSignal): Promise<void> {
      const due = (await pool.query<{ recovery_id: string }>(`SELECT DISTINCT recovery_id FROM rest_wallet_recovery_chains
        WHERE state IN ('approved','submitted') AND checked_at_ms <= $1 LIMIT 16`, [now() - interval])).rows;
      for (const { recovery_id: id } of due) {
        signal?.throwIfAborted();
        const client = await pool.connect();
        let held = false;
        try {
          held = (await client.query<{ held: boolean }>("SELECT pg_try_advisory_lock(hashtextextended('rest_wallet_recovery_chains'::regclass::oid::text||$1,0)) AS held", [id])).rows[0]!.held;
          // An unread chain or an unavailable service leaves the rows as they are; the next pass checks again.
          if (held) await progress(id, signal).catch(() => undefined);
        } finally {
          try { if (held) await client.query("SELECT pg_advisory_unlock(hashtextextended('rest_wallet_recovery_chains'::regclass::oid::text||$1,0))", [id]); client.release(); }
          catch { client.release(true); }
        }
      }
    },
  };
}
