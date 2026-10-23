import { decodeFunctionResult, encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { RestError, type RestBlockEvidence, type RestRpc } from "../core.js";
import { safeAbi } from "../smartAccounts/service.js";
import { uoHash, uoObject, uoQuantity } from "../userOperations/codec.js";
import { SIGNA_HOME_CHAIN_ID } from "./chains.js";
import { operationRpc, walletPreflightRpcBounds } from "./operationRpc.js";


export type WalletOwnerState =
  | { chainId: number; status: "consistent"; owners: Address[]; threshold: bigint; block: RestBlockEvidence }
  | { chainId: number; status: "diverged"; owners: Address[]; threshold: bigint; expected: Address[]; block: RestBlockEvidence }
  | { chainId: number; status: "unknown"; reason: string };
export interface WalletOwnerObservation { owners: Address[]; threshold: bigint; block: RestBlockEvidence }
/** The last observation per account and chain. It is reused only while its block is still the
 * chain's head, so a new block, a reorg or an owner change (which lands in a new block) re-reads it. */
export interface WalletOwnerStateStore {
  get(account: Address, chainId: number): Promise<WalletOwnerObservation | null>;
  put(account: Address, observation: WalletOwnerObservation): Promise<void>;
}

async function observe(account: Address, chainId: number, rpc: RestRpc, now: () => number, store?: WalletOwnerStateStore, signal?: AbortSignal, withNonce = false): Promise<WalletOwnerObservation & { nonce?: bigint }> {
  const reads = operationRpc(rpc, walletPreflightRpcBounds, signal, false, chainId);
  try {
    const [chain, block, stored] = await Promise.all([reads.request("eth_chainId", []), reads.request("eth_getBlockByNumber", ["latest", false]), store?.get(account, chainId)]);
    if (uoQuantity(chain, "RPC chain") !== BigInt(chainId) || !uoObject(block)) throw new Error("The RPC did not establish the expected chain.");
    const evidence: RestBlockEvidence = { chainId, blockNumber: uoQuantity(block.number, "block number").toString(),
      blockHash: uoHash(block.hash, "block hash"), timestamp: uoQuantity(block.timestamp, "block timestamp").toString(), source: "onchain" };
    // A node stuck behind the chain would keep answering with owners from before a change: its head must be current.
    const seconds = BigInt(Math.floor(now() / 1000)), timestamp = BigInt(evidence.timestamp);
    if (timestamp > seconds + 30n || timestamp + 300n < seconds) throw new Error("The chain head is stale.");
    if (stored && stored.block.blockHash === evidence.blockHash) return stored;
    const at = { blockHash: evidence.blockHash, requireCanonical: true };
    const read = async (functionName: "getOwners" | "getThreshold" | "nonce") => decodeFunctionResult({ abi: safeAbi, functionName,
      data: await reads.request("eth_call", [{ to: account, data: encodeFunctionData({ abi: safeAbi, functionName }) }, at]) as Hex });
    const [owners, threshold, nonce] = await Promise.all([read("getOwners"), read("getThreshold"), withNonce ? read("nonce") : undefined]);
    const observation = { owners: (owners as readonly Address[]).map(owner => getAddress(owner)), threshold: threshold as bigint, block: evidence };
    await store?.put(account, observation);
    return withNonce ? { ...observation, nonce: nonce as bigint } : observation;
  } finally { reads.close(); }
}
const sameOwners = (a: readonly Address[], b: readonly Address[]) =>
  a.length === b.length && a.every(owner => b.some(other => other.toLowerCase() === owner.toLowerCase()));

/** Reads the account's owners and threshold on Base and on each chain at one head per chain, all at
 * once. A chain is `consistent` only with Base's exact owner set and threshold one; any failed read
 * is `unknown`, never consistent. */
export async function observeWalletOwners(input: { account: Address; chains: number[]; rpc: RestRpc; store?: WalletOwnerStateStore; signal?: AbortSignal; now?: () => number }): Promise<WalletOwnerState[]> {
  const chains = [...new Set(input.chains)];
  const read = (chainId: number) => observe(input.account, chainId, input.rpc, input.now ?? Date.now, input.store, input.signal);
  const home = read(SIGNA_HOME_CHAIN_ID);
  home.catch(() => undefined);
  const results = await Promise.allSettled(chains.map(chainId => chainId === SIGNA_HOME_CHAIN_ID ? home : read(chainId)));
  const expected = await home.catch(() => undefined);
  return chains.map((chainId, index): WalletOwnerState => {
    const result = results[index]!;
    if (result.status === "rejected") return { chainId, status: "unknown", reason: "The owners on this chain could not be read." };
    if (!expected) return { chainId, status: "unknown", reason: "The owners on Base could not be read." };
    const { owners, threshold, block } = result.value;
    if (threshold === 1n && sameOwners(owners, expected.owners) && expected.threshold === 1n) return { chainId, status: "consistent", owners, threshold, block };
    return { chainId, status: "diverged", owners, threshold, expected: expected.owners, block };
  });
}

/** The account's owners, threshold and Safe nonce on one chain, all at that chain's current head. */
export async function readWalletSafe(input: { account: Address; chainId: number; rpc: RestRpc; signal?: AbortSignal; now?: () => number }) {
  const read = await observe(input.account, input.chainId, input.rpc, input.now ?? Date.now, undefined, input.signal, true);
  return { ...read, nonce: read.nonce! };
}

/** An operation on a chain is admitted only when that chain's owners are Base's. */
export function assertOwnersConsistent(states: WalletOwnerState[], chainId: number): void {
  const state = states.find(item => item.chainId === chainId);
  if (state?.status === "consistent") return;
  if (state?.status === "diverged") throw new RestError(409, "WALLET_OWNERS_DIVERGED", "This account's owners on this network differ from Base. Update the network before using it.");
  throw new RestError(503, "WALLET_OWNERS_UNKNOWN", "This account's owners on this network could not be checked. Try again shortly.");
}
