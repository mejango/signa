// SPDX-License-Identifier: MIT
import { type ChildProcess } from "node:child_process";
import { spawnAnvil } from "./support/anvil.js";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServices, loadConfig, type PlanDraft } from "@juicebox/mcp/host";
import { concatHex, decodeErrorResult, decodeEventLog, decodeFunctionData, decodeFunctionResult, encodeEventTopics,
  encodeFunctionData, erc20Abi, keccak256, padHex, toHex, zeroAddress, zeroHash, type Abi, type Address, type Hex } from "viem";
import { assertSafe7579Execution, encodeSafe7579Execution } from "../src/rest/smartAccounts/accountExecution.js";
import { prepareSafe7579Creation } from "../src/rest/smartAccounts/creation.js";
import { CHECKED_SMART_ACCOUNT_BINDING_MANIFESTS } from "../src/rest/smartAccounts/manifests.js";
import { encodeSafe7579PasskeyOwnerSignature, safe7579PasskeyOwnerSigningPayload } from "../src/rest/smartAccounts/passkeySignatures.js";
import { ENTRY_POINT_V07_ABI, UserOperationChain } from "../src/rest/userOperations/chain.js";
import { getUserOperationHash, packUserOperation, userOperationCommitment } from "../src/rest/userOperations/codec.js";
import { observeUserOperation } from "../src/rest/userOperations/execution.js";
import { recognizeWalletV6UsdcPayment, verifyWalletV6UsdcPaymentEffects } from "../src/rest/userOperations/semantics.js";
import type { UserOperationV07 } from "../src/rest/userOperations/types.js";
import { verifyWalletAssertion } from "../src/rest/wallet/webauthn.js";
import type { StoredPlan, StoredReceipt } from "../src/rest/transactions/types.js";
import { createRegistration, signGet } from "./fixtures/wallet-enrollment-crypto.js";
import { deployV6PaymentContracts, loadV6PaymentArtifacts } from "./fixtures/v6-payment/contracts.js";

type Artifact = { address: Address; abi: Abi; bytecode: Hex; deployedBytecode: Hex; deployedRuntimeBytecode?: Hex; runtimeCodeHash: Hex };
const artifact = (name: string, passkey = false): Artifact => JSON.parse(readFileSync(new URL(
  `../src/rest/smartAccounts/stack/${passkey ? "passkey/" : ""}artifacts/${name}.json`, import.meta.url), "utf8"));
const safe = artifact("SafeL2"), proxy = artifact("SafeProxy"), factory = artifact("SafeProxyFactory"), adapter = artifact("Safe7579"),
  launchpad = artifact("Safe7579Launchpad"), utility = artifact("Safe7579DCUtil"), entry = artifact("EntryPoint"),
  senderCreator = artifact("SenderCreator"), sessions = artifact("SmartSession"), fcl = artifact("FCLP256Verifier", true),
  signerFactory = artifact("SafeWebAuthnSignerFactory", true);
const chainId = 8453, rpId = "wallet.juicebox.center", origin = `https://${rpId}`;
const amount = 25_000_000n, weight = 1000n * 10n ** 18n, output = amount * weight / 10n ** 6n;
const credential = createRegistration({ challenge: zeroHash, rpId, origin, userHandle: Buffer.from("local-v6-payment").toString("base64url") });
type Receipt = { transactionHash: Hex; blockHash: Hex; blockNumber: Hex; status: Hex; contractAddress: Address | null;
  logs: { address: Address; topics: [Hex, ...Hex[]]; data: Hex; logIndex: Hex; transactionIndex: Hex;
    transactionHash: Hex; blockHash: Hex; blockNumber: Hex; removed: boolean }[] };
function stored(draft: PlanDraft): Pick<StoredPlan, "draft"> {
  return { draft: { ...draft, evidence: draft.evidence.map(value => ({ ...value, source: "onchain" as const })) } };
}

// The pinned V6 source and artifacts are an explicit dependency, documented in
// test/fixtures/v6-payment/README.md; the release check prepares them before running this suite.
const v6Sources = Boolean(process.env.CENTER_V6_SOURCE_ROOT?.trim());

// Genuine P256/FCL, Safe, EntryPoint and catalog-pinned V6 execution. Synthetic local genesis,
// constructor-state transplants and an unchanged six-decimal OZ ERC20 fixture; no Circle USDC,
// physical authenticator, Base deployment, live fee/provider, or full authority-admission claim.
describe.skipIf(!v6Sources)("actual local V6 payment through passkey Safe and pinned EntryPoint", () => {
  let child: ChildProcess | undefined, endpoint: string, baseline: Hex, sender: Address, backup: Address, beneficiary: Address;
  let account: Address, signer: Address, projectId: string, requestId = 0;
  let v6: Awaited<ReturnType<typeof deployV6PaymentContracts>>, payments: ReturnType<typeof createServices>["payments"];
  async function rpc<T = unknown>(method: string, params: readonly unknown[] = []): Promise<T> {
    const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, redirect: "error",
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }), signal: AbortSignal.timeout(10_000) });
    const body = await response.json() as { result: T; error?: { message: string; data?: Hex } };
    if (!response.ok || body.error) throw Object.assign(new Error(`${method}: ${body.error?.message ?? response.status}`), { data: body.error?.data });
    return body.result;
  }
  async function send(data: Hex, to?: Address, value: Hex = "0x0", from = sender) {
    const hash = await rpc<Hex>("eth_sendTransaction", [{ from, ...(to ? { to } : {}), data, value, gas: "0xf42400" }]);
    for (let i = 0; i < 100; i++) {
      const receipt = await rpc<Receipt | null>("eth_getTransactionReceipt", [hash]);
      if (receipt) { expect(receipt.status, `local transaction ${hash}`).toBe("0x1"); return receipt; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("Local payment fixture transaction did not mine");
  }
  async function read(contract: { address: Address; abi: Abi }, functionName: string, args: readonly unknown[] = []) {
    return decodeFunctionResult({ abi: contract.abi, functionName, data: await rpc<Hex>("eth_call", [{ to: contract.address,
      data: encodeFunctionData({ abi: contract.abi, functionName, args }) }, "latest"]) });
  }
  async function setAllowance(value: bigint) {
    const signatures = concatHex([padHex(backup, { size: 32 }), zeroHash, "0x01"]);
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [v6.at("JBMultiTerminal"), value] });
    await send(encodeFunctionData({ abi: safe.abi, functionName: "execTransaction", args: [v6.token.address, 0n, data,
      0, 0n, 0n, 0n, zeroAddress, zeroAddress, signatures] }), account, "0x0", backup);
    expect(await allowance()).toBe(value);
  }
  const allowance = () => read(v6.token, "allowance", [account, v6.at("JBMultiTerminal")]);
  async function balances() {
    return { payer: await read(v6.token, "balanceOf", [account]), treasury: await read(v6.token, "balanceOf", [v6.at("JBMultiTerminal")]),
      project: await read(v6.get("JBTerminalStore"), "balanceOf", [v6.at("JBMultiTerminal"), BigInt(projectId), v6.token.address]),
      beneficiary: await read(v6.get("JBTokens"), "totalBalanceOf", [beneficiary, BigInt(projectId)]), allowance: await allowance() };
  }
  const config = () => ({ chainId, token: v6.token.address, directV6Terminal: v6.at("JBMultiTerminal") } as const);
  const prepare = () => payments.preparePay({ project: { chainId, projectId, version: 6 }, account, token: v6.token.address,
    amount: String(amount), beneficiary, slippageBps: 0, memo: "local exact V6 payment", metadata: "0x" });
  async function signed(draft: PlanDraft) {
    const operation: UserOperationV07 = { sender: account, nonce: toHex(await read(entry, "getNonce", [account, 0n]) as bigint),
      callData: encodeSafe7579Execution(draft.calls.map(call => ({ target: call.to, value: call.value, callData: call.data }))),
      verificationGasLimit: toHex(800_000), callGasLimit: toHex(1_500_000), preVerificationGas: toHex(100_000),
      maxPriorityFeePerGas: toHex(1_000_000_000), maxFeePerGas: toHex(2_000_000_000), signature: "0x" };
    assertSafe7579Execution(operation.callData, draft.calls.map(call => ({ target: call.to, value: call.value, callData: call.data })));
    const validity = { validAfter: "1800000000", validUntil: "1800000300" };
    const payload = safe7579PasskeyOwnerSigningPayload({ operation, chainId, safe7579: adapter.address, entryPoint: entry.address, ...validity });
    const proof = verifyWalletAssertion(signGet({ ...credential, challenge: payload.digest, rpId, origin }), {
      purpose: "payment", challenge: payload.digest, rpId, origin, requireUserHandle: true,
      credential: { id: credential.credentialId, userHandle: credential.userHandle, publicKey: credential.publicKey, backupEligible: true } });
    operation.signature = encodeSafe7579PasskeyOwnerSignature({ ...validity, signatures: [{ kind: "contract", owner: signer, signature: proof.contractSignature }] });
    return operation;
  }
  const handleOps = (operation: UserOperationV07) => encodeFunctionData({ abi: entry.abi, functionName: "handleOps", args: [[packUserOperation(operation)], sender] });
  async function execute(draft: PlanDraft) {
    const operation = await signed(draft), encoded = handleOps(operation);
    const receipt = await send(encoded, entry.address);
    const transaction = await rpc<{ to: Address; input: Hex }>("eth_getTransactionByHash", [receipt.transactionHash]);
    expect(transaction.to.toLowerCase()).toBe(entry.address.toLowerCase()); expect(transaction.input).toBe(encoded);
    const decoded = decodeFunctionData({ abi: ENTRY_POINT_V07_ABI, data: transaction.input });
    expect(decoded.functionName).toBe("handleOps");
    const beforeTopic = encodeEventTopics({ abi: ENTRY_POINT_V07_ABI, eventName: "BeforeExecution" })[0];
    const eventTopic = encodeEventTopics({ abi: ENTRY_POINT_V07_ABI, eventName: "UserOperationEvent" })[0];
    const boundaries = receipt.logs.map((log, position) => ({ log, position })).filter(({ log }) =>
      log.address.toLowerCase() === entry.address.toLowerCase() && log.topics[0] === beforeTopic);
    const events = receipt.logs.map((log, position) => ({ log, position })).filter(({ log }) =>
      log.address.toLowerCase() === entry.address.toLowerCase() && log.topics[0] === eventTopic);
    expect(boundaries).toHaveLength(1); expect(events).toHaveLength(1);
    const event = decodeEventLog({ abi: ENTRY_POINT_V07_ABI, eventName: "UserOperationEvent", topics: events[0]!.log.topics, data: events[0]!.log.data });
    expect(event.args).toMatchObject({ userOpHash: getUserOperationHash(operation, entry.address, chainId), sender: account, nonce: BigInt(operation.nonce) });
    expect(event.args.actualGasCost).toBeGreaterThan(0n);
    const canonical = await rpc<{ hash: Hex }>("eth_getBlockByNumber", [receipt.blockNumber, false]);
    expect(canonical.hash).toBe(receipt.blockHash);
    const scoped: StoredReceipt = { transactionHash: receipt.transactionHash, blockHash: receipt.blockHash,
      blockNumber: String(BigInt(receipt.blockNumber)), status: event.args.success ? "success" : "reverted", confirmations: 1,
      canonical: true, observedAt: 1_800_000_000_000, logs: receipt.logs.slice(boundaries[0]!.position + 1, events[0]!.position) };
    const indexes = draft.calls.map((_, index) => index);
    let checkedAccount = false, checkedSemantics = false;
    const observation = await observeUserOperation({
      chain: new UserOperationChain({ request: (requestedChain, method, params) => {
        expect(requestedChain).toBe(chainId);
        expect(["eth_chainId", "eth_getBlockByNumber", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getCode", "eth_getStorageAt", "eth_call"]).toContain(method);
        return rpc(method, params);
      } }, { now: () => 1_800_000_000_000 }),
      binding: { chainId, entryPoint: { address: entry.address, runtimeCodeHash: entry.runtimeCodeHash },
        accountCode: { address: account, runtimeCodeHash: proxy.runtimeCodeHash }, operation,
        operationHash: getUserOperationHash(operation, entry.address, chainId), calls: draft.calls },
      signedCommitment: userOperationCommitment(operation, entry.address, chainId), transactionHash: receipt.transactionHash,
      confirmations: 1, now: 1_800_000_000_000,
      async verifyAccountAtBlock(_binding, evidence, chain) {
        // Bounded fixture callback: independently checks these real canonical account properties.
        // Full manifest history, session enumeration and authority admission retain their own suites.
        checkedAccount = true;
        for (const a of [safe, adapter, sessions]) await chain.runtime(chainId, a, evidence);
        const tag = chain.tag(evidence);
        const call = async (functionName: string, args: readonly unknown[] = []) => decodeFunctionResult({ abi: safe.abi, functionName,
          data: await chain.request(chainId, "eth_call", [{ to: account, data: encodeFunctionData({ abi: safe.abi, functionName, args }) }, tag]) as Hex });
        expect((await call("getOwners") as Address[]).map(value => value.toLowerCase()).sort()).toEqual([signer, backup].map(value => value.toLowerCase()).sort());
        expect(await call("getThreshold")).toBe(1n);
        expect(await call("isModuleEnabled", [adapter.address])).toBe(true);
        for (const [slot, expected] of [[zeroHash, padHex(safe.address, { size: 32 })],
          [keccak256(toHex("fallback_manager.handler.address")), padHex(adapter.address, { size: 32 })],
          [keccak256(toHex("guard_manager.guard.address")), zeroHash]] as const)
          expect((await chain.request(chainId, "eth_getStorageAt", [account, slot, tag]) as string).toLowerCase()).toBe(expected.toLowerCase());
      },
      async verifySemantics(value) {
        checkedSemantics = true;
        expect(value.logs).toEqual(scoped.logs);
        return verifyWalletV6UsdcPaymentEffects(stored(draft), indexes, config(), value);
      },
    });
    expect(observation.state).toBe(event.args.success ? "confirmed" : "reverted");
    expect(checkedAccount).toBe(event.args.success); expect(checkedSemantics).toBe(event.args.success);
    return { operation, receipt, scoped, success: event.args.success, semantic: observation.semantic! };
  }
  beforeAll(async () => {
    const builds = await loadV6PaymentArtifacts();
    expect(builds.verifiedSourceCount).toBeGreaterThan(30);
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve()));
    endpoint = `http://127.0.0.1:${port}`;
    child = spawnAnvil(["--host", "127.0.0.1", "--port", String(port), "--chain-id", String(chainId),
      "--hardfork", "cancun", "--timestamp", "1800000000", "--silent"]);
    let ready = false;
    for (let i = 0; i < 100; i++) { try { if (await rpc("eth_chainId") === "0x2105") { ready = true; break; } } catch { /* bounded startup */ }
      await new Promise(resolve => setTimeout(resolve, 30)); }
    expect(ready).toBe(true);
    [sender, backup, beneficiary] = await rpc<[Address, Address, Address]>("eth_accounts");
    for (const a of [safe, factory, adapter, launchpad, utility, entry, senderCreator, sessions]) {
      const code = a.deployedRuntimeBytecode ?? a.deployedBytecode;
      expect(keccak256(code)).toBe(a.runtimeCodeHash); await rpc("anvil_setCode", [a.address, code]);
    }
    const fclAddress = (await send(fcl.bytecode)).contractAddress!, signerFactoryAddress = (await send(signerFactory.bytecode)).contractAddress!;
    const signerArgs = [BigInt(credential.publicKey.x), BigInt(credential.publicKey.y), BigInt(fclAddress)];
    signer = await read({ abi: signerFactory.abi, address: signerFactoryAddress }, "getSigner", signerArgs) as Address;
    await send(encodeFunctionData({ abi: signerFactory.abi, functionName: "createSigner", args: signerArgs }), signerFactoryAddress);
    const creation = prepareSafe7579Creation({ manifest: { ...CHECKED_SMART_ACCOUNT_BINDING_MANIFESTS[0]!, chainId },
      owners: [signer, backup], threshold: 1, saltNonce: "64001" });
    account = creation.address; await send(creation.transaction.data, creation.transaction.to);
    await send(encodeFunctionData({ abi: entry.abi, functionName: "depositTo", args: [account] }), entry.address, toHex(2n * 10n ** 18n));
    v6 = await deployV6PaymentContracts(builds, rpc, sender, send);
    expect(await read(v6.token, "decimals")).toBe(6);
    expect((await read(v6.get("JBMultiTerminal"), "DIRECTORY") as string).toLowerCase()).toBe(v6.at("JBDirectory").toLowerCase());
    const currency = Number(BigInt(v6.token.address) & 0xffff_ffffn);
    const ruleset = { mustStartAtOrAfter: 0, duration: 0, weight, weightCutPercent: 0, approvalHook: zeroAddress,
      metadata: { reservedPercent: 0, cashOutTaxRate: 0, baseCurrency: currency, pausePay: false, pauseCreditTransfers: false,
        allowOwnerMinting: false, allowSetCustomToken: false, allowTerminalMigration: false, allowSetTerminals: false,
        ownerMustSendPayouts: false, allowSetController: false, allowAddAccountingContext: true, allowAddPriceFeed: false,
        holdFees: false, scopeCashOutsToLocalBalances: false, useDataHookForPay: false, useDataHookForCashOut: false, dataHook: zeroAddress, metadata: 0 },
      splitGroups: [], fundAccessLimitGroups: [] };
    const terminals = [{ terminal: v6.at("JBMultiTerminal"), accountingContextsToAccept: [{ token: v6.token.address, decimals: 6, currency }] }];
    await send(encodeFunctionData({ abi: v6.get("JBController").abi, functionName: "launchProjectFor",
      args: [sender, "ipfs://local-payment-fixture", [ruleset], terminals, ""] }), v6.at("JBController"));
    projectId = String(await read(v6.get("JBProjects"), "count"));
    await send(encodeFunctionData({ abi: v6.token.abi, functionName: "mint", args: [account, amount * 10n] }), v6.token.address);
    payments = createServices(loadConfig({ NODE_ENV: "test", JBCENTER_URL: endpoint, RPC_URL_8453: endpoint,
      PLAN_SECRET: "local-v6-fixture-only-unused-plan-secret" })).payments;
    baseline = await rpc<Hex>("evm_snapshot");
  }, 45_000);
  beforeEach(async () => { expect(await rpc("evm_revert", [baseline])).toBe(true); baseline = await rpc<Hex>("evm_snapshot"); });
  afterAll(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child!.once("exit", () => resolve())); child.kill("SIGTERM"); await exited;
    }
  });
  it.each([0n, 1n, amount])("runs the unmodified payment producer and exact real batch with prior allowance %s", async prior => {
    if (prior) await setAllowance(prior);
    const draft = await prepare(), count = prior === amount ? 1 : prior === 0n ? 2 : 3;
    expect(draft.calls).toHaveLength(count);
    expect(draft.summary).toMatchObject({ route: "multi-terminal", beneficiaryTokenCount: String(output), minimumBeneficiaryTokenCount: String(output) });
    expect(recognizeWalletV6UsdcPayment(stored(draft), draft.calls.map((_, i) => i), config())).toMatchObject({ resetAllowance: prior === 1n, amount: String(amount) });
    const result = await execute(draft);
    expect(result.success).toBe(true); expect(result.semantic.status).toBe("verified");
    expect(await balances()).toEqual({ payer: amount * 9n, treasury: amount, project: amount, beneficiary: output, allowance: 0n });
    expect(await read(entry, "getNonce", [account, 0n])).toBe(1n);
    const tokenLogs = result.scoped.logs!.filter(log => (log as { address: string }).address.toLowerCase() === v6.token.address.toLowerCase());
    expect(tokenLogs).toHaveLength(count); // planned Approval(s), exactly one Transfer; no transferFrom Approval.
    const withoutTransfer = { ...result.scoped, logs: result.scoped.logs!.filter(log =>
      (log as { topics: string[] }).topics[0] !== encodeEventTopics({ abi: erc20Abi, eventName: "Transfer" })[0]) };
    expect(verifyWalletV6UsdcPaymentEffects(stored(draft), draft.calls.map((_, i) => i), config(), withoutTransfer).status).toBe("unknown");
  });
  it("keeps a successful outer EntryPoint receipt from confirming a failed atomic payment", async () => {
    await setAllowance(1n);
    const draft = await prepare();
    const last = draft.calls[draft.calls.length - 1]!;
    const decoded = decodeFunctionData({ abi: v6.get("JBMultiTerminal").abi, data: last.data });
    const args = [...decoded.args!]; args[4] = output + 1n;
    last.data = encodeFunctionData({ abi: v6.get("JBMultiTerminal").abi, functionName: "pay", args });
    (draft.summary as Record<string, unknown>).minimumBeneficiaryTokenCount = String(output + 1n);
    const before = await balances(), result = await execute(draft);
    expect(result.receipt.status).toBe("0x1"); expect(result.success).toBe(false); expect(result.semantic.status).toBe("failed");
    expect(await balances()).toEqual(before); // Both preceding approvals and all payment effects rolled back.
    const revert = result.receipt.logs.find(log => log.address.toLowerCase() === entry.address.toLowerCase() &&
      log.topics[0] === encodeEventTopics({ abi: ENTRY_POINT_V07_ABI, eventName: "UserOperationRevertReason" })[0])!;
    const reason = decodeEventLog({ abi: ENTRY_POINT_V07_ABI, eventName: "UserOperationRevertReason", data: revert.data, topics: revert.topics });
    expect(decodeErrorResult({ abi: adapter.abi, data: reason.args.revertReason }).errorName).toBe("ExecutionFailed");
  });
  it("rejects an exact successful operation replay before any second transfer", async () => {
    const draft = await prepare(), first = await execute(draft), before = await balances();
    let failure: unknown;
    try { await rpc("eth_call", [{ from: sender, to: entry.address, data: handleOps(first.operation), gas: "0xf42400" }, "latest"]); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    const error = decodeErrorResult({ abi: entry.abi, data: (failure as { data: Hex }).data });
    expect(error.errorName).toBe("FailedOp"); expect(error.args?.[1]).toBe("AA25 invalid account nonce");
    expect(await balances()).toEqual(before);
  });
});
