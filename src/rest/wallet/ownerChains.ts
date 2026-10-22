import type { Pool, PoolClient } from "pg";
import { getAddress, type Address, type Hex } from "viem";
import { RestError, type RestRpc } from "../core.js";
import { rpcHex } from "../protocol/code.js";
import { SIGNA_HOME_CHAIN_ID, signaChainName, signaChains } from "./chains.js";
import type { createWalletNetworks } from "./networks.js";
import { operationRpc, walletPreflightRpcBounds } from "./operationRpc.js";
import { readWalletSafe } from "./ownerState.js";

/** review: waiting for the owner's signature; approved: signed, waiting for Base; submitted: paid to Relayr;
 * updated: the chain shows the change; failed: this change cannot be made there. */
export type WalletOwnerChainState = "review" | "approved" | "submitted" | "updated" | "failed";
/** What sends an owner change to a chain other than Base: a recovery's swap, a device's addition, or a network's update to Base's owners. */
export type WalletOwnerChainKind = "recovery" | "device" | "network";
export interface WalletOwnerChain { chainId: number; name: string; state: WalletOwnerChainState }
export interface WalletOwnerCall { to: Address; value: "0"; data: Hex }
/** One chain's change in owner terms: the Safe nonce its signatures are for, the owners that must still be there for
 * them to run, and the owners it adds and removes. The chain's owners, never a provider's word, decide it ran. */
export interface WalletOwnerTarget { safeNonce: string; requires: Address[]; add: Address[]; remove: Address[];
  /** A change made of several Safe transactions: the owners before each, then after the last (`walletOwnerPlan`). */
  path?: Address[][] }
/** The exact calls in order; a single owner change also keeps the SafeTx hash its owner signed. With `setup`, the
 * first `setup` calls are sent every time and each later call is one Safe transaction, sent one per bundle in nonce order. */
export interface WalletOwnerApproval { calls: WalletOwnerCall[]; safeTxHash?: Hex; setup?: number }
export type WalletOwnerChainRow<Review = unknown> = { chain_id: string; kind: WalletOwnerChainKind; account_id: string; state: WalletOwnerChainState;
  review: Review | null; target: WalletOwnerTarget | null; approval: WalletOwnerApproval | null; bundle_id: string | null; attempts: number; reason: string | null; updated_at_ms: string; sent_step: number };
/** Each paid Relayr bundle for a chain is an attempt; a chain that fails this many is reported, not retried. */
const maximumAttempts = 3;
/** An approval whose change never reached Base (its ceremony was abandoned) stops holding the chain after a day. */
const baseWaitMs = 86_400_000;
/** A paid signer creation gets this long to show on chain before it is sent again. */
const setupWaitMs = 300_000;
const includes = (owners: readonly Address[], owner: Address) => owners.some(item => item.toLowerCase() === owner.toLowerCase());
/** The chain shows the change: every added owner is there and no removed one is. */
export const walletOwnerChangeApplied = (owners: readonly Address[], target: WalletOwnerTarget) =>
  target.add.every(owner => includes(owners, owner)) && !target.remove.some(owner => includes(owners, owner));
const sameSet = (a: readonly Address[], b: readonly Address[]) => a.length === b.length && a.every(owner => includes(b, owner));
/** How many of a row's Safe transactions there are, and the calls that send the next one once `done` have run. */
const stepCount = (approval: WalletOwnerApproval) => approval.setup === undefined ? 1 : approval.calls.length - approval.setup;
const nextCalls = (approval: WalletOwnerApproval, done: number) => approval.setup === undefined ? approval.calls
  : [...approval.calls.slice(0, approval.setup), approval.calls[approval.setup + done]!];
function changed(): never { throw new RestError(409, "WALLET_OWNER_CHAINS_CHANGED", "The networks to update changed. Review them again."); }
/** The other chains an owner change goes to. A deployment with a signed payment could already be on chain, so it holds the review until it settles. */
export async function walletOwnerChainDestinations(pool: Pool, accountId: string, unavailable: () => never): Promise<number[]> {
  const networks = (await pool.query<{ chain_id: string; state: string }>("SELECT chain_id,state FROM rest_wallet_networks WHERE account_id=$1 AND chain_id<>$2 ORDER BY chain_id",
    [accountId, SIGNA_HOME_CHAIN_ID])).rows;
  if (networks.some(row => row.state === "pending") || (await pool.query(`SELECT 1 FROM rest_wallet_network_bundles WHERE account_id=$1 AND state='paying'
    AND document->>'purpose' IS NULL LIMIT 1`, [accountId])).rowCount) unavailable();
  return networks.filter(row => row.state === "deployed").map(row => Number(row.chain_id));
}

export async function walletOwnerChainRows<Review = unknown>(sql: Pool | PoolClient, changeId: string) {
  return (await sql.query<WalletOwnerChainRow<Review>>(`SELECT chain_id,kind,account_id,state,review,target,approval,bundle_id,attempts,reason,updated_at_ms,sent_step
    FROM rest_wallet_owner_chains WHERE change_id=$1 ORDER BY chain_id`, [changeId])).rows;
}
/** Records a chain's change for review, or what it already is there. Only a row still in review or failed is replaced. */
export async function recordWalletOwnerChain(sql: Pool | PoolClient, input: { changeId: string; kind: WalletOwnerChainKind; accountId: string; chainId: number;
  state: "review" | "updated" | "failed"; review: unknown; target: WalletOwnerTarget | null; reason: string | null; now: number }) {
  await sql.query(`INSERT INTO rest_wallet_owner_chains(change_id,kind,account_id,chain_id,state,review,target,reason,updated_at_ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT(change_id,chain_id) DO UPDATE SET state=EXCLUDED.state,review=EXCLUDED.review,target=EXCLUDED.target,reason=EXCLUDED.reason,updated_at_ms=EXCLUDED.updated_at_ms,
      approval=NULL,bundle_id=NULL,attempts=0
    WHERE rest_wallet_owner_chains.state IN ('review','failed') AND rest_wallet_owner_chains.kind=EXCLUDED.kind`,
    [input.changeId, input.kind, input.accountId, input.chainId, input.state, input.review === null ? null : JSON.stringify(input.review),
      input.target === null ? null : JSON.stringify(input.target), input.reason, input.now]);
}
/** Keeps every chain's verified approval, all or none, each against the exact review it was signed for. */
export async function approveWalletOwnerChains(pool: Pool, changeId: string, approvals: { chainId: number; review: unknown; approval: WalletOwnerApproval }[], now: number) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const { chainId, review, approval } of approvals) {
      const written = await client.query(`UPDATE rest_wallet_owner_chains SET state='approved',approval=$3,updated_at_ms=$4
        WHERE change_id=$1 AND chain_id=$2 AND state='review' AND review=$5::jsonb`, [changeId, chainId, JSON.stringify(approval), now, JSON.stringify(review)]);
      if (written.rowCount !== 1) changed();
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    // Another change already holds one of these chains: only one approved change per chain is on its way.
    if ((error as { code?: string }).code === "23505") changed();
    throw error;
  } finally { client.release(); }
}
/** The account's chains with an owner change approved and still on its way. */
export async function walletOwnerChainsUnderway(sql: Pool | PoolClient, accountId: string): Promise<number[]> {
  return (await sql.query<{ chain_id: string }>("SELECT DISTINCT chain_id FROM rest_wallet_owner_chains WHERE account_id=$1 AND state IN ('approved','submitted') ORDER BY chain_id",
    [accountId])).rows.map(row => Number(row.chain_id));
}
export const walletOwnerChainView = (row: { chain_id: string | number; state: WalletOwnerChainState }): WalletOwnerChain =>
  ({ chainId: Number(row.chain_id), name: signaChainName(Number(row.chain_id)), state: row.state });

/** Sends approved owner changes to the account's other chains. Nothing is sent to a chain before Base shows the
 * same change; then Center's networks payer funds one Relayr bundle per family. A chain is updated only when
 * its own owners show the change. */
export function createWalletOwnerChains(options: { pool: Pool; rpc: RestRpc;
  networks?: Pick<ReturnType<typeof createWalletNetworks>, "quoteOwnerCalls" | "payOwnerCalls" | "ownerCallsStatus">;
  /** How long a chain waits between checks; each check reads the chain and Relayr. */
  checkIntervalMs?: number; now?: () => number }) {
  const { pool, rpc } = options, interval = options.checkIntervalMs ?? 10_000, now = options.now ?? Date.now;
  const read = (accountId: string, chainId: number, signal?: AbortSignal) => readWalletSafe({ account: getAddress(accountId.slice(`eip155:${SIGNA_HOME_CHAIN_ID}:`.length)),
    chainId, rpc, now, ...(signal ? { signal } : {}) });
  /** The owners a change adds that are contracts on Base (its passkey signers) but have no code yet on the chain. */
  async function unsetSigners(chainId: number, owners: Address[], signal?: AbortSignal) {
    const code = async (chain: number) => {
      const reads = operationRpc(rpc, walletPreflightRpcBounds, signal, false, chain);
      try { return await Promise.all(owners.map(async owner => rpcHex(await reads.request("eth_getCode", [owner, "latest"]), "owner code") !== "0x")); } finally { reads.close(); }
    };
    const [home, there] = await Promise.all([code(SIGNA_HOME_CHAIN_ID), code(chainId)]);
    return owners.filter((_, index) => home[index] && !there[index]);
  }
  async function set(id: string, chainId: number, from: WalletOwnerChainState[], state: WalletOwnerChainState, reason: string | null) {
    await pool.query("UPDATE rest_wallet_owner_chains SET state=$3,reason=$4,updated_at_ms=$5 WHERE change_id=$1 AND chain_id=$2 AND state=ANY($6)",
      [id, chainId, state, reason, now(), from]);
  }

  /** One pass over a change's open chains, by one worker at a time. */
  async function progress(id: string, signal?: AbortSignal) {
    await pool.query("UPDATE rest_wallet_owner_chains SET checked_at_ms=$2 WHERE change_id=$1 AND state IN ('approved','submitted')", [id, now()]);
    const open = (await walletOwnerChainRows(pool, id)).filter(row => row.state === "approved" || row.state === "submitted");
    if (!open.length) return;
    const accountId = open[0]!.account_id;
    // A network whose deployment failed never gets the update its owners were signed for.
    const undeployed = new Set((await pool.query<{ chain_id: string }>("SELECT chain_id FROM rest_wallet_networks WHERE account_id=$1 AND state='failed'", [accountId])).rows.map(row => Number(row.chain_id)));
    for (const row of open.filter(row => row.state === "approved" && undeployed.has(Number(row.chain_id)))) await set(id, Number(row.chain_id), ["approved"], "failed", "deployment-failed");
    // A signed payment is sent or settled before anything else is read, so it never holds the payer's nonce.
    const outcomes = new Map<string, Awaited<ReturnType<NonNullable<typeof options.networks>["ownerCallsStatus"]>> | null>();
    for (const bundleId of new Set(open.flatMap(row => row.state === "submitted" ? [row.bundle_id!] : [])))
      outcomes.set(bundleId, await options.networks?.ownerCallsStatus(accountId, bundleId).catch(() => null) ?? null);
    // Every other chain follows Base: nothing is sent until Base shows the same change.
    // A network's update brings the chain to Base's exact owners, so it follows only while Base holds exactly those.
    const home = await read(accountId, SIGNA_HOME_CHAIN_ID, signal), gate = open.map(({ target }) => target!.path
      ? home.threshold === 1n && sameSet(home.owners, target!.path[target!.path.length - 1]!) : walletOwnerChangeApplied(home.owners, target!));
    // A network's update was quoted from Base's owners, so one Base no longer matches has been overtaken.
    for (const [index, row] of open.entries()) if (row.state === "approved" && !gate[index] && row.target!.path)
      await set(id, Number(row.chain_id), ["approved"], "failed", "base-changed");
    else if (row.state === "approved" && !gate[index] && now() - Number(row.updated_at_ms) > baseWaitMs)
      await set(id, Number(row.chain_id), ["approved"], "failed", "base-unchanged");
    // A sent change is always reconciled; an approved one is read only once Base shows it.
    const states = await Promise.all(open.map((row, index) => gate[index] || row.state === "submitted" ? read(accountId, Number(row.chain_id), signal).catch(() => null) : null));
    // A change of several Safe transactions is done when the chain holds exactly its final owners with a threshold of one.
    const applied = (row: typeof open[number], state: NonNullable<typeof states[number]>) => row.target!.path
      ? state.threshold === 1n && sameSet(state.owners, row.target!.path[row.target!.path.length - 1]!) : walletOwnerChangeApplied(state.owners, row.target!);
    // The Safe transactions that already ran there, counted by the chain's nonce.
    const done = open.map((row, index) => states[index] ? Number(states[index].nonce - BigInt(row.target!.safeNonce)) : -1);
    // A bundle that failed before any payment was signed for it costs no attempt.
    const resend: { row: typeof open[number]; calls: WalletOwnerCall[]; step: number }[] = [], unpaid = new Set<number>();
    // The signed calls still apply only while Base shows the change, their signer's owners remain, and the chain is at a
    // nonce one of them was signed for, holding the owners that call expects.
    const live = open.map((row, index) => {
      const state = states[index], target = row.target!;
      if (!gate[index] || !state || done[index]! < 0 || done[index]! >= stepCount(row.approval!)) return false;
      return target.path ? state.threshold === 1n && sameSet(state.owners, target.path[done[index]!]!)
        : done[index] === 0 && target.requires.every(owner => includes(state.owners, owner));
    });
    const payable = (bundleId: string) => open.every((row, index) => row.bundle_id !== bundleId || live[index]);
    for (const [index, row] of open.entries()) {
      const chainId = Number(row.chain_id), state = states[index], outcome = row.state === "submitted" ? outcomes.get(row.bundle_id!) : undefined;
      // A chain stays open while its payment is unsettled or unread, so the payment keeps being reconciled.
      if (!state || (row.state === "submitted" && (!outcome || outcome.state === "paying"))) continue;
      // Relayr runs each call on its own, so the owner change can land while a signer's creation failed: the chain is
      // updated only once every added passkey signer exists there, and a missing one gets its creation sent again.
      if (applied(row, state) && (!row.target!.path || gate[index])) {
        // An unread chain stays as it is for the next pass.
        const unset = await unsetSigners(chainId, row.target!.add, signal).catch(() => null);
        if (!unset) continue;
        if (!unset.length) { await set(id, chainId, ["approved", "submitted"], "updated", null); continue; }
        // The repair counts as the step after the row's last Safe transaction, whatever else moved the Safe's nonce.
        const repair = stepCount(row.approval!);
        if (outcome?.paid && row.sent_step === repair && !outcome.failed.includes(chainId) && now() - Number(row.updated_at_ms) < setupWaitMs) continue;
        if (outcome && !outcome.paid) unpaid.add(chainId);
        if (row.attempts >= maximumAttempts && row.sent_step === repair && !unpaid.has(chainId)) { await set(id, chainId, ["approved", "submitted"], "failed", "attempts-exhausted"); continue; }
        resend.push({ row, calls: row.approval!.calls.slice(0, row.approval!.setup ?? 1), step: repair });
        continue;
      }
      // Base moved on since this change was approved: it no longer brings the chain to Base's owners.
      if (!gate[index]) { await set(id, chainId, ["approved", "submitted"], "failed", "base-changed"); continue; }
      if (outcome) {
        // A quote is funded only while every change it carries still applies; otherwise its live chains are quoted again.
        if (outcome.state === "quoted" && payable(row.bundle_id!)) { await options.networks!.payOwnerCalls(accountId, row.bundle_id!).catch(() => undefined); continue; }
        // The bundle ran or is running there: wait for the chain, unless its step already ran and the next one is due.
        if (outcome.state !== "quoted" && outcome.state !== "failed" && !outcome.failed.includes(chainId)) {
          if (!live[index]) { await set(id, chainId, ["submitted"], "failed", "approval-stale"); continue; }
          if (done[index] === row.sent_step) continue;
        }
        if (!outcome.paid) unpaid.add(chainId);
      }
      if (!live[index]) { await set(id, chainId, ["approved", "submitted"], "failed", "approval-stale"); continue; }
      // Attempts count per Safe transaction: a step that ran starts the next one's count.
      if (row.attempts >= maximumAttempts && row.sent_step === done[index] && !unpaid.has(chainId)) { await set(id, chainId, ["approved", "submitted"], "failed", "attempts-exhausted"); continue; }
      resend.push({ row, calls: nextCalls(row.approval!, done[index]!), step: done[index]! });
    }
    // One bundle per family carries every chain still to update there.
    for (const family of ["mainnet", "testnet"] as const) {
      const batch = resend.filter(({ row }) => signaChains.find(chain => chain.chainId === Number(row.chain_id))?.family === family);
      if (!batch.length) continue;
      let bundleId: string;
      try {
        if (!options.networks) throw new RestError(503, "WALLET_NETWORKS_UNAVAILABLE", "Network funding is not configured.");
        bundleId = await options.networks.quoteOwnerCalls({ accountId, changeId: id,
          calls: batch.flatMap(({ row, calls }) => calls.map(call => ({ chainId: Number(row.chain_id), ...call }))) });
      } catch (error) {
        // Nothing was paid; a later pass quotes again.
        const reason = error instanceof RestError ? error.code : "quote-unavailable";
        for (const { row } of batch) await pool.query("UPDATE rest_wallet_owner_chains SET reason=$3 WHERE change_id=$1 AND chain_id=$2", [id, row.chain_id, reason]);
        continue;
      }
      // The bundle is on record against every one of its chains before any payment is signed for it. A row another
      // worker moved since this pass read it leaves the bundle unpaid.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const { row, step } of batch) {
          const written = await client.query(`UPDATE rest_wallet_owner_chains SET state='submitted',bundle_id=$3,
            attempts=CASE WHEN sent_step=$9 THEN attempts+$7 ELSE $7 END,sent_step=$9,reason=NULL,updated_at_ms=$4
            WHERE change_id=$1 AND chain_id=$2 AND state=$5 AND bundle_id IS NOT DISTINCT FROM $6 AND attempts=$8`,
            [id, row.chain_id, bundleId, now(), row.state, row.bundle_id, unpaid.has(Number(row.chain_id)) ? 0 : 1, row.attempts, step]);
          if (written.rowCount !== 1) throw new Error("owner chain moved");
        }
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
      await options.networks!.payOwnerCalls(accountId, bundleId).catch(() => undefined);
    }
  }

  return {
    async status(id: string): Promise<WalletOwnerChain[]> { return (await walletOwnerChainRows(pool, id)).map(walletOwnerChainView); },
    /** The worker step: every change with a chain due for a check gets one pass, one worker per change. */
    async tick(signal?: AbortSignal): Promise<void> {
      const due = (await pool.query<{ change_id: string }>(`SELECT DISTINCT change_id FROM rest_wallet_owner_chains
        WHERE state IN ('approved','submitted') AND checked_at_ms <= $1 LIMIT 16`, [now() - interval])).rows;
      for (const { change_id: id } of due) {
        signal?.throwIfAborted();
        const client = await pool.connect();
        let held = false;
        try {
          held = (await client.query<{ held: boolean }>("SELECT pg_try_advisory_lock(hashtextextended('rest_wallet_owner_chains'::regclass::oid::text||$1,0)) AS held", [id])).rows[0]!.held;
          // An unread chain or an unavailable service leaves the rows as they are; the next pass checks again.
          if (held) await progress(id, signal).catch(() => undefined);
        } finally {
          try { if (held) await client.query("SELECT pg_advisory_unlock(hashtextextended('rest_wallet_owner_chains'::regclass::oid::text||$1,0))", [id]); client.release(); }
          catch { client.release(true); }
        }
      }
    },
  };
}
