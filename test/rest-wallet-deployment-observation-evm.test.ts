import { type ChildProcess } from "node:child_process";
import { anvilAvailable, spawnAnvil } from "./support/anvil.js";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { concatHex, decodeFunctionResult, encodeFunctionData, getAddress, hashTypedData, keccak256, padHex, stringToHex, toHex, zeroAddress, zeroHash,
  type Abi, type Address, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import type { RelayPolicy } from "../src/rest/transactions/types.js";
import { assertWalletDeploymentObservation, type WalletDeploymentObservation } from "../src/rest/wallet/deploymentObservation.js";
import type { RestRpc } from "../src/rest/core.js";
import type { ContractPin, SmartAccountManifest } from "../src/rest/smartAccounts/types.js";
import { SAFE7579_INSPECTOR_ID } from "../src/rest/smartAccounts/inspector.js";
import { createWalletDeploymentChain } from "../src/rest/wallet/deploymentChain.js";
import { prepareWalletDeploymentApproval, prepareWalletDeploymentTemplate, validateSignedWalletDeployment, verifyWalletDeploymentProof, walletDeploymentDocument, type WalletDeploymentApproval } from "../src/rest/wallet/deployment.js";
import type { WalletDeploymentOperation, WalletDeploymentPoolConfiguration } from "../src/rest/wallet/deploymentPostgres.js";
import { createWalletEnrollmentIntent, enrollmentDigest, prepareWalletEnrollmentCandidate,
  verifyWalletEnrollmentProof, walletEnrollmentDocument, type WalletEnrollment } from "../src/rest/wallet/enrollment.js";
import { createRegistration, enrollmentBackupAccount, signBackupProof, signGet } from "./fixtures/wallet-enrollment-crypto.js";

type Artifact = { address: Address; canonicalAddress?: Address; abi: Abi; bytecode: Hex; deployedBytecode: Hex;
  deployedRuntimeBytecode?: Hex; runtimeCodeHash: Hex;
  source: { repo?: string; repository?: string; commit: string; artifactSha256?: string } };
const files = new Map<string, Buffer>();
function artifact(name: string, directory = ""): Artifact {
  const bytes = readFileSync(new URL(`../src/rest/smartAccounts/stack/${directory}artifacts/${name}.json`, import.meta.url));
  files.set(name, bytes); return JSON.parse(bytes.toString());
}
const safe = artifact("SafeL2"), factory = artifact("SafeProxyFactory"), proxy = artifact("SafeProxy"),
  adapter = artifact("Safe7579"), launchpad = artifact("Safe7579Launchpad"), utility = artifact("Safe7579DCUtil"),
  entry = artifact("EntryPoint"), senderCreator = artifact("SenderCreator"), sessions = artifact("SmartSession"),
  signerFactory = artifact("SafeWebAuthnSignerFactory", "passkey/"), signerSingleton = artifact("SafeWebAuthnSignerSingleton", "passkey/"),
  fcl = artifact("FCLP256Verifier", "passkey/"), multiSend = artifact("MultiSend", "passkey/bootstrap/");
const pin = (a: Artifact): ContractPin => ({ address: a.address, runtimeCodeHash: a.runtimeCodeHash,
  source: { repository: a.source.repo!, commit: a.source.commit, artifactSha256: a.source.artifactSha256! } });
const available = anvilAvailable();

describe.skipIf(!available)("read-only signed deployment observation against the pinned Base EVM", () => {
  let child: ChildProcess | undefined, endpoint: string, baseline: Hex, sender: Address, thirdParty: Address;
  let manifest: SmartAccountManifest, configuration: WalletDeploymentPoolConfiguration;
  let enrollment: WalletEnrollment, approval: WalletDeploymentApproval, clock: number, requestId = 0;
  let operation: WalletDeploymentOperation, credential: ReturnType<typeof createRegistration>;
  const treasury = mnemonicToAccount("test test test test test test test test test test test junk");
  const observed: { method: string; params: readonly unknown[] }[] = [];
  const traces: ReturnType<typeof traceSize>[] = [];
  function traceSize(value: unknown) {
    let frames = 0, frameDepth = 0, jsonNodes = 0, jsonDepth = 0;
    function walk(frame: unknown, level = 0) {
      if (!frame || typeof frame !== "object") return;
      frames++; frameDepth = Math.max(frameDepth, level);
      for (const next of (frame as { calls?: unknown[] }).calls ?? []) walk(next, level + 1);
    }
    function json(node: unknown, level = 0) {
      jsonNodes++; jsonDepth = Math.max(jsonDepth, level);
      if (node && typeof node === "object") for (const child of Object.values(node)) json(child, level + 1);
    }
    walk(value); json(value);
    return { bytes: Buffer.byteLength(JSON.stringify(value)), frames, frameDepth, jsonNodes, jsonDepth };
  }
  async function rpc<T = unknown>(method: string, params: readonly unknown[] = [], signal?: AbortSignal): Promise<T> {
    const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) });
    const result = await response.json() as { result: T; error?: { message: string } };
    if (result.error) throw new Error(`${method}: ${result.error.message}`); return result.result;
  }
  // The adapter can only use read methods. All setup mutations below bypass this transport.
  const transport: RestRpc = { request: (chainId, method, params, signal) => {
    expect(chainId).toBe(8453);
    expect(["eth_chainId", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getCode", "eth_getStorageAt",
      "eth_getBalance", "eth_getTransactionCount", "eth_call", "eth_estimateGas", "eth_getTransactionReceipt",
      "eth_getTransactionByHash", "eth_getTransactionByBlockHashAndIndex", "eth_getRawTransactionByHash", "eth_getLogs", "debug_traceTransaction"]).toContain(method);
    observed.push({ method, params: structuredClone(params) });
    return rpc(method, params, signal).then(result => {
      if (method === "debug_traceTransaction") {
        traces.push(traceSize(result));
      }
      return result;
    });
  } };
  async function send(data: Hex, to?: Address, from = sender) {
    const hash = await rpc<Hex>("eth_sendTransaction", [{ from, ...(to ? { to } : {}), data, gas: "0xf42400" }]);
    let receipt: { status: Hex; contractAddress: Address | null } | null = null;
    for (let i = 0; i < 100; i++) {
      receipt = await rpc("eth_getTransactionReceipt", [hash]); if (receipt) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!receipt) throw new Error("Local fixture deployment did not mine before its deadline");
    expect(receipt.status).toBe("0x1"); return { ...receipt, transactionHash: hash };
  }
  async function read(abi: Abi, address: Address, functionName: string, args: readonly unknown[] = []) {
    return decodeFunctionResult({ abi, functionName, data: await rpc<Hex>("eth_call", [
      { to: address, data: encodeFunctionData({ abi, functionName, args }) }, "latest"]) });
  }
  async function deployedPin(name: string, a: Artifact, address: Address): Promise<ContractPin> {
    return { address: getAddress(address), runtimeCodeHash: keccak256(await rpc<Hex>("eth_getCode", [address, "latest"])),
      source: { repository: a.source.repository!, commit: a.source.commit,
        artifactSha256: createHash("sha256").update(files.get(name)!).digest("hex") } };
  }
  const preflight = (config = configuration) => createWalletDeploymentChain({ rpc: transport, configuration: config,
    manifest, utility: pin(utility), now: () => clock }).preflight(enrollment, approval);
  async function unchangedState() {
    return {
      nonce: await rpc<Hex>("eth_getTransactionCount", [sender, "latest"]),
      balance: await rpc<Hex>("eth_getBalance", [sender, "latest"]),
      safeCode: await rpc<Hex>("eth_getCode", [enrollment.creation!.address, "latest"]),
      signerCode: await rpc<Hex>("eth_getCode", [enrollment.creation!.bootstrap.signerAddress, "latest"]),
      block: await rpc<Hex>("eth_blockNumber"),
    };
  }
  beforeAll(async () => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve) => server.close(() => resolve())); endpoint = `http://127.0.0.1:${port}`;
    child = spawnAnvil(["--host", "127.0.0.1", "--port", String(port), "--chain-id", "8453", "--hardfork", "cancun", "--silent"]);
    for (let i = 0; i < 100; i++) { try { await rpc("eth_chainId"); break; } catch { await new Promise((resolve) => setTimeout(resolve, 30)); } }
    [sender, thirdParty] = await rpc<[Address, Address]>("eth_accounts");
    expect(sender.toLowerCase()).toBe(treasury.address.toLowerCase());
    for (const a of [safe, factory, adapter, launchpad, utility, entry, senderCreator, sessions]) {
      const code = a.deployedRuntimeBytecode ?? a.deployedBytecode;
      expect(keccak256(code)).toBe(a.runtimeCodeHash); await rpc("anvil_setCode", [a.address, code]);
    }
    expect(keccak256(multiSend.deployedRuntimeBytecode!)).toBe(multiSend.runtimeCodeHash);
    await rpc("anvil_setCode", [multiSend.canonicalAddress!, multiSend.deployedRuntimeBytecode!]);
    const fclAddress = (await send(fcl.bytecode)).contractAddress!, factoryAddress = (await send(signerFactory.bytecode)).contractAddress!;
    const singletonAddress = await read(signerFactory.abi, factoryAddress, "SINGLETON") as Address;
    manifest = { id: "wallet-deployment-chain-local", mode: "execution-candidate", chainId: 8453,
      revision: keccak256(toHex("wallet-deployment-chain-local")), safeVersion: "1.4.1", proxyRuntimeCodeHash: proxy.runtimeCodeHash,
      singleton: pin(safe), factory: pin(factory), safe7579: pin(adapter), launchpad: pin(launchpad),
      entryPoint: { ...pin(entry), version: "0.7" }, smartSessions: { ...pin(sessions), generation: "legacy-validator" },
      policies: [], moduleInspectorId: SAFE7579_INSPECTOR_ID,
      ownerProfile: { version: "center-passkey-v1", signerFactory: await deployedPin("SafeWebAuthnSignerFactory", signerFactory, factoryAddress),
        signerSingleton: await deployedPin("SafeWebAuthnSignerSingleton", signerSingleton, singletonAddress),
        p256Verifier: await deployedPin("FCLP256Verifier", fcl, fclAddress) },
      creationProfile: { version: "center-passkey-bootstrap-v1", multiSend: { address: getAddress(multiSend.canonicalAddress!), runtimeCodeHash: multiSend.runtimeCodeHash,
        source: { repository: multiSend.source.repository!, commit: multiSend.source.commit,
          artifactSha256: createHash("sha256").update(files.get("MultiSend")!).digest("hex") } } } };
    configuration = { id: randomUUID(), chainId: 8453, sender: sender.toLowerCase() as Address,
      allocationWei: "100000000000000000", globalAllocationLimitWei: "1000000000000000000",
      policy: { maximumRawBytes: 32768, maximumGas: "2000000", maximumFeePerGas: "10000000000",
        maximumTransactionCost: "20000000000000000", maximumObservationAgeMs: 5000 } };
    const createdAt = Date.now();
    const intent = createWalletEnrollmentIntent({ manifest, rpId: "wallet.juicebox.center", origin: "https://wallet.juicebox.center",
      recoveryOwner: enrollmentBackupAccount.address, expiresAt: createdAt + 120_000 });
    const empty: WalletEnrollment = { intent, createdAt, state: "awaiting_registration", candidate: null,
      candidateDigest: null, creation: null, possession: null, receipt: null };
    credential = createRegistration({ challenge: `0x${Buffer.from(intent.registration.challenge, "base64url").toString("hex")}`,
      rpId: intent.rpId, origin: intent.origin, userHandle: intent.userHandle });
    const pending: WalletEnrollment = { ...empty, ...prepareWalletEnrollmentCandidate(empty, credential.response), state: "awaiting_possession" };
    const document = walletEnrollmentDocument(pending);
    const assertion = signGet({ ...credential, challenge: hashTypedData(document), rpId: intent.rpId, origin: intent.origin });
    const proof = await verifyWalletEnrollmentProof(pending, { assertion, backupSignature: await signBackupProof(document) });
    // Stand-in for the separately tested W3 durable receipt; this suite exercises real EVM reads, not DB admission.
    enrollment = { ...pending, state: "verified", receipt: { id: intent.id, enrollmentId: intent.id,
      accountId: `eip155:8453:${pending.creation!.address.toLowerCase()}`, credentialId: credential.credentialId,
      initializerHash: pending.creation!.initializerHash, manifestCommitment: `0x${enrollmentDigest(intent.manifest)}`,
      manifestRevision: intent.manifest.revision, creationCommitment: `0x${enrollmentDigest(pending.creation)}`,
      verificationDigest: proof.verificationDigest, verifiedAt: Date.now() } };
    baseline = await rpc<Hex>("evm_snapshot");
  }, 30_000);
  beforeEach(async () => {
    expect(await rpc("evm_revert", [baseline])).toBe(true); baseline = await rpc<Hex>("evm_snapshot");
    clock = Date.now(); approval = prepareWalletDeploymentApproval(enrollment, { issuedAt: clock, expiresAt: clock + 120_000 });
    await rpc("evm_setAutomine", [true]);
    const admitted = await preflight();
    const policy: RelayPolicy = { allowedChainIds: [8453], planTtlMs: 300000, maximumPlanTtlMs: 300000, leaseMs: 15000,
      rpcTimeoutMs: 1000, confirmations: 1, maximumRawBytes: configuration.policy.maximumRawBytes,
      maximumGas: BigInt(configuration.policy.maximumGas), maximumFeePerGas: BigInt(configuration.policy.maximumFeePerGas),
      maximumTransactionCost: BigInt(configuration.policy.maximumTransactionCost) };
    const template = prepareWalletDeploymentTemplate(enrollment, approval, {
      sender: configuration.sender, nonce: admitted.admission.confirmedNonce, gas: admitted.admission.gas,
      maxFeePerGas: admitted.admission.maxFeePerGas, maxPriorityFeePerGas: admitted.admission.maxPriorityFeePerGas,
    }, policy);
    const tx = template.transaction;
    const rawTransaction = await treasury.signTransaction({ ...tx, nonce: Number(tx.nonce), value: 0n,
      gas: BigInt(tx.gas), maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) });
    const signed = await validateSignedWalletDeployment({ enrollment, approval, template, rawTransaction, policy });
    const proof = verifyWalletDeploymentProof(enrollment, approval, signGet({ ...credential,
      challenge: hashTypedData(walletDeploymentDocument(enrollment, approval)), rpId: enrollment.intent.rpId,
      origin: enrollment.intent.origin }), clock);
    // Stand-in for separately tested atomic PostgreSQL claim/sign persistence; these bytes come
    // from the exact real producers, and only the test treasury key ever signs or dispatches.
    operation = { id: approval.id, poolId: configuration.id, enrollmentId: enrollment.intent.id,
      poolConfigurationDigest: enrollmentDigest(configuration), approval, state: "signed", createdAt: clock,
      retainUntil: clock + 86400000, claimedAt: clock, proofDigest: proof.verificationDigest, admission: admitted.admission,
      template, templateCommitment: signed.templateCommitment, signingLease: null,
      signed: { rawTransaction: signed.rawTransaction, hash: signed.hash, maximumExecutionCost: signed.maximumExecutionCost },
      observation: null, historicalCanonicalObservation: null, highestObservedHead: null, observationSavedAt: null, releasedAt: null, reservedWei: null, revision: 3 };
    observed.length = 0; traces.length = 0;
  });
  afterAll(async () => {
    if (child && child.exitCode === null) { const done = new Promise<void>(resolve => child!.once("exit", () => resolve())); child.kill("SIGTERM"); await done; }
  });

  const observer = (rpcOverride: RestRpc = transport) => createWalletDeploymentChain({
    rpc: rpcOverride, configuration, manifest, utility: pin(utility), now: () => clock,
  });
  const observe = async (rpcOverride: RestRpc = transport) => assertWalletDeploymentObservation(
    await observer(rpcOverride).observeSigned({ enrollment, operation }),
  );
  type Receipt = { transactionHash: Hex; blockHash: Hex; blockNumber: Hex; transactionIndex: Hex; status: Hex;
    gasUsed: Hex; effectiveGasPrice: Hex; logs: { address: Address; data: Hex; topics: Hex[] }[] };
  async function broadcast(expectedStatus: Hex = "0x1") {
    const hash = await rpc<Hex>("eth_sendRawTransaction", [operation.signed!.rawTransaction]);
    expect(hash).toBe(operation.signed!.hash);
    let receipt: Receipt | null = null;
    for (let i = 0; i < 100; i++) {
      receipt = await rpc<Receipt | null>("eth_getTransactionReceipt", [hash]); if (receipt) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (!receipt) throw new Error("Local signed fixture transaction did not mine");
    expect(receipt.status).toBe(expectedStatus); return receipt;
  }
  function unknownWallet(value: WalletDeploymentObservation) {
    expect(value.wallet.state).toBe("unknown");
    expect(value.wallet.stateHash).toBeNull();
    expect(value.wallet.evidence).toBeNull();
    expect(value.wallet.creationTransaction).toBeNull();
    expect(value.wallet.reason).toBeTruthy();
    expect(value.dispatchEligible).toBe(false);
  }

  it("observes exact canonical treasury execution, finality and enrolled current wallet without sending anything", async () => {
    const receipt = await broadcast(), before = await unchangedState();
    const trace = traceSize(await rpc("debug_traceTransaction", [receipt.transactionHash, { tracer: "callTracer" }]));
    expect(trace.bytes).toBeLessThan(1048576); expect(trace.jsonNodes).toBeLessThan(32768); expect(trace.jsonDepth).toBeLessThan(64);
    console.info("Actual pinned bootstrap trace", JSON.stringify(trace));
    const inputs = structuredClone({ enrollment, operation });
    const result = await observe();
    expect(result).toMatchObject({ version: "center-wallet-deployment-observation-v1", operationId: operation.id,
      templateCommitment: operation.templateCommitment, transactionHash: receipt.transactionHash, dispatchEligible: false,
      transaction: { state: "canonical-success", receipt: { status: "success", gasUsed: BigInt(receipt.gasUsed).toString(),
        effectiveGasPrice: BigInt(receipt.effectiveGasPrice).toString(), transactionIndex: BigInt(receipt.transactionIndex).toString(),
        block: { blockHash: receipt.blockHash, blockNumber: BigInt(receipt.blockNumber).toString() } },
        // The lane is released on this: the sender's nonce at the observed head is past the inclusion.
        nonce: { confirmed: String(BigInt(operation.template!.transaction.nonce) + 1n), pending: String(BigInt(operation.template!.transaction.nonce) + 1n) } },
      wallet: { state: "verified", address: enrollment.creation!.address.toLowerCase(), initializerHash: enrollment.creation!.initializerHash,
        creationTransaction: receipt.transactionHash },
      fees: { executionWei: (BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice)).toString(),
        l1Wei: null, operatorWei: null, totalWei: null } });
    expect(result.wallet.stateHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.wallet.evidence?.blockHash).toBe(result.head?.blockHash);
    const finalized = await rpc<{ number: Hex; hash: Hex }>("eth_getBlockByNumber", ["finalized", false]);
    expect(result.finality.state).toBe(BigInt(finalized.number) >= BigInt(receipt.blockNumber) ? "finalized" : "unfinalized");
    expect(traces.length).toBeGreaterThan(0);
    expect(observed.length).toBeLessThanOrEqual(256);
    console.info("Local deployment observation bounds", JSON.stringify({ calls: observed.length, traces }));
    expect(await unchangedState()).toEqual(before);
    expect({ enrollment, operation }).toEqual(inputs);
  });

  it("stops at the verified receipt when only the inclusion is asked for, with no trace or history read", async () => {
    const receipt = await broadcast(), full = await observe();
    observed.length = 0; traces.length = 0;
    const result = assertWalletDeploymentObservation(await observer().observeSigned({ enrollment, operation }, undefined, { inspection: "inclusion" }));
    // The same transaction, receipt, creation log, nonce and finality facts; the wallet's state is left for the inspection that follows.
    expect(result).toMatchObject({ transaction: full.transaction, finality: full.finality, fees: full.fees,
      wallet: { state: "unknown", reason: "inspection-deferred", stateHash: null, evidence: null, creationTransaction: null,
        address: enrollment.creation!.address.toLowerCase(), initializerHash: enrollment.creation!.initializerHash } });
    expect(result.transaction.receipt?.block.blockHash).toBe(receipt.blockHash);
    expect(traces).toEqual([]);
    expect(observed.filter(call => call.method === "eth_getLogs")).toEqual([]);
    expect(observed.length).toBeLessThan(16);
  });
  it("repeats canonical observation after enrollment and approval expiry with no chain or record mutation", async () => {
    await broadcast();
    clock = Math.max(approval.expiresAt, enrollment.intent.expiresAt) + 86400000;
    await rpc("evm_setNextBlockTimestamp", [Math.ceil(clock / 1000)]);
    await rpc("evm_mine");
    const before = await unchangedState(), frozen = structuredClone({ enrollment, operation });
    const first = await observe(), second = await observe();
    expect(first.transaction.state).toBe("canonical-success");
    expect(first.wallet.state).toBe("verified");
    expect(second).toEqual(first);
    expect(await unchangedState()).toEqual(before);
    expect({ enrollment, operation }).toEqual(frozen);
  });

  it("separates a treasury revert from a wallet created with the exact initializer by a third party", async () => {
    const creation = await send(enrollment.creation!.transaction.data, enrollment.creation!.transaction.to, thirdParty);
    const receipt = await broadcast("0x0");
    const result = await observe();
    expect(result.transaction).toMatchObject({ state: "canonical-revert", receipt: { status: "reverted", block: { blockHash: receipt.blockHash } } });
    expect(result.wallet.state).toBe("verified");
    expect(result.wallet.initializerHash).toBe(enrollment.creation!.initializerHash);
    expect(result.wallet.creationTransaction).toBe(creation.transactionHash);
    expect(result.fees.executionWei).toBe((BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice)).toString());
    expect(result.dispatchEligible).toBe(false);
  });

  it("does not turn an old creation receipt into proof of the original recovery owner after rotation", async () => {
    await broadcast();
    const address = enrollment.creation!.address;
    const owners = await read(safe.abi, address, "getOwners") as Address[];
    const index = owners.findIndex(owner => owner.toLowerCase() === enrollmentBackupAccount.address.toLowerCase());
    expect(index).toBeGreaterThanOrEqual(0);
    const previous = index === 0 ? "0x0000000000000000000000000000000000000001" : owners[index - 1]!;
    const data = encodeFunctionData({ abi: safe.abi, functionName: "swapOwner", args: [previous, enrollmentBackupAccount.address, thirdParty] });
    const signatures = concatHex([padHex(enrollmentBackupAccount.address, { size: 32 }), zeroHash, "0x01"]);
    const execution = encodeFunctionData({ abi: safe.abi, functionName: "execTransaction", args: [
      address, 0n, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, signatures,
    ] });
    await rpc("anvil_setBalance", [enrollmentBackupAccount.address, toHex(10n ** 18n)]);
    const signed = await enrollmentBackupAccount.signTransaction({ type: "eip1559", chainId: 8453, nonce: 0,
      to: address, data: execution, gas: 1000000n, maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1000000n });
    const hash = await rpc<Hex>("eth_sendRawTransaction", [signed]);
    for (let i = 0; i < 100; i++) {
      if (await rpc("eth_getTransactionReceipt", [hash])) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(await read(safe.abi, address, "isOwner", [enrollmentBackupAccount.address])).toBe(false);
    const result = await observe();
    expect(result.transaction.state).toBe("canonical-success");
    unknownWallet(result);
  });

  it("keeps a missing receipt as not-observed and undeployed without dispatch", async () => {
    const before = await unchangedState(), result = await observe();
    expect(result.transaction).toMatchObject({ state: "not-observed", receipt: null });
    expect(result.wallet.state).toBe("undeployed");
    expect(result.fees).toEqual({ executionWei: null, l1Wei: null, operatorWei: null, totalWei: null });
    expect(result.dispatchEligible).toBe(false);
    expect(await unchangedState()).toEqual(before);
  });

  it("reports pending signed bytes without upgrading them to a receipt or wallet", async () => {
    await rpc("evm_setAutomine", [false]);
    expect(await rpc("eth_sendRawTransaction", [operation.signed!.rawTransaction])).toBe(operation.signed!.hash);
    try {
      const result = await observe();
      expect(result.transaction).toMatchObject({ state: "pending", receipt: null });
      expect(result.wallet.state).toBe("undeployed");
      expect(result.finality.state).toBe("unknown");
      expect(result.dispatchEligible).toBe(false);
    } finally {
      // Anvil snapshots do not remove pending transactions. Clear this synthetic pending
      // request before reenabling mining so it cannot contaminate another fixture.
      await rpc("anvil_dropTransaction", [operation.signed!.hash]);
    }
  });

  it("proves a different canonical transaction consumed the treasury nonce without treating it as this deployment", async () => {
    const conflict = await send("0x", thirdParty);
    const result = await observe();
    expect(result.transaction).toMatchObject({ state: "nonce-conflict", receipt: null,
      conflict: { transactionHash: conflict.transactionHash } });
    expect(result.transactionHash).toBe(operation.signed!.hash);
    expect(result.transactionHash).not.toBe(conflict.transactionHash);
    expect(result.wallet.state).toBe("undeployed");
    expect(result.fees.executionWei).toBeNull();
    expect(result.dispatchEligible).toBe(false);
  });

  it.each(["throw", "reject"] as const)("drops current proof when the actual creation trace is unavailable (%s)", async mode => {
    await broadcast();
    let attempted = false;
    const result = await observe({ request: (chain, method, params, signal) => {
      if (method === "debug_traceTransaction") {
        attempted = true;
        const error = new Error("Synthetic unavailable trace");
        if (mode === "throw") throw error;
        return Promise.reject(error);
      }
      return transport.request(chain, method, params, signal);
    } });
    expect(attempted).toBe(true);
    unknownWallet(result);
    expect(result.head).toBeNull();
    expect(result.transaction).toMatchObject({ state: "unknown", receipt: null });
    expect(result.finality).toEqual({ state: "unknown", evidence: null });
  });

  it("rejects a forged creation log in the treasury receipt instead of proving the wallet with it", async () => {
    // The receipt's own ProxyCreation log is what proves the deployment to the wallet inspector,
    // so a provider that tampers with it must leave the whole observation unproven.
    await broadcast();
    let forged = false;
    const result = await observe({ request: async (chain, method, params, signal) => {
      const answer = await transport.request(chain, method, params, signal);
      if (method === "eth_getTransactionReceipt" && answer && typeof answer === "object" && Array.isArray((answer as Receipt).logs)) {
        forged = true;
        return { ...answer, logs: (answer as Receipt).logs.map(log => log.topics[0] === keccak256(stringToHex("ProxyCreation(address,address)")) ? { ...log, data: "0x" } : log) };
      }
      return answer;
    } });
    expect(forged).toBe(true);
    expect(result.transaction.state).not.toBe("canonical-success");
    expect(result.wallet.state).not.toBe("verified");
    expect(result.dispatchEligible).toBe(false);
  });
  it("proves the wallet from the verified receipt without scanning factory history from genesis", async () => {
    const receipt = await broadcast();
    const scans: { fromBlock: string }[] = [];
    const result = await observe({ request: async (chain, method, params, signal) => {
      if (method === "eth_getLogs") scans.push(params[0] as { fromBlock: string });
      return transport.request(chain, method, params, signal);
    } });
    expect(result.transaction).toMatchObject({ state: "canonical-success", receipt: { block: { blockHash: receipt.blockHash } } });
    expect(result.wallet.state).toBe("verified");
    expect(scans.length).toBeGreaterThan(0);
    expect(scans.map(scan => BigInt(scan.fromBlock) >= BigInt(receipt.blockNumber))).not.toContain(false);
  });

  it("drops current proof when a receipt block cannot be canonically rechecked", async () => {
    const receipt = await broadcast();
    let changed = false;
    const result = await observe({ request: async (chain, method, params, signal) => {
      const answer = await transport.request(chain, method, params, signal);
      if (method === "eth_getBlockByNumber" && params[0] === receipt.blockNumber && answer) {
        changed = true; return { ...answer as object, hash: `0x${"ab".repeat(32)}` };
      }
      return answer;
    } });
    expect(changed).toBe(true);
    expect(["unknown", "reorged"]).toContain(result.transaction.state);
    expect(result.wallet.state).not.toBe("verified");
    expect(result.dispatchEligible).toBe(false);
  });
});
