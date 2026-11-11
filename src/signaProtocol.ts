import { readFileSync } from "node:fs";
import { NATIVE_TOKEN, jbMultiTerminalAbi } from "@bananapus/nana-sdk-core";
import { decodeFunctionData, encodeFunctionData, erc20Abi, isAddress, type AbiFunction, type Address, type Hex } from "viem";
import { z } from "zod";
import { RestError, type RestBlockEvidence, type RestPlanDraft } from "./rest/core.js";
import { jsonValue, REST_LIMITS } from "./rest/http.js";
import { getContractCatalog, type ContractCatalog } from "./rest/contracts/catalog.js";
import { argumentsFor, signature } from "./rest/protocol/abi.js";

export interface ProtocolOperation {
  id: string;
  description: string;
  kind: string;
  sources: readonly string[];
  transaction: boolean;
  effects: { externalMutation: boolean; idempotent: boolean };
  inputJsonSchema: Record<string, unknown>;
}
export interface ProtocolOperations {
  list(): readonly ProtocolOperation[];
  prepare(id: string, input: unknown, options?: { signal?: AbortSignal; at?: RestBlockEvidence }): Promise<RestPlanDraft>;
}
const catalog = JSON.parse(readFileSync(new URL("./rest/protocol/operations.json", import.meta.url), "utf8")) as { operations: ProtocolOperation[] };
/** Reviewed API operation IDs and the protocol action each is permitted to return. */
export const CENTER_DRAFT_OPERATIONS: Readonly<Record<string, string>> = Object.freeze({
  prepare_pay: "pay", prepare_cash_out: "cash_out", prepare_payout: "payout", prepare_ruleset_change: "ruleset-change",
  prepare_launch: "launch", prepare_borrow: "borrow", prepare_repay: "repay_loan", prepare_bridge_claim: "bridge_claim",
  prepare_accounting_sync: "sync_accounting", prepare_buyback_pool: "setPoolFor", prepare_buyback_twap: "setTwapWindowOf",
  prepare_buyback_hook: "setHookFor", prepare_router_terminal: "setTerminalFor", prepare_721_pay: "721_pay",
  prepare_adjust_tiers: "721_adjust_tiers", prepare_721_launch: "721_launch", prepare_revnet_deploy: "revnet_deploy",
  prepare_auto_issue: "revnet_auto_issue", contract_calls: "protocol-contract-calls", "protocol-contract-calls": "protocol-contract-calls",
});
const chains = z.union([z.literal(1), z.literal(10), z.literal(8453), z.literal(42161), z.literal(11155111), z.literal(11155420), z.literal(84532), z.literal(421614)]);
const uint = z.string().regex(/^(0|[1-9][0-9]*)$/).max(78).refine(value => BigInt(value) < 1n << 256n);
const address = z.string().refine(value => isAddress(value)).transform(value => value as Address);
const hex = z.string().regex(/^0x(?:[a-fA-F0-9]{2})*$/).max(262146).transform(value => value as Hex);
const hash = z.string().regex(/^0x[a-fA-F0-9]{64}$/).transform(value => value as Hex);
const schema = z.object({
  operation: z.string().min(1).max(128), account: address,
  project: z.object({ chainId: chains, projectId: uint, version: z.literal(6).optional() }).strict().optional(),
  calls: z.array(z.object({ chainId: chains, to: address, data: hex, value: uint, label: z.string().max(4000),
    dependsOn: z.array(z.number().int().min(0).max(31)).max(31), decoded: z.unknown() }).strict()).min(1).max(32),
  evidence: z.array(z.object({ chainId: chains, blockNumber: uint, blockHash: hash, timestamp: uint, source: z.literal("onchain") }).strict()).min(1).max(32),
  summary: z.unknown(), warnings: z.array(z.string().max(4000)).max(64),
}).strict();
const mismatch = () => new RestError(502, "PROTOCOL_RESPONSE_INVALID", "Center returned a draft that does not match the requested action.");
const unavailable = () => new RestError(503, "PROTOCOL_UNAVAILABLE", "Center protocol preparation is unavailable. Retry the original request.");
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const same = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

/** Bind the payment and allowance calls to the requested spend, not Center's display fields.
 * Route discovery and quoting stay in Center; Signa's wallet review independently checks its
 * supported terminal, decoded review facts and authority before approval. */
function validatePayment(draft: RestPlanDraft, input: Record<string, unknown>) {
  try {
    const last = draft.calls.at(-1)!;
    const decoded = decodeFunctionData({ abi: jbMultiTerminalAbi, data: last.data });
    if (decoded.functionName !== "pay") throw mismatch();
    const [projectId, token, amount, beneficiary, minimum, memo, metadata] = decoded.args;
    if (!record(input.project) || String(projectId) !== input.project.projectId || !same(token, input.token) ||
      String(amount) !== input.amount || !same(beneficiary, input.beneficiary) || memo !== (input.memo ?? "") ||
      (input.minReturnedTokens !== undefined && String(minimum) !== input.minReturnedTokens) ||
      (input.metadata !== undefined && !same(metadata, input.metadata)) ||
      !same(encodeFunctionData({ abi: jbMultiTerminalAbi, functionName: "pay", args: decoded.args }), last.data)) throw mismatch();
    const native = same(token, NATIVE_TOKEN);
    if (last.value !== (native ? String(amount) : "0") || draft.calls.length > (native ? 1 : 3)) throw mismatch();
    for (const [index, call] of draft.calls.entries()) {
      if (call.dependsOn.length !== (index === 0 ? 0 : 1) || (index > 0 && call.dependsOn[0] !== index - 1)) throw mismatch();
      if (call === last) continue;
      const approval = decodeFunctionData({ abi: erc20Abi, data: call.data });
      if (!same(call.to, token) || call.value !== "0" || approval.functionName !== "approve" ||
        !same(approval.args[0], last.to) || approval.args[1] !== (draft.calls.length === 3 && index === 0 ? 0n : amount) ||
        !same(encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: approval.args }), call.data)) throw mismatch();
    }
  } catch { throw mismatch(); }
}

/** Validate data from Center. Signa's transaction service independently proves ownership,
 * canonical evidence, simulation, approvals and exact execution before spending. */
export function validateCenterDraft(value: unknown, operation: string, input: unknown, at?: RestBlockEvidence): RestPlanDraft {
  const parsed = schema.safeParse(value);
  if (!parsed.success || !record(input)) throw mismatch();
  const draft = parsed.data as RestPlanDraft;
  if (!Object.hasOwn(CENTER_DRAFT_OPERATIONS, operation) || draft.operation !== CENTER_DRAFT_OPERATIONS[operation] || !same(draft.account, input.account)) throw mismatch();
  const project = input.project;
  if (record(project) && (!draft.project || draft.project.chainId !== project.chainId || draft.project.projectId !== project.projectId ||
    draft.calls.some(call => call.chainId !== project.chainId))) throw mismatch();
  if (typeof input.chainId === "number" && draft.calls.some(call => call.chainId !== input.chainId)) throw mismatch();
  const evidenceChains = new Set(draft.evidence.map(item => item.chainId));
  const callChains = new Set(draft.calls.map(call => call.chainId));
  if (evidenceChains.size !== draft.evidence.length || evidenceChains.size !== callChains.size || draft.calls.some((call,index) => !evidenceChains.has(call.chainId) ||
    new Set(call.dependsOn).size !== call.dependsOn.length || call.dependsOn.some(dependency => dependency >= index))) throw mismatch();
  if (at) {
    const observed = draft.evidence.find(item => item.chainId === at.chainId);
    if (!observed || !same(observed.blockHash,at.blockHash) || observed.blockNumber !== at.blockNumber || observed.timestamp !== at.timestamp) throw mismatch();
  }
  if (operation === "prepare_pay" || operation === "prepare_721_pay") validatePayment(draft, input);
  return draft;
}

/** The catalog path already owns ABI conversion. Reuse it to bind explicit generic calls
 * without repeating Center's target discovery, runtime proofs or RPC preparation. */
function validateContractCalls(draft: RestPlanDraft, input: unknown, contracts: ContractCatalog) {
  try {
    if (!record(input) || !Array.isArray(input.calls) || input.calls.length !== draft.calls.length) throw mismatch();
    for (const [index, call] of draft.calls.entries()) {
      const requested = input.calls[index];
      if (!record(requested) || !record(call.decoded) || typeof requested.contractId !== "string" ||
        typeof requested.function !== "string" || typeof call.decoded.abiHash !== "string" ||
        call.decoded.contractId !== requested.contractId || call.chainId !== requested.chainId ||
        (requested.address !== undefined && !same(call.to, requested.address)) || call.value !== (requested.value ?? "0") ||
        JSON.stringify(call.dependsOn) !== JSON.stringify(requested.dependsOn ?? [])) throw mismatch();
      const variant = contracts.variant(requested.contractId, call.decoded.abiHash);
      const candidates = variant.abi.filter((item): item is AbiFunction => item.type === "function" && signature(item) === requested.function);
      if (candidates.length !== 1) throw mismatch();
      const fn = candidates[0]!;
      if (fn.stateMutability === "view" || fn.stateMutability === "pure" || (call.value !== "0" && fn.stateMutability !== "payable")) throw mismatch();
      const args = argumentsFor(fn, requested.args);
      if (!same(call.data, encodeFunctionData({ abi: [fn], functionName: fn.name, args }))) throw mismatch();
    }
  } catch { throw mismatch(); }
}

async function responseValue(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw mismatch();
  const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const reader = response.body.getReader();
  // Cancelling the reader releases a pending read even if a supplied fetch adapter does not
  // itself observe the signal. Checking only between chunks can otherwise hang forever.
  const cancel = () => { void reader.cancel().catch(() => {}); };
  const chunks: Uint8Array[] = [];
  let length = 0;
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    if (type !== "application/json" && type !== "application/problem+json") throw mismatch();
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > REST_LIMITS.bodyBytes) throw mismatch();
      chunks.push(value);
    }
    try { return jsonValue(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)), "Center response"); }
    catch { throw mismatch(); }
  } catch (error) {
    if (error instanceof RestError && !signal.aborted) throw error;
    throw unavailable();
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

/** A fixed protocol service supplies unsigned drafts only. Center never receives account
 * credentials, owner approvals or Signa's durable execution identifiers. The reviewed catalog
 * is local, so login, recovery and receipt reconciliation do not depend on Center availability. */
export function createSignaProtocol(options: { fetch?: typeof fetch } = {}): ProtocolOperations {
  return {
    list: () => structuredClone(catalog.operations),
    async prepare(operation, input, optionsForCall = {}) {
      if (!Object.hasOwn(CENTER_DRAFT_OPERATIONS, operation)) throw new RestError(404,"TRANSACTION_OPERATION_NOT_FOUND","Choose a supported transaction operation.");
      // Only prepare_pay currently supports the exact-head optimization. Other builders
      // choose their own evidence, which the local transaction service verifies normally.
      const requestedAt = operation === "prepare_pay" ? optionsForCall.at : undefined;
      const signal = AbortSignal.any([AbortSignal.timeout(REST_LIMITS.timeoutMs), ...(optionsForCall.signal ? [optionsForCall.signal] : [])]);
      const body = JSON.stringify({ operation, input, ...(requestedAt ? { at: requestedAt } : {}) });
      if (Buffer.byteLength(body) > REST_LIMITS.bodyBytes) throw new RestError(413,"PROTOCOL_REQUEST_TOO_LARGE","Protocol preparation exceeds one MiB.");
      // Keep the exact submitted request across the external await, even if a local caller
      // later mutates the original input object.
      const sent = jsonValue(body) as { input: unknown; at?: RestBlockEvidence };
      let response: Response;
      try {
        signal.throwIfAborted();
        response = await (options.fetch ?? fetch)("https://juicebox.center/api/v1/plans", {
          method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body,
          redirect: "error", credentials: "omit", cache: "no-store", signal,
        });
      } catch { throw unavailable(); }
      const result = await responseValue(response, signal);
      if (!response.ok) {
        // Center's public problem contract excludes raw implementation errors and upstream
        // credentials. Retain actionable request refusals such as protected-minimum errors.
        if (response.status >= 400 && response.status < 500 && record(result) && result.status === response.status &&
          typeof result.code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(result.code) &&
          typeof result.detail === "string" && result.detail.length > 0 && result.detail.length <= 4000)
          throw new RestError(response.status, result.code, result.detail);
        throw unavailable();
      }
      if (!record(result) || Object.keys(result).length !== 1 || !Object.hasOwn(result,"data")) throw mismatch();
      const draft = validateCenterDraft(result.data, operation, sent.input, sent.at);
      if (draft.operation === "protocol-contract-calls") validateContractCalls(draft, sent.input, await getContractCatalog());
      return draft;
    },
  };
}
