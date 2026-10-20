import { type ChildProcess } from "node:child_process";
import { anvilAvailable, spawnAnvil } from "./support/anvil.js";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  concatHex, decodeErrorResult, decodeEventLog, decodeFunctionResult, encodeFunctionData,
  keccak256, parseAbi, size, sliceHex, toHex,
  type Abi, type Address, type Hex,
} from "viem";
import { createContractOwnerVerifier } from "../src/rest/contractOwner.js";
import { encodeSafe7579Execution } from "../src/rest/smartAccounts/accountExecution.js";
import { prepareSafe7579Creation } from "../src/rest/smartAccounts/creation.js";
import { CHECKED_SMART_ACCOUNT_BINDING_MANIFESTS } from "../src/rest/smartAccounts/manifests.js";
import {
  encodeSafe7579MessageSignature, encodeSafe7579PasskeyOwnerSignature,
  safe7579MessageSigningPayload, safe7579PasskeyOwnerSigningPayload,
} from "../src/rest/smartAccounts/passkeySignatures.js";
import { getUserOperationHash, packUserOperation } from "../src/rest/userOperations/codec.js";
import { passkeyDummyContractSignature, passkeyDummySignature } from "../src/rest/userOperations/passkeyEstimation.js";
import type { UserOperationV07 } from "../src/rest/userOperations/types.js";
import {
  deriveWalletAuthenticationChallenge, verifyWalletAssertion,
  type WalletAssertion, type WalletAssertionPurpose,
} from "../src/rest/wallet/webauthn.js";

type Artifact = {
  address: Address; abi: Abi; bytecode: Hex; deployedBytecode: Hex;
  deployedRuntimeBytecode?: Hex; runtimeCodeHash: Hex;
};
const artifact = (name: string, passkey = false): Artifact => JSON.parse(readFileSync(
  new URL(`../src/rest/smartAccounts/stack/${passkey ? "passkey/" : ""}artifacts/${name}.json`, import.meta.url), "utf8",
));
const safe = artifact("SafeL2"), factory = artifact("SafeProxyFactory"),
  adapter = artifact("Safe7579"), launchpad = artifact("Safe7579Launchpad"),
  utility = artifact("Safe7579DCUtil"), entry = artifact("EntryPoint"), sessions = artifact("SmartSession"),
  senderCreator = artifact("SenderCreator"), fcl = artifact("FCLP256Verifier", true),
  passkeyFactory = artifact("SafeWebAuthnSignerFactory", true);
const erc1271Abi = parseAbi(["function isValidSignature(bytes32 digest,bytes signature) view returns(bytes4)"]);
const eventAbi = parseAbi(["event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)"]);
const available = anvilAvailable();
const chainId = 8453;
const rpId = "wallet.juicebox.center", origin = `https://${rpId}`;
const credentialId = Buffer.from("synthetic-p256-credential").toString("base64url");
const userHandle = Buffer.from("synthetic-wallet-user").toString("base64url");
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest();
// Public P-256 generator / scalar 1: deliberately public local test authority, never a wallet key.
const publicKey = {
  x: "0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296" as Hex,
  y: "0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5" as Hex,
};
const privateKey = createPrivateKey({ format: "jwk", key: {
  kty: "EC", crv: "P-256",
  x: Buffer.from(publicKey.x.slice(2), "hex").toString("base64url"),
  y: Buffer.from(publicKey.y.slice(2), "hex").toString("base64url"),
  d: Buffer.from(toHex(1n, { size: 32 }).slice(2), "hex").toString("base64url"),
} });

function assertion(challenge: Hex, purpose: WalletAssertionPurpose, maximum = false) {
  let json = JSON.stringify({
    type: "webauthn.get", challenge: Buffer.from(challenge.slice(2), "hex").toString("base64url"),
    origin, crossOrigin: false,
  });
  if (maximum) {
    json = json.slice(0, -1) + ',"extra":""}';
    json = json.replace('"extra":""', `"extra":"${"x".repeat(2048 - Buffer.byteLength(json))}"`);
    expect(Buffer.byteLength(json)).toBe(2048);
  }
  const authenticatorData = Buffer.concat([sha256(rpId), Buffer.from([0x1d, 0, 0, 0, 0])]);
  const clientDataJSON = Buffer.from(json);
  const value: WalletAssertion = {
    credentialId, userHandle, authenticatorData, clientDataJSON,
    signature: sign("sha256", Buffer.concat([authenticatorData, sha256(clientDataJSON)]), privateKey),
  };
  const checked = verifyWalletAssertion(value, {
    challenge, purpose, rpId, origin, requireUserHandle: true,
    credential: { id: credentialId, userHandle, publicKey, backupEligible: true },
  });
  return checked.contractSignature;
}

// Only the authenticator is synthetic. The TS producers, REST verifier, actual FCL, immutable
// signer, Safe, Safe7579 and EntryPoint all execute. This is no browser/device or provider claim.
describe.skipIf(!available)("TypeScript passkey producer through the pinned local EVM", () => {
  let child: ChildProcess | undefined, endpoint: string, baseline: Hex;
  let sender: Address, backup: Address, recipient: Address, account: Address, signer: Address;
  let requestId = 0;
  async function rpc<T = unknown>(method: string, params: readonly unknown[] = [], signal?: AbortSignal): Promise<T> {
    const response = await fetch(endpoint, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
      signal: signal ?? AbortSignal.timeout(10_000),
    });
    const result = await response.json() as { result: T; error?: { message: string; data?: unknown } };
    if (result.error) throw Object.assign(new Error(`${method}: ${result.error.message}`), { data: result.error.data });
    return result.result;
  }
  const verifier = createContractOwnerVerifier({
    request: (_chain, method, params, signal) => rpc(method, params, signal),
  }, [chainId]);
  const authenticate = (digest: Hex, signature: Hex, ownerAddress = account) => verifier({
    ownerAddress, authorityChainId: chainId, digest, signature, signal: AbortSignal.timeout(5_000),
  });
  type Receipt = {
    status: Hex; contractAddress: Address | null; gasUsed: Hex;
    logs: { address: Address; topics: [Hex, ...Hex[]]; data: Hex }[];
  };
  async function send(data: Hex, to?: Address, value = "0x0", expectedStatus: Hex = "0x1") {
    const hash = await rpc<Hex>("eth_sendTransaction", [{ from: sender, ...(to ? { to } : {}), data, value, gas: "0xf42400" }]);
    let receipt: Receipt | null = null;
    for (let attempt = 0; attempt < 100; attempt++) {
      receipt = await rpc<Receipt | null>("eth_getTransactionReceipt", [hash]);
      if (receipt) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!receipt) throw new Error(`Local transaction ${hash} was not mined`);
    expect(receipt.status, `local transaction ${hash}`).toBe(expectedStatus);
    return receipt;
  }
  async function read(a: { abi: Abi; address: Address }, functionName: string, args: readonly unknown[]) {
    return decodeFunctionResult({ abi: a.abi, functionName, data: await rpc<Hex>("eth_call", [
      { to: a.address, data: encodeFunctionData({ abi: a.abi, functionName, args }) }, "latest",
    ]) });
  }
  function unsignedOperation(): UserOperationV07 {
    return {
      sender: account, nonce: "0x0", callData: encodeSafe7579Execution([
        { target: recipient, value: "100000000000000000", callData: "0x" },
      ]),
      verificationGasLimit: toHex(800_000), callGasLimit: toHex(200_000),
      preVerificationGas: toHex(100_000), maxPriorityFeePerGas: toHex(1_000_000_000),
      maxFeePerGas: toHex(2_000_000_000), signature: "0x",
    };
  }
  const validity = { validAfter: "1800000000", validUntil: "1800000300" };
  function signedOperation(maximum = false) {
    const operation = unsignedOperation();
    const payload = safe7579PasskeyOwnerSigningPayload({
      operation, chainId, safe7579: adapter.address, entryPoint: entry.address, ...validity,
    });
    const contractSignature = assertion(payload.digest, "payment", maximum);
    operation.signature = encodeSafe7579PasskeyOwnerSignature({
      ...validity, signatures: [{ kind: "contract", owner: signer, signature: contractSignature }],
    });
    return { operation, payload, contractSignature };
  }
  const handleOps = (operation: UserOperationV07) => encodeFunctionData({
    abi: entry.abi, functionName: "handleOps", args: [[packUserOperation(operation)], sender],
  });
  async function assertRejected(operation: UserOperationV07, reasons = ["AA24 signature error", "AA23 reverted"]) {
    let failure: unknown;
    try {
      await rpc("eth_call", [{ from: sender, to: entry.address, data: handleOps(operation), gas: "0xf42400" }, "latest"]);
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    const data = (failure as { data: Hex }).data;
    // An unrelated transport error or insufficient prefund cannot stand in for rejection
    // of an invalid approval. Check the actual EntryPoint custom-error category.
    const decoded = decodeErrorResult({ abi: entry.abi, data });
    expect(["FailedOp", "FailedOpWithRevert"]).toContain(decoded.errorName);
    expect(reasons).toContain(decoded.args?.[1]);
  }

  beforeAll(async () => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    endpoint = `http://127.0.0.1:${port}`;
    child = spawnAnvil(["--host", "127.0.0.1", "--port", String(port), "--chain-id", String(chainId), "--hardfork", "cancun", "--timestamp", "1800000000", "--silent"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    for (let i = 0; i < 100; i++) {
      try { await rpc("eth_chainId"); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 30)); }
    }
    [sender, backup, recipient] = await rpc<[Address, Address, Address]>("eth_accounts");
    for (const a of [safe, factory, adapter, launchpad, utility, entry, senderCreator, sessions]) {
      const code = a.deployedRuntimeBytecode ?? a.deployedBytecode;
      expect(keccak256(code)).toBe(a.runtimeCodeHash);
      await rpc("anvil_setCode", [a.address, code]);
    }
    // Deploy the exact artifact creation bytes so constructor immutables are real as well.
    const fclAddress = (await send(fcl.bytecode)).contractAddress!;
    const factoryAddress = (await send(passkeyFactory.bytecode)).contractAddress!;
    const signerArgs = [BigInt(publicKey.x), BigInt(publicKey.y), BigInt(fclAddress)] as const;
    const factoryContract = { abi: passkeyFactory.abi, address: factoryAddress };
    signer = await read(factoryContract, "getSigner", signerArgs) as Address;
    await send(encodeFunctionData({ abi: passkeyFactory.abi, functionName: "createSigner", args: signerArgs }), factoryAddress);
    // Reuse Center's actual initializer: the pinned SmartSession validator is installed empty.
    // No spending session is enabled, and production passkey admission remains gated.
    const prepared = prepareSafe7579Creation({
      manifest: { ...CHECKED_SMART_ACCOUNT_BINDING_MANIFESTS[0]!, chainId },
      owners: [signer, backup], threshold: 1, saltNonce: "4242",
    });
    account = prepared.address;
    await send(prepared.transaction.data, prepared.transaction.to);
    await send("0x", account, toHex(5n * 10n ** 18n));
    await send(encodeFunctionData({ abi: entry.abi, functionName: "depositTo", args: [account] }), entry.address, toHex(2n * 10n ** 18n));
    baseline = await rpc<Hex>("evm_snapshot");
  }, 30_000);
  beforeEach(async () => {
    expect(await rpc("evm_revert", [baseline])).toBe(true);
    baseline = await rpc<Hex>("evm_snapshot");
  });
  afterAll(async () => {
    if (child && child.exitCode === null) {
      const exited = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
      child.kill("SIGTERM"); await exited;
    }
  });

  it.each([false, true])("authenticates the stable Safe through REST ERC1271 using actual FCL (maximum client data: %s)", async (maximum) => {
    const requestDigest = deriveWalletAuthenticationChallenge({
      purpose: "login", accountId: `eip155:${chainId}:${account}`,
      bindingDigest: keccak256(toHex("first-party request")), nonce: toHex(42n, { size: 32 }), expiresAt: 1_800_000_300,
    });
    const payload = safe7579MessageSigningPayload({ safe: account, chainId, requestDigest });
    const contractSignature = assertion(payload.digest, "login", maximum);
    const signature = encodeSafe7579MessageSignature([{ kind: "contract", owner: signer, signature: contractSignature }]);
    expect(await authenticate(requestDigest, signature)).toBe(true);
    expect(await authenticate(keccak256(toHex("different request")), signature)).toBe(false);
    // A raw request digest is not Safe's SafeMessage preimage, and cannot replace it.
    const rawSignature = encodeSafe7579MessageSignature([{ kind: "contract", owner: signer, signature: assertion(requestDigest, "login", maximum) }]);
    expect(await authenticate(requestDigest, rawSignature)).toBe(false);
    const gas = BigInt(await rpc<Hex>("eth_estimateGas", [{ to: account, data: encodeFunctionData({ abi: erc1271Abi, functionName: "isValidSignature", args: [requestDigest, signature] }) }]));
    expect(gas).toBeLessThan(500_000n); // The existing REST verifier's real, bounded eth_call budget.
    if (maximum) expect(size(contractSignature)).toBe(2240);
  });

  it.each([false, true])("executes the exact TS SafeOp via EntryPoint and records one canonical payment (maximum client data: %s)", async (maximum) => {
    const { operation, payload } = signedOperation(maximum);
    const onchain = await read(adapter, "getSafeOp", [packUserOperation(operation), entry.address]) as [Hex, number, number, Hex];
    expect(onchain[0]).toBe(payload.signedData);
    expect(keccak256(onchain[0])).toBe(payload.digest);
    expect(onchain.slice(1)).toEqual([1_800_000_000, 1_800_000_300, sliceHex(operation.signature, 12)]);
    const before = BigInt(await rpc<Hex>("eth_getBalance", [recipient, "latest"]));
    const receipt = await send(handleOps(operation), entry.address);
    expect(BigInt(await rpc<Hex>("eth_getBalance", [recipient, "latest"])) - before).toBe(10n ** 17n);
    expect(await read(entry, "getNonce", [account, 0n])).toBe(1n);
    const events = receipt.logs.filter((log) => log.address.toLowerCase() === entry.address.toLowerCase()).flatMap((log) => {
      try {
        const decoded = decodeEventLog({ abi: eventAbi, eventName: "UserOperationEvent", topics: log.topics, data: log.data });
        return [decoded.args];
      } catch { return []; }
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ userOpHash: getUserOperationHash(operation, entry.address, chainId), sender: account, success: true });
    expect(events[0]!.actualGasCost).toBeGreaterThan(0n);
    await assertRejected(operation, ["AA25 invalid account nonce"]); // An executed request cannot charge again.
    expect(BigInt(await rpc<Hex>("eth_getBalance", [recipient, "latest"])) - before).toBe(10n ** 17n);
  });

  it("runs the maximum estimation stub through real FCL before rejecting it, without making it an approval", async () => {
    const signature = passkeyDummyContractSignature();
    expect(size(signature)).toBe(2240);
    const envelope = passkeyDummySignature({ signer, ...validity });
    expect(size(envelope)).toBe(2349);
    const challenge = signedOperation().payload.digest;
    const trace = async (contractSignature: Hex) => rpc<{ gas: number; failed: boolean; returnValue: Hex }>("debug_traceCall", [
      { to: signer, data: encodeFunctionData({ abi: erc1271Abi, functionName: "isValidSignature", args: [challenge, contractSignature] }), gas: "0x7a120" },
      "latest", { disableMemory: true, disableStack: true, disableStorage: true },
    ]);
    const full = await trace(signature);
    // Keep all ABI/client-data bytes identical except scalar r. Zero r exits the actual FCL
    // verifier before scalar multiplication; a cryptographically invalid valid-range pair does not.
    const early = await trace(concatHex([sliceHex(signature, 0, 64), toHex(0, { size: 32 }), sliceHex(signature, 96)]));
    for (const observed of [full, early]) {
      expect(observed.failed).toBe(false);
      expect(BigInt(observed.returnValue)).toBe(0n);
    }
    expect(full.gas - early.gas).toBeGreaterThan(30_000);
    expect(full.gas).toBeLessThan(500_000);
    await assertRejected({ ...unsignedOperation(), signature: envelope });
  });

  it("rejects changed payment simulations and rolls back a broadcast destination substitution", async () => {
    const { operation } = signedOperation();
    const changedCalls = [
      { target: backup, value: "100000000000000000", callData: "0x" as Hex },
      { target: recipient, value: "100000000000000001", callData: "0x" as Hex },
      { target: recipient, value: "100000000000000000", callData: "0x01" as Hex },
    ].map((call) => ({ ...operation, callData: encodeSafe7579Execution([call]) }));
    for (const changed of [
      ...changedCalls, { ...operation, nonce: "0x1" as Hex },
      { ...operation, maxFeePerGas: toHex(3_000_000_000) },
      { ...operation, maxPriorityFeePerGas: toHex(2_000_000_000) },
      { ...operation, verificationGasLimit: toHex(900_000) },
      { ...operation, callGasLimit: toHex(300_000) },
      { ...operation, preVerificationGas: toHex(200_000) },
      { ...operation, signature: concatHex([sliceHex(operation.signature, 0, 6), toHex(1_800_000_400, { size: 6 }), sliceHex(operation.signature, 12)]) },
      { ...operation, signature: concatHex([sliceHex(operation.signature, 0, 44), toHex(64, { size: 32 }), sliceHex(operation.signature, 76)]) },
    ]) await assertRejected(changed, changed.nonce !== operation.nonce
      ? ["AA25 invalid account nonce"] : ["AA24 signature error", "AA23 reverted"]);
    // eth_call cannot prove persistence. Broadcast one invalid operation and verify actual
    // failure with no wallet debit, deposit debit or nonce consumption in the mined state.
    const balance = await rpc<Hex>("eth_getBalance", [account, "latest"]);
    const deposit = await read(entry, "balanceOf", [account]);
    await send(handleOps(changedCalls[0]!), entry.address, "0x0", "0x0");
    expect(await rpc<Hex>("eth_getBalance", [account, "latest"])).toBe(balance);
    expect(await read(entry, "balanceOf", [account])).toBe(deposit);
    expect(await read(entry, "getNonce", [account, 0n])).toBe(0n);
  });

  it("keeps SafeMessage authentication and payment approvals cryptographically separate", async () => {
    const { operation, payload, contractSignature } = signedOperation();
    const paymentAsLogin = encodeSafe7579MessageSignature([{ kind: "contract", owner: signer, signature: contractSignature }]);
    expect(await authenticate(payload.digest, paymentAsLogin)).toBe(false);
    const login = safe7579MessageSigningPayload({ safe: account, chainId, requestDigest: payload.digest });
    operation.signature = encodeSafe7579PasskeyOwnerSignature({
      ...validity, signatures: [{ kind: "contract", owner: signer, signature: assertion(login.digest, "login") }],
    });
    await assertRejected(operation);
  });

  it("rejects a signature from another authority chain and an expired real approval", async () => {
    const { operation } = signedOperation();
    const wrongChain = safe7579PasskeyOwnerSigningPayload({ operation, chainId: 1, safe7579: adapter.address, entryPoint: entry.address, ...validity });
    await assertRejected({ ...operation, signature: encodeSafe7579PasskeyOwnerSignature({
      ...validity, signatures: [{ kind: "contract", owner: signer, signature: assertion(wrongChain.digest, "payment") }],
    }) });
    await rpc("evm_setNextBlockTimestamp", [1_800_000_301]);
    await rpc("evm_mine");
    await assertRejected(operation, ["AA22 expired or not due"]);
  });
});
