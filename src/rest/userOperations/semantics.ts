import { decodeEventLog, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi, getAddress, isAddress, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import type { StoredPlan, StoredReceipt, SemanticResult } from "../transactions/types.js";

/** Trusted host configuration; never populate these addresses from a payment request. */
export interface WalletV6UsdcPaymentConfig {
  chainId: 8453;
  token: Address;
  directV6Terminal: Address;
}

/** Exact call-derived review facts. Recognition conveys no execution or spending authority. */
export interface WalletV6UsdcPayment {
  kind: "v6-usdc-pay";
  chainId: 8453;
  account: Address;
  token: Address;
  terminal: Address;
  projectId: string;
  amount: string;
  beneficiary: Address;
  minimumReturnedTokens: string;
  memo: string;
  metadata: Hex;
  stepIndexes: readonly number[];
  approvalStepIndexes: readonly number[];
  paymentStepIndex: number;
  resetAllowance: boolean;
}

// Exact JBMultiTerminal / IJBTerminal ABI at the catalog's nana-core-v6 source pin
// feff600654aee6fb1747dded692f18068b2230a6. No router or arbitrary multicall ABI.
export const terminalAbi = parseAbi([
  "function pay(uint256 projectId,address token,uint256 amount,address beneficiary,uint256 minReturnedTokens,string memo,bytes metadata) payable returns(uint256)",
  "event Pay(uint256 indexed rulesetId,uint256 indexed rulesetCycleNumber,uint256 indexed projectId,address payer,address beneficiary,uint256 amount,uint256 newlyIssuedTokenCount,string memo,bytes metadata,address caller)",
]);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const sameTopics = (a: readonly Hex[], b: readonly (Hex | readonly Hex[] | null)[]) => a.length === b.length && a.every((topic, i) => typeof b[i] === "string" && same(topic, b[i] as string));
const hash = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
const bytes = (v: unknown, max = 32_768): v is Hex => typeof v === "string" && v.length <= 2 + max * 2 && /^0x(?:[0-9a-fA-F]{2})*$/.test(v);
const address = (v: unknown): Address => {
  if (typeof v !== "string" || !isAddress(v) || same(v, zeroAddress)) throw new Error("address");
  return getAddress(v);
};
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) throw new Error("object");
  return v as Record<string, unknown>;
};
/** Snapshot plain bounded JSON data without ordinary accessors or toJSON hooks.
 * This browser-safe leaf is not a sandbox for executable Proxy objects; the
 * HTTP/storage boundaries must provide parsed data, never caller-owned objects.
 */
function snapshot<T>(input: T, maxBytes: number): T {
  let nodes = 0, serializedBytes = 0;
  const count = (text: string) => {
    serializedBytes += new TextEncoder().encode(text).length;
    if (serializedBytes > maxBytes) throw new Error("bound");
  };
  const copy = (v: unknown, depth: number): unknown => {
    if (++nodes > 30_000 || depth > 20) throw new Error("bound");
    if (v === null || typeof v === "boolean") { count(String(v)); return v; }
    if (typeof v === "string") { if (v.length > maxBytes) throw new Error("bound"); count(JSON.stringify(v)); return v; }
    if (typeof v === "number" && Number.isSafeInteger(v)) { count(String(v)); return v; }
    if (typeof v === "bigint" && v >= 0n && v < 2n ** 256n) { count(JSON.stringify(String(v))); return String(v); }
    if (!v || typeof v !== "object") throw new Error("data");
    const array = Array.isArray(v);
    if (!array) object(v);
    if (Object.getOwnPropertySymbols(v).length) throw new Error("symbol");
    const descriptors = Object.getOwnPropertyDescriptors(v);
    const entries = Object.entries(descriptors);
    if (entries.length > 30_000) throw new Error("bound");
    if (array) {
      const length = descriptors.length;
      if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value > 30_000 || length.value !== entries.length - 1) throw new Error("array bound");
      for (let i = 0; i < length.value; i++) if (!Object.hasOwn(descriptors, String(i))) throw new Error("sparse array");
    }
    count("[]");
    const out: Record<string, unknown> | unknown[] = array ? [] : Object.create(null);
    for (const [key, desc] of entries) {
      if (array && key === "length") continue;
      if (!desc.enumerable || !("value" in desc) || (array && !/^(?:0|[1-9][0-9]*)$/.test(key))) throw new Error("descriptor");
      count(array ? "," : `${JSON.stringify(key)}:,`);
      Object.defineProperty(out, key, { value: copy(desc.value, depth + 1), enumerable: true, configurable: true, writable: true });
    }
    return out;
  };
  const result = copy(input, 0);
  if (new TextEncoder().encode(JSON.stringify(result)).length > maxBytes) throw new Error("bound");
  return result as T;
}
function uint(v: unknown): bigint {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && v.length <= 78 && /^(?:0|[1-9][0-9]*|0x(?:0|[1-9a-fA-F][0-9a-fA-F]*))$/.test(v)) {
    const n = BigInt(v); if (n < 2n ** 256n) return n;
  }
  throw new Error("quantity");
}

/** Full modeled direct-terminal pay plans only. Malformed, partial and generic batches return null. */
export function recognizeWalletV6UsdcPayment(
  plan: Pick<StoredPlan, "draft">,
  stepIndexes: readonly number[],
  config: WalletV6UsdcPaymentConfig,
): WalletV6UsdcPayment | null {
  try {
    const { draft } = snapshot(plan, 262_144);
    const indexes = snapshot(stepIndexes, 128);
    const trusted = snapshot(config, 1024);
    if (trusted.chainId !== 8453 || draft.operation !== "pay") return null;
    const token = address(trusted.token), terminal = address(trusted.directV6Terminal), account = address(draft.account);
    if (same(token, terminal) || same(account, terminal) || same(account, token)) return null;
    const calls = draft.calls;
    if (!Array.isArray(calls) || calls.length < 1 || calls.length > 3 || !Array.isArray(indexes) || indexes.length !== calls.length || indexes.some((v, i) => v !== i)) return null;
    const project = object(draft.project);
    if (project.chainId !== 8453 || (project.version !== undefined && project.version !== 6) || typeof project.projectId !== "string" || !/^[1-9][0-9]*$/.test(project.projectId)) return null;
    const projectId = uint(project.projectId);
    for (const [i, call] of calls.entries()) {
      if (call.chainId !== 8453 || call.value !== "0" || !bytes(call.data) || !Array.isArray(call.dependsOn) || call.dependsOn.length !== (i === 0 ? 0 : 1) || (i > 0 && call.dependsOn[0] !== i - 1)) return null;
    }
    const last = calls[calls.length - 1]!;
    if (!same(address(last.to), terminal)) return null;
    const decoded = decodeFunctionData({ abi: terminalAbi, data: last.data });
    if (decoded.functionName !== "pay" || !same(encodeFunctionData({ abi: terminalAbi, functionName: "pay", args: decoded.args }), last.data)) return null;
    const [id, paidToken, amount, to, minimum, memo, metadata] = decoded.args;
    if (id !== projectId || !same(paidToken, token) || amount <= 0n || amount === 2n ** 256n - 1n || !bytes(metadata, 16_384) || new TextEncoder().encode(memo).length > 256) return null;
    const beneficiary = address(to);
    for (let i = 0; i < calls.length - 1; i++) {
      const call = calls[i]!;
      if (!same(address(call.to), token)) return null;
      const approval = decodeFunctionData({ abi: erc20Abi, data: call.data });
      if (approval.functionName !== "approve" || !same(approval.args[0], terminal) || approval.args[1] !== (calls.length === 3 && i === 0 ? 0n : amount) || !same(encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: approval.args }), call.data)) return null;
    }
    const summary = object(draft.summary), payment = object(summary.payment), quotedProject = object(summary.project);
    if (summary.operation !== "pay" || !same(address(summary.account), account) || summary.route !== "multi-terminal" || !same(address(summary.terminal), terminal) || summary.routerGateway !== null || !Array.isArray(summary.terminalPath) || summary.terminalPath.length !== 1 || !same(address(summary.terminalPath[0]), terminal) || quotedProject.chainId !== 8453 || quotedProject.projectId !== project.projectId || (quotedProject.version !== undefined && quotedProject.version !== 6) || !same(address(payment.token), token) || payment.amount !== String(amount) || payment.unit !== "token-base-units" || !same(address(summary.beneficiary), beneficiary) || summary.minimumBeneficiaryTokenCount !== String(minimum) || typeof summary.metadata !== "string" || !same(summary.metadata, metadata)) return null;
    return Object.freeze({ kind: "v6-usdc-pay", chainId: 8453, account, token, terminal, projectId: String(id), amount: String(amount), beneficiary,
      minimumReturnedTokens: String(minimum), memo, metadata, stepIndexes: Object.freeze([...indexes]), approvalStepIndexes: Object.freeze(indexes.slice(0, -1)),
      paymentStepIndex: calls.length - 1, resetAllowance: calls.length === 3 });
  } catch { return null; }
}

/** Whether a plan is a pay of the configured token through the configured terminal, however
 * well or badly formed. Such a plan is verified only by the strict effects check below and never
 * falls back to weaker per-step evidence; any other pay on the chain (another token, another
 * terminal) keeps the generic verification. */
export function walletV6UsdcPaymentDomain(plan: Pick<StoredPlan, "draft">, config: WalletV6UsdcPaymentConfig): boolean {
  try {
    const draft = plan.draft;
    if (config.chainId !== 8453 || draft.operation !== "pay" || !Array.isArray(draft.calls) || !draft.calls.length) return false;
    const last = draft.calls[draft.calls.length - 1]!;
    if (!same(address(last.to), address(config.directV6Terminal))) return false;
    const decoded = decodeFunctionData({ abi: terminalAbi, data: last.data as Hex });
    return decoded.functionName === "pay" && same(decoded.args[1] as string, address(config.token));
  } catch { return false; }
}

/** Caller must already prove exact atomic Safe7579 invocation and EntryPoint operation log scope. */
export function verifyWalletV6UsdcPaymentEffects(
  plan: Pick<StoredPlan, "draft">,
  stepIndexes: readonly number[],
  config: WalletV6UsdcPaymentConfig,
  scopedReceipt: StoredReceipt,
): SemanticResult {
  const unknown = (): SemanticResult => ({ status: "unknown", details: { reason: "Exact modeled payment and distinct canonical operation-scoped effects are required." } });
  try {
    const payment = recognizeWalletV6UsdcPayment(plan, stepIndexes, config);
    if (!payment) return unknown();
    const receipt = snapshot(scopedReceipt, 524_288);
    if (receipt.canonical !== true || !hash(receipt.transactionHash) || !hash(receipt.blockHash) || (receipt.logsStored !== undefined && receipt.logsStored !== true) || !Array.isArray(receipt.logs) || receipt.logs.length > 2048) return unknown();
    if (receipt.status === "reverted") return { status: "failed", details: { reason: "The exact payment invocation reverted." } };
    if (receipt.status !== "success") return unknown();
    const blockNumber = uint(receipt.blockNumber);
    let previous = -1n, txIndex: bigint | undefined;
    const approvals: { index: bigint; value: bigint }[] = [];
    const transfers: bigint[] = [], pays: bigint[] = [];
    for (const input of receipt.logs) {
      const log = object(input);
      if (!hash(log.transactionHash) || !same(log.transactionHash, receipt.transactionHash) || !hash(log.blockHash) || !same(log.blockHash, receipt.blockHash) || uint(log.blockNumber) !== blockNumber || log.removed !== false || !bytes(log.data, 262_144) || !Array.isArray(log.topics) || log.topics.length > 4 || !log.topics.every(hash)) return unknown();
      const emitter = address(log.address), index = uint(log.logIndex), transactionIndex = uint(log.transactionIndex);
      if (index <= previous || index > BigInt(Number.MAX_SAFE_INTEGER) || transactionIndex > BigInt(Number.MAX_SAFE_INTEGER) || (txIndex !== undefined && txIndex !== transactionIndex)) return unknown();
      previous = index; txIndex = transactionIndex;
      const topics = log.topics as [Hex, ...Hex[]];
      if (same(emitter, payment.token)) {
        if (same(topics[0] ?? "", encodeEventTopics({ abi: erc20Abi, eventName: "Approval" })[0])) {
          const event = decodeEventLog({ abi: erc20Abi, eventName: "Approval", data: log.data, topics, strict: true });
          const { owner, spender, value } = event.args;
          if (!sameTopics(topics, encodeEventTopics({ abi: erc20Abi, eventName: "Approval", args: { owner, spender } })) || !same(log.data, encodeAbiParameters([{ type: "uint256" }], [value]))) return unknown();
          if (same(owner, payment.account)) {
            if (!same(spender, payment.terminal)) return unknown();
            approvals.push({ index, value });
          }
        } else if (same(topics[0] ?? "", encodeEventTopics({ abi: erc20Abi, eventName: "Transfer" })[0])) {
          const event = decodeEventLog({ abi: erc20Abi, eventName: "Transfer", data: log.data, topics, strict: true });
          const { from, to, value } = event.args;
          if (!sameTopics(topics, encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } })) || !same(log.data, encodeAbiParameters([{ type: "uint256" }], [value]))) return unknown();
          if (same(from, payment.account)) {
            if (!same(to, payment.terminal) || value !== BigInt(payment.amount)) return unknown();
            transfers.push(index);
          }
        }
      } else if (same(emitter, payment.terminal) && same(topics[0] ?? "", encodeEventTopics({ abi: terminalAbi, eventName: "Pay" })[0])) {
        const event = decodeEventLog({ abi: terminalAbi, eventName: "Pay", data: log.data, topics, strict: true });
        const a = event.args;
        if (!sameTopics(topics, encodeEventTopics({ abi: terminalAbi, eventName: "Pay", args: { rulesetId: a.rulesetId, rulesetCycleNumber: a.rulesetCycleNumber, projectId: a.projectId } })) || a.projectId !== BigInt(payment.projectId) || !same(a.payer, payment.account) || !same(a.caller, payment.account) || !same(a.beneficiary, payment.beneficiary) || a.amount !== BigInt(payment.amount) || a.memo !== payment.memo || !same(a.metadata, payment.metadata)) return unknown();
        const canonicalData = encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "string" }, { type: "bytes" }, { type: "address" }], [a.payer, a.beneficiary, a.amount, a.newlyIssuedTokenCount, a.memo, a.metadata, a.caller]);
        if (!same(canonicalData, log.data)) return unknown();
        pays.push(index);
      }
    }
    if (approvals.length !== payment.approvalStepIndexes.length || transfers.length !== 1 || pays.length !== 1 || transfers[0]! >= pays[0]!) return unknown();
    for (const [i, approval] of approvals.entries()) {
      if (approval.value !== (payment.resetAllowance && i === 0 ? 0n : BigInt(payment.amount)) || approval.index >= transfers[0]!) return unknown();
    }
    // The caller has proved this exact atomic invocation succeeded. V6 checks the
    // full beneficiary balance delta against minReturnedTokens (including hooks).
    // Pay.newlyIssuedTokenCount is only minted output, and is never used as that delta.
    // Retain economic facts and unique event assignments without duplicating
    // bounded but potentially large memo/metadata already committed by the plan.
    const facts = { kind: payment.kind, chainId: payment.chainId, account: payment.account, token: payment.token, terminal: payment.terminal,
      projectId: payment.projectId, amount: payment.amount, beneficiary: payment.beneficiary, minimumReturnedTokens: payment.minimumReturnedTokens };
    return { status: "verified", details: { verifier: "exact-v6-usdc-payment-v1", payment: facts,
      assignments: [...approvals.map((a, i) => ({ stepIndex: payment.approvalStepIndexes[i]!, logIndexes: [String(a.index)] })),
        { stepIndex: payment.paymentStepIndex, logIndexes: [String(transfers[0]), String(pays[0])] }],
      minimumEvidence: "exact-successful-terminal-call" } };
  } catch { return unknown(); }
}
