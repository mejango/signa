import { NATIVE_TOKEN, jbMultiTerminalAbi } from "@bananapus/nana-sdk-core";
import { encodeFunctionData, erc20Abi, type Address } from "viem";
import { describe, expect, it, vi } from "vitest";
import { CENTER_DRAFT_OPERATIONS, createSignaProtocol, validateCenterDraft } from "../src/signaProtocol.js";
import type { RestBlockEvidence, RestPlanDraft } from "../src/rest/core.js";
import { getContractCatalog } from "../src/rest/contracts/catalog.js";

const account = `0x${"11".repeat(20)}` as Address;
const beneficiary = `0x${"22".repeat(20)}` as Address;
const token = `0x${"33".repeat(20)}` as Address;
const terminal = `0x${"44".repeat(20)}` as Address;
const at: RestBlockEvidence = { chainId: 8453, blockNumber: "123", blockHash: `0x${"55".repeat(32)}`, timestamp: "1800000000", source: "onchain" };
const input = () => ({ project: { chainId: 8453, projectId: "7", version: 6 as const }, account, token, amount: "100", beneficiary });
function payment(overrides: Partial<ReturnType<typeof input>> = {}): RestPlanDraft {
  const requested = { ...input(), ...overrides };
  return {
    operation: "pay", account, project: requested.project,
    calls: [{ chainId: 8453, to: terminal,
      data: encodeFunctionData({ abi: jbMultiTerminalAbi, functionName: "pay", args: [7n, requested.token, 100n, requested.beneficiary, 90n, "", "0x"] }),
      value: requested.token === NATIVE_TOKEN ? "100" : "0", label: "Pay", dependsOn: [], decoded: {} }],
    evidence: [structuredClone(at)], summary: {}, warnings: [],
  };
}
function approval(value: bigint, dependsOn: number[] = []) {
  return { chainId: 8453, to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [terminal, value] }),
    value: "0", label: "Approve", dependsOn, decoded: {} };
}
const fetchResponse = (value: unknown, status = 200) => vi.fn<typeof fetch>().mockResolvedValue(Response.json(value, { status }));

describe("Signa protocol dependency boundary", () => {
  it("loads reviewed transaction descriptors locally without contacting Center", () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const operations = createSignaProtocol({ fetch });
    expect(operations.list().length).toBeGreaterThan(15);
    for (const entry of operations.list()) {
      expect(entry.transaction).toBe(true);
      expect(entry.effects.externalMutation).toBe(false);
      expect(CENTER_DRAFT_OPERATIONS[entry.id]).toBeDefined();
    }
    const modified = operations.list()[0]!;
    modified.id = "tampered";
    expect(operations.list()[0]!.id).not.toBe("tampered");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends only unsigned preparation input to the fixed Center endpoint", async () => {
    const draft = payment();
    const fetch = fetchResponse({ data: draft });
    await expect(createSignaProtocol({ fetch }).prepare("prepare_pay", input(), { at })).resolves.toEqual(draft);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://juicebox.center/api/v1/plans");
    expect(init).toMatchObject({ method: "POST", redirect: "error", credentials: "omit", cache: "no-store" });
    expect(init?.headers).toEqual({ "content-type": "application/json", accept: "application/json" });
    expect(JSON.parse(init!.body as string)).toEqual({ operation: "prepare_pay", input: input(), at });
  });

  it.each([
    ["prepare_buyback_pool", "setPoolFor"], ["prepare_router_terminal", "setTerminalFor"],
    ["prepare_ruleset_change", "ruleset-change"], ["prepare_cash_out", "cash_out"],
  ])("accepts %s's reviewed action name and does not forward unsupported exact heads", async (operation, name) => {
    const draft = { ...payment(), operation: name };
    const fetch = fetchResponse({ data: draft });
    await expect(createSignaProtocol({ fetch }).prepare(operation, input(), { at })).resolves.toEqual(draft);
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).not.toHaveProperty("at");
  });

  it("preserves the exact input snapshot across the Center request", async () => {
    const requested = input();
    let release!: (response: Response) => void;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const promise = createSignaProtocol({ fetch }).prepare("prepare_pay", requested);
    requested.beneficiary = account;
    release(Response.json({ data: payment() }));
    await expect(promise).resolves.toEqual(payment());
  });

  it.each([
    ["account", (draft: RestPlanDraft) => { draft.account = beneficiary; }],
    ["operation", (draft: RestPlanDraft) => { draft.operation = "payout"; }],
    ["project", (draft: RestPlanDraft) => { draft.project!.projectId = "8"; }],
    ["chain", (draft: RestPlanDraft) => { draft.calls[0]!.chainId = 1; draft.evidence[0]!.chainId = 1; }],
    ["block", (draft: RestPlanDraft) => { draft.evidence[0]!.blockHash = `0x${"66".repeat(32)}`; }],
    ["extra evidence", (draft: RestPlanDraft) => { draft.evidence.push({ ...at, chainId: 1 }); }],
    ["forward dependency", (draft: RestPlanDraft) => { draft.calls[0]!.dependsOn = [0]; }],
    ["invalid integer", (draft: RestPlanDraft) => { draft.calls[0]!.value = "not-an-integer"; }],
  ])("rejects a substituted %s", async (_label, mutate) => {
    const draft = payment(); mutate(draft);
    await expect(createSignaProtocol({ fetch: fetchResponse({ data: draft }) }).prepare("prepare_pay", input(), { at }))
      .rejects.toMatchObject({ code: "PROTOCOL_RESPONSE_INVALID" });
  });

  it("checks payment calldata, native value, and exact approval prefixes rather than labels", () => {
    expect(validateCenterDraft(payment(), "prepare_pay", input())).toEqual(payment());
    expect(validateCenterDraft(payment({ token: NATIVE_TOKEN }), "prepare_pay", inputWithNative())).toEqual(payment({ token: NATIVE_TOKEN }));
    const reset = payment(); reset.calls[0]!.dependsOn = [1]; reset.calls.unshift(approval(0n), approval(100n, [0]));
    expect(validateCenterDraft(reset, "prepare_pay", input())).toEqual(reset);
    const maliciousApproval = structuredClone(reset);
    maliciousApproval.calls[1] = approval(2n ** 256n - 1n, [0]);
    expect(() => validateCenterDraft(maliciousApproval, "prepare_pay", input())).toThrowError(/does not match/);
    const substituted = payment({ beneficiary: account });
    substituted.summary = { beneficiary };
    expect(() => validateCenterDraft(substituted, "prepare_pay", input())).toThrowError(/does not match/);
    const wrongValue = payment(); wrongValue.calls[0]!.value = "100";
    expect(() => validateCenterDraft(wrongValue, "prepare_pay", input())).toThrowError(/does not match/);
    expect(() => validateCenterDraft(payment(), "prepare_pay", { ...input(), minReturnedTokens: "99" })).toThrowError(/does not match/);
    expect(() => validateCenterDraft(payment(), "prepare_pay", { ...input(), metadata: "0x1234" })).toThrowError(/does not match/);
  });

  it("binds generic call fields and ABI-encoded arguments without trusting decoded display arguments", async () => {
    const catalog = await getContractCatalog();
    const controller = catalog.list({}).find(contract => contract.name === "JBController")!;
    const variant = catalog.variant(controller.id);
    const address = controller.deployments.find(chain => chain.chainId === 8453)!.instances.find(deployment => !deployment.retired)!.address;
    const requested = { account, calls: [{ chainId: 8453, contractId: controller.id, address, function: "setUriOf(uint256,string)", args: ["7", "ipfs://reviewed"] }] };
    const draft: RestPlanDraft = { operation: "protocol-contract-calls", account, evidence: [at], summary: {}, warnings: [], calls: [{
      chainId: 8453, to: address, value: "0", dependsOn: [], label: "Set URI",
      data: encodeFunctionData({ abi: variant.abi, functionName: "setUriOf", args: [7n, "ipfs://reviewed"] }),
      decoded: { contractId: controller.id, abiHash: variant.abiHash, function: "setUriOf(uint256,string)", args: ["7", "ipfs://reviewed"] },
    }] };
    const fetch = fetchResponse({ data: draft });
    await expect(createSignaProtocol({ fetch }).prepare("contract_calls", requested, { at })).resolves.toEqual(draft);
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).not.toHaveProperty("at");
    const mutations = [
      (d: RestPlanDraft) => { d.calls[0]!.to = beneficiary; },
      (d: RestPlanDraft) => { d.calls[0]!.value = "1"; },
      (d: RestPlanDraft) => { d.calls[0]!.data = encodeFunctionData({ abi: variant.abi, functionName: "setUriOf", args: [7n, "ipfs://substituted"] }); },
      (d: RestPlanDraft) => { d.calls.push({ ...d.calls[0]! }); },
      (d: RestPlanDraft) => { d.calls[0]!.chainId = 1; d.evidence = [{ ...at, chainId: 1 }]; },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(draft); mutate(changed);
      await expect(createSignaProtocol({ fetch: fetchResponse({ data: changed }) }).prepare("contract_calls", requested))
        .rejects.toMatchObject({ code: "PROTOCOL_RESPONSE_INVALID" });
    }
  });

  it("retains actionable Center validation refusals while hiding server failures", async () => {
    const refusal = { status: 400, code: "PAY_DEFAULT_MINIMUM_ABOVE_FILL", detail: "Choose an explicit minimum.", details: { refusal: { suggestedMinReturnedTokens: "90" } } };
    await expect(createSignaProtocol({ fetch: fetchResponse(refusal, 400) }).prepare("prepare_pay", input()))
      .rejects.toMatchObject({ status: 400, code: refusal.code, message: refusal.detail, details: refusal.details });
    await expect(createSignaProtocol({ fetch: fetchResponse({ ...refusal, status: 500, detail: "private implementation details" }, 500) }).prepare("prepare_pay", input()))
      .rejects.toMatchObject({ status: 503, code: "PROTOCOL_UNAVAILABLE" });
  });

  it.each([
    ["extra envelope fields", () => Response.json({ data: payment(), authorization: "approved" })],
    ["oversized response", () => new Response('"' + "x".repeat(1_048_576) + '"', { headers: { "content-type": "application/json" } })],
    ["deep JSON", () => new Response('{"data":' + "[".repeat(40) + "0" + "]".repeat(40) + "}", { headers: { "content-type": "application/json" } })],
    ["reserved keys", () => new Response('{"data":{"__proto__":{}}}', { headers: { "content-type": "application/json" } })],
    ["unsafe integers", () => Response.json({ data: payment(), value: Number.MAX_SAFE_INTEGER + 1 })],
    ["wrong content type", () => new Response(JSON.stringify({ data: payment() }), { headers: { "content-type": "text/html" } })],
    ["invalid UTF8", () => new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } })],
  ])("rejects %s", async (_label, response) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    await expect(createSignaProtocol({ fetch }).prepare("prepare_pay", input())).rejects.toMatchObject({ code: "PROTOCOL_RESPONSE_INVALID" });
  });

  it("aborts an idle response body even when the fetch adapter ignores cancellation", async () => {
    const controller = new AbortController();
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(new TextEncoder().encode('{"data":')); }, cancel: cancelled });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body, { headers: { "content-type": "application/json" } }));
    const prepared = createSignaProtocol({ fetch }).prepare("prepare_pay", input(), { signal: controller.signal });
    const rejected = expect(prepared).rejects.toMatchObject({ code: "PROTOCOL_UNAVAILABLE" });
    await vi.waitFor(() => expect(body.locked).toBe(true));
    controller.abort();
    await rejected;
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("fails network errors without a fallback endpoint or exposing credentials", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("https://private.invalid/credential"));
    await expect(createSignaProtocol({ fetch }).prepare("prepare_pay", input())).rejects.toMatchObject({ code: "PROTOCOL_UNAVAILABLE" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects unknown operations and cancelled calls before fetch", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const adapter = createSignaProtocol({ fetch });
    await expect(adapter.prepare("__proto__", input())).rejects.toMatchObject({ code: "TRANSACTION_OPERATION_NOT_FOUND" });
    await expect(adapter.prepare("prepare_pay", input(), { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "PROTOCOL_UNAVAILABLE" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

function inputWithNative() { return { ...input(), token: NATIVE_TOKEN }; }
