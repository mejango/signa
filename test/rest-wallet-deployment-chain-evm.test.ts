import { type ChildProcess } from "node:child_process";
import { anvilAvailable, spawnAnvil } from "./support/anvil.js";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { decodeFunctionResult, encodeFunctionData, getAddress, hashTypedData, keccak256, toHex,
  type Abi, type Address, type Hex } from "viem";
import type { RestRpc } from "../src/rest/core.js";
import type { ContractPin, SmartAccountManifest } from "../src/rest/smartAccounts/types.js";
import { SAFE7579_INSPECTOR_ID } from "../src/rest/smartAccounts/inspector.js";
import { createWalletDeploymentChain } from "../src/rest/wallet/deploymentChain.js";
import { prepareWalletDeploymentApproval, type WalletDeploymentApproval } from "../src/rest/wallet/deployment.js";
import type { WalletDeploymentPoolConfiguration } from "../src/rest/wallet/deploymentPostgres.js";
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

describe.skipIf(!available)("read-only wallet deployment preflight against the pinned Base EVM", () => {
  let child: ChildProcess | undefined, endpoint: string, baseline: Hex, sender: Address;
  let manifest: SmartAccountManifest, configuration: WalletDeploymentPoolConfiguration;
  let enrollment: WalletEnrollment, approval: WalletDeploymentApproval, clock: number, requestId = 0;
  const observed: { method: string; params: readonly unknown[] }[] = [];
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
      "eth_getBalance", "eth_getTransactionCount", "eth_call", "eth_estimateGas"]).toContain(method);
    observed.push({ method, params: structuredClone(params) }); return rpc(method, params, signal);
  } };
  async function send(data: Hex, to?: Address) {
    const hash = await rpc<Hex>("eth_sendTransaction", [{ from: sender, ...(to ? { to } : {}), data, gas: "0xf42400" }]);
    let receipt: { status: Hex; contractAddress: Address | null } | null = null;
    for (let i = 0; i < 100; i++) {
      receipt = await rpc("eth_getTransactionReceipt", [hash]); if (receipt) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!receipt) throw new Error("Local fixture deployment did not mine before its deadline");
    expect(receipt.status).toBe("0x1"); return receipt;
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
  async function createEnrolledSigner() {
    await send(enrollment.creation!.bootstrap.signerFactoryData, manifest.ownerProfile!.signerFactory.address);
  }
  async function creationStillSimulates() {
    const creation = enrollment.creation!;
    const result = await rpc<Hex>("eth_call", [{ from: sender, ...creation.transaction, value: "0x0", gas: "0x1e8480" }, "latest"]);
    const address = decodeFunctionResult({ abi: factory.abi, functionName: "createProxyWithNonce", data: result }) as Address;
    expect(address.toLowerCase()).toBe(creation.address.toLowerCase());
  }
  beforeAll(async () => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve) => server.close(() => resolve())); endpoint = `http://127.0.0.1:${port}`;
    child = spawnAnvil(["--host", "127.0.0.1", "--port", String(port), "--chain-id", "8453", "--hardfork", "cancun", "--silent"]);
    for (let i = 0; i < 100; i++) { try { await rpc("eth_chainId"); break; } catch { await new Promise((resolve) => setTimeout(resolve, 30)); } }
    [sender] = await rpc<[Address]>("eth_accounts");
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
    const credential = createRegistration({ challenge: `0x${Buffer.from(intent.registration.challenge, "base64url").toString("hex")}`,
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
    observed.length = 0;
  });
  afterAll(async () => {
    if (child && child.exitCode === null) { const done = new Promise<void>(resolve => child!.once("exit", () => resolve())); child.kill("SIGTERM"); await done; }
  });

  it.each([false, true])("simulates the exact atomic creation with signer already deployed=%s and leaves all chain state unchanged", async (deployed) => {
    if (deployed) await createEnrolledSigner();
    const before = await unchangedState(), result = await preflight(), creation = enrollment.creation!;
    expect(result.signer).toEqual({ address: creation.bootstrap.signerAddress, deployed });
    expect(result.dispatchEligible).toBe(false);
    expect(result.evidence).toMatchObject({ chainId: 8453, blockNumber: BigInt(before.block).toString(), source: "onchain" });
    expect(await preflight()).toEqual(result);
    expect(result.feeModel).toMatchObject({ kind: "base-execution-only-v1", balance: BigInt(before.balance).toString(),
      executionEnvelopeCovered: true, baseTotalAffordability: "unknown" });
    expect(BigInt(result.feeModel.estimatedGas)).toBeGreaterThan(21_000n);
    expect(result.admission).toMatchObject({ chainId: 8453, sender: configuration.sender,
      confirmedNonce: BigInt(before.nonce).toString(), pendingNonce: BigInt(before.nonce).toString(),
      enrollmentCommitment: approval.enrollmentCommitment, manifestRevision: manifest.revision,
      initializerHash: creation.initializerHash, blockHash: result.evidence.blockHash });
    const gas = (BigInt(result.feeModel.estimatedGas) * 125n + 99n) / 100n + 25_000n;
    expect(result.admission.gas).toBe(gas.toString());
    expect(result.admission.maxPriorityFeePerGas).toBe("1000000");
    expect(result.admission.maxFeePerGas).toBe((BigInt(result.feeModel.baseFeePerGas) * 2n + 1_000_000n).toString());
    expect(result.feeModel.maximumExecutionCost).toBe((gas * BigInt(result.admission.maxFeePerGas)).toString());
    expect(result.template.transaction).toMatchObject({ to: creation.transaction.to, data: creation.transaction.data,
      value: "0", type: "eip1559", chainId: 8453, nonce: BigInt(before.nonce).toString(), accessList: [] });
    const factoryCalls = observed.filter(call => ["eth_call", "eth_estimateGas"].includes(call.method) &&
      String((call.params[0] as { to?: string }).to).toLowerCase() === creation.transaction.to.toLowerCase());
    expect(factoryCalls.some(call => call.method === "eth_call")).toBe(true);
    expect(factoryCalls.some(call => call.method === "eth_estimateGas")).toBe(true);
    for (const call of factoryCalls) {
      const tx = call.params[0] as { from: Address; to: Address; data: Hex; value: Hex };
      expect(tx.from.toLowerCase()).toBe(configuration.sender);
      expect(tx.data.toLowerCase()).toBe(creation.transaction.data.toLowerCase()); expect(BigInt(tx.value)).toBe(0n);
    }
    expect(await unchangedState()).toEqual(before); expect(before.safeCode).toBe("0x");
    expect(deployed ? before.signerCode !== "0x" : before.signerCode === "0x").toBe(true);
  });

  it("rejects counterfeit code already occupying the deterministic signer address", async () => {
    await rpc("anvil_setCode", [enrollment.creation!.bootstrap.signerAddress, "0x60006000"]);
    // Factory simulation alone accepts this occupancy. Exact signer validation must reject it.
    await creationStillSimulates();
    await expect(preflight()).rejects.toThrow();
    expect(await rpc("eth_getCode", [enrollment.creation!.address, "latest"])).toBe("0x");
  });
  it("rejects a genuine signer runtime carrying a different immutable public key", async () => {
    const args = [0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
      0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n, BigInt(manifest.ownerProfile!.p256Verifier.address)];
    const other = await read(signerFactory.abi, manifest.ownerProfile!.signerFactory.address, "getSigner", args) as Address;
    expect(other.toLowerCase()).not.toBe(enrollment.creation!.bootstrap.signerAddress.toLowerCase());
    await send(encodeFunctionData({ abi: signerFactory.abi, functionName: "createSigner", args }), manifest.ownerProfile!.signerFactory.address);
    const runtime = await rpc<Hex>("eth_getCode", [other, "latest"]);
    await rpc("anvil_setCode", [enrollment.creation!.bootstrap.signerAddress, runtime]);
    await creationStillSimulates();
    await expect(preflight()).rejects.toThrow();
  });
  it.each(["signerFactory", "signerSingleton", "p256Verifier"] as const)("rejects changed %s dependency runtime", async name => {
    await rpc("anvil_setCode", [manifest.ownerProfile![name].address, "0x60006000"]);
    await creationStillSimulates();
    await expect(preflight()).rejects.toThrow();
  });
  it("rejects delegated recovery-owner code", async () => {
    await rpc("anvil_setCode", [enrollment.intent.recoveryOwner, `0xef0100${sender.slice(2)}`]);
    await creationStillSimulates();
    await expect(preflight()).rejects.toThrow();
  });
  it("rejects a balance below the execution envelope without calling it a total-fee check", async () => {
    await rpc("anvil_setBalance", [sender, "0x1"]);
    await expect(preflight()).rejects.toThrow();
    expect(await rpc("eth_getCode", [enrollment.creation!.address, "latest"])).toBe("0x");
  });
  it("rejects a gas policy that cannot contain the real atomic deployment", async () => {
    const low = { ...configuration, policy: { ...configuration.policy, maximumGas: "21000" } };
    await expect(preflight(low)).rejects.toThrow();
  });
});
