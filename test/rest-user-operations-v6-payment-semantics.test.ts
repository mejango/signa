import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi, parseAbi, type Address, type Hex } from "viem";
import type { RestPlanDraft } from "../src/rest/core.js";
import type { StoredReceipt } from "../src/rest/transactions/types.js";
import { recognizeWalletV6UsdcPayment, verifyWalletV6UsdcPaymentEffects, type WalletV6UsdcPaymentConfig } from "../src/rest/userOperations/semantics.js";
import { UserOperationService, type UserOperationServiceDependencies } from "../src/rest/userOperations/service.js";
import { encodeSafe7579Execution } from "../src/rest/smartAccounts/accountExecution.js";
import type { ObserveUserOperationOptions } from "../src/rest/userOperations/execution.js";
import type { UserOperationObservation } from "../src/rest/userOperations/types.js";
import { plan as storedFixture, record as operationFixture, account as accountFixture, binding as bindingFixture, owner as ownerFixture } from "./fixtures/user-operations.js";
const observer = vi.hoisted(() => vi.fn());
vi.mock("../src/rest/userOperations/execution.js", () => ({ observeUserOperation: observer }));

const account = "0x1111111111111111111111111111111111111111" as Address;
const beneficiary = "0x2222222222222222222222222222222222222222" as Address;
const token = "0x3333333333333333333333333333333333333333" as Address;
const terminal = "0x4444444444444444444444444444444444444444" as Address;
const config: WalletV6UsdcPaymentConfig = { chainId: 8453, token, directV6Terminal: terminal };
const payAbi = parseAbi(["function pay(uint256 projectId,address token,uint256 amount,address beneficiary,uint256 minReturnedTokens,string memo,bytes metadata) payable returns(uint256)",
  "event Pay(uint256 indexed rulesetId,uint256 indexed rulesetCycleNumber,uint256 indexed projectId,address payer,address beneficiary,uint256 amount,uint256 newlyIssuedTokenCount,string memo,bytes metadata,address caller)"]);
const payArgs = [7n, token, 100n, beneficiary, 5n, "reviewed memo", "0x1234"] as const;
function plan(approvals: bigint[] = [0n, 100n]): { draft: RestPlanDraft } {
  return { draft: { operation: "pay", account, project: { chainId: 8453, projectId: "7", version: 6 },
    calls: [...approvals.map(amount => ({ chainId: 8453, to: token,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [terminal, amount] }),
      value: "0", label: "Approve", dependsOn: [] as number[], decoded: null })),
    { chainId: 8453, to: terminal, data: encodeFunctionData({ abi: payAbi, functionName: "pay", args: payArgs }),
      value: "0", label: "Pay", dependsOn: [], decoded: null }].map((call, i) => ({ ...call, dependsOn: i === 0 ? [] : [i - 1] })),
    evidence: [], warnings: [], summary: { operation: "pay", project: { chainId: 8453, projectId: "7", version: 6 }, account,
      terminal, terminalPath: [terminal], routerGateway: null, route: "multi-terminal", payment: { token, amount: "100", unit: "token-base-units" },
      beneficiary, minimumBeneficiaryTokenCount: "5", metadata: "0x1234" } } };
}
function log(kind: "Approval" | "Transfer" | "Pay", logIndex: number, value = 100n): Record<string, unknown> {
  const base = { address: kind === "Pay" ? terminal : token, blockHash: `0x${"ab".repeat(32)}`, blockNumber: "10",
    transactionHash: `0x${"cd".repeat(32)}`, transactionIndex: 0, logIndex, removed: false };
  if (kind === "Approval") return { ...base, topics: encodeEventTopics({ abi: erc20Abi, eventName: kind, args: { owner: account, spender: terminal } }), data: encodeAbiParameters([{ type: "uint256" }], [value]) };
  if (kind === "Transfer") return { ...base, topics: encodeEventTopics({ abi: erc20Abi, eventName: kind, args: { from: account, to: terminal } }), data: encodeAbiParameters([{ type: "uint256" }], [value]) };
  return { ...base, topics: encodeEventTopics({ abi: payAbi, eventName: kind, args: { rulesetId: 1n, rulesetCycleNumber: 1n, projectId: 7n } }),
    data: encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "string" }, { type: "bytes" }, { type: "address" }],
      [account, beneficiary, value, 0n, "reviewed memo", "0x1234", account]) };
}
function receipt(logs = [log("Approval", 1, 0n), log("Approval", 2), log("Transfer", 3), log("Pay", 4)]): StoredReceipt {
  return { transactionHash: `0x${"cd".repeat(32)}`, blockHash: `0x${"ab".repeat(32)}`, blockNumber: "10", status: "success", canonical: true,
    confirmations: 2, observedAt: 1_800_000_000_000, logs };
}
const indexes = (p: ReturnType<typeof plan>) => p.draft.calls.map((_, i) => i);
describe("exact modeled V6 USDC payment semantics", () => {
  it.each([{ approvals: [] }, { approvals: [100n] }, { approvals: [0n, 100n] }])("recognizes full production-shaped calls with approvals $approvals", ({ approvals }) => {
    const p = plan(approvals);
    expect(recognizeWalletV6UsdcPayment(p, indexes(p), config)).toMatchObject({ kind: "v6-usdc-pay", amount: "100", projectId: "7", beneficiary,
      minimumReturnedTokens: "5", memo: "reviewed memo", metadata: "0x1234", resetAllowance: approvals.length === 2 });
  });
  it("proves distinct ordered approval, transfer and Pay evidence, without mistaking mint-only output for the minimum", () => {
    const p = plan();
    expect(verifyWalletV6UsdcPaymentEffects(p, indexes(p), config, receipt()).status).toBe("verified");
  });
  it.each([
    ["generic batch", (p: ReturnType<typeof plan>) => { p.draft.operation = "contract_calls"; }],
    ["another token", (p: ReturnType<typeof plan>) => { p.draft.calls[0]!.to = beneficiary; }],
    ["native value", (p: ReturnType<typeof plan>) => { p.draft.calls[2]!.value = "1"; }],
    ["missing dependency", (p: ReturnType<typeof plan>) => { p.draft.calls[2]!.dependsOn = []; }],
    ["cyclic dependency", (p: ReturnType<typeof plan>) => { p.draft.calls[1]!.dependsOn = [2]; }],
    ["another chain", (p: ReturnType<typeof plan>) => { p.draft.calls[1]!.chainId = 1; }],
    ["project mismatch", (p: ReturnType<typeof plan>) => { p.draft.project!.projectId = "8"; }],
    ["unlimited approval", (p: ReturnType<typeof plan>) => { p.draft.calls[1]!.data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [terminal, 2n ** 256n - 1n] }); }],
    ["trailing approval bytes", (p: ReturnType<typeof plan>) => { p.draft.calls[0]!.data += "00"; }],
    ["trailing payment bytes", (p: ReturnType<typeof plan>) => { p.draft.calls[2]!.data += "00"; }],
    ["another summary beneficiary", (p: ReturnType<typeof plan>) => { (p.draft.summary as Record<string, unknown>).beneficiary = account; }],
    ["another summary amount", (p: ReturnType<typeof plan>) => { ((p.draft.summary as Record<string, unknown>).payment as Record<string, unknown>).amount = "101"; }],
    ["another summary minimum", (p: ReturnType<typeof plan>) => { (p.draft.summary as Record<string, unknown>).minimumBeneficiaryTokenCount = "0"; }],
    ["another summary metadata", (p: ReturnType<typeof plan>) => { (p.draft.summary as Record<string, unknown>).metadata = "0x"; }],
    ["router path", (p: ReturnType<typeof plan>) => { (p.draft.summary as Record<string, unknown>).terminalPath = [terminal, token]; }],
    ["router route", (p: ReturnType<typeof plan>) => { (p.draft.summary as Record<string, unknown>).route = "router-terminal"; }],
    ["missing summary", (p: ReturnType<typeof plan>) => { p.draft.summary = {}; }],
  ] as const)("rejects unrecognized or altered plan: %s", (_, mutate) => {
    const p = plan(); mutate(p);
    expect(recognizeWalletV6UsdcPayment(p, indexes(p), config)).toBeNull();
    expect(verifyWalletV6UsdcPaymentEffects(p, indexes(p), config, receipt()).status).toBe("unknown");
  });
  it.each([[0], [2], [0, 2], [2, 1, 0], [0, 1, 1], [0, 1, 2, 3]])("rejects partial/reordered indices %j", (...selected) => {
    expect(recognizeWalletV6UsdcPayment(plan(), selected, config)).toBeNull();
  });
  it("snapshots immutable review facts and does not execute input getters", () => {
    const p = plan(); const result = recognizeWalletV6UsdcPayment(p, indexes(p), config)!;
    p.draft.calls.length = 0;
    expect(result.stepIndexes).toEqual([0, 1, 2]); expect(Object.isFrozen(result)).toBe(true);
    let executed = false;
    const evil = plan(); Object.defineProperty(evil.draft, "summary", { enumerable: true, get() { executed = true; throw new Error("unsafe"); } });
    expect(recognizeWalletV6UsdcPayment(evil, [0, 1, 2], config)).toBeNull(); expect(executed).toBe(false);
  });
  it.each([
    ["missing approval", (r: StoredReceipt) => { r.logs.splice(0, 1); }],
    ["missing transfer", (r: StoredReceipt) => { r.logs.splice(2, 1); }],
    ["missing Pay", (r: StoredReceipt) => { r.logs.pop(); }],
    ["duplicate approval evidence", (r: StoredReceipt) => { r.logs.splice(1, 0, { ...log("Approval", 1, 0n) }); }],
    ["extra approval", (r: StoredReceipt) => { r.logs.push(log("Approval", 5)); }],
    ["duplicated Pay", (r: StoredReceipt) => { r.logs.push(log("Pay", 5)); }],
    ["duplicated transfer", (r: StoredReceipt) => { r.logs.push(log("Transfer", 5)); }],
    ["out-of-order logs", (r: StoredReceipt) => { r.logs.reverse(); }],
    ["wrong amount", (r: StoredReceipt) => { r.logs[3] = log("Pay", 4, 101n); }],
    ["wrong transferred amount", (r: StoredReceipt) => { r.logs[2] = log("Transfer", 3, 99n); }],
    ["wrong approved amount", (r: StoredReceipt) => { r.logs[1] = log("Approval", 2, 101n); }],
    ["reorg", (r: StoredReceipt) => { r.canonical = false; }],
    ["logs omitted", (r: StoredReceipt) => { r.logsStored = false; }],
    ["removed log", (r: StoredReceipt) => { (r.logs[0] as Record<string, unknown>).removed = true; }],
    ["foreign block", (r: StoredReceipt) => { (r.logs[0] as Record<string, unknown>).blockHash = `0x${"ff".repeat(32)}`; }],
    ["foreign transaction", (r: StoredReceipt) => { (r.logs[0] as Record<string, unknown>).transactionHash = `0x${"ff".repeat(32)}`; }],
    ["foreign transaction index", (r: StoredReceipt) => { (r.logs[1] as Record<string, unknown>).transactionIndex = 1; }],
    ["trailing event data", (r: StoredReceipt) => { (r.logs[3] as Record<string, unknown>).data += "00"; }],
  ] as const)("leaves incomplete/ambiguous effects unknown: %s", (_, mutate) => {
    const r = receipt(); mutate(r);
    expect(verifyWalletV6UsdcPaymentEffects(plan(), [0, 1, 2], config, r).status).toBe("unknown");
  });
  it.each([{ approvals: [] }, { approvals: [100n] }])("verifies disjoint effects with $approvals approvals", ({ approvals }) => {
    const p = plan(approvals), events = approvals.map((v, i) => log("Approval", i, v));
    events.push(log("Transfer", approvals.length), log("Pay", approvals.length + 1));
    expect(verifyWalletV6UsdcPaymentEffects(p, indexes(p), config, receipt(events)).status).toBe("verified");
  });
  it("rejects canonical success without economic logs and reports exact reverted invocation failed", () => {
    expect(verifyWalletV6UsdcPaymentEffects(plan(), [0, 1, 2], config, receipt([])).status).toBe("unknown");
    expect(verifyWalletV6UsdcPaymentEffects(plan(), [0, 1, 2], config, { ...receipt([]), status: "reverted" }).status).toBe("failed");
  });
  it("rejects noncanonical indexed address padding instead of truncating it to a matching owner", () => {
    const r = receipt(), approval = r.logs[0] as Record<string, unknown>;
    const topics = approval.topics as Hex[];
    topics[1] = `0x01${topics[1]!.slice(4)}`;
    expect(verifyWalletV6UsdcPaymentEffects(plan(), [0, 1, 2], config, r).status).toBe("unknown");
  });
  it("rejects sparse step selections rather than skipping missing call assignments", () => {
    const sparse = new Array<number>(3); sparse[2] = 2;
    expect(recognizeWalletV6UsdcPayment(plan(), sparse, config)).toBeNull();
    expect(verifyWalletV6UsdcPaymentEffects(plan(), sparse, config, receipt()).status).toBe("unknown");
  });
  it.each(["false", 1, {}, null])("rejects malformed canonical flag %j", value => {
    const r = receipt(); (r as unknown as Record<string, unknown>).canonical = value;
    expect(verifyWalletV6UsdcPaymentEffects(plan(), [0, 1, 2], config, r).status).toBe("unknown");
  });
  it("rejects oversized sparse array descriptors before serializing their holes", () => {
    const sparse: number[] = []; sparse[4_294_967_294] = 2;
    expect(recognizeWalletV6UsdcPayment(plan(), sparse, config)).toBeNull();
  });
  it("keeps semantic receipt details bounded even when reviewed metadata reaches its limit", () => {
    const p = plan(), metadata = `0x${"ab".repeat(16_384)}` as Hex;
    p.draft.calls[2]!.data = encodeFunctionData({ abi: payAbi, functionName: "pay", args: [7n, token, 100n, beneficiary, 5n, "reviewed memo", metadata] });
    (p.draft.summary as Record<string, unknown>).metadata = metadata;
    const r = receipt(); (r.logs[3] as Record<string, unknown>).data = encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "string" }, { type: "bytes" }, { type: "address" }],
      [account, beneficiary, 100n, 0n, "reviewed memo", metadata, account]);
    const result = verifyWalletV6UsdcPaymentEffects(p, [0, 1, 2], config, r);
    expect(result.status).toBe("verified");
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(8192);
  });
  it.each([
    { field: "payer", args: [terminal, beneficiary, 100n, 0n, "reviewed memo", "0x1234", account] },
    { field: "beneficiary", args: [account, terminal, 100n, 0n, "reviewed memo", "0x1234", account] },
    { field: "caller", args: [account, beneficiary, 100n, 0n, "reviewed memo", "0x1234", terminal] },
    { field: "memo", args: [account, beneficiary, 100n, 0n, "different memo", "0x1234", account] },
    { field: "metadata", args: [account, beneficiary, 100n, 0n, "reviewed memo", "0x5678", account] },
  ])("requires exact terminal Pay $field", ({ args }) => {
    const r = receipt(); (r.logs[3] as Record<string, unknown>).data = encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "string" }, { type: "bytes" }, { type: "address" }],
      args as [Address, Address, bigint, bigint, string, Hex, Address]);
    expect(verifyWalletV6UsdcPaymentEffects(plan(), [0, 1, 2], config, r).status).toBe("unknown");
  });
  it("requires the exact project and configured event emitters", () => {
    for (const mutate of [
      (r: StoredReceipt) => { ((r.logs[3] as Record<string, unknown>).topics as Hex[])[3] = `0x${"0".repeat(63)}8`; },
      (r: StoredReceipt) => { (r.logs[3] as Record<string, unknown>).address = beneficiary; },
      (r: StoredReceipt) => { (r.logs[2] as Record<string, unknown>).address = beneficiary; },
    ]) {
      const r = receipt(); mutate(r);
      expect(verifyWalletV6UsdcPaymentEffects(plan(), [0, 1, 2], config, r).status).toBe("unknown");
    }
  });
});

describe("UserOperationService configured payment semantic routing", () => {
  // These are callback-routing tests. The observation boundary is a labeled
  // double; separate chain and actual EVM suites prove invocation and log scope.
  async function routed(mutate: (p: ReturnType<typeof plan>) => void, selected: number[], configured = true) {
    const p = plan(); mutate(p);
    const now = Date.now(), owner = accountFixture(now);
    const stored = storedFixture("payment-routing", ownerFixture(owner), bindingFixture(owner, now), now, 3); stored.draft = p.draft;
    const record = operationFixture(stored); record.chainId = 8453; record.stepIndexes = selected;
    record.state = "pending"; record.submission = { key: "routing", commitment: record.commitment, operation: record.operation, startedAt: Date.now() };
    let observation: UserOperationObservation | undefined;
    const legacy = vi.fn(async () => ({ status: "verified" as const }));
    observer.mockImplementation(async (options: ObserveUserOperationOptions) => ({ state: "confirmed", operationHash: record.operationHash,
      semantic: await options.verifySemantics!(receipt()) }));
    const deps = { policies: [{ chainId: 8453, confirmations: 1 }], now: Date.now,
      rpc: { request: async () => { throw new Error("No RPC in callback routing test"); } },
      store: { recoverable: async () => [record], observe: async (_id: string, _revision: number, value: UserOperationObservation) => {
        observation = value; return { ...record, state: value.state, observation: value };
      } }, transactionStore: { get: async () => stored },
      provider: { configuration: () => ({ providerId: record.providerId }), receipt: async () => undefined },
      manifestForPlan: () => ({ entryPoint: { address: record.entryPoint }, proxyRuntimeCodeHash: record.commitment }),
      verifyHistoricalAccount: async () => {}, semanticVerifier: { verify: legacy },
      ...(configured ? { v6UsdcPayment: config } : {}) } as unknown as UserOperationServiceDependencies;
    await new UserOperationService(deps).recoverPending(1);
    return { observation, legacy };
  }
  it("uses strict disjoint effects for a full recognized payment", async () => {
    const { observation, legacy } = await routed(() => {}, [0, 1, 2]);
    expect(observation?.semantic?.status).toBe("verified"); expect(legacy).not.toHaveBeenCalled();
  });
  it("does not downgrade a rejected summary to legacy single-step success", async () => {
    const { observation } = await routed(p => { (p.draft.summary as Record<string, unknown>).beneficiary = account; }, [2]);
    expect(observation?.semantic?.status).toBe("unknown");
  });
  it("does not downgrade a partial selection to legacy single-step success", async () => {
    const { observation } = await routed(() => {}, [2]);
    expect(observation?.semantic?.status).toBe("unknown");
  });
  it("verifies a Base pay in another token the generic way even with payments configured", async () => {
    // Only the configured token through the configured terminal is the strict domain; an ETH pay is not.
    const native = "0x000000000000000000000000000000000000EEEe" as Address;
    const eth = await routed(p => {
      p.draft.calls = [{ chainId: 8453, to: terminal, value: "100", dependsOn: [],
        data: encodeFunctionData({ abi: payAbi, functionName: "pay", args: [7n, native, 100n, beneficiary, 5n, "reviewed memo", "0x1234"] }) }] as never;
      (p.draft.summary as Record<string, unknown>).payment = { token: native, amount: "100", unit: "token-base-units" };
    }, [0]);
    expect(eth.observation?.semantic?.status).toBe("verified"); expect(eth.legacy).toHaveBeenCalledTimes(1);
    // A pay of the configured token to another terminal is not the strict domain either.
    const other = "0x5555555555555555555555555555555555555555" as Address;
    const elsewhere = await routed(p => {
      const calls = p.draft.calls.map(call => ({ ...call }));
      calls[calls.length - 1]!.to = other; p.draft.calls = calls as never;
      Object.assign(p.draft.summary as Record<string, unknown>, { terminal: other, terminalPath: [other] });
    }, [0, 1, 2]);
    expect(elsewhere.observation?.semantic?.status).toBe("unknown"); // generic multi-step uncertainty, as before payments were configured
    expect(elsewhere.legacy).toHaveBeenCalledTimes(3);
  });
  it("retains generic batch uncertainty and unconfigured legacy behavior", async () => {
    const generic = await routed(p => { p.draft.operation = "contract_calls"; }, [0, 1, 2]);
    expect(generic.observation?.semantic?.status).toBe("unknown"); expect(generic.legacy).toHaveBeenCalledTimes(3);
    const unconfigured = await routed(() => {}, [0, 1, 2], false);
    expect(unconfigured.observation?.semantic?.status).toBe("unknown"); expect(unconfigured.legacy).toHaveBeenCalledTimes(3);
  });
});

describe("UserOperationService reverted payment reasons", () => {
  // JBMultiTerminal_UnderMin(812, 900), as the terminal reverts it.
  const underMin = `0x6b2bb382${encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [812n, 900n]).slice(2)}` as Hex;
  const hash = `0x${"cd".repeat(32)}` as Hex;
  async function reverted(previous?: UserOperationObservation, blockHash: Hex = `0x${"ef".repeat(32)}`) {
    const p = plan(), now = Date.now(), owner = accountFixture(now);
    const stored = storedFixture("payment-failure", ownerFixture(owner), bindingFixture(owner, now), now, 3); stored.draft = p.draft;
    const record = operationFixture(stored); record.chainId = 8453; record.stepIndexes = [0, 1, 2];
    const callData = encodeSafe7579Execution(p.draft.calls.map(call => ({ target: call.to, value: call.value, callData: call.data })));
    record.state = "pending"; record.submission = { key: "failure", commitment: record.commitment, operation: { ...record.operation, callData }, startedAt: now };
    if (previous) record.observation = previous;
    let observation: UserOperationObservation | undefined;
    observer.mockImplementation(async (options: ObserveUserOperationOptions) => {
      const payFailure = await options.payFailure!(hash, blockHash);
      return { state: "reverted", operationHash: record.operationHash, transactionHash: hash, receipt: { ...receipt(), blockHash },
        semantic: { status: "failed" }, ...(payFailure ? { payFailure } : {}) };
    });
    const request = vi.fn(async (_chainId: number, method: string) => {
      expect(method).toBe("debug_traceTransaction");
      return { from: "0x0000000000000000000000000000000000000007", calls: [{ to: record.sender, input: callData,
        calls: [{ from: record.sender, to: terminal, error: "execution reverted", output: underMin }] }] };
    });
    const deps = { policies: [{ chainId: 8453, confirmations: 1 }], now: Date.now, rpc: { request },
      store: { recoverable: async () => [record], observe: async (_id: string, _revision: number, value: UserOperationObservation) => {
        observation = value; return { ...record, state: value.state, observation: value };
      } }, transactionStore: { get: async () => stored },
      provider: { configuration: () => ({ providerId: record.providerId }), receipt: async () => undefined },
      manifestForPlan: () => ({ entryPoint: { address: record.entryPoint }, proxyRuntimeCodeHash: record.commitment }),
      verifyHistoricalAccount: async () => {}, semanticVerifier: { verify: async () => ({ status: "verified" as const }) },
      v6UsdcPayment: config } as unknown as UserOperationServiceDependencies;
    await new UserOperationService(deps).recoverPending(1);
    return { observation, request };
  }
  it("traces a reverted payment once per block, by its operation, and keeps what it found", async () => {
    const first = await reverted();
    expect(first.observation?.payFailure).toEqual({ reason: "TERMINAL_UNDER_MIN", received: "812", minimum: "900", message: expect.any(String) });
    expect(first.request).toHaveBeenCalledTimes(1);
    const again = await reverted({ ...first.observation!, state: "confirming" });
    expect(again.observation?.payFailure).toEqual(first.observation?.payFailure);
    expect(again.request).not.toHaveBeenCalled();
    // Re-included in another block after a reorg, it is traced again.
    const reorged = await reverted({ ...first.observation!, state: "confirming" }, `0x${"12".repeat(32)}`);
    expect(reorged.request).toHaveBeenCalledTimes(1);
  });
});
