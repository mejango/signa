// SPDX-License-Identifier: MIT
import { type ChildProcess } from "node:child_process";
import { anvilAvailable, spawnAnvil } from "./support/anvil.js";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { decodeEventLog, decodeFunctionData, decodeFunctionResult, encodeEventTopics, encodeFunctionData, keccak256, padHex,
  toHex, zeroHash, type Abi, type Address, type Hex } from "viem";
import { assertSafe7579Execution, encodeSafe7579Execution } from "../src/rest/smartAccounts/accountExecution.js";
import { prepareSafe7579Creation } from "../src/rest/smartAccounts/creation.js";
import { CHECKED_SMART_ACCOUNT_BINDING_MANIFESTS } from "../src/rest/smartAccounts/manifests.js";
import { encodeSafe7579PasskeyOwnerSignature, safe7579PasskeyOwnerSigningPayload } from "../src/rest/smartAccounts/passkeySignatures.js";
import { ENTRY_POINT_V07_ABI, UserOperationChain } from "../src/rest/userOperations/chain.js";
import { getUserOperationHash, packUserOperation, userOperationCommitment } from "../src/rest/userOperations/codec.js";
import { observeUserOperation } from "../src/rest/userOperations/execution.js";
import { REVIEWED_CALLS_KIND, REVIEWED_CALLS_OPERATION, verifyReviewedCallsEffects } from "../src/rest/userOperations/reviewedCalls.js";
import type { UserOperationV07 } from "../src/rest/userOperations/types.js";
import { verifyWalletAssertion } from "../src/rest/wallet/webauthn.js";
import type { RestPlanDraft } from "../src/rest/core.js";
import type { StoredReceipt } from "../src/rest/transactions/types.js";
import { createRegistration, signGet } from "./fixtures/wallet-enrollment-crypto.js";

type Artifact = { address: Address; abi: Abi; bytecode: Hex; deployedBytecode: Hex; deployedRuntimeBytecode?: Hex; runtimeCodeHash: Hex };
const artifact = (name: string, passkey = false): Artifact => JSON.parse(readFileSync(new URL(
  `../src/rest/smartAccounts/stack/${passkey ? "passkey/" : ""}artifacts/${name}.json`, import.meta.url), "utf8"));
const safe = artifact("SafeL2"), proxy = artifact("SafeProxy"), factory = artifact("SafeProxyFactory"), adapter = artifact("Safe7579"),
  launchpad = artifact("Safe7579Launchpad"), utility = artifact("Safe7579DCUtil"), entry = artifact("EntryPoint"),
  senderCreator = artifact("SenderCreator"), sessions = artifact("SmartSession"), fcl = artifact("FCLP256Verifier", true),
  signerFactory = artifact("SafeWebAuthnSignerFactory", true);
const chainId = 8453, rpId = "wallet.juicebox.center", origin = `https://${rpId}`;
const credential = createRegistration({ challenge: zeroHash, rpId, origin, userHandle: Buffer.from("local-reviewed-calls").toString("base64url") });
type Receipt = { transactionHash: Hex; blockHash: Hex; blockNumber: Hex; status: Hex; contractAddress: Address | null;
  logs: { address: Address; topics: [Hex, ...Hex[]]; data: Hex; logIndex: Hex; transactionIndex: Hex;
    transactionHash: Hex; blockHash: Hex; blockNumber: Hex; removed: boolean }[] };
type ReviewedDraft = RestPlanDraft;
// Code with no Solidity behind it: one contract stops, one reverts whatever it is sent.
const stops = "0x5555555555555555555555555555555555555555" as Address, reverts = "0x6666666666666666666666666666666666666666" as Address;
const draftOf = (calls: { to: Address; value: bigint; data: Hex }[]): ReviewedDraft => ({ operation: REVIEWED_CALLS_OPERATION, account,
  evidence: [], warnings: [], summary: { kind: REVIEWED_CALLS_KIND, sources: calls.map(call => call.data === "0x" ? { source: "raw", lookup: "no-abi" }
    : { source: "raw", lookup: "lookup-failed" }) },
  calls: calls.map((call, index) => ({ chainId, to: call.to, value: call.value.toString(), data: call.data, label: "", decoded: {}, dependsOn: index ? [index - 1] : [] })) });
let account: Address;

// Genuine P256/FCL, Safe, Safe7579 and EntryPoint execution on a local chain; no Base deployment or provider.
describe.skipIf(!anvilAvailable())("reviewed calls through the passkey Safe and pinned EntryPoint", () => {
  let child: ChildProcess | undefined, endpoint: string, baseline: Hex, sender: Address, backup: Address, beneficiary: Address;
  let signer: Address, requestId = 0;
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
    throw new Error("Local fixture transaction did not mine");
  }
  async function read(contract: { address: Address; abi: Abi }, functionName: string, args: readonly unknown[] = []) {
    return decodeFunctionResult({ abi: contract.abi, functionName, data: await rpc<Hex>("eth_call", [{ to: contract.address,
      data: encodeFunctionData({ abi: contract.abi, functionName, args }) }, "latest"]) });
  }
  async function signed(draft: ReviewedDraft) {
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
  async function execute(draft: ReviewedDraft) {
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
        return verifyReviewedCallsEffects({ draft }, value);
      },
    });
    expect(observation.state).toBe(event.args.success ? "confirmed" : "reverted");
    expect(checkedAccount).toBe(event.args.success); expect(checkedSemantics).toBe(event.args.success);
    return { operation, receipt, scoped, success: event.args.success, semantic: observation.semantic! };
  }
  beforeAll(async () => {
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
    await rpc("anvil_setCode", [stops, "0x00"]); await rpc("anvil_setCode", [reverts, "0x60006000fd"]);
    for (const a of [safe, factory, adapter, launchpad, utility, entry, senderCreator, sessions]) {
      const code = a.deployedRuntimeBytecode ?? a.deployedBytecode;
      expect(keccak256(code)).toBe(a.runtimeCodeHash); await rpc("anvil_setCode", [a.address, code]);
    }
    const fclAddress = (await send(fcl.bytecode)).contractAddress!, signerFactoryAddress = (await send(signerFactory.bytecode)).contractAddress!;
    const signerArgs = [BigInt(credential.publicKey.x), BigInt(credential.publicKey.y), BigInt(fclAddress)];
    signer = await read({ abi: signerFactory.abi, address: signerFactoryAddress }, "getSigner", signerArgs) as Address;
    await send(encodeFunctionData({ abi: signerFactory.abi, functionName: "createSigner", args: signerArgs }), signerFactoryAddress);
    const creation = prepareSafe7579Creation({ manifest: { ...CHECKED_SMART_ACCOUNT_BINDING_MANIFESTS[0]!, chainId },
      owners: [signer, backup], threshold: 1, saltNonce: "64013" });
    account = creation.address; await send(creation.transaction.data, creation.transaction.to);
    await send(encodeFunctionData({ abi: entry.abi, functionName: "depositTo", args: [account] }), entry.address, toHex(2n * 10n ** 18n));
    await send("0x", account, toHex(10n ** 18n));
    baseline = await rpc<Hex>("evm_snapshot");
  }, 45_000);
  beforeEach(async () => { expect(await rpc("evm_revert", [baseline])).toBe(true); baseline = await rpc<Hex>("evm_snapshot"); });
  afterAll(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child!.once("exit", () => resolve())); child.kill("SIGTERM"); await exited;
    }
  });
  const balance = async (address: Address) => BigInt(await rpc<Hex>("eth_getBalance", [address, "latest"]));
  it("verifies effects only for a canonical successful execution of the exact calls", async () => {
    const before = await balance(beneficiary);
    const draft = draftOf([{ to: beneficiary, value: 7n, data: "0x" }, { to: stops, value: 0n, data: "0x12345678" }]);
    const result = await execute(draft);
    expect(result.success).toBe(true);
    expect(result.semantic).toMatchObject({ status: "verified", details: { verifier: "reviewed-calls-v1", calls: 2 } });
    expect(await balance(beneficiary)).toBe(before + 7n);
    // The same receipt read against another plan's calls, or a plan that is not a reviewed call set, proves nothing.
    expect(verifyReviewedCallsEffects({ draft: { ...draft, operation: "pay" } }, result.scoped).status).toBe("unknown");
  });
  it("an inner revert is failed, a reorg is unknown", async () => {
    const before = await balance(beneficiary);
    const result = await execute(draftOf([{ to: beneficiary, value: 7n, data: "0x" }, { to: reverts, value: 0n, data: "0x12345678" }]));
    expect(result.receipt.status).toBe("0x1"); expect(result.success).toBe(false);
    expect(result.semantic.status).toBe("failed");
    expect(await balance(beneficiary)).toBe(before); // The transfer before the revert rolled back with it.
    const ok = await execute(draftOf([{ to: beneficiary, value: 7n, data: "0x" }]));
    expect(verifyReviewedCallsEffects({ draft: draftOf([{ to: beneficiary, value: 7n, data: "0x" }]) }, { ...ok.scoped, canonical: false }).status).toBe("unknown");
  });
});
