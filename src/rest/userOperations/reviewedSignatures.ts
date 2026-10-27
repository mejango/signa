import { encodeFunctionData, getAddress, isAddress, parseAbi, type Address, type Hex } from "viem";
import { RestError, type RestRpc } from "../core.js";
import { SIGNA_HOME_CHAIN_ID } from "../wallet/chains.js";
import { observeWalletOwners, type WalletOwnerState, type WalletOwnerStateStore } from "../wallet/ownerState.js";
import { callSource, REVIEWED_CALLS_KIND, reviewedCallsView, sourceOf, type CallSource, type EtherscanAbiSource } from "./reviewedCalls.js";
import { REVIEWED_SIGNATURE_KIND, signatureFacts, signatureRefusal, signatureRequestOf, signatureWarnings,
  type ReviewedSignatureRefusal, type SignatureRequest } from "./reviewedSignatureRules.js";

export { REVIEWED_SIGNATURE_KIND, type ReviewedSignatureRefusal, type SignatureRequest } from "./reviewedSignatureRules.js";

/** What the owner approves: the exact request and, for a call it lets someone run, where that call's description comes from. */
export interface ReviewedSignatureReview {
  kind: typeof REVIEWED_SIGNATURE_KIND;
  chainId: number;
  request: SignatureRequest;
  sources: CallSource[];
}
/** The chain facts a signature needs: the account is deployed there and carries Base's owners. */
export interface SignatureChain {
  deployed(chainId: number, account: Address): Promise<boolean>;
  owners(chainId: number, account: Address): Promise<WalletOwnerState["status"]>;
}

/** What the approval page needs beside the raw request: the facts it re-derives, the warning codes it
 * words itself and, for a call the signature lets someone run, the SDK's view of that call. JSON-ready. */
export function reviewedSignatureView(review: ReviewedSignatureReview, account: Address) {
  const facts = signatureFacts(account, review.request), call = "call" in facts ? facts.call : null;
  if (review.sources.length !== (call ? 1 : 0)) throw new Error("sources");
  return { facts, warnings: signatureWarnings(facts),
    call: call ? reviewedCallsView({ kind: REVIEWED_CALLS_KIND, chainId: review.chainId, sources: review.sources,
      calls: [{ to: getAddress(call.to), value: call.value, data: call.data }] }, getAddress(call.from)) : null };
}

/** A stored review that still reads as its request says, on Base, or null. */
export function recognizeReviewedSignature(value: unknown, account: Address): ReviewedSignatureReview | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const v = value as Record<string, unknown>, keys = Object.keys(v);
    if (keys.length !== 4 || ["kind", "chainId", "request", "sources"].some(key => !keys.includes(key))) return null;
    if (v.kind !== REVIEWED_SIGNATURE_KIND || v.chainId !== SIGNA_HOME_CHAIN_ID || !Array.isArray(v.sources) || !isAddress(account)) return null;
    const request = signatureRequestOf(v.request);
    if (request.chainId !== v.chainId || signatureRefusal(account, request)) return null;
    const review: ReviewedSignatureReview = { kind: REVIEWED_SIGNATURE_KIND, chainId: SIGNA_HOME_CHAIN_ID, request, sources: v.sources.map(sourceOf) };
    reviewedSignatureView(review, account);
    return review;
  } catch { return null; }
}

/** Describes a signature request from a Signa account in the one approval. Requests addressed to the
 * account itself, to Signa's own documents or to another chain are refused from the raw request
 * before any decode; then the account must be deployed with Base's owners on the request's chain. A
 * call the signature lets someone run is described like a reviewed call: the SDK, Etherscan, else raw. */
export async function reviewSignature(input: { account: Address; request: SignatureRequest; chain: SignatureChain; abis: EtherscanAbiSource }):
  Promise<{ ok: true; review: ReviewedSignatureReview } | { ok: false; refusal: ReviewedSignatureRefusal }> {
  const { account, request } = input;
  const refusal = signatureRefusal(account, request);
  if (refusal) return { ok: false, refusal };
  if (!await input.chain.deployed(request.chainId, account)) return { ok: false, refusal: "account-not-deployed" };
  const owners = await input.chain.owners(request.chainId, account);
  if (owners === "diverged") return { ok: false, refusal: "owners-diverged" };
  if (owners !== "consistent") throw new RestError(503, "WALLET_OWNERS_UNKNOWN", "This account's owners on this network could not be checked. Try again shortly.");
  const facts = signatureFacts(account, request);
  const sources = "call" in facts ? [await callSource(request.chainId, facts.call, input.abis)] : [];
  const review: ReviewedSignatureReview = { kind: REVIEWED_SIGNATURE_KIND, chainId: request.chainId, request, sources };
  reviewedSignatureView(review, account);
  return { ok: true, review };
}

const ERC1271 = parseAbi(["function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)"]);
/** The account's own ERC-1271 answer at its chain's head, with bounded gas. Only the exact magic value is valid. */
export async function verifyAccountSignature(rpc: RestRpc, input: { chainId: number; account: Address; hash: Hex; signature: Hex }): Promise<boolean> {
  const result = await rpc.request(input.chainId, "eth_call", [{ to: input.account, gas: "0x1e8480",
    data: encodeFunctionData({ abi: ERC1271, functionName: "isValidSignature", args: [input.hash, input.signature] }) }, "latest"]);
  return typeof result === "string" && result.toLowerCase() === `0x1626ba7e${"00".repeat(28)}`;
}
/** The chain facts a signature review reads, from the server's RPC: code at the account, and its owners against Base's. */
export function signatureChain(rpc: RestRpc, store?: WalletOwnerStateStore): SignatureChain {
  return {
    deployed: async (chainId, account) => { const code = await rpc.request(chainId, "eth_getCode", [account, "latest"]); return typeof code === "string" && code !== "0x"; },
    owners: async (chainId, account) => (await observeWalletOwners({ account, chains: [chainId], rpc, ...(store ? { store } : {}) }))[0]!.status,
  };
}
