// Test-only local chain with publicly known keys and synthetic genesis balances. Never forks.
import { type ChildProcess } from "node:child_process";
import { spawnAnvil } from "../support/anvil.js";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { decodeFunctionResult, encodeFunctionData, getAddress, hashTypedData, keccak256, toHex, type Abi, type Address, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import type { RestRpc } from "../../src/rest/core.js";
import type { ContractPin, SmartAccountManifest } from "../../src/rest/smartAccounts/types.js";
import { SAFE7579_INSPECTOR_ID } from "../../src/rest/smartAccounts/inspector.js";
import type { RelayPolicy } from "../../src/rest/transactions/types.js";
import { createWalletDeploymentChain } from "../../src/rest/wallet/deploymentChain.js";
import { prepareWalletDeploymentApproval, prepareWalletDeploymentTemplate, validateSignedWalletDeployment,
  verifyWalletDeploymentProof, walletDeploymentDocument, type WalletDeploymentTemplate } from "../../src/rest/wallet/deployment.js";
import type { WalletDeploymentExecutionContext } from "../../src/rest/wallet/deploymentDispatch.js";
import type { WalletDeploymentOperation, WalletDeploymentPoolConfiguration } from "../../src/rest/wallet/deploymentPostgres.js";
import { createWalletEnrollmentIntent, enrollmentDigest, prepareWalletEnrollmentCandidate, verifyWalletEnrollmentProof,
  walletEnrollmentDocument, type WalletEnrollment } from "../../src/rest/wallet/enrollment.js";
import { createRegistration, enrollmentBackupAccount, signBackupProof, signGet } from "./wallet-enrollment-crypto.js";

type Artifact = { address: Address; canonicalAddress?: Address; abi: Abi; bytecode: Hex; deployedBytecode: Hex;
  deployedRuntimeBytecode?: Hex; runtimeCodeHash: Hex; source: { repo?: string; repository?: string; commit: string; artifactSha256?: string } };
function artifact(name: string, directory = "") {
  const bytes = readFileSync(new URL(`../../src/rest/smartAccounts/stack/${directory}artifacts/${name}.json`, import.meta.url));
  return { bytes, value: JSON.parse(bytes.toString()) as Artifact };
}
const readMethods = new Set(["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getCode", "eth_getStorageAt",
  "eth_getBalance", "eth_getTransactionCount", "eth_call", "eth_estimateGas", "eth_getTransactionReceipt",
  "eth_getTransactionByHash", "eth_getTransactionByBlockHashAndIndex", "eth_getRawTransactionByHash", "eth_getLogs", "debug_traceTransaction"]);

/** For a separate local PG worker observing the same parent-spawned Anvil process. */
export function createWalletDeploymentAnvilRpc(endpoint: string): RestRpc {
  if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(endpoint)) throw new Error("Fixture requires a literal local endpoint");
  let id = 0;
  return { async request(chain, method, params, signal) {
    if (chain !== 8453 || !readMethods.has(method)) throw new Error("Fixture observer requested a forbidden method");
    const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, redirect: "error",
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) });
    const value = await response.json() as { error?: unknown; result: unknown };
    if (!response.ok || value.error) throw new Error("Local fixture observer RPC failed");
    return value.result;
  } };
}

/** `setup` runs before the baseline snapshot so `reset()` restores its state too. */
export async function startWalletDeploymentAnvil(setup?: (rpc: <T = unknown>(method: string, params?: readonly unknown[]) => Promise<T>) => Promise<void>) {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  const endpoint = `http://127.0.0.1:${port}`;
  // Repeated snapshot resets and finality mining still consume Anvil's history cache.
  // Keep enough in-memory history for trace verification.
  const child: ChildProcess = spawnAnvil(["--host", "127.0.0.1", "--port", String(port),
    "--chain-id", "8453", "--hardfork", "cancun", "--silent"], { history: 4096 });
  let requestId = 0;
  async function rpc<T = unknown>(method: string, params: readonly unknown[] = [], signal?: AbortSignal): Promise<T> {
    const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }), redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) });
    const result = await response.json() as { result: T; error?: unknown };
    if (!response.ok || result.error) throw new Error(`Local fixture RPC failed: ${method}`);
    return result.result;
  }
  async function close() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const done = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill("SIGKILL"); await done;
  }
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error("Local Anvil exited during startup");
      try { if (await rpc("eth_chainId") === "0x2105") { ready = true; break; } } catch { /* bounded startup */ }
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    if (!ready) throw new Error("Local Anvil did not start");
    const expectedGenesisHash = (await rpc<{ hash: Hex }>("eth_getBlockByNumber", ["0x0", false])).hash;
    const treasury = mnemonicToAccount("test test test test test test test test test test test junk");
    const sender = treasury.address.toLowerCase() as Address;
    const readOnlyRpc: RestRpc = { request(chain, method, params, signal) {
      if (chain !== 8453 || !readMethods.has(method)) throw new Error("Fixture observer requested a forbidden method");
      return rpc(method, params, signal);
    } };
    const pin = (a: Artifact): ContractPin => ({ address: a.address, runtimeCodeHash: a.runtimeCodeHash,
      source: { repository: a.source.repo!, commit: a.source.commit, artifactSha256: a.source.artifactSha256! } });
    const safe = artifact("SafeL2").value, factory = artifact("SafeProxyFactory").value, proxy = artifact("SafeProxy").value,
      adapter = artifact("Safe7579").value, launchpad = artifact("Safe7579Launchpad").value, util = artifact("Safe7579DCUtil").value,
      entry = artifact("EntryPoint").value, creator = artifact("SenderCreator").value, sessions = artifact("SmartSession").value,
      multisend = artifact("MultiSend", "passkey/bootstrap/"), signerFactory = artifact("SafeWebAuthnSignerFactory", "passkey/"),
      signerSingleton = artifact("SafeWebAuthnSignerSingleton", "passkey/"), fcl = artifact("FCLP256Verifier", "passkey/");
    for (const a of [safe, factory, adapter, launchpad, util, entry, creator, sessions, multisend.value]) {
      const code = a.deployedRuntimeBytecode ?? a.deployedBytecode;
      if (keccak256(code) !== a.runtimeCodeHash) throw new Error("Fixture artifact runtime mismatch");
      await rpc("anvil_setCode", [a.canonicalAddress ?? a.address, code]);
    }
    async function deploy(a: Artifact): Promise<Address> {
      const hash = await rpc<Hex>("eth_sendTransaction", [{ from: sender, data: a.bytecode, gas: "0xf42400" }]);
      let receipt: { status: Hex; contractAddress: Address } | null = null;
      for (let i = 0; i < 100; i++) {
        receipt = await rpc("eth_getTransactionReceipt", [hash]); if (receipt) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (receipt?.status !== "0x1") throw new Error("Local fixture contract failed to deploy");
      return receipt.contractAddress;
    }
    const fclAddress = await deploy(fcl.value), signerFactoryAddress = await deploy(signerFactory.value);
    const singletonAddress = decodeFunctionResult({ abi: signerFactory.value.abi, functionName: "SINGLETON", data: await rpc<Hex>("eth_call",
      [{ to: signerFactoryAddress, data: encodeFunctionData({ abi: signerFactory.value.abi, functionName: "SINGLETON" }) }, "latest"]) }) as Address;
    async function deployedPin(a: ReturnType<typeof artifact>, address: Address): Promise<ContractPin> {
      return { address: getAddress(address), runtimeCodeHash: keccak256(await rpc<Hex>("eth_getCode", [address, "latest"])),
        source: { repository: a.value.source.repository!, commit: a.value.source.commit, artifactSha256: createHash("sha256").update(a.bytes).digest("hex") } };
    }
    const utility = pin(util);
    const manifest: SmartAccountManifest = { id: "wallet-dispatch-unforked-anvil", mode: "execution-candidate", chainId: 8453,
      revision: keccak256(toHex("wallet-dispatch-unforked-anvil")), safeVersion: "1.4.1", proxyRuntimeCodeHash: proxy.runtimeCodeHash,
      singleton: pin(safe), factory: pin(factory), safe7579: pin(adapter), launchpad: pin(launchpad),
      entryPoint: { ...pin(entry), version: "0.7" }, smartSessions: { ...pin(sessions), generation: "legacy-validator" },
      policies: [], moduleInspectorId: SAFE7579_INSPECTOR_ID,
      ownerProfile: { version: "center-passkey-v1", signerFactory: await deployedPin(signerFactory, signerFactoryAddress),
        signerSingleton: await deployedPin(signerSingleton, singletonAddress), p256Verifier: await deployedPin(fcl, fclAddress) },
      creationProfile: { version: "center-passkey-bootstrap-v1", multiSend: { address: getAddress(multisend.value.canonicalAddress!),
        runtimeCodeHash: multisend.value.runtimeCodeHash, source: { repository: multisend.value.source.repository!,
          commit: multisend.value.source.commit, artifactSha256: createHash("sha256").update(multisend.bytes).digest("hex") } } } };
    const configuration: WalletDeploymentPoolConfiguration = { id: randomUUID(), chainId: 8453, sender,
      allocationWei: "100000000000000000", globalAllocationLimitWei: "1000000000000000000",
      policy: { maximumRawBytes: 32768, maximumGas: "2000000", maximumFeePerGas: "10000000000",
        maximumTransactionCost: "20000000000000000", maximumObservationAgeMs: 5000 } };
    const chain = () => createWalletDeploymentChain({ rpc: readOnlyRpc, configuration, manifest, utility });
    async function signFrozenTransaction(template: WalletDeploymentTemplate): Promise<Hex> {
      enrollmentDigest(template); const { transaction: tx } = structuredClone(template);
      if (template.sender !== sender) throw new Error("Fixture signer mismatch");
      return treasury.signTransaction({ type: "eip1559", chainId: tx.chainId, to: tx.to, data: tx.data,
        nonce: Number(tx.nonce), value: BigInt(tx.value), gas: BigInt(tx.gas), maxFeePerGas: BigInt(tx.maxFeePerGas),
        maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas), accessList: [] });
    }
    async function createEnrollment() {
      const createdAt = Date.now(), intent = createWalletEnrollmentIntent({ manifest, rpId: "wallet.juicebox.center",
        origin: "https://wallet.juicebox.center", recoveryOwner: enrollmentBackupAccount.address, expiresAt: createdAt + 120_000 });
      const empty: WalletEnrollment = { intent, createdAt, state: "awaiting_registration", candidate: null,
        candidateDigest: null, creation: null, possession: null, receipt: null };
      const credential = createRegistration({ challenge: `0x${Buffer.from(intent.registration.challenge, "base64url").toString("hex")}`,
        rpId: intent.rpId, origin: intent.origin, userHandle: intent.userHandle });
      const pending: WalletEnrollment = { ...empty, ...prepareWalletEnrollmentCandidate(empty, credential.response), state: "awaiting_possession" };
      const document = walletEnrollmentDocument(pending), assertion = signGet({ ...credential, challenge: hashTypedData(document), rpId: intent.rpId, origin: intent.origin });
      const proof = await verifyWalletEnrollmentProof(pending, { assertion, backupSignature: await signBackupProof(document) });
      // This receipt stands in for W3 storage only in adapter tests. Combined PG tests use the real store.
      const enrollment: WalletEnrollment = { ...pending, state: "verified", receipt: { id: intent.id, enrollmentId: intent.id,
        accountId: `eip155:8453:${pending.creation!.address.toLowerCase()}`, credentialId: credential.credentialId,
        initializerHash: pending.creation!.initializerHash, manifestCommitment: `0x${enrollmentDigest(intent.manifest)}`,
        manifestRevision: manifest.revision, creationCommitment: `0x${enrollmentDigest(pending.creation)}`,
        verificationDigest: proof.verificationDigest, verifiedAt: Date.now() } };
      return { enrollment, credential };
    }
    async function signedContext(): Promise<WalletDeploymentExecutionContext> {
      const { enrollment, credential } = await createEnrollment(), now = Date.now();
      const approval = prepareWalletDeploymentApproval(enrollment, { issuedAt: now, expiresAt: now + 120_000 });
      const admitted = await chain().preflight(enrollment, approval);
      const policy: RelayPolicy = { allowedChainIds: [8453], planTtlMs: 300000, maximumPlanTtlMs: 300000, leaseMs: 15000,
        rpcTimeoutMs: 1000, confirmations: 1, maximumRawBytes: configuration.policy.maximumRawBytes,
        maximumGas: BigInt(configuration.policy.maximumGas), maximumFeePerGas: BigInt(configuration.policy.maximumFeePerGas),
        maximumTransactionCost: BigInt(configuration.policy.maximumTransactionCost) };
      const template = prepareWalletDeploymentTemplate(enrollment, approval, { sender, nonce: admitted.admission.confirmedNonce,
        gas: admitted.admission.gas, maxFeePerGas: admitted.admission.maxFeePerGas, maxPriorityFeePerGas: admitted.admission.maxPriorityFeePerGas }, policy);
      const rawTransaction = await signFrozenTransaction(template), signed = await validateSignedWalletDeployment({ enrollment, approval, template, rawTransaction, policy });
      const proof = verifyWalletDeploymentProof(enrollment, approval, signGet({ ...credential,
        challenge: hashTypedData(walletDeploymentDocument(enrollment, approval)), rpId: enrollment.intent.rpId, origin: enrollment.intent.origin }), now);
      const operation: WalletDeploymentOperation = { id: approval.id, poolId: configuration.id, enrollmentId: enrollment.intent.id,
        poolConfigurationDigest: enrollmentDigest(configuration), approval, state: "signed", createdAt: now, retainUntil: now + 86400000,
        claimedAt: now, proofDigest: proof.verificationDigest, admission: admitted.admission, template, templateCommitment: signed.templateCommitment,
        signingLease: null, signed: { rawTransaction, hash: signed.hash, maximumExecutionCost: signed.maximumExecutionCost },
        observation: null, observationSavedAt: null, historicalCanonicalObservation: null, highestObservedHead: null, releasedAt: null, reservedWei: null, revision: 4 };
      operation.observation = await chain().observeSigned({ enrollment, operation });
      operation.observationSavedAt = Date.now(); operation.highestObservedHead = operation.observation.head!.blockNumber;
      return { pool: { configuration, configurationDigest: enrollmentDigest(configuration), createdAt: now,
        state: "active", activeOperationId: operation.id, reservedWei: "0", revision: 2 }, enrollment, operation };
    }
    await setup?.(rpc);
    let baseline = await rpc<Hex>("evm_snapshot");
    async function reset() {
      const pending = await rpc<{ transactions: { hash: Hex }[] }>("eth_getBlockByNumber", ["pending", true]);
      for (const tx of pending.transactions) await rpc("anvil_dropTransaction", [tx.hash]);
      if (!await rpc("evm_revert", [baseline])) throw new Error("Local fixture snapshot missing");
      baseline = await rpc<Hex>("evm_snapshot"); await rpc("evm_setAutomine", [true]);
    }
    return { endpoint, expectedGenesisHash, manifest, utility, configuration, sender, rpc, readOnlyRpc, chain,
      createEnrollment, signedContext, signFrozenTransaction, reset, close };
  } catch (error) { await close(); throw error; }
}
