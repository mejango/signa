import { buildReviewModel, decodeReviewCall, type ReviewModel, type TransactionReviewCall } from "@bananapus/nana-sdk-core/review";
import { getAddress, isAddress, type Abi, type AbiFunction, type Address, type Hex } from "viem";
import type { SemanticResult, StoredPlan, StoredReceipt } from "../transactions/types.js";
import { SIGNA_HOME_CHAIN_ID } from "../wallet/chains.js";
import { decodeSafe7579Execution } from "../smartAccounts/accountExecution.js";
import { exactFunction, REVIEWED_CALLS_KIND, reviewedCallRefusal, type CallSource, type ReviewedCallsRefusal,
  type SignaCall } from "./reviewedCallRules.js";

export { REVIEWED_CALLS_KIND, type CallSource, type ReviewedCallsRefusal, type SignaCall } from "./reviewedCallRules.js";

/** The plan operation an app's call set is stored under. */
export const REVIEWED_CALLS_OPERATION = "reviewed-calls";
export const REVIEWED_CALLS_MAXIMUM = 16;

export interface EtherscanAbiSource {
  abiFor(input: { chainId: number; address: Address }): Promise<{ ok: true; abi: Abi; implementation?: Address } | { ok: false; reason: "no-abi" | "lookup-failed" }>;
}
/** What the owner approves: the exact calls and where each one's description comes from. */
export interface ReviewedCallsReview {
  kind: typeof REVIEWED_CALLS_KIND;
  chainId: number;
  calls: { to: Address; value: string; data: Hex }[];
  sources: CallSource[];
}

const plain = (value: unknown, keys: string[], optional: string[] = []): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new Error("object");
  const own = Object.keys(value);
  if (keys.some(key => !own.includes(key)) || own.some(key => !keys.includes(key) && !optional.includes(key))) throw new Error("fields");
  return value as Record<string, unknown>;
};
export function sourceOf(value: unknown): CallSource {
  const kind = plain(value, ["source"], ["lookup", "abi", "implementation"]).source;
  if (kind === "first-party") { plain(value, ["source"]); return { source: "first-party" }; }
  if (kind === "raw") {
    const { lookup } = plain(value, ["source", "lookup"]);
    if (lookup !== "no-abi" && lookup !== "lookup-failed") throw new Error("lookup");
    return { source: "raw", lookup };
  }
  if (kind !== "etherscan") throw new Error("source");
  const v = plain(value, ["source", "abi"], ["implementation"]);
  // The one function the call uses: the review stores what it decoded with, not a whole contract ABI.
  if (!Array.isArray(v.abi) || v.abi.length !== 1 || (v.abi[0] as { type?: unknown })?.type !== "function") throw new Error("abi");
  if (v.implementation !== undefined && (typeof v.implementation !== "string" || !isAddress(v.implementation))) throw new Error("implementation");
  return { source: "etherscan", abi: v.abi as Abi, ...(v.implementation === undefined ? {} : { implementation: getAddress(v.implementation as string) }) };
}

/** Each call as the SDK decodes it, or with the stored Etherscan ABI where the SDK left it raw.
 * Throws when a source no longer fits its call. */
function decodedCalls(review: ReviewedCallsReview, account: Address): TransactionReviewCall[] {
  return review.calls.map((call, index) => {
    const source = review.sources[index]!;
    const decoded = decodeReviewCall({ chainId: review.chainId, to: call.to, data: call.data, value: BigInt(call.value), from: account });
    if (source.source === "first-party") { if (!decoded.abi) throw new Error("first-party"); return decoded; }
    if (decoded.abi) throw new Error("decoded first-party");
    if (source.source === "raw") return decoded;
    const found = exactFunction(source.abi, call.data);
    if (!found) throw new Error("etherscan");
    return { ...decoded, abi: [found.item], functionName: found.item.name, args: found.args };
  });
}
/** The SDK's review of the exact calls, decoded with their sources. Throws when it cannot. */
export function reviewedCallsModel(review: ReviewedCallsReview, account: Address): ReviewModel {
  const model = buildReviewModel({ kind: "transaction", title: "Review calls", calls: decodedCalls(review, account) });
  if (model.calls.some(call => call.warnings.some(warning => warning.code === "unreadable")) || model.warnings.length) throw new Error("unreadable");
  return model;
}
/** What the approval page needs beside the operation bytes: the model's facts per call and the
 * function each decoded call used, so the page decodes the bytes itself. JSON-ready. */
export function reviewedCallsView(review: ReviewedCallsReview, account: Address) {
  const decoded = decodedCalls(review, account), model = reviewedCallsModel(review, account);
  return {
    model: { id: model.id, calls: model.calls.map(call => ({ to: call.to, value: call.value.toString(), data: call.data,
      contractName: call.contractName, functionName: call.functionName, roles: call.roles.map(role => ({ ...role })),
      warnings: call.warnings.map(warning => ({ ...warning })) })) },
    functions: decoded.map(call => (call.abi?.[0] as AbiFunction | undefined) ?? null),
  };
}
/** The view of an operation's own calls as the SDK describes them: what a payment review shows,
 * read from the bytes the passkey signs rather than from any plan summary. */
export function operationCallsView(operation: { sender: Address; callData: Hex }) {
  const calls = decodeSafe7579Execution(operation.callData).map(call => ({ to: getAddress(call.target), value: call.value, data: call.callData.toLowerCase() as Hex }));
  return reviewedCallsView({ kind: REVIEWED_CALLS_KIND, chainId: SIGNA_HOME_CHAIN_ID, calls, sources: calls.map(() => ({ source: "first-party" as const })) },
    operation.sender);
}

/** The exact call set a reviewed-calls plan stores, without decoding it. */
function reviewedCallsShape(plan: Pick<StoredPlan, "draft">, stepIndexes: readonly number[], chainId: number): ReviewedCallsReview | null {
  try {
    const d = plan.draft;
    if (d.operation !== REVIEWED_CALLS_OPERATION || chainId !== SIGNA_HOME_CHAIN_ID || !isAddress(d.account)) return null;
    const account = getAddress(d.account), calls = d.calls;
    if (!Array.isArray(calls) || calls.length < 1 || calls.length > REVIEWED_CALLS_MAXIMUM || stepIndexes.length !== calls.length ||
      stepIndexes.some((value, index) => value !== index)) return null;
    for (const [index, call] of calls.entries())
      if (call.chainId !== chainId || !isAddress(call.to) || typeof call.data !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(call.data) ||
        typeof call.value !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(call.value) || BigInt(call.value) >= 2n ** 256n ||
        !Array.isArray(call.dependsOn) || call.dependsOn.length !== (index ? 1 : 0) || (index && call.dependsOn[0] !== index - 1) ||
        reviewedCallRefusal(account, call)) return null;
    const summary = plain(d.summary, ["kind", "sources"]);
    if (summary.kind !== REVIEWED_CALLS_KIND || !Array.isArray(summary.sources) || summary.sources.length !== calls.length) return null;
    return { kind: REVIEWED_CALLS_KIND, chainId, sources: summary.sources.map(sourceOf),
      calls: calls.map(call => ({ to: getAddress(call.to), value: call.value, data: call.data.toLowerCase() as Hex })) };
  } catch { return null; }
}
/** A reviewed-calls plan whose every call still decodes as its source says, selected whole. */
export function recognizeReviewedCalls(plan: Pick<StoredPlan, "draft">, stepIndexes: readonly number[],
  chainId: number = SIGNA_HOME_CHAIN_ID): ReviewedCallsReview | null {
  const review = reviewedCallsShape(plan, stepIndexes, chainId);
  try { if (review) reviewedCallsModel(review, getAddress(plan.draft.account)); } catch { return null; }
  return review;
}

const canonicalArgument = (value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value) ? value.toLowerCase()
    : Array.isArray(value) ? value.map(canonicalArgument)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonicalArgument(v)]))
    : value;
/** The first call the app's expectation misstates: a decoded call must match its function and
 * arguments exactly, and a raw call must be expected as null. */
function expectationMismatch(calls: TransactionReviewCall[], expectation: unknown): number | null {
  if (!Array.isArray(expectation) || expectation.length !== calls.length) return 0;
  for (const [index, call] of calls.entries()) {
    const expected = expectation[index] as { functionName?: unknown; args?: unknown } | null;
    if (!call.functionName ? expected !== null
      : !expected || typeof expected !== "object" || expected.functionName !== call.functionName ||
        JSON.stringify(canonicalArgument(expected.args ?? [])) !== JSON.stringify(canonicalArgument(call.args ?? []))) return index;
  }
  return null;
}

/** Where one call's description comes from: the SDK, else the Etherscan-verified ABI of its target, else raw. */
export async function callSource(chainId: number, call: { to: Address; data: Hex }, abis: EtherscanAbiSource): Promise<CallSource> {
  if (decodeReviewCall({ chainId, to: call.to, data: call.data }).abi) return { source: "first-party" };
  if (!/^0x[0-9a-fA-F]{8}/.test(call.data)) return { source: "raw", lookup: "no-abi" };
  const found = await abis.abiFor({ chainId, address: call.to }).catch(() => ({ ok: false, reason: "lookup-failed" }) as const);
  if (!found.ok) return { source: "raw", lookup: found.reason };
  const fn = exactFunction(found.abi, call.data);
  return fn ? { source: "etherscan", abi: [fn.item], ...(found.implementation ? { implementation: found.implementation } : {}) }
    : { source: "raw", lookup: "no-abi" };
}

/** Describes any call set from a Signa account in the one approval: the SDK first, then the
 * Etherscan-verified ABI of the target (its implementation, behind a proxy), else raw with a
 * warning. Self-calls and delegatecalls are refused from the raw calls before any decode or lookup.
 * The app's expectation is checked against the decode and never shown. */
export async function reviewCalls(input: { chainId: number; account: Address; calls: SignaCall[]; abis: EtherscanAbiSource; expectation?: unknown }):
  Promise<{ ok: true; model: ReviewModel; sources: CallSource[] } | { ok: false; refusal: ReviewedCallsRefusal; callIndex: number }> {
  const { chainId, account, calls } = input;
  for (const [callIndex, call] of calls.entries()) {
    const refusal = reviewedCallRefusal(account, call);
    if (refusal) return { ok: false, refusal, callIndex };
  }
  const sources = await Promise.all(calls.map(call => callSource(chainId, call, input.abis)));
  const review: ReviewedCallsReview = { kind: REVIEWED_CALLS_KIND, chainId, sources,
    calls: calls.map(call => ({ to: getAddress(call.to), value: call.value.toString(), data: call.data.toLowerCase() as Hex })) };
  if (input.expectation !== undefined) {
    const callIndex = expectationMismatch(decodedCalls(review, account), input.expectation);
    if (callIndex !== null) return { ok: false, refusal: "app-expectation-mismatch", callIndex };
  }
  return { ok: true, model: reviewedCallsModel(review, account), sources };
}

/** The caller has proved the exact atomic Safe7579 execution of the plan's calls and its EntryPoint
 * operation scope. Verified only on a canonical successful execution: one failing call reverts the
 * whole execution, so success is every reviewed call succeeding. Nothing is claimed about effects. */
export function verifyReviewedCallsEffects(plan: Pick<StoredPlan, "draft">, scopedReceipt: StoredReceipt): SemanticResult {
  const unknown = (): SemanticResult => ({ status: "unknown", details: { reason: "A canonical result of the exact reviewed calls is required." } });
  const hash = (value: unknown) => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
  const review = reviewedCallsShape(plan, plan.draft.calls.map((_, index) => index), SIGNA_HOME_CHAIN_ID);
  if (!review || scopedReceipt.canonical !== true || !hash(scopedReceipt.transactionHash) || !hash(scopedReceipt.blockHash)) return unknown();
  if (scopedReceipt.status === "reverted") return { status: "failed", details: { reason: "The reviewed calls reverted together." } };
  if (scopedReceipt.status !== "success") return unknown();
  return { status: "verified", details: { verifier: "reviewed-calls-v1", calls: review.calls.length, minimumEvidence: "exact-successful-account-execution" } };
}
