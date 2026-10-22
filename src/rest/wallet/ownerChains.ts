import type { Pool, PoolClient } from "pg";
import { encodeFunctionData, getAddress, parseAbi, type Address, type Hex } from "viem";
import { RestError, type RestRpc } from "../core.js";
import { SIGNA_HOME_CHAIN_ID, signaChainName, signaChains } from "./chains.js";
import type { createWalletNetworks } from "./networks.js";
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
export interface WalletOwnerTarget { safeNonce: string; requires: Address[]; add: Address[]; remove: Address[] }
/** The exact calls in order; a single owner change also keeps the SafeTx hash its owner signed. */
export interface WalletOwnerApproval { calls: WalletOwnerCall[]; safeTxHash?: Hex }
export type WalletOwnerChainRow<Review = unknown> = { chain_id: string; kind: WalletOwnerChainKind; account_id: string; state: WalletOwnerChainState;
  review: Review | null; target: WalletOwnerTarget | null; approval: WalletOwnerApproval | null; bundle_id: string | null; attempts: number; reason: string | null; updated_at_ms: string };
/** Each paid Relayr bundle for a chain is an attempt; a chain that fails this many is reported, not retried. */
const maximumAttempts = 3;
/** An approval whose change never reached Base (its ceremony was abandoned) stops holding the chain after a day. */
const baseWaitMs = 86_400_000;
const includes = (owners: readonly Address[], owner: Address) => owners.some(item => item.toLowerCase() === owner.toLowerCase());
/** The chain shows the change: every added owner is there and no removed one is. */
export const walletOwnerChangeApplied = (owners: readonly Address[], target: WalletOwnerTarget) =>
  target.add.every(owner => includes(owners, owner)) && !target.remove.some(owner => includes(owners, owner));
function changed(): never { throw new RestError(409, "WALLET_OWNER_CHAINS_CHANGED", "The networks to update changed. Review them again."); }
const sentinel = "0x0000000000000000000000000000000000000001" as Address;
const ownerAbi = parseAbi(["function addOwnerWithThreshold(address owner,uint256 _threshold)", "function removeOwner(address prevOwner,address owner,uint256 _threshold)",
  "function swapOwner(address prevOwner,address oldOwner,address newOwner)"]);

/** The Safe owner calls, in order, that take `owners` (in the Safe's own list order) to exactly `target` with a
 * threshold of one: a swap for each owner replaced, then additions, then removals. Each call is one SafeTx. */
export function walletOwnerSteps(owners: readonly Address[], target: readonly Address[]): Hex[] {
  const list = owners.map(owner => getAddress(owner)), wanted = target.map(owner => getAddress(owner));
  const remove = list.filter(owner => !includes(wanted, owner)), add = wanted.filter(owner => !includes(list, owner)), steps: Hex[] = [];
  const previous = (owner: Address) => { const index = list.indexOf(owner); return index === 0 ? sentinel : list[index - 1]!; };
  const swaps = Math.min(remove.length, add.length);
  for (let i = 0; i < swaps; i++) {
    steps.push(encodeFunctionData({ abi: ownerAbi, functionName: "swapOwner", args: [previous(remove[i]!), remove[i]!, add[i]!] }));
    list[list.indexOf(remove[i]!)] = add[i]!;
  }
  // Safe adds an owner at the head of its list.
  for (const owner of add.slice(swaps)) { steps.push(encodeFunctionData({ abi: ownerAbi, functionName: "addOwnerWithThreshold", args: [owner, 1n] })); list.unshift(owner); }
  for (const owner of remove.slice(swaps)) { steps.push(encodeFunctionData({ abi: ownerAbi, functionName: "removeOwner", args: [previous(owner), owner, 1n] })); list.splice(list.indexOf(owner), 1); }
  return steps;
}
/** The other chains an owner change goes to. A deployment with a signed payment could already be on chain, so it holds the review until it settles. */
export async function walletOwnerChainDestinations(pool: Pool, accountId: string, unavailable: () => never): Promise<number[]> {
  const networks = (await pool.query<{ chain_id: string; state: string }>("SELECT chain_id,state FROM rest_wallet_networks WHERE account_id=$1 AND chain_id<>$2 ORDER BY chain_id",
    [accountId, SIGNA_HOME_CHAIN_ID])).rows;
  if (networks.some(row => row.state === "pending") || (await pool.query(`SELECT 1 FROM rest_wallet_network_bundles WHERE account_id=$1 AND state='paying'
    AND document->>'purpose' IS NULL LIMIT 1`, [accountId])).rowCount) unavailable();
  return networks.filter(row => row.state === "deployed").map(row => Number(row.chain_id));
}

export async function walletOwnerChainRows<Review = unknown>(sql: Pool | PoolClient, changeId: string) {
  return (await sql.query<WalletOwnerChainRow<Review>>(`SELECT chain_id,kind,account_id,state,review,target,approval,bundle_id,attempts,reason,updated_at_ms
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
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
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
    const home = await read(accountId, SIGNA_HOME_CHAIN_ID, signal);
    for (const row of open.filter(row => row.state === "approved" && !walletOwnerChangeApplied(home.owners, row.target!) && now() - Number(row.updated_at_ms) > baseWaitMs))
      await set(id, Number(row.chain_id), ["approved"], "failed", "base-unchanged");
    const states = await Promise.all(open.map(row => walletOwnerChangeApplied(home.owners, row.target!) ? read(accountId, Number(row.chain_id), signal).catch(() => null) : null));
    // A bundle that failed before any payment was signed for it costs no attempt.
    const resend: typeof open = [], unpaid = new Set<number>();
    // The signed calls still apply only while their signer's owners remain and the Safe nonce is the one signed.
    const live = open.map((row, index) => !!states[index] && row.target!.requires.every(owner => includes(states[index]!.owners, owner))
      && states[index].nonce.toString() === row.target!.safeNonce);
    const payable = (bundleId: string) => open.every((row, index) => row.bundle_id !== bundleId || live[index]);
    for (const [index, row] of open.entries()) {
      const chainId = Number(row.chain_id), state = states[index], outcome = row.state === "submitted" ? outcomes.get(row.bundle_id!) : undefined;
      // A chain stays open while its payment is unsettled or unread, so the payment keeps being reconciled.
      if (!state || (row.state === "submitted" && (!outcome || outcome.state === "paying"))) continue;
      if (walletOwnerChangeApplied(state.owners, row.target!)) { await set(id, chainId, ["approved", "submitted"], "updated", null); continue; }
      if (outcome) {
        // A quote is funded only while every change it carries still applies; otherwise its live chains are quoted again.
        if (outcome.state === "quoted" && payable(row.bundle_id!)) { await options.networks!.payOwnerCalls(accountId, row.bundle_id!).catch(() => undefined); continue; }
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
        bundleId = await options.networks.quoteOwnerCalls({ accountId, changeId: id,
          calls: batch.flatMap(row => row.approval!.calls.map(call => ({ chainId: Number(row.chain_id), ...call }))) });
      } catch (error) {
        // Nothing was paid; a later pass quotes again.
        const reason = error instanceof RestError ? error.code : "quote-unavailable";
        for (const row of batch) await pool.query("UPDATE rest_wallet_owner_chains SET reason=$3 WHERE change_id=$1 AND chain_id=$2", [id, row.chain_id, reason]);
        continue;
      }
      // The bundle is on record against every one of its chains before any payment is signed for it. A row another
      // worker moved since this pass read it leaves the bundle unpaid.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const row of batch) {
          const written = await client.query(`UPDATE rest_wallet_owner_chains SET state='submitted',bundle_id=$3,attempts=attempts+$7,reason=NULL,updated_at_ms=$4
            WHERE change_id=$1 AND chain_id=$2 AND state=$5 AND bundle_id IS NOT DISTINCT FROM $6 AND attempts=$8`,
            [id, row.chain_id, bundleId, now(), row.state, row.bundle_id, unpaid.has(Number(row.chain_id)) ? 0 : 1, row.attempts]);
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
