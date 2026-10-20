import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, encodeFunctionResult, erc20Abi, keccak256, parseAbi, size, sliceHex, toHex, type Address, type Hex } from "viem";
import { buildUserPayMetadata } from "@bananapus/nana-sdk-core/v6";
import { MemoryAccountStore } from "../src/rest/auth/memory.js";
import type { RestPrincipal } from "../src/rest/auth/store.js";
import { privateKeyToAccount } from "viem/accounts";
import { type RestRpc } from "../src/rest/core.js";
import { encodeSafe7579PasskeyOwnerSignature } from "../src/rest/smartAccounts/passkeySignatures.js";
import type { SmartAccountManifest } from "../src/rest/smartAccounts/types.js";
import { MemoryTransactionStore } from "../src/rest/transactions/memory.js";
import type { ActiveActorGuard } from "../src/rest/transactions/store.js";
import { TransactionService } from "../src/rest/transactions/service.js";
import { MemoryTransportReservations } from "../src/rest/transactions/transport-reservations.js";
import { ENTRY_POINT_V07_ABI } from "../src/rest/userOperations/chain.js";
import { getUserOperationHash, unpackUserOperation, userOperationCommitment } from "../src/rest/userOperations/codec.js";
import { MemoryUserOperationStore } from "../src/rest/userOperations/memory.js";
import { passkeyDummyContractSignature, passkeyDummySignature, passkeyEstimateProvider, PASSKEY_MAX_SIGNATURE_BYTES } from "../src/rest/userOperations/passkeyEstimation.js";
import { UserOperationProvider } from "../src/rest/userOperations/provider.js";
import { UserOperationService } from "../src/rest/userOperations/service.js";
import { assertPlan, retiring } from "../src/rest/userOperations/store.js";
import type { UserOperationGasEstimate, UserOperationGasPolicy, UserOperationV07 } from "../src/rest/userOperations/types.js";
import { account, binding, entryPoint, h, owner, ownerKey, plan, safe, target } from "./fixtures/user-operations.js";

const signer = "0x4444444444444444444444444444444444444444" as Address;
const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const payAbi = parseAbi(["function pay(uint256 projectId,address token,uint256 amount,address beneficiary,uint256 minReturnedTokens,string memo,bytes metadata) payable returns(uint256)"]);
const code = "0x6000" as Hex;
let now = 1_800_000_000_000;
const legacy1271 = parseAbi(["function isValidSignature(bytes data, bytes signature) view returns(bytes4)"]);
const gas: UserOperationGasPolicy = {
  id: "passkey-test", maximumCallGas: 1_000_000n, maximumVerificationGas: 1_000_000n,
  maximumPreVerificationGas: 1_000_000n, maximumPaymasterVerificationGas: 1_000_000n,
  maximumPaymasterPostOpGas: 1_000_000n, maximumFeePerGas: 100n,
  maximumPriorityFeePerGas: 100n, maximumCost: 1_000_000_000n, requirePaymaster: false,
};

// Real service, storage, codecs and EOA signatures; RPC/provider I/O is synthetic here.
// The separate pinned-Anvil suite establishes actual passkey/FCL execution compatibility.
async function fixture(options: { app?: boolean; legacy?: boolean; sponsored?: boolean; maximumPreVerificationGas?: bigint; paymentMetadata?: Hex; paymentLabel?: string; steps?: number; planLifetimeMs?: number } = {}) {
  const apiAccount = account(now, 8453);
  if (!options.legacy) { apiAccount.id = `eip155:8453:${safe}`; apiAccount.ownerAddress = safe; }
  const actor = owner(apiAccount), wallet = binding(apiAccount, now);
  wallet.wallet.chainId = wallet.state.chainId = wallet.state.evidence.chainId = 8453;
  wallet.state.evidence.blockHash = h("passkey-block");
  wallet.state.owners = options.legacy ? [ownerKey.address] : [signer, ownerKey.address];
  // The inspection at the head records every pinned runtime it proved, the signer's included.
  if (!options.legacy) wallet.state.codeHashes = [signer, target].map((address) => ({ address, runtimeCodeHash: keccak256(code) }));
  if (!options.legacy) wallet.state.ownerProfile = {
    version: "center-passkey-v1",
    signer: { address: signer, kind: "contract", x: h("x"), y: h("y"), verifiers: toHex(99n, { size: 22 }), runtimeCodeHash: keccak256(code) },
    recoveryOwner: { address: ownerKey.address, kind: "ecdsa" },
  };
  const pin = (address: Address) => ({ address, runtimeCodeHash: keccak256(code), source: {
    repository: "https://example.test/test-only", commit: "1".repeat(40), artifactSha256: "2".repeat(64),
  } });
  const manifest: SmartAccountManifest = {
    id: wallet.manifestId, mode: "execution-candidate", chainId: 8453,
    revision: wallet.state.manifestRevision, safeVersion: "1.4.1", proxyRuntimeCodeHash: keccak256(code),
    singleton: pin(target), factory: pin(target), safe7579: pin(target), launchpad: pin(target),
    entryPoint: { ...pin(entryPoint), version: "0.7" },
    smartSessions: { ...pin(target), generation: "legacy-validator" }, policies: [], moduleInspectorId: "test-only",
    ...(!options.legacy ? { ownerProfile: { version: "center-passkey-v1" as const,
      signerFactory: pin(target), signerSingleton: pin(target), p256Verifier: pin(target) } } : {}),
  };
  const authority = new MemoryAccountStore();
  const enrolled = await authority.enroll(apiAccount, {
    accountId: apiAccount.id, signer: apiAccount.ownerAddress, grantId: null,
    nonce: h("enroll"), issuedAt: now / 1000, expiresAt: now / 1000 + 60,
    idempotencyKey: null, requiredScopes: [], ownerOnly: true, now: now / 1000,
  });
  const requestKey = privateKeyToAccount(`0x${"44".repeat(32)}`);
  const grantId = "11111111-1111-4111-8111-111111111111";
  const principal: RestPrincipal = options.app ? { ...enrolled, kind: "wallet-app",
    principalId: `app:${grantId}:9007199254740993`, grantId, isOwner: false, signer: requestKey.address,
    walletApp: { origin: "https://beep.biz", audience: "https://juicebox.center", incarnation: "9007199254740993" },
  } : enrolled;
  actor.principalId = principal.principalId;
  // App authority requires PostgreSQL and is independently tested there. This isolated service
  // fixture admits only its exact actor so the real owner-signature/operation boundary is exercised.
  const actorGuard: ActiveActorGuard = options.app ? { async withActiveActor(actual, _scopes, _clock, work) {
    expect(actual).toEqual(actor); return work();
  } } : authority;
  const transports = new MemoryTransportReservations();
  const transactionStore = new MemoryTransactionStore(actorGuard, transports);
  const preparedPlan = plan("passkey-plan", actor, wallet, now, options.steps);
  if (options.planLifetimeMs) preparedPlan.expiresAt = now + options.planLifetimeMs;
  preparedPlan.smartAccount!.chainId = 8453;
  for (const call of preparedPlan.draft.calls) call.chainId = 8453;
  if (options.paymentMetadata !== undefined) {
    // A full Base USDC pay through the reviewed terminal: exact approval, then pay.
    const project = { chainId: 8453, projectId: "7", version: 6 as const };
    preparedPlan.draft = { operation: options.paymentLabel ?? "pay", account: safe, project, evidence: [], warnings: [], calls: [
      { chainId: 8453, to: usdc, value: "0", label: "Approve", dependsOn: [], decoded: {},
        data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [target, 1_000_000n] }) },
      { chainId: 8453, to: target, value: "0", label: "Pay", dependsOn: [0], decoded: {},
        data: encodeFunctionData({ abi: payAbi, functionName: "pay", args: [7n, usdc, 1_000_000n, safe, 5n, "", options.paymentMetadata] }) },
    ], summary: { operation: "pay", project, account: safe, terminal: target, terminalPath: [target], routerGateway: null, route: "multi-terminal",
      payment: { token: usdc, amount: "1000000", unit: "token-base-units" }, beneficiary: safe, minimumBeneficiaryTokenCount: "5", metadata: options.paymentMetadata } };
    preparedPlan.steps = [{ index: 0, state: "waiting" }, { index: 1, state: "waiting" }];
  }
  await transactionStore.create(preparedPlan, { key: "plan", requestHash: h("plan"), operation: "fixture" }, now);
  const store = new MemoryUserOperationStore(actorGuard, transports, {
    now: () => now, assertBindingAndSession: (record, clock) => assertPlan(record, preparedPlan, clock * 1000),
  });
  const state = {
    contractResult: encodeFunctionResult({ abi: legacy1271, functionName: "isValidSignature", result: "0x20c13b0b" }) as unknown,
    contractFailure: false, runtimeFailure: false, reorg: false, preflightFailure: false, bindingFailure: false,
    estimateFailure: false, sends: 0, sendFailure: false, finalQuotes: 0, growth: false, growAlways: false,
    estimateTimeout: false, signedEstimate: undefined as Partial<UserOperationGasEstimate> | undefined,
    bundlerFees: null as { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex } | null, bundlerDown: false,
    estimated: [] as UserOperationV07[], sent: undefined as UserOperationV07 | undefined,
    baseFee: "0x0" as Hex, finalGasBump: false, nonce: 0n, headLagSeconds: 0,
  };
  const rpcDefault: RestRpc["request"] = async (_chain, method, params) => {
    if (method === "eth_chainId") return toHex(8453);
    if (method === "eth_getBlockByNumber") return { number: "0x64", hash: state.reorg ? h("reorg") : h("passkey-block"), timestamp: toHex(Math.floor(now / 1000) - state.headLagSeconds), baseFeePerGas: state.baseFee };
    if (method === "eth_maxPriorityFeePerGas") return "0x1";
    if (method === "eth_getCode") return state.runtimeFailure && params[0] === signer ? "0x6001" : code;
    if (method === "eth_getBalance") return toHex(10n ** 18n);
    if (method === "eth_call") {
      const call = params[0] as { to: Address; data: Hex };
      if (call.to.toLowerCase() === signer) {
        if (state.contractFailure) throw Error("unavailable");
        return state.contractResult;
      }
      if (call.to.toLowerCase() === safe) return "0x";
      const decoded = decodeFunctionData({ abi: ENTRY_POINT_V07_ABI, data: call.data });
      // Key zero follows `state.nonce`; any other key stays at its first sequence.
      if (decoded.functionName === "getNonce") return toHex(decoded.args[1] === 0n ? state.nonce : decoded.args[1] << 64n, { size: 32 });
      if (decoded.functionName === "getUserOpHash") return getUserOperationHash(unpackUserOperation(decoded.args[0]), entryPoint, 8453);
      if (decoded.functionName === "balanceOf") return toHex(10n ** 18n, { size: 32 });
      if (decoded.functionName === "entryPoint") return encodeFunctionResult({ abi: ENTRY_POINT_V07_ABI, functionName: "entryPoint", result: entryPoint });
      if (decoded.functionName === "validatePaymasterUserOp") return encodeFunctionResult({ abi: ENTRY_POINT_V07_ABI, functionName: "validatePaymasterUserOp", result: ["0x", 0n] });
      if (decoded.functionName === "handleOps" && state.preflightFailure) throw Error("validation failed");
      return "0x";
    }
    throw Error(`unexpected RPC ${method}`);
  };
  const rpc = vi.fn<RestRpc["request"]>(rpcDefault);
  const paymaster = "0x000000000000000000000000000000000000006a" as Address;
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    let result: unknown;
    if (request.method === "eth_chainId") result = toHex(8453);
    else if (request.method === "eth_supportedEntryPoints") result = [entryPoint];
    else if (request.method === "eth_estimateUserOperationGas") {
      state.estimated.push(structuredClone(request.params[0]));
      if (state.estimateTimeout) return new Promise<Response>(() => {});
      if (state.estimateFailure) return Response.json({ jsonrpc: "2.0", id: request.id, error: { code: -32500, message: "GS024" } });
      result = { callGasLimit: "0x186a0", verificationGasLimit: "0xc3500",
        preVerificationGas: toHex(state.growAlways ? 100_000n * BigInt(1 + state.finalQuotes) : state.growth && state.finalQuotes > 0 ? 60_000n : 50_000n),
        ...state.signedEstimate };
    } else if (request.method === "pm_getPaymasterStubData" || request.method === "pm_getPaymasterData") {
      if (request.method === "pm_getPaymasterData") state.finalQuotes++;
      result = { paymaster, paymasterData: toHex(0x1234 + state.finalQuotes, { size: 2 }),
        paymasterVerificationGasLimit: request.method === "pm_getPaymasterData" && state.finalGasBump ? "0x65" : "0x64", paymasterPostOpGasLimit: "0x0" };
    } else if (request.method === "eth_sendUserOperation") {
      state.sends++; state.sent = request.params[0];
      if (state.sendFailure) throw Error("lost response after provider acceptance");
      result = getUserOperationHash(state.sent!, entryPoint, 8453);
    } else if (request.method === "eth_getUserOperationReceipt") result = null;
    else if (request.method === "pimlico_getUserOperationGasPrice") {
      if (state.bundlerDown) return new Response("", { status: 503 });
      if (state.bundlerFees === null) return Response.json({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
      const lower = { maxFeePerGas: "0x2", maxPriorityFeePerGas: "0x2" };
      result = { slow: lower, standard: lower, fast: state.bundlerFees };
    } else throw Error(`unexpected provider ${request.method}`);
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  });
  const provider = new UserOperationProvider([{
    chainId: 8453, providerId: "passkey-provider", entryPoint: pin(entryPoint), bundlerUrl: "https://bundler.example.test/rpc",
    ...(options.sponsored ? { paymasterUrl: "https://paymaster.example.test/rpc", paymasterPolicy: {
      id: "fixture-policy", profile: "pimlico-v7-current-flags" as const, contract: pin(paymaster), context: {},
      inspect: () => ({ policyId: "fixture-policy", gasOnly: true as const, validAfter: 0, validUntil: now / 1000 + 1000, commitment: h("sponsor") }),
    } } : {}),
  }], fetcher, 1000, () => now);
  const currentBinding = vi.fn(async () => wallet);
  // A signer runtime the inspection could not prove is absent from the state; the verifier reads it.
  const currentBindingAt = vi.fn(async () => { if (state.bindingFailure) throw Error("binding changed");
    return state.runtimeFailure ? { ...wallet, state: { ...wallet.state, codeHashes: [] } } : wallet; });
  let service: UserOperationService;
  const transactions = new TransactionService({ store: transactionStore, rpc: { request: rpc }, now: () => now,
    externalObservers: [{ kind: "erc4337", observePlanStep: (plan, index, bindingId, request) => service.observePlanStep(plan, index, bindingId, request) }] });
  service = new UserOperationService({
    rpc: { request: rpc }, provider, store, transactionStore, transactions,
    policies: [{ chainId: 8453, gas: { ...gas,
      ...(options.maximumPreVerificationGas !== undefined ? { maximumPreVerificationGas: options.maximumPreVerificationGas } : {}),
    }, confirmations: 1 }],
    currentBinding, currentBindingAt, manifestFor: () => manifest, manifestForPlan: () => manifest,
    verifyHistoricalAccount: async () => {}, semanticVerifier: { verify: async () => ({ status: "verified" }) },
    now: () => now, authorizeRequest: async () => ({ issuedAt: now / 1000, expiresAt: now / 1000 + 60 }),
    ...(options.paymentMetadata !== undefined ? { v6UsdcPayment: { chainId: 8453 as const, token: usdc, directV6Terminal: target } } : {}),
  });
  const prepare = (extra = {}) => service.prepare(principal, { planId: preparedPlan.id, stepIndexes: options.paymentMetadata !== undefined ? [0, 1] : [0], ...extra }, "prepare", h("prepare"));
  const signature = (view: Awaited<ReturnType<typeof prepare>>, body: Hex = "0x1234") => encodeSafe7579PasskeyOwnerSignature({
    validAfter: String(view.createdAt / 1000), validUntil: String(view.expiresAt / 1000), signatures: [{ kind: "contract", owner: signer, signature: body }],
  });
  return { service, prepare, signature, state, wallet, manifest, principal, rpc, rpcDefault, provider, fetcher, currentBinding, currentBindingAt, store, actor, requestKey, preparedPlan, transactionStore, transactions };
}

describe("app UserOperation owner boundary", () => {
  const ownerSignature = async (view: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["prepare"]>>, key = ownerKey) =>
    encodeSafe7579PasskeyOwnerSignature({ validAfter: String(view.createdAt / 1000), validUntil: String(view.expiresAt / 1000),
      signatures: [{ kind: "ecdsa", owner: ownerKey.address, signature: await key.sign({ hash: view.signing.digest }) }] });

  it("allows the app to publish a separately signed exact Base owner operation", async () => {
    const f = await fixture({ app: true }), view = await f.prepare();
    f.currentBinding.mockClear(); f.currentBindingAt.mockClear();
    expect((await f.service.submit(f.principal, view.id, await ownerSignature(view), "submit")).state).toBe("pending");
    // One account verification per submission, at the block the preflight simulates against.
    expect(f.currentBinding).not.toHaveBeenCalled();
    expect(f.currentBindingAt).toHaveBeenCalledTimes(1);
    expect((f.currentBindingAt.mock.calls[0] as unknown[])[2]).toMatchObject({ blockHash: h("passkey-block") });
    expect(f.state.sends).toBe(1);
  });

  it("ends a published operation the chain never included once its validity has passed", async () => {
    const started = now;
    try {
      const f = await fixture({ app: true }), view = await f.prepare();
      const submitted = await f.service.submit(f.principal, view.id, await ownerSignature(view), "submit");
      expect(submitted.state).toBe("pending");
      now = view.expiresAt + 60_000;
      expect((await f.service.get(f.principal, view.id)).state).toBe("pending");
      now = view.expiresAt + 121_000;
      const ended = await f.service.get(f.principal, view.id);
      expect(ended.state).toBe("expired");
      expect(ended.observation?.transactionHash).toBeUndefined();
      // Final: recovery no longer polls it, and a later read keeps the verdict.
      expect((await f.service.recoverPending()).items).toEqual([]);
      expect((await f.service.get(f.principal, view.id)).state).toBe("expired");
      // The plan that carried it settles too: its step is failed, still claimed, and out of recovery.
      const plan = await f.transactions.getPlan(f.actor, f.preparedPlan.id);
      expect(plan.steps[0]).toMatchObject({ state: "reverted", semantic: { status: "failed" } });
      expect(plan.status).toBe("blocked");
      expect((await f.transactions.recoverPending()).reconciled).toEqual([]);
    } finally {
      now = started;
    }
  });
  it("rejects the app request key as spending authorization before claim or send", async () => {
    const f = await fixture({ app: true }), view = await f.prepare();
    await expect(f.service.submit(f.principal, view.id, await ownerSignature(view, f.requestKey), "submit"))
      .rejects.toMatchObject({ code: "SMART_OWNER_SIGNATURE_INVALID" });
    expect((await f.store.get(f.actor, view.id))!.submission).toBeUndefined();
    expect(f.state.sends).toBe(0);
  });

  it("rejects app session selection before any cached preparation lookup", async () => {
    const f = await fixture({ app: true }); await f.prepare();
    const lookup = vi.spyOn(f.store, "find");
    await expect(f.prepare({ sessionId: "22222222-2222-4222-8222-222222222222" }))
      .rejects.toMatchObject({ code: "USER_OPERATION_APP_SESSION_UNAVAILABLE" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each(["session", "chain"])("rejects cached app preparation and reads with unsupported %s authority", async variant => {
    const f = await fixture({ app: true }), view = await f.prepare();
    const record = (await f.store.get(f.actor, view.id))!;
    if (variant === "session") record.session = {} as NonNullable<typeof record.session>;
    else record.chainId = 1;
    vi.spyOn(f.store, "find").mockResolvedValue(record);
    vi.spyOn(f.store, "get").mockResolvedValue(record);
    await expect(f.prepare()).rejects.toMatchObject({ code: variant === "session" ? "USER_OPERATION_APP_SESSION_UNAVAILABLE" : "USER_OPERATION_APP_CHAIN_UNAVAILABLE" });
    await expect(f.service.get(f.principal, view.id)).rejects.toMatchObject({ code: variant === "session" ? "USER_OPERATION_APP_SESSION_UNAVAILABLE" : "USER_OPERATION_APP_CHAIN_UNAVAILABLE" });
    expect(f.state.sends).toBe(0);
  });

  it.each(["session", "chain"])("rejects cached app submission retries with unsupported %s authority", async variant => {
    const f = await fixture({ app: true }), view = await f.prepare(), signature = await ownerSignature(view);
    await f.service.submit(f.principal, view.id, signature, "submit");
    const record = (await f.store.get(f.actor, view.id))!;
    if (variant === "session") record.session = {} as NonNullable<typeof record.session>;
    else record.chainId = 1;
    vi.spyOn(f.store, "get").mockResolvedValue(record);
    await expect(f.service.submit(f.principal, view.id, signature, "submit"))
      .rejects.toMatchObject({ code: variant === "session" ? "USER_OPERATION_APP_SESSION_UNAVAILABLE" : "USER_OPERATION_APP_CHAIN_UNAVAILABLE" });
    expect(f.state.sends).toBe(1);
  });

  it("prepares a passkey pay with any Juicebox hook metadata, whatever its buyback minimum", async () => {
    // A minimum above the terminal's covers the swap and leftover mint before the reserved split.
    for (const metadata of ["0x", buildUserPayMetadata({ chainId: 8453, minimumSwapAmountOut: 5n }),
      buildUserPayMetadata({ chainId: 8453, minimumSwapAmountOut: 6n, skipSplits: false }),
      buildUserPayMetadata({ chainId: 8453, minimumSwapAmountOut: 5n, tiers: { metadataIdTarget: usdc, tierIdsToMint: [3n] } })] as Hex[])
      expect((await (await fixture({ paymentMetadata: metadata })).prepare()).state).toBe("prepared");
    for (const options of [{ paymentMetadata: "0x1234" as Hex }, { paymentMetadata: "0x1234" as Hex, paymentLabel: "contract_calls" }])
      await expect((await fixture(options)).prepare()).rejects.toMatchObject({ code: "USER_OPERATION_PAYMENT_METADATA_UNSUPPORTED" });
  });

  it("says why a refused payment would revert, when the calls simulated from the account say", async () => {
    // JBMultiTerminal_UnderMin(812, 900), as the terminal reverts it.
    const underMin = `0x6b2bb382${encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [812n, 900n]).slice(2)}` as Hex;
    const payFailure = { reason: "TERMINAL_UNDER_MIN", received: "812", minimum: "900", message: expect.any(String) };
    const simulating = (f: Awaited<ReturnType<typeof fixture>>) => f.rpc.mockImplementation(async (chain, method, params, signal) =>
      method === "eth_simulateV1" ? [{ calls: [{ status: "0x1", returnData: "0x" }, { status: "0x0", returnData: underMin }] }]
        : f.rpcDefault(chain, method, params, signal));
    // The bundler refuses to estimate it.
    const refused = await fixture({ paymentMetadata: "0x" });
    refused.state.estimateFailure = true;
    simulating(refused);
    await expect(refused.prepare()).rejects.toMatchObject({ code: "USER_OPERATION_PROVIDER_REJECTED", details: { payFailure } });
    // The chain's simulation of the signed calls refuses it at submission.
    const f = await fixture({ app: true, paymentMetadata: "0x" }), view = await f.prepare();
    simulating(f);
    const inner = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation(async (chain, method, params, signal) => method === "eth_call" && (params[0] as { to: string }).to.toLowerCase() === safe
      ? Promise.reject(new Error("execution reverted")) : inner(chain, method, params, signal));
    const signature = encodeSafe7579PasskeyOwnerSignature({ validAfter: String(view.createdAt / 1000), validUntil: String(view.expiresAt / 1000),
      signatures: [{ kind: "ecdsa", owner: ownerKey.address, signature: await ownerKey.sign({ hash: view.signing.digest }) }] });
    await expect(f.service.submit(f.principal, view.id, signature, "submit"))
      .rejects.toMatchObject({ code: "USER_OPERATION_RPC_UNAVAILABLE", details: { payFailure } });
    expect(f.state.sends).toBe(0);
    // An operation that pays nothing is never simulated for a reason.
    const other = await fixture();
    other.state.estimateFailure = true;
    await expect(other.prepare()).rejects.toMatchObject({ code: "USER_OPERATION_PROVIDER_REJECTED" });
    expect(other.rpc.mock.calls.some(([, method]) => method === "eth_simulateV1")).toBe(false);
  });

  it("rejects a non-Base app plan before account/provider work", async () => {
    const f = await fixture({ app: true });
    // Stored plans are immutable in production; return an unsupported plan at the service boundary.
    f.preparedPlan.smartAccount!.chainId = 1;
    vi.spyOn(f.transactionStore, "get").mockResolvedValue(f.preparedPlan);
    await expect(f.prepare()).rejects.toMatchObject({ code: "USER_OPERATION_APP_CHAIN_UNAVAILABLE" });
    expect(f.rpc).not.toHaveBeenCalled(); expect(f.state.sends).toBe(0);
  });
});

describe("passkey UserOperation estimation", () => {
  it("uses the maximum accepted real WebAuthn shape and nonzero in-range FCL scalars", async () => {
    const maximum = JSON.parse(await readFile(new URL("./fixtures/wallet/passkey-assertion-max.json", import.meta.url), "utf8"));
    const body = passkeyDummyContractSignature();
    expect(body).toBe(maximum.contractSignature);
    expect(size(body)).toBe(2240);
    const [auth, fields, r, s] = decodeAbiParameters([{ type: "bytes" }, { type: "string" }, { type: "uint256" }, { type: "uint256" }], body);
    expect(size(auth)).toBe(37); expect(Buffer.byteLength(fields)).toBe(1966);
    expect(BigInt(sliceHex(auth, 32, 33)) & 4n).toBe(4n);
    const n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
    expect(r > 0n && r < n && s > 0n && s < n).toBe(true);
    expect(size(passkeyDummySignature({ signer, validAfter: "1", validUntil: "2" }))).toBe(PASSKEY_MAX_SIGNATURE_BYTES);
  });

  it("never prices an operation below the bundler's own fee floor, and keeps the node's fees when the bundler has none", async () => {
    // The node's priority fee is 0x1 and the base fee 0x0; the bundler will not include below its floor.
    const f = await fixture({});
    f.state.bundlerFees = { maxFeePerGas: "0x9", maxPriorityFeePerGas: "0x5" };
    const floored = await f.prepare();
    expect([floored.operation.maxPriorityFeePerGas, floored.operation.maxFeePerGas]).toEqual(["0x5", "0x9"]);
    // The node's own quote wins when it is higher.
    f.rpc.mockImplementation(async (_chain, method, params) => method === "eth_maxPriorityFeePerGas" ? "0x7" : f.rpcDefault(_chain, method, params));
    const above = await f.service.prepare(f.principal, { planId: f.preparedPlan.id, stepIndexes: [0] }, "prepare-again", h("prepare-again"));
    expect([above.operation.maxPriorityFeePerGas, above.operation.maxFeePerGas]).toEqual(["0x7", "0x9"]);
    // A bundler without the method changes nothing; a bundler that cannot answer fails the preparation
    // rather than silently pricing below its floor.
    const plain = await fixture({});
    plain.state.bundlerFees = null;
    const view = await plain.prepare();
    expect(view.operation.maxPriorityFeePerGas).toBe("0x1");
    const down = await fixture({});
    down.state.bundlerDown = true;
    await expect(down.prepare()).rejects.toMatchObject({ code: "USER_OPERATION_PROVIDER_UNAVAILABLE" });
  });
  it("adds the calldata-byte margin independently to every provider estimate", async () => {
    const estimate = { callGasLimit: "0x1", verificationGasLimit: "0x1", preVerificationGas: toHex(50_000) };
    const original = { estimate: vi.fn(async () => ({ ...estimate })), sponsor: vi.fn() };
    const wrapper = passkeyEstimateProvider(original as unknown as UserOperationProvider, 1_000_000n);
    const operation = {} as UserOperationV07;
    for (let i = 0; i < 3; i++) expect(BigInt((await wrapper.estimate(8453, operation)).preVerificationGas)).toBe(50_000n + 12n * 2349n);
    expect(estimate.preVerificationGas).toBe(toHex(50_000));
  });
  it("leaves the passkey validation headroom the dummy-signature estimate cannot see, within the policy cap", async () => {
    // A production signature starved the P256 check at the bundler's exact estimate (AA24).
    const original = { estimate: vi.fn(async () => ({ callGasLimit: "0x1", verificationGasLimit: toHex(190_000), preVerificationGas: "0x1" })), sponsor: vi.fn() };
    const operation = {} as UserOperationV07;
    expect(BigInt((await passkeyEstimateProvider(original as unknown as UserOperationProvider, 1_000_000n).estimate(8453, operation)).verificationGasLimit))
      .toBe(190_000n + 95_000n + 50_000n);
    expect(BigInt((await passkeyEstimateProvider(original as unknown as UserOperationProvider, 300_000n).estimate(8453, operation)).verificationGasLimit))
      .toBe(300_000n);
    // The fixture's 800k estimate plus headroom meets the 1M policy cap.
    const f = await fixture({}), view = await f.prepare();
    expect(BigInt(view.operation.verificationGasLimit)).toBe(1_000_000n);
  });

  it("prepares the new explicit signature profile with its exact SafeOp preimage", async () => {
    const f = await fixture(), view = await f.prepare();
    expect(size(f.state.estimated[0]!.signature)).toBe(2349);
    expect(BigInt(view.operation.preVerificationGas)).toBe(50_000n + 12n * 2349n);
    expect(view.signing).toMatchObject({ ownerProfile: "center-passkey-v1" });
    expect(keccak256((view.signing as { signedData: Hex }).signedData)).toBe(view.signing.digest);
    expect(view.operation.signature).toBe("0x");
  });

  it("preserves legacy EOA preparation without dynamic signatures or margins", async () => {
    const f = await fixture({ legacy: true }), view = await f.prepare();
    expect(size(f.state.estimated[0]!.signature)).toBe(77);
    expect(view.operation.preVerificationGas).toBe(toHex(50_000));
    expect(view.signing).not.toHaveProperty("ownerProfile");
  });

  it("fails closed when the hosted provider cannot estimate the actual invalid-signature path", async () => {
    const f = await fixture(); f.state.estimateFailure = true;
    await expect(f.prepare()).rejects.toMatchObject({ code: "USER_OPERATION_PROVIDER_REJECTED" });
    expect(f.state.sends).toBe(0);
    expect(await f.store.find(f.actor, "prepare", h("prepare"))).toBeUndefined();
  });

  it("rejects a calldata margin above policy before requesting a final sponsor quote", async () => {
    const f = await fixture({ sponsored: true, maximumPreVerificationGas: 78_187n });
    await expect(f.prepare()).rejects.toMatchObject({ code: "USER_OPERATION_GAS_LIMIT" });
    expect(f.state.finalQuotes).toBe(0); expect(f.state.sends).toBe(0);
    expect(await f.store.find(f.actor, "prepare", h("prepare"))).toBeUndefined();
  });

  it("requires matching canonical state and manifest profiles", async () => {
    for (const remove of ["manifest", "state"] as const) {
      const f = await fixture();
      if (remove === "manifest") delete f.manifest.ownerProfile; else delete f.wallet.state.ownerProfile;
      await expect(f.prepare()).rejects.toMatchObject({ code: "USER_OPERATION_OWNER_PROFILE_CHANGED" });
      expect(f.state.estimated).toHaveLength(0);
    }
  });

  it("refuses delegated sessions for the pilot owner profile", async () => {
    const f = await fixture();
    await expect(f.prepare({ sessionId: "00000000-0000-0000-0000-000000000000" })).rejects.toMatchObject({ code: "USER_OPERATION_PASSKEY_SESSION_UNAVAILABLE" });
  });

  it("takes the final sponsorship without another estimate: the provider pins its size to the stub and the margins cover the bytes", async () => {
    const f = await fixture({ sponsored: true }); f.state.growth = true;
    const view = await f.prepare();
    expect(f.state.finalQuotes).toBe(1);
    expect(f.state.estimated).toHaveLength(1);
    expect(size(f.state.estimated[0]!.signature)).toBe(2349);
    expect(BigInt(view.operation.preVerificationGas)).toBe(50_000n + 12n * 2349n);
  });

  it("reads the bundler, the nonce head and the fees together, prices from the head it already holds, and keeps the paymaster stub and the EntryPoint runtime between preparations", async () => {
    const f = await fixture({ sponsored: true }); f.state.bundlerFees = { maxFeePerGas: "0x2", maxPriorityFeePerGas: "0x2" }; f.state.baseFee = "0x10";
    let releaseReadiness!: () => void;
    const readinessHeld = new Promise<void>((resolve) => { releaseReadiness = resolve; });
    const original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => {
      if (JSON.parse(String(init?.body)).method === "eth_supportedEntryPoints") await readinessHeld;
      return original(url, init);
    });
    const first = f.prepare();
    // The nonce head and the fee quotes do not wait for the bundler readiness check.
    await vi.waitFor(() => {
      expect(f.rpc.mock.calls.some(([, method]) => method === "eth_getBlockByNumber")).toBe(true);
      expect(f.rpc.mock.calls.some(([, method]) => method === "eth_maxPriorityFeePerGas")).toBe(true);
      expect(f.fetcher.mock.calls.some(([, init]) => JSON.parse(String(init?.body)).method === "pimlico_getUserOperationGasPrice")).toBe(true);
    });
    releaseReadiness();
    const view = await first;
    const calls = (method: string) => f.rpc.mock.calls.filter(([, m]) => m === method).length;
    const provider = (method: string) => f.fetcher.mock.calls.filter(([, init]) => JSON.parse(String(init?.body)).method === method).length;
    // One head read prices the operation: the head, and the final canonical recheck beside the sponsorship;
    // the pinned nonce read needs no recheck of its own.
    expect(calls("eth_getBlockByNumber")).toBe(2);
    expect(BigInt(view.operation.maxFeePerGas)).toBe(2n * 0x10n + 2n);
    expect(provider("pm_getPaymasterStubData")).toBe(1);
    const again = await f.service.prepare(f.principal, { planId: f.preparedPlan.id, stepIndexes: [0] }, "prepare-2", h("prepare-2"));
    expect(again.id).not.toBe(view.id);
    expect(provider("pm_getPaymasterStubData")).toBe(1);
    expect(provider("pm_getPaymasterData")).toBe(2);
    // A final sponsorship whose gas fields no longer match the kept stub drops it; the next preparation fetches a fresh one.
    f.state.finalGasBump = true;
    await expect(f.service.prepare(f.principal, { planId: f.preparedPlan.id, stepIndexes: [0] }, "prepare-3", h("prepare-3"))).rejects.toMatchObject({ code: "USER_OPERATION_PAYMASTER_GAS_CHANGED" });
    f.state.finalGasBump = false;
    await f.service.prepare(f.principal, { planId: f.preparedPlan.id, stepIndexes: [0] }, "prepare-4", h("prepare-4"));
    expect(provider("pm_getPaymasterStubData")).toBe(2);
    // A kept stub that stops validating is dropped and fetched again, once, within the same preparation.
    const policy = f.provider.configuration(8453).paymasterPolicy!;
    const inspect = policy.inspect; let rejected = 0;
    policy.inspect = (...args) => { if (rejected++ === 0) throw Error("stub window passed"); return inspect(...args); };
    await f.service.prepare(f.principal, { planId: f.preparedPlan.id, stepIndexes: [0] }, "prepare-5", h("prepare-5"));
    expect(provider("pm_getPaymasterStubData")).toBe(3);
    policy.inspect = inspect;
  });

  it("proves the EntryPoint runtime once per process and again after ten minutes; the account's own code is read at every head", async () => {
    const entryPointCode = (f: Awaited<ReturnType<typeof fixture>>) => f.rpc.mock.calls.filter(([, m, params]) => m === "eth_getCode" && String(params[0]).toLowerCase() === entryPoint.toLowerCase()).length;
    const accountCode = (f: Awaited<ReturnType<typeof fixture>>) => f.rpc.mock.calls.filter(([, m, params]) => m === "eth_getCode" && String(params[0]).toLowerCase() === safe).length;
    const first = await fixture(); await first.prepare();
    const second = await fixture(); await second.prepare();
    expect(entryPointCode(second)).toBe(0);
    const before = now; now += 601_000;
    try {
      const third = await fixture(); const view = await third.prepare();
      expect(entryPointCode(third)).toBe(1);
      await third.service.submit(third.principal, view.id, third.signature(view), "submit");
      expect(entryPointCode(third)).toBe(1); expect(accountCode(third)).toBe(1);
    } finally { now = before; }
  });

  it("still re-estimates and bounds sponsorship for an owner-key operation without those margins", async () => {
    const f = await fixture({ sponsored: true, legacy: true }); f.state.growAlways = true;
    await expect(f.prepare()).rejects.toMatchObject({ code: "USER_OPERATION_SPONSOR_GAS_CHANGED" });
    expect(f.state.finalQuotes).toBe(3); expect(f.state.sends).toBe(0);
  });
});

describe("passkey UserOperation owner admission", () => {
  it("calls the exact legacy bytes selector at the inspected block and preserves every approved field", async () => {
    const f = await fixture(), view = await f.prepare(), signature = f.signature(view);
    const submitted = await f.service.submit(f.principal, view.id, signature, "submit");
    expect(submitted.state).toBe("pending");
    expect(f.state.sent).toEqual({ ...view.operation, signature });
    expect(f.state.estimated).toHaveLength(2);
    expect(f.state.estimated[1]).toEqual({ ...view.operation, signature });
    expect(f.currentBindingAt).toHaveBeenCalledTimes(1);
    const call = f.rpc.mock.calls.find(([, method, params]) => method === "eth_call" && (params[0] as { to: string }).to === signer)!;
    const data = decodeFunctionData({ abi: legacy1271, data: (call[2][0] as { data: Hex }).data });
    expect(data.args).toEqual([(view.signing as { signedData: Hex }).signedData, "0x1234"]);
    expect(call[2][1]).toEqual({ blockHash: h("passkey-block"), requireCanonical: true });
    expect(BigInt((call[2][0] as { gas: Hex }).gas)).toBeLessThanOrEqual(2_000_000n);
    expect(call[3]).toBeInstanceOf(AbortSignal);
  });

  it("allows the independent recovery EOA to sign the exact same SafeOp", async () => {
    const f = await fixture(), view = await f.prepare();
    const signature = encodeSafe7579PasskeyOwnerSignature({ validAfter: String(view.createdAt / 1000), validUntil: String(view.expiresAt / 1000),
      signatures: [{ kind: "ecdsa", owner: ownerKey.address, signature: await ownerKey.sign({ hash: view.signing.digest }) }],
    });
    expect((await f.service.submit(f.principal, view.id, signature, "submit")).state).toBe("pending");
    expect(f.rpc.mock.calls.some(([, method, params]) => method === "eth_call" && (params[0] as { to: string }).to === signer)).toBe(false);
  });

  it.each([
    [false, "callGasLimit"], [false, "verificationGasLimit"], [false, "preVerificationGas"],
    [true, "callGasLimit"], [true, "verificationGasLimit"], [true, "preVerificationGas"],
    [true, "paymasterVerificationGasLimit"], [true, "paymasterPostOpGasLimit"],
  ] as const)("does not claim or change approved gas when the exact signed estimate grows: sponsored=%s %s", async (sponsored, field) => {
    const f = await fixture({ sponsored }), view = await f.prepare();
    f.state.signedEstimate = { [field]: toHex(BigInt(view.operation[field]!) + 1n) };
    await expect(f.service.submit(f.principal, view.id, f.signature(view), "submit")).rejects.toMatchObject({ code: "USER_OPERATION_SIGNED_GAS_CHANGED" });
    const stored = (await f.store.get(f.actor, view.id))!;
    expect(stored.state).toBe("prepared"); expect(stored.submission).toBeUndefined();
    expect(stored.operation).toEqual(view.operation); expect(f.state.sends).toBe(0);
  });

  it.each([false, true])("does not reserve a nonce when exact signed provider estimation rejects: sponsored=%s", async (sponsored) => {
    const f = await fixture({ sponsored }), view = await f.prepare(); f.state.estimateFailure = true;
    await expect(f.service.submit(f.principal, view.id, f.signature(view), "submit")).rejects.toMatchObject({ code: "USER_OPERATION_PROVIDER_REJECTED" });
    expect((await f.store.get(f.actor, view.id))!.submission).toBeUndefined(); expect(f.state.sends).toBe(0);
  });

  it("retains the approved bytes when the exact signed estimate times out under the existing provider deadline", async () => {
    const f = await fixture(), view = await f.prepare(); f.state.estimateTimeout = true;
    await expect(f.service.submit(f.principal, view.id, f.signature(view), "submit")).rejects.toMatchObject({ code: "USER_OPERATION_PROVIDER_TIMEOUT" });
    expect((await f.store.get(f.actor, view.id))!.submission).toBeUndefined(); expect(f.state.sends).toBe(0);
  });

  it("does not add the dummy margin a second time to the actual signed estimate", async () => {
    const f = await fixture(), view = await f.prepare();
    f.state.signedEstimate = { preVerificationGas: view.operation.preVerificationGas };
    expect((await f.service.submit(f.principal, view.id, f.signature(view), "submit")).state).toBe("pending");
    expect(f.state.sent!.preVerificationGas).toBe(view.operation.preVerificationGas);
  });

  it("submits the exact final sponsored bytes when their signed estimate fits", async () => {
    const f = await fixture({ sponsored: true }), view = await f.prepare(), signature = f.signature(view);
    expect((await f.service.submit(f.principal, view.id, signature, "submit")).state).toBe("pending");
    expect(f.state.sent).toEqual({ ...view.operation, signature });
  });

  it.each(["0x1626ba7e", `0x1626ba7e${"00".repeat(28)}`, "0x20c13b0b", `0x20c13b0b${"00".repeat(29)}`, "0x", "0x01", null, true])("rejects noncanonical contract evidence %s before admission", async (invalid) => {
    const f = await fixture(), view = await f.prepare(); f.state.contractResult = invalid;
    await expect(f.service.submit(f.principal, view.id, f.signature(view), "submit")).rejects.toMatchObject({ code: "SMART_OWNER_SIGNATURE_INVALID" });
    expect(f.state.sends).toBe(0);
    expect((await f.store.get(f.actor, view.id))!.submission).toBeUndefined();
  });

  it.each(["contractFailure", "runtimeFailure", "reorg", "preflightFailure", "bindingFailure"] as const)("never claims or sends when %s removes canonical evidence", async (failure) => {
    const f = await fixture(), view = await f.prepare(); f.state[failure] = true;
    await expect(f.service.submit(f.principal, view.id, f.signature(view), "submit")).rejects.toThrow();
    expect(f.state.sends).toBe(0);
    expect((await f.store.get(f.actor, view.id))!.submission).toBeUndefined();
  });

  it("rejects signatures beyond the approved maximum without attempting verification or gas changes", async () => {
    const f = await fixture(), view = await f.prepare();
    await expect(f.service.submit(f.principal, view.id, f.signature(view, `0x${"11".repeat(2241)}`), "submit")).rejects.toMatchObject({ code: "USER_OPERATION_PASSKEY_SIGNATURE_LIMIT" });
    expect(f.state.sends).toBe(0); expect(f.state.estimated).toHaveLength(1);
  });

  it("rejects a modified validity window before checking the contract or reserving its nonce", async () => {
    const f = await fixture(), view = await f.prepare();
    const signature = encodeSafe7579PasskeyOwnerSignature({ validAfter: String(view.createdAt / 1000), validUntil: String(view.expiresAt / 1000 + 1),
      signatures: [{ kind: "contract", owner: signer, signature: "0x1234" }],
    });
    await expect(f.service.submit(f.principal, view.id, signature, "submit")).rejects.toMatchObject({ code: "SMART_ACCOUNT_ENVELOPE_INVALID" });
    expect(f.state.sends).toBe(0);
    expect(f.rpc.mock.calls.some(([, method, params]) => method === "eth_call" && (params[0] as { to: string }).to === signer)).toBe(false);
  });

  it("an aborted contract verification never claims or sends the operation", async () => {
    const f = await fixture(), view = await f.prepare(), controller = new AbortController();
    controller.abort();
    await expect(f.service.submit(f.principal, view.id, f.signature(view), "submit", controller.signal)).rejects.toThrow();
    expect(f.state.sends).toBe(0);
    expect((await f.store.get(f.actor, view.id))!.submission).toBeUndefined();
  });

  it("verifies the account and preflights at one head together, then checks the signature and the signed bytes, ahead of the nonce claim", async () => {
    const f = await fixture(), view = await f.prepare();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    f.currentBindingAt.mockImplementationOnce(async () => { await held; return f.wallet; });
    const seen = { handleOps: 0, signer: 0 };
    f.rpc.mockImplementation(async (chain, method, params, signal) => {
      if (method === "eth_call") {
        const call = params[0] as { to: string; data: Hex };
        if (call.to.toLowerCase() === signer) seen.signer++;
        else try { if (decodeFunctionData({ abi: ENTRY_POINT_V07_ABI, data: call.data }).functionName === "handleOps") seen.handleOps++; } catch {}
      }
      return f.rpcDefault(chain, method, params, signal);
    });
    const submission = f.service.submit(f.principal, view.id, f.signature(view), "submit");
    // The EntryPoint preflight does not wait for the account inspection; the bundler only sees the
    // signed bytes, and the signer contract is only asked, once the account is verified.
    await vi.waitFor(() => expect(seen.handleOps).toBe(1));
    expect(f.state.estimated).toHaveLength(1); expect(seen.signer).toBe(0);
    expect(f.state.sends).toBe(0);
    expect((await f.store.get(f.actor, view.id))!.submission).toBeUndefined();
    release();
    expect((await submission).state).toBe("pending");
    expect(f.state.estimated).toHaveLength(2);
    // The signature is checked against the account state verified at that head; the pinned
    // signer dependencies it needs were already proven there, so it reads no runtime again.
    expect(seen.signer).toBe(1);
    expect(f.rpc.mock.calls.filter(([, method]) => method === "eth_getCode").length).toBe(f.rpc.mock.calls.filter(([, method, params]) =>
      method === "eth_getCode" && [entryPoint.toLowerCase(), safe].includes(String(params[0]).toLowerCase())).length);
  });

  it("takes the head-bound checks speculated ahead of the approval within their window, and runs them itself otherwise", async () => {
    const f = await fixture(), view = await f.prepare();
    // The fixture's one block follows the clock; here the clock moves while the block stays canonical.
    const pin = (g: typeof f, at: number) => g.rpc.mockImplementation(async (chain, method, params, signal) => method === "eth_getBlockByNumber"
      ? { number: "0x64", hash: h("passkey-block"), timestamp: toHex(at / 1000), baseFeePerGas: g.state.baseFee } : g.rpcDefault(chain, method, params, signal));
    pin(f, now);
    const handleOps = () => f.rpc.mock.calls.filter(([, method, params]) => { if (method !== "eth_call") return false;
      try { return decodeFunctionData({ abi: ENTRY_POINT_V07_ABI, data: (params[0] as { data: Hex }).data }).functionName === "handleOps"; } catch { return false; } }).length;
    // The review's creation speculates: the account and the EntryPoint preflight at one head — all but
    // the validation of the signed bytes, which needs the signature — no claim, no send; page reads
    // that arrive while it runs join it rather than starting their own.
    await Promise.all([1, 2, 3].map(() => f.service.speculate(f.actor, view.id)));
    expect(f.currentBindingAt).toHaveBeenCalledTimes(1); expect(handleOps()).toBe(0); expect(f.state.sends).toBe(0);
    expect((await f.store.get(f.actor, view.id))!.submission).toBeUndefined();
    // A page read within fifteen seconds keeps what it has; one later refreshes it.
    now += 10_000; await f.service.speculate(f.actor, view.id); expect(f.currentBindingAt).toHaveBeenCalledTimes(1);
    now += 10_000; await f.service.speculate(f.actor, view.id); expect(f.currentBindingAt).toHaveBeenCalledTimes(2);
    // The approval within a minute of it does only what needs the signature (the EntryPoint validation
    // of the signed bytes at the speculated head, the signer check, the signed estimate), then claims and sends.
    now += 30_000;
    const logs = vi.spyOn(console, "info").mockImplementation(() => {});
    expect((await f.service.submit(f.principal, view.id, f.signature(view), "submit")).state).toBe("pending");
    expect(f.currentBindingAt).toHaveBeenCalledTimes(2); expect(handleOps()).toBe(1); expect(f.state.sends).toBe(1);
    // A signature the EntryPoint rejects is refused before the claim even when the checks were carried.
    const g2 = await fixture(), rejected = await g2.prepare(); pin(g2, now);
    await g2.service.speculate(g2.actor, rejected.id); g2.state.preflightFailure = true;
    await expect(g2.service.submit(g2.principal, rejected.id, g2.signature(rejected), "submit-rejected")).rejects.toBeTruthy();
    expect(g2.state.sends).toBe(0); expect((await g2.store.get(g2.actor, rejected.id))!.submission).toBeUndefined();
    const stages = logs.mock.calls.map(([line]) => { try { return JSON.parse(String(line)); } catch { return {}; } }).find((line) => line.action === "submit_stages");
    logs.mockRestore();
    expect(stages.speculatedAgeMs).toBe(30_000); expect(stages.speculatedHead).toBeGreaterThan(0); expect(stages.headMs).toBeUndefined();
    // A sent or unknown operation is never speculated; a failure is logged, not thrown.
    await f.service.speculate(f.actor, view.id); await f.service.speculate(f.actor, "missing");
    expect(f.currentBindingAt).toHaveBeenCalledTimes(2);
    // A speculation older than a minute is dropped: the approval runs the checks itself.
    const g = await fixture(), stale = await g.prepare(); pin(g, now);
    await g.service.speculate(g.actor, stale.id); expect(g.currentBindingAt).toHaveBeenCalledTimes(1);
    now += 61_000;
    expect((await g.service.submit(g.principal, stale.id, g.signature(stale), "submit-stale")).state).toBe("pending");
    expect(g.currentBindingAt).toHaveBeenCalledTimes(2); expect(g.state.sends).toBe(1);
  });

  it("sends the same signed bytes once whichever publication key carries them", async () => {
    const f = await fixture(), view = await f.prepare(), signature = f.signature(view);
    expect((await f.service.submit(f.principal, view.id, signature, "submit-a")).state).toBe("pending");
    // The approval's own submission and the app's hand-back carry the same bytes under different keys.
    expect((await f.service.submit(f.principal, view.id, signature, "submit-b")).state).toBe("pending");
    expect(f.state.sends).toBe(1);
    expect((await f.store.get(f.actor, view.id))!.submission!.key).toBe("submit-a");
  });

  it("submits an approved review's operation on the review's own authority, with every gate before the send", async () => {
    const f = await fixture(), view = await f.prepare(), signature = f.signature(view);
    const authorizeRequest = vi.fn(async () => ({ issuedAt: now / 1000, expiresAt: now / 1000 + 60 }));
    (f.service as unknown as { options: { authorizeRequest: unknown } }).options.authorizeRequest = authorizeRequest;
    const approved = { actor: f.actor, operationId: view.id, signature, key: "review:one",
      authority: { issuedAt: now / 1000, expiresAt: now / 1000 + 300 } };
    expect((await f.service.submitApproved(approved)).state).toBe("pending");
    expect(authorizeRequest).not.toHaveBeenCalled(); expect(f.state.sends).toBe(1);
    expect(f.currentBindingAt).toHaveBeenCalledTimes(1); expect(f.state.estimated).toHaveLength(2);
    // A second approval-driven submission of the same bytes observes the first.
    expect((await f.service.submitApproved({ ...approved, key: "review:one-again" })).state).toBe("pending"); expect(f.state.sends).toBe(1);
    // Another actor's review cannot submit this operation; a different signature stays a conflict.
    await expect(f.service.submitApproved({ ...approved, actor: { ...f.actor, principalId: "app:other" } })).rejects.toMatchObject({ status: 404 });
    await expect(f.service.submitApproved({ ...approved, signature: f.signature(view, "0x5678"), key: "review:two" })).rejects.toMatchObject({ code: "USER_OPERATION_CONFLICT" });
    expect(f.state.sends).toBe(1);
  });

  it("lets a hand-back whose checks fail against the operation the approval already published observe that submission", async () => {
    const f = await fixture(), view = await f.prepare(), signature = f.signature(view);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    // The hand-back loads the record before the approval's submission lands, then waits in its account check.
    f.currentBindingAt.mockImplementationOnce(async () => { await held; return f.wallet; });
    const handBack = f.service.submit(f.principal, view.id, signature, "submit-hand-back");
    await vi.waitFor(() => expect(f.currentBindingAt).toHaveBeenCalledTimes(1));
    // The approval's submission runs on another replica: nothing in this process to join.
    (f.service as unknown as { inflight: Map<string, unknown> }).inflight.clear();
    expect((await f.service.submitApproved({ actor: f.actor, operationId: view.id, signature, key: "review:one",
      authority: { issuedAt: now / 1000, expiresAt: now / 1000 + 300 } })).state).toBe("pending");
    expect(f.state.sends).toBe(1);
    // The bundler now refuses to estimate an operation it already holds.
    f.state.estimateFailure = true; release();
    expect((await handBack).state).toBe("pending");
    expect(f.state.sends).toBe(1);
    expect((await f.store.get(f.actor, view.id))!.submission!.key).toBe("review:one");
  });

  it("joins a submission of the same bytes already in flight instead of checking twice", async () => {
    const f = await fixture(), view = await f.prepare(), signature = f.signature(view);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    f.currentBindingAt.mockImplementationOnce(async () => { await held; return f.wallet; });
    const approval = f.service.submitApproved({ actor: f.actor, operationId: view.id, signature, key: "review:one",
      authority: { issuedAt: now / 1000, expiresAt: now / 1000 + 300 } });
    await vi.waitFor(() => expect(f.currentBindingAt).toHaveBeenCalledTimes(1));
    const handBack = f.service.submit(f.principal, view.id, signature, "submit-hand-back");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.currentBindingAt).toHaveBeenCalledTimes(1);
    release();
    expect((await approval).state).toBe("pending"); expect((await handBack).state).toBe("pending");
    expect(f.state.sends).toBe(1); expect(f.currentBindingAt).toHaveBeenCalledTimes(1); expect(f.state.estimated).toHaveLength(2);
  });

  it("permits only one competing signature to claim the same prepared nonce", async () => {
    const f = await fixture(), view = await f.prepare();
    const results = await Promise.allSettled(Array.from({ length: 25 }, (_, index) =>
      f.service.submit(f.principal, view.id, f.signature(view, toHex(index + 1, { size: 2 })), `submit-${index}`)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "USER_OPERATION_CONFLICT" });
    expect(f.state.sends).toBe(1);
    expect((await f.store.get(f.actor, view.id))!.submission!.operation).toEqual(f.state.sent);
  });

  it("preserves unknown submission and forbids a second signature from taking the same nonce", async () => {
    const f = await fixture(), view = await f.prepare(); f.state.sendFailure = true;
    expect((await f.service.submit(f.principal, view.id, f.signature(view), "submit")).state).toBe("submission_unknown");
    await expect(f.service.submit(f.principal, view.id, f.signature(view, "0x5678"), "submit")).rejects.toMatchObject({ code: "USER_OPERATION_CONFLICT" });
    expect(f.state.sends).toBe(1);
  });
});

describe("retiring a refused approval", () => {
  const approvedBy = (f: Awaited<ReturnType<typeof fixture>>, view: { id: string }, signature: Hex, key: string) => f.service.submitApproved({
    actor: f.actor, operationId: view.id, signature, key, authority: { issuedAt: now / 1000, expiresAt: now / 1000 + 300 } });
  const prepareAs = (f: Awaited<ReturnType<typeof fixture>>, key: string, stepIndexes = [0]) =>
    f.service.prepare(f.principal, { planId: f.preparedPlan.id, stepIndexes }, key, h(key));

  it("never claims or sends an approval retired after its refusal, though another replica was admitting it", async () => {
    const f = await fixture(), view = await f.prepare(), signature = f.signature(view);
    f.state.estimateFailure = true;
    await expect(f.service.submit(f.principal, view.id, signature, "submit")).rejects.toMatchObject({ code: "USER_OPERATION_PROVIDER_REJECTED" });
    // The approval's own send is admitting the same bytes on another replica when the app retires them.
    f.state.estimateFailure = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    f.currentBindingAt.mockImplementationOnce(async () => { await held; return f.wallet; });
    const other = approvedBy(f, view, signature, "review:one");
    await vi.waitFor(() => expect(f.currentBindingAt).toHaveBeenCalledTimes(2));
    (f.service as unknown as { inflight: Map<string, unknown> }).inflight.clear();
    const retired = await f.service.retire(f.principal, view.id);
    expect(retired).toMatchObject({ state: "retired", revision: 1 }); expect(retired).not.toHaveProperty("submission");
    release();
    await expect(other).rejects.toMatchObject({ code: "USER_OPERATION_RETIRED" });
    // A reopened approval page or a retried hand-back is refused before any chain or bundler work.
    const reads = f.rpc.mock.calls.length, estimates = f.state.estimated.length;
    await expect(approvedBy(f, view, signature, "review:again")).rejects.toMatchObject({ code: "USER_OPERATION_RETIRED" });
    await expect(f.service.submit(f.principal, view.id, signature, "submit-again")).rejects.toMatchObject({ code: "USER_OPERATION_RETIRED" });
    expect(f.rpc.mock.calls.length).toBe(reads); expect(f.state.estimated.length).toBe(estimates);
    expect(f.state.sends).toBe(0);
    // Retiring again is the same answer.
    expect(await f.service.retire(f.principal, view.id)).toEqual(retired);
  });

  it("hands back the submission a claim already made instead of retiring it", async () => {
    const f = await fixture(), view = await f.prepare();
    expect((await f.service.submit(f.principal, view.id, f.signature(view), "submit")).state).toBe("pending");
    const kept = await f.service.retire(f.principal, view.id);
    expect(kept.state).toBe("pending"); expect(kept.submission).toBeDefined(); expect(f.state.sends).toBe(1);
  });

  it("prepares a fresh payment over a retired approval at that approval's own nonce, at once", async () => {
    const f = await fixture({ steps: 2 }), old = await f.prepare();
    await f.service.retire(f.principal, old.id);
    const started = Date.now(), fresh = await prepareAs(f, "fresh");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(fresh.state).toBe("prepared"); expect(BigInt(fresh.operation.nonce)).toBe(BigInt(old.operation.nonce));
    expect((await f.service.submit(f.principal, fresh.id, f.signature(fresh), "submit")).state).toBe("pending");
  });

  it("prepares nothing over a retired approval whose nonce moved outside Signa, even after its window", async () => {
    const started = now;
    try {
      const f = await fixture({ steps: 2, planLifetimeMs: 3_600_000 }), old = await f.prepare();
      await f.service.retire(f.principal, old.id);
      // The nonce moved and nothing Signa sent holds it: the retired bytes may have run.
      f.state.nonce = 1n;
      await expect(prepareAs(f, "fresh")).rejects.toMatchObject({ code: "USER_OPERATION_RETIRED_NONCE_USED", status: 409 });
      now = old.expiresAt + 600_000;
      await expect(prepareAs(f, "fresh")).rejects.toMatchObject({ code: "USER_OPERATION_RETIRED_NONCE_USED" });
    } finally {
      now = started;
    }
  });

  it("settles a retired approval under another nonce key only on a canonical head two minutes past its window, its nonce unchanged", async () => {
    const started = now;
    try {
      const f = await fixture({ steps: 2, planLifetimeMs: 3_600_000 }), old = await f.prepare();
      await f.service.retire(f.principal, old.id);
      // As if it had been signed under nonce key one: a key-zero replacement cannot exclude it.
      const records = (f.store as unknown as { records: Map<string, { operation: { nonce: Hex } }> }).records;
      records.get(old.id)!.operation.nonce = toHex(1n << 64n);
      await expect(prepareAs(f, "fresh")).rejects.toMatchObject({ code: "USER_OPERATION_RETIRED_OPEN", status: 409 });
      // Server time past the window is not enough while the chain's head is still inside it.
      now = old.expiresAt + 121_000; f.state.headLagSeconds = 60;
      await expect(prepareAs(f, "fresh")).rejects.toMatchObject({ code: "USER_OPERATION_RETIRED_OPEN" });
      f.state.headLagSeconds = 0;
      expect((await prepareAs(f, "fresh")).state).toBe("prepared");
      expect((await f.store.get(f.actor, old.id))!.retiredSettledAt).toBeDefined();
      expect(await f.store.retired(8453, old.operation.sender)).toEqual([]);
    } finally {
      now = started;
    }
  });

  const executedReplacement = async (outer: "success" | "reverted") => {
    const f = await fixture({ steps: 2 }), old = await f.prepare();
    await f.service.retire(f.principal, old.id);
    const replacement = await prepareAs(f, "replacement", [1]);
    const submitted = await f.service.submit(f.principal, replacement.id, f.signature(replacement), "submit");
    const transactionHash = h("replacement-transaction");
    await f.store.observe(replacement.id, submitted.revision, { state: outer === "success" ? "confirmed" : "reverted",
      operationHash: replacement.operationHash, transactionHash,
      receipt: { transactionHash, blockHash: h("passkey-block"), blockNumber: "90", status: outer, canonical: true, confirmations: 10,
        observedAt: now, logs: [], logsStored: false, logCount: 1, logsHash: h("logs") } });
    f.state.nonce = 1n;
    // A re-observation finds no bundle on the chain.
    f.rpc.mockImplementation(async (chain, method, params, signal) =>
      ["eth_getTransactionByHash", "eth_getTransactionReceipt"].includes(method) ? null : f.rpcDefault(chain, method, params, signal));
    return { f, old, replacement };
  };

  it("prepares past a retired approval's nonce once Signa's own payment holding it executed", async () => {
    const { f, old } = await executedReplacement("success");
    expect(BigInt((await prepareAs(f, "after")).operation.nonce)).toBe(1n);
    expect((await f.store.get(f.actor, old.id))!.retiredSettledAt).toBeDefined();
  });

  it("never retires a session operation, which no signed deadline would settle", async () => {
    const f = await fixture(), old = await f.prepare();
    const record = (await f.store.get(f.actor, old.id))!;
    expect(() => retiring({ ...record, session: {} as NonNullable<typeof record.session> })).toThrow(expect.objectContaining({ code: "USER_OPERATION_NOT_RETIRABLE" }));
  });

  it("asks to wait while the payment that took a retired approval's nonce is still confirming", async () => {
    const f = await fixture({ steps: 2 }), old = await f.prepare();
    await f.service.retire(f.principal, old.id);
    const replacement = await prepareAs(f, "replacement", [1]);
    await f.service.submit(f.principal, replacement.id, f.signature(replacement), "submit");
    f.state.nonce = 1n;
    f.rpc.mockImplementation(async (chain, method, params, signal) =>
      ["eth_getTransactionByHash", "eth_getTransactionReceipt"].includes(method) ? null : f.rpcDefault(chain, method, params, signal));
    await expect(prepareAs(f, "after")).rejects.toMatchObject({ code: "USER_OPERATION_RETIRED_CONFIRMING" });
  });

  it("is not settled by a holder whose whole bundle reverted, which rolled its nonce back", async () => {
    const { f } = await executedReplacement("reverted");
    await expect(prepareAs(f, "after")).rejects.toMatchObject({ code: "USER_OPERATION_RETIRED_CONFIRMING" });
  });

  it("is not settled by a holder's execution a reorg removed", async () => {
    const { f, replacement } = await executedReplacement("success");
    f.rpc.mockImplementation(async (chain, method, params, signal) => method === "eth_getBlockByNumber" && params[0] === "0x5a"
      ? { number: "0x5a", hash: h("other-block"), timestamp: toHex(now / 1000), baseFeePerGas: "0x0" }
      : ["eth_getTransactionByHash", "eth_getTransactionReceipt"].includes(method) ? null : f.rpcDefault(chain, method, params, signal));
    await expect(prepareAs(f, "after-reorg")).rejects.toMatchObject({ code: "USER_OPERATION_RETIRED_CONFIRMING" });
    expect((await f.store.get(f.actor, replacement.id))!.state).toBe("pending");
    expect(await f.store.find(f.actor, "after-reorg", h("after-reorg"))).toBeUndefined();
  });

  it("holds a preparation made before the retirement to the same rule when it is submitted", async () => {
    const f = await fixture({ steps: 2 }), old = await f.prepare();
    // The approval's bytes ran outside Signa while it was still prepared; another payment was prepared after.
    f.state.nonce = 1n;
    const other = await prepareAs(f, "other", [1]);
    await f.service.retire(f.principal, old.id);
    await expect(f.service.submit(f.principal, other.id, f.signature(other), "submit")).rejects.toMatchObject({ code: "USER_OPERATION_RETIRED_NONCE_USED" });
    expect(f.state.sends).toBe(0);
  });

  it("refuses a claim when another approval from the sender was retired after its admission checked them", async () => {
    const f = await fixture({ steps: 2 }), old = await f.prepare();
    f.state.nonce = 1n;
    const other = await prepareAs(f, "other", [1]);
    await f.service.retire(f.principal, old.id);
    const operation = { ...other.operation, signature: f.signature(other) };
    await expect(f.store.claim({ actor: f.actor, id: other.id, key: "late", operation,
      signedCommitment: userOperationCommitment(operation, entryPoint, 8453), retiredChecked: [],
      authorization: { issuedAt: now / 1000, expiresAt: now / 1000 + 60 }, now })).rejects.toMatchObject({ code: "USER_OPERATION_RETIRED_CHANGED" });
  });
});
