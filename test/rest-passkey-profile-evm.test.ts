import { type ChildProcess } from "node:child_process";
import { anvilAvailable, spawnAnvil } from "./support/anvil.js";
import { createECDH, createHash, createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  concatHex, decodeFunctionResult, encodeFunctionData, encodeFunctionResult, getAddress, hashTypedData,
  keccak256, padHex, parseAbi, toHex, zeroAddress, zeroHash, type Abi, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createSmartAccountService } from "../src/rest/smartAccounts/service.js";
import type { RestBlockEvidence } from "../src/rest/core.js";
import { prepareSafe7579Creation } from "../src/rest/smartAccounts/creation.js";
import { createSafe7579Inspector, SAFE7579_INSPECTOR_ID } from "../src/rest/smartAccounts/inspector.js";
import { createInstalledSessionVerifier } from "../src/rest/smartAccounts/installed.js";
import { MemorySmartAccountRegistry } from "../src/rest/smartAccounts/registry.js";
import { MemoryOnboardingStore } from "../src/rest/smartAccounts/onboardingMemory.js";
import { MemoryAccountStore } from "../src/rest/auth/memory.js";
import { inspectPasskeyOwnerProfile, passkeyOwnerProfileHolds } from "../src/rest/smartAccounts/passkeyProfile.js";
import { createPasskeyContractSignatureVerifier } from "../src/rest/smartAccounts/passkeyContractVerifier.js";
import { encodeSafe7579MessageSignature } from "../src/rest/smartAccounts/passkeySignatures.js";
import {
  passkeyOnboardingDocument, passkeyOnboardingProofDocument, passkeyOnboardingSigningPayload,
  verifyPasskeyOnboardingSignatures, type PasskeyOnboardingInput,
} from "../src/rest/smartAccounts/passkeyOnboarding.js";
import { createContractOwnerVerifier } from "../src/rest/contractOwner.js";
import { verifyWalletAssertion } from "../src/rest/wallet/webauthn.js";
import type { ContractPin, SmartAccountManifest, SmartAccountState, SmartSnapshot } from "../src/rest/smartAccounts/types.js";

type Artifact = {
  address: Address; abi: Abi; bytecode: Hex; deployedBytecode: Hex;
  deployedRuntimeBytecode?: Hex; runtimeCodeHash: Hex;
  source: { repo?: string; repository?: string; commit: string; artifactSha256?: string };
};
const files = new Map<string, Buffer>();
function artifact(name: string, passkey = false): Artifact {
  const bytes = readFileSync(new URL(`../src/rest/smartAccounts/stack/${passkey ? "passkey/" : ""}artifacts/${name}.json`, import.meta.url));
  files.set(name, bytes);
  return JSON.parse(bytes.toString());
}
const safe = artifact("SafeL2"), factory = artifact("SafeProxyFactory"), proxy = artifact("SafeProxy"),
  adapter = artifact("Safe7579"), launchpad = artifact("Safe7579Launchpad"), utility = artifact("Safe7579DCUtil"),
  entry = artifact("EntryPoint"), senderCreator = artifact("SenderCreator"), sessions = artifact("SmartSession"),
  signerFactory = artifact("SafeWebAuthnSignerFactory", true), signerSingleton = artifact("SafeWebAuthnSignerSingleton", true),
  fcl = artifact("FCLP256Verifier", true);
const pin = (a: Artifact): ContractPin => ({ address: a.address, runtimeCodeHash: a.runtimeCodeHash,
  source: { repository: a.source.repo!, commit: a.source.commit, artifactSha256: a.source.artifactSha256! } });
const publicKey = {
  x: "0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296" as Hex,
  y: "0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5" as Hex,
};
const configurationAbi = parseAbi(["function getConfiguration() view returns(uint256 x,uint256 y,uint176 verifiers)"]);
const available = anvilAvailable();
const browser = privateKeyToAccount(`0x${"43".repeat(32)}`);
const rpId = "wallet.juicebox.center", origin = `https://${rpId}`;
const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest();
// Known public local-test keys. The authenticator alone is synthetic; all contract verification is real.
function passkey(scalar: bigint) {
  const d = Buffer.from(toHex(scalar, { size: 32 }).slice(2), "hex"), curve = createECDH("prime256v1");
  curve.setPrivateKey(d);
  const point = curve.getPublicKey(undefined, "uncompressed"), x = point.subarray(1, 33), y = point.subarray(33);
  return { publicKey: { x: toHex(x), y: toHex(y) }, privateKey: createPrivateKey({ format: "jwk", key: {
    kty: "EC", crv: "P-256", x: x.toString("base64url"), y: y.toString("base64url"), d: d.toString("base64url"),
  } }) };
}
function assertion(digest: Hex, scalar: bigint) {
  const key = passkey(scalar), userHandle = Buffer.from("local-profile-user").toString("base64url"),
    credentialId = Buffer.from(`local-profile-credential-${scalar}`).toString("base64url");
  const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get",
    challenge: Buffer.from(digest.slice(2), "hex").toString("base64url"), origin, crossOrigin: false }));
  const authenticatorData = Buffer.concat([sha256(rpId), Buffer.from([0x05, 0, 0, 0, 0])]);
  return verifyWalletAssertion({ credentialId, userHandle, clientDataJSON, authenticatorData,
    signature: sign("sha256", Buffer.concat([authenticatorData, sha256(clientDataJSON)]), key.privateKey) },
  { challenge: digest, purpose: "session", rpId, origin, requireUserHandle: true,
    credential: { id: credentialId, userHandle, publicKey: key.publicKey, backupEligible: false } }).contractSignature;
}

describe.skipIf(!available)("canonical passkey owner profile in the pinned local EVM", () => {
  let child: ChildProcess | undefined, endpoint: string, baseline: Hex;
  let sender: Address, backup: Address, signer: Address, account: Address, manifest: SmartAccountManifest;
  let id = 0;
  async function rpc<T = unknown>(method: string, params: readonly unknown[] = []): Promise<T> {
    const result = await (await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal: AbortSignal.timeout(10_000),
    })).json() as { result: T; error?: { message: string } };
    if (result.error) throw new Error(`${method}: ${result.error.message}`);
    return result.result;
  }
  const transport = { request: (_chain: number, method: string, params: readonly unknown[]) => rpc(method, params) };
  async function send(data: Hex, to?: Address, from = sender) {
    const hash = await rpc<Hex>("eth_sendTransaction", [{ from, ...(to ? { to } : {}), data, gas: "0xf42400" }]);
    let receipt: { status: Hex; contractAddress: Address | null } | null = null;
    for (let attempt = 0; attempt < 100; attempt++) {
      receipt = await rpc("eth_getTransactionReceipt", [hash]);
      if (receipt) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!receipt) throw new Error("The local fixture transaction was not mined before its deadline.");
    expect(receipt.status).toBe("0x1");
    return getAddress(receipt.contractAddress ?? to!);
  }
  async function read(abi: Abi, address: Address, functionName: string, args: readonly unknown[] = []) {
    return decodeFunctionResult({ abi, functionName,
      data: await rpc<Hex>("eth_call", [{ to: address, data: encodeFunctionData({ abi, functionName, args }) }, "latest"]) });
  }
  async function deployedPin(name: string, a: Artifact, address: Address): Promise<ContractPin> {
    return { address, runtimeCodeHash: keccak256(await rpc<Hex>("eth_getCode", [address, "latest"])),
      source: { repository: a.source.repository!, commit: a.source.commit,
        artifactSha256: createHash("sha256").update(files.get(name)!).digest("hex") } };
  }
  function service(m = manifest, accounts?: MemoryAccountStore) {
    const registry = new MemorySmartAccountRegistry();
    return createSmartAccountService({ rpc: transport, manifests: [m], registry,
      ...(accounts ? { onboarding: new MemoryOnboardingStore(accounts, registry) } : {}),
      audience: "https://wallet.juicebox.center", moduleInspectors: [createSafe7579Inspector({ rpc: transport,
        utility: pin(utility), inspectSessions: createInstalledSessionVerifier({ rpc: transport }).inspectAllAt })] });
  }
  async function snapshot(): Promise<SmartSnapshot> {
    const block = await rpc<{ hash: Hex; number: Hex; timestamp: Hex }>("eth_getBlockByNumber", ["latest", false]);
    const tag = { blockHash: block.hash, requireCanonical: true as const };
    return { tag, evidence: { chainId: 8453, blockHash: block.hash, blockNumber: String(BigInt(block.number)),
      timestamp: String(BigInt(block.timestamp)), source: "onchain" }, request: (method, params) => rpc(method, [...params, tag]) };
  }
  const inspect = () => service().inspect({ manifestId: manifest.id, address: account });
  it("issues the dependency and owner reads concurrently rather than one after another", async () => {
    // Over a hosted provider each read costs a round trip; the pins, the singleton check and the
    // owner code reads are independent, so they must go out together.
    const base = await snapshot(); let inFlight = 0, peak = 0;
    const counted: SmartSnapshot = { ...base, request: async (method, params) => {
      inFlight++; peak = Math.max(peak, inFlight);
      try { return await base.request(method, params); } finally { inFlight--; }
    } };
    await inspectOwners({ snapshot: counted });
    expect(peak).toBeGreaterThanOrEqual(4);
  });
  async function inspectOwners(changes: Partial<Parameters<typeof inspectPasskeyOwnerProfile>[0]> = {}) {
    return inspectPasskeyOwnerProfile({ manifest, owners: [signer, backup], threshold: 1, snapshot: await snapshot(), ...changes });
  }
  function setupInput(state: SmartAccountState, nonce = 1n): PasskeyOnboardingInput {
    const issuedAt = Number(state.evidence.timestamp);
    return { profile: "center-passkey-v1", address: account, manifestId: manifest.id,
      nonce: toHex(nonce, { size: 32 }), issuedAt, expiresAt: issuedAt + 300,
      grant: { id: "550e8400-e29b-41d4-a716-446655440000", botAddress: browser.address,
        scopes: ["read", "plan", "relay"], expiresAt: issuedAt + 3600, label: "Local Beep setup" } };
  }
  async function approvedSetup(state: SmartAccountState, scalar = 1n, nonce = 1n) {
    const input = setupInput(state, nonce), document = passkeyOnboardingDocument(origin, input, state);
    const payload = passkeyOnboardingSigningPayload(document);
    const signature = encodeSafe7579MessageSignature([{ kind: "contract", owner: state.ownerProfile!.signer.address,
      signature: assertion(payload.digest, scalar) }]);
    const proofSignature = await browser.signTypedData(passkeyOnboardingProofDocument(document));
    return { input, document, signature, proofSignature };
  }
  const verifier = (state: SmartAccountState) => createPasskeyContractSignatureVerifier({ state, manifest, rpc: transport,
    now: () => Number(state.evidence.timestamp) * 1000 });
  beforeAll(async () => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    endpoint = `http://127.0.0.1:${port}`;
    child = spawnAnvil(["--host", "127.0.0.1", "--port", String(port), "--chain-id", "8453", "--hardfork", "cancun", "--silent"]);
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await rpc("eth_chainId"); break; } catch { await new Promise((resolve) => setTimeout(resolve, 30)); }
    }
    [sender, backup] = await rpc<[Address, Address]>("eth_accounts");
    backup = getAddress(backup);
    for (const a of [safe, factory, adapter, launchpad, utility, entry, senderCreator, sessions]) {
      const code = a.deployedRuntimeBytecode ?? a.deployedBytecode;
      expect(keccak256(code)).toBe(a.runtimeCodeHash);
      await rpc("anvil_setCode", [a.address, code]);
    }
    const fclAddress = await send(fcl.bytecode), factoryAddress = await send(signerFactory.bytecode);
    const singletonAddress = await read(signerFactory.abi, factoryAddress, "SINGLETON") as Address;
    const args = [BigInt(publicKey.x), BigInt(publicKey.y), BigInt(fclAddress)];
    signer = getAddress(await read(signerFactory.abi, factoryAddress, "getSigner", args) as Address);
    await send(encodeFunctionData({ abi: signerFactory.abi, functionName: "createSigner", args }), factoryAddress);
    manifest = { id: "local-center-passkey-v1", mode: "execution-candidate", chainId: 8453,
      revision: keccak256(toHex("local-center-passkey-v1")), safeVersion: "1.4.1", proxyRuntimeCodeHash: proxy.runtimeCodeHash,
      singleton: pin(safe), factory: pin(factory), safe7579: pin(adapter), launchpad: pin(launchpad),
      entryPoint: { ...pin(entry), version: "0.7" }, smartSessions: { ...pin(sessions), generation: "legacy-validator" },
      policies: [], moduleInspectorId: SAFE7579_INSPECTOR_ID,
      ownerProfile: { version: "center-passkey-v1", signerFactory: await deployedPin("SafeWebAuthnSignerFactory", signerFactory, factoryAddress),
        signerSingleton: await deployedPin("SafeWebAuthnSignerSingleton", signerSingleton, singletonAddress),
        p256Verifier: await deployedPin("FCLP256Verifier", fcl, fclAddress) } };
    const creation = prepareSafe7579Creation({ manifest, owners: [signer, backup], threshold: 1, saltNonce: "4343" });
    account = creation.address;
    await send(creation.transaction.data, factory.address);
    baseline = await rpc<Hex>("evm_snapshot");
  }, 30_000);
  beforeEach(async () => { expect(await rpc("evm_revert", [baseline])).toBe(true); baseline = await rpc<Hex>("evm_snapshot"); });
  afterAll(async () => {
    if (child && child.exitCode === null) {
      const exited = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
      child.kill("SIGTERM"); await exited;
    }
  });

  it("carries a verified state across empty blocks on the real chain, and inspects afresh once a device is added", async () => {
    const calls: string[] = [];
    const counted = { request: (chain: number, method: string, params: readonly unknown[]) => { calls.push(method); return transport.request(chain, method, params); } };
    const own = createSmartAccountService({ rpc: counted, manifests: [manifest], registry: new MemorySmartAccountRegistry(),
      audience: "https://wallet.juicebox.center", moduleInspectors: [createSafe7579Inspector({ rpc: counted,
        utility: pin(utility), inspectSessions: createInstalledSessionVerifier({ rpc: counted }).inspectAllAt })] });
    const full = await own.inspect({ manifestId: manifest.id, address: account }, undefined, undefined, true);
    const fullReads = calls.length;
    const evidenceAt = async (number: bigint): Promise<RestBlockEvidence> => {
      const block = await rpc<{ hash: Hex; number: Hex; timestamp: Hex }>("eth_getBlockByNumber", [toHex(number), false]);
      return { chainId: 8453, blockHash: block.hash, blockNumber: String(number), timestamp: String(BigInt(block.timestamp)), source: "onchain" };
    };
    for (let i = 0; i < 3; i++) await rpc("evm_mine", []);
    const later = await evidenceAt(BigInt(full.evidence.blockNumber) + 3n);
    calls.length = 0;
    const carried = await own.inspect({ manifestId: manifest.id, address: account }, undefined, later, true);
    expect(carried.stateHash).toBe(full.stateHash);
    expect(carried.evidence).toEqual(later);
    expect(calls.filter((m) => m === "debug_traceTransaction")).toEqual([]);
    expect(calls.length).toBeLessThan(fullReads / 2);
    // A device signer added to the account leaves its logs and a changed owner set: the pinned read
    // at that block is a full inspection again and shows the device.
    const device = passkey(9n);
    const args = [BigInt(device.publicKey.x), BigInt(device.publicKey.y), BigInt(manifest.ownerProfile!.p256Verifier.address)];
    const deviceSigner = getAddress(await read(signerFactory.abi, manifest.ownerProfile!.signerFactory.address, "getSigner", args) as Address);
    await send(encodeFunctionData({ abi: signerFactory.abi, functionName: "createSigner", args }), manifest.ownerProfile!.signerFactory.address);
    const directBackupApproval = concatHex([padHex(backup, { size: 32 }), zeroHash, "0x01"]);
    await send(encodeFunctionData({ abi: safe.abi, functionName: "execTransaction", args: [account, 0n,
      encodeFunctionData({ abi: safe.abi, functionName: "addOwnerWithThreshold", args: [deviceSigner, 1n] }), 0,
      0n, 0n, 0n, zeroAddress, zeroAddress, directBackupApproval] }), account, backup);
    const head = BigInt((await rpc<{ number: Hex }>("eth_getBlockByNumber", ["latest", false])).number);
    calls.length = 0;
    const changed = await own.inspect({ manifestId: manifest.id, address: account }, undefined, await evidenceAt(head), true);
    expect(changed.stateHash).not.toBe(full.stateHash);
    expect(changed.ownerProfile!.devices!.map((entry) => entry.address)).toEqual([deviceSigner]);
    expect(calls.filter((m) => m === "debug_traceTransaction").length).toBeGreaterThan(0);
    // Put the account back for the cases that follow.
    await send(encodeFunctionData({ abi: safe.abi, functionName: "execTransaction", args: [account, 0n,
      encodeFunctionData({ abi: safe.abi, functionName: "removeOwner", args: ["0x0000000000000000000000000000000000000001", deviceSigner, 1n] }), 0,
      0n, 0n, 0n, zeroAddress, zeroAddress, directBackupApproval] }), account, backup);
    expect((await read(safe.abi, account, "getOwners") as Address[]).length).toBe(2);
  });
  it("joins a full inspection already under way instead of running a second one, then carries it to the pinned block", async () => {
    const calls: string[] = [];
    const counted = { request: (chain: number, method: string, params: readonly unknown[]) => { calls.push(method); return transport.request(chain, method, params); } };
    const service = () => createSmartAccountService({ rpc: counted, manifests: [manifest], registry: new MemorySmartAccountRegistry(),
      audience: "https://wallet.juicebox.center", moduleInspectors: [createSafe7579Inspector({ rpc: counted,
        utility: pin(utility), inspectSessions: createInstalledSessionVerifier({ rpc: counted }).inspectAllAt })] });
    await service().inspect({ manifestId: manifest.id, address: account });
    const single = calls.filter((m) => m === "debug_traceTransaction").length;
    expect(single).toBeGreaterThan(0);
    calls.length = 0;
    const own = service();
    // The worker's inspection is in flight when activation asks for the account at a later block.
    const behind = own.inspect({ manifestId: manifest.id, address: account });
    await rpc("evm_mine", []);
    const block = await rpc<{ hash: Hex; number: Hex; timestamp: Hex }>("eth_getBlockByNumber", ["latest", false]);
    const later: RestBlockEvidence = { chainId: 8453, blockHash: block.hash, blockNumber: String(BigInt(block.number)), timestamp: String(BigInt(block.timestamp)), source: "onchain" };
    const joined = await own.inspect({ manifestId: manifest.id, address: account }, undefined, later, true);
    const full = await behind;
    expect(joined.stateHash).toBe(full.stateHash);
    expect(joined.evidence).toEqual(later);
    // One inspection's traces, not two: the join carried the first result to the later block.
    expect(calls.filter((m) => m === "debug_traceTransaction").length).toBe(single);
  });
  it("checks in one round trip that a verified passkey profile still holds", async () => {
    const state = await inspect(), snap = await snapshot();
    expect(await passkeyOwnerProfileHolds({ profile: state.ownerProfile!, snapshot: snap })).toBe(true);
    const other = { ...state.ownerProfile!, signer: { ...state.ownerProfile!.signer, x: toHex(1n, { size: 32 }) } };
    expect(await passkeyOwnerProfileHolds({ profile: other, snapshot: snap })).toBe(false);
    const delegated = { ...state.ownerProfile!, recoveryOwner: { address: signer, kind: "ecdsa" as const } };
    expect(await passkeyOwnerProfileHolds({ profile: delegated, snapshot: snap })).toBe(false);
  });
  it("inspects actual Safe authority, factory lineage, immutable key and every module at one canonical block", async () => {
    const state = await inspect();
    expect(state.ownerProfile).toEqual({ version: "center-passkey-v1", signer: { address: signer, kind: "contract", ...publicKey,
      verifiers: toHex(BigInt(manifest.ownerProfile!.p256Verifier.address), { size: 22 }),
      runtimeCodeHash: keccak256(await rpc<Hex>("eth_getCode", [signer, "latest"])) }, recoveryOwner: { address: backup, kind: "ecdsa" } });
    expect(state.moduleConfigurationVerified).toBe(true);
    expect(state.modules!.details).toMatchObject({ sessions: { permissionIds: [] } });
    expect(state.codeHashes.some((item) => item.address === signer)).toBe(true);
    expect((await inspect()).stateHash).toBe(state.stateHash);
  });
  it("preserves the legacy contract-owner rejection", async () => {
    const { ownerProfile: _profile, ...legacy } = manifest;
    await expect(service(legacy).inspect({ manifestId: legacy.id, address: account })).rejects.toMatchObject({ code: "SMART_CONTRACT_OWNER_UNSUPPORTED" });
  });
  it("verifies exact v2 setup through genuine P256, SafeMessage and the legacy contract selector", async () => {
    const state = await inspect(), approved = await approvedSetup(state);
    expect(approved.document.message.accountId).toBe(`eip155:8453:${account.toLowerCase()}`);
    expect(approved.document.domain.version).toBe("2");
    expect(await verifyPasskeyOnboardingSignatures(approved.document, state, approved.signature, approved.proofSignature, verifier(state))).toEqual([signer]);
    const onchain = createContractOwnerVerifier(transport, [8453]);
    expect(await onchain({ ownerAddress: account, authorityChainId: 8453,
      digest: hashTypedData(approved.document), signature: approved.signature, signal: AbortSignal.timeout(5000) })).toBe(true);
    // Give the changed document its correct browser proof: only the reviewed owner authorization is stale.
    const changed = passkeyOnboardingDocument(origin, { ...approved.input,
      grant: { ...approved.input.grant, label: "Different setup" } }, state);
    const changedProof = await browser.signTypedData(passkeyOnboardingProofDocument(changed));
    await expect(verifyPasskeyOnboardingSignatures(changed, state, approved.signature, changedProof, verifier(state)))
      .rejects.toMatchObject({ code: "SMART_OWNER_SIGNATURE_INVALID" });
  });
  it("inspects a second passkey signer as a device owner, keeping the original as the primary signer", async () => {
    // A device is another canonical passkey signer added at the head of the owner list; the primary
    // stays the last contract owner, so recovery and existing bindings keep their meaning.
    const device = passkey(7n);
    const args = [BigInt(device.publicKey.x), BigInt(device.publicKey.y), BigInt(manifest.ownerProfile!.p256Verifier.address)];
    const deviceSigner = getAddress(await read(signerFactory.abi, manifest.ownerProfile!.signerFactory.address, "getSigner", args) as Address);
    await send(encodeFunctionData({ abi: signerFactory.abi, functionName: "createSigner", args }), manifest.ownerProfile!.signerFactory.address);
    const add = encodeFunctionData({ abi: safe.abi, functionName: "addOwnerWithThreshold", args: [deviceSigner, 1n] });
    const directBackupApproval = concatHex([padHex(backup, { size: 32 }), zeroHash, "0x01"]);
    await send(encodeFunctionData({ abi: safe.abi, functionName: "execTransaction", args: [account, 0n, add, 0,
      0n, 0n, 0n, zeroAddress, zeroAddress, directBackupApproval] }), account, backup);
    const owners = await read(safe.abi, account, "getOwners") as Address[];
    expect(owners.map((owner) => owner.toLowerCase())).toEqual([deviceSigner, signer, backup].map((owner) => owner.toLowerCase()));
    const profile = await inspectOwners({ owners });
    expect(profile.ownerProfile.signer.address).toBe(signer);
    expect(profile.ownerProfile.devices!.map((entry) => entry.address)).toEqual([deviceSigner]);
    expect(profile.ownerProfile.devices![0]).toMatchObject({ kind: "contract", x: device.publicKey.x, y: device.publicKey.y });
    expect(profile.codeHashes.some((entry) => entry.address === deviceSigner)).toBe(true);
    const state = await inspect();
    expect(state.ownerProfile!.devices!.map((entry) => entry.address)).toEqual([deviceSigner]);
    expect(state.owners.length).toBe(3);
    // Two EOAs, or a contract owner that is not a canonical signer, are still refused.
    await expect(inspectOwners({ owners: [deviceSigner, signer, backup, sender] })).rejects.toMatchObject({ code: "SMART_PASSKEY_PROFILE_UNSUPPORTED" });
    await expect(inspectOwners({ owners: [account, signer, backup] })).rejects.toMatchObject({ code: "SMART_PASSKEY_PROFILE_UNSUPPORTED" });
    // Put the account back for the cases that follow.
    const remove = encodeFunctionData({ abi: safe.abi, functionName: "removeOwner", args: ["0x0000000000000000000000000000000000000001", deviceSigner, 1n] });
    await send(encodeFunctionData({ abi: safe.abi, functionName: "execTransaction", args: [account, 0n, remove, 0,
      0n, 0n, 0n, zeroAddress, zeroAddress, directBackupApproval] }), account, backup);
    expect((await read(safe.abi, account, "getOwners") as Address[]).length).toBe(2);
  });

  it("keeps the same Safe principal after real backup-owner rotation and rejects old setup and signer authority", async () => {
    const before = await inspect(), old = await approvedSetup(before), replacement = passkey(2n);
    const args = [BigInt(replacement.publicKey.x), BigInt(replacement.publicKey.y), BigInt(manifest.ownerProfile!.p256Verifier.address)];
    const nextSigner = getAddress(await read(signerFactory.abi, manifest.ownerProfile!.signerFactory.address, "getSigner", args) as Address);
    await send(encodeFunctionData({ abi: signerFactory.abi, functionName: "createSigner", args }), manifest.ownerProfile!.signerFactory.address);
    const owners = await read(safe.abi, account, "getOwners") as Address[], index = owners.findIndex((owner) => owner.toLowerCase() === signer.toLowerCase());
    expect(index).toBeGreaterThanOrEqual(0);
    const previous = index === 0 ? "0x0000000000000000000000000000000000000001" : owners[index - 1]!;
    const swap = encodeFunctionData({ abi: safe.abi, functionName: "swapOwner", args: [previous, signer, nextSigner] });
    const directBackupApproval = concatHex([padHex(backup, { size: 32 }), zeroHash, "0x01"]);
    await send(encodeFunctionData({ abi: safe.abi, functionName: "execTransaction", args: [account, 0n, swap, 0,
      0n, 0n, 0n, zeroAddress, zeroAddress, directBackupApproval] }), account, backup);
    const after = await inspect(), renewed = await approvedSetup(after, 2n, 2n);
    expect(after.address).toBe(before.address);
    expect(after.stateHash).not.toBe(before.stateHash);
    expect(after.ownerProfile!.signer.address).toBe(nextSigner);
    expect(renewed.document.message.accountId).toBe(old.document.message.accountId);
    expect(await verifyPasskeyOnboardingSignatures(renewed.document, after, renewed.signature, renewed.proofSignature, verifier(after))).toEqual([nextSigner]);
    // A signer that is not the inspected owner names the reason instead of failing silently.
    await expect(verifier(after)({ owner: signer, digest: renewed.document as never, signedData: "0x00", signature: "0x00" })).rejects.toThrow("owner-mismatch");
    await expect(verifyPasskeyOnboardingSignatures(old.document, after, old.signature, old.proofSignature, verifier(after)))
      .rejects.toMatchObject({ code: "SMART_ACCOUNT_CHANGED" });
    await expect(verifyPasskeyOnboardingSignatures(renewed.document, after, old.signature, renewed.proofSignature, verifier(after)))
      .rejects.toMatchObject({ code: "SMART_OWNER_SIGNATURE_INVALID" });
    expect(await createContractOwnerVerifier(transport, [8453])({ ownerAddress: account, authorityChainId: 8453,
      digest: hashTypedData(old.document), signature: old.signature, signal: AbortSignal.timeout(5000) })).toBe(false);
  });
  it("finalizes a real passkey setup through the service into the shared account, binding and browser grant", async () => {
    const accounts = new MemoryAccountStore(), shared = service(manifest, accounts), input = setupInput(await inspect());
    const challenge = await shared.passkeyOnboardingChallenge(input);
    const signature = encodeSafe7579MessageSignature([{ kind: "contract", owner: signer,
      signature: assertion(challenge.signingPayload.digest, 1n) }]);
    const proofSignature = await browser.signTypedData(passkeyOnboardingProofDocument(challenge.typedData));
    const finalized = { ...input, manifestRevision: challenge.state.manifestRevision,
      initializerHash: challenge.typedData.message.initializerHash, stateHash: challenge.state.stateHash, signature, proofSignature };
    const result = await shared.finalizePasskeyOnboarding(finalized);
    expect(result.account.id).toBe(`eip155:8453:${account.toLowerCase()}`);
    expect(getAddress(result.account.ownerAddress)).toBe(account);
    expect(getAddress(result.binding.ownerAddress)).toBe(account);
    expect(result.binding.authorization.method).toBe("safe-passkey-owner-threshold-and-api-grant");
    expect(await accounts.getAccount(result.account.id)).toEqual(result.account);
    expect(await accounts.listBots(result.account.id)).toEqual([result.grant]);
    expect((await shared.current(result.account.id, result.binding.id)).state.ownerProfile!.signer.address).toBe(signer);
    expect(await shared.finalizePasskeyOnboarding(finalized)).toEqual(result);
    expect(await accounts.listBots(result.account.id)).toHaveLength(1);
  });
  it.each([0, 2])("rejects unsupported threshold %s", async (threshold) => {
    await expect(inspectOwners({ threshold })).rejects.toMatchObject({ code: "SMART_PASSKEY_PROFILE_UNSUPPORTED" });
  });
  it("rejects duplicate or extra owners without widening the experimental profile", async () => {
    await expect(inspectOwners({ owners: [signer, signer] })).rejects.toMatchObject({ code: "SMART_PASSKEY_PROFILE_UNSUPPORTED" });
    await expect(inspectOwners({ owners: [signer, backup, sender] })).rejects.toMatchObject({ code: "SMART_PASSKEY_PROFILE_UNSUPPORTED" });
  });
  it("requires the explicit supported version and Base authority chain", async () => {
    const changed = structuredClone(manifest);
    changed.chainId = 1;
    await expect(inspectOwners({ manifest: changed })).rejects.toMatchObject({ code: "SMART_PASSKEY_PROFILE_INVALID" });
    changed.chainId = 8453;
    Object.assign(changed.ownerProfile!, { version: "center-passkey-v2" });
    await expect(inspectOwners({ manifest: changed })).rejects.toMatchObject({ code: "SMART_PASSKEY_PROFILE_INVALID" });
  });
  it.each(["0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000001"] as const)("rejects invalid backup %s", async (address) => {
    await expect(inspectOwners({ owners: [signer, address] })).rejects.toMatchObject({ code: "SMART_PASSKEY_PROFILE_UNSUPPORTED" });
  });
  it("rejects an EIP7702 delegated backup", async () => {
    await rpc("anvil_setCode", [backup, `0xef0100${sender.slice(2)}`]);
    await expect(inspect()).rejects.toMatchObject({ code: "SMART_PASSKEY_PROFILE_UNSUPPORTED" });
  });
  it("rejects signer code changes independently of a plausible configuration getter", async () => {
    const code = await rpc<Hex>("eth_getCode", [signer, "latest"]);
    await rpc("anvil_setCode", [signer, `${code.slice(0, -2)}00`]);
    await expect(inspect()).rejects.toMatchObject({ code: "SMART_PASSKEY_PROFILE_UNSUPPORTED" });
  });
  it.each(["signerFactory", "signerSingleton", "p256Verifier"] as const)("rejects changed dependency bytecode: %s", async (name) => {
    await rpc("anvil_setCode", [manifest.ownerProfile![name].address, "0x60006000"]);
    await expect(inspect()).rejects.toMatchObject({ code: "SMART_PASSKEY_PROFILE_UNSUPPORTED" });
  });
  it.each(["off-curve", "out-of-field", "different-valid-key", "foreign-verifier"])("rejects spoofed configuration: %s", async (kind) => {
    const base = await snapshot(), prime = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
    const args = [kind === "out-of-field" ? prime : BigInt(publicKey.x),
      kind === "off-curve" ? 1n : kind === "different-valid-key" ? prime - BigInt(publicKey.y) : BigInt(publicKey.y),
      kind === "foreign-verifier" ? BigInt(sender) : BigInt(manifest.ownerProfile!.p256Verifier.address)] as const;
    const data = encodeFunctionResult({ abi: configurationAbi, functionName: "getConfiguration", result: args });
    await expect(inspectOwners({ snapshot: { ...base, request: (method, params) => method === "eth_call" &&
      String((params[0] as { to?: string }).to).toLowerCase() === signer.toLowerCase() ? Promise.resolve(data) : base.request(method, params) } }))
      .rejects.toMatchObject({ code: "SMART_PASSKEY_PROFILE_UNSUPPORTED" });
  });
  it("rejects the same key attributed to a different genuine factory", async () => {
    const address = await send(signerFactory.bytecode), singletonAddress = await read(signerFactory.abi, address, "SINGLETON") as Address;
    const changed = { ...manifest, ownerProfile: { ...manifest.ownerProfile!,
      signerFactory: await deployedPin("SafeWebAuthnSignerFactory", signerFactory, address),
      signerSingleton: await deployedPin("SafeWebAuthnSignerSingleton", signerSingleton, singletonAddress) } };
    await expect(inspectOwners({ manifest: changed })).rejects.toMatchObject({ code: "SMART_PASSKEY_PROFILE_UNSUPPORTED" });
  });
  it("rejects an unreviewed source or runtime pin", async () => {
    const changed = structuredClone(manifest);
    changed.ownerProfile!.signerFactory.source.commit = "a".repeat(40);
    await expect(inspectOwners({ manifest: changed })).rejects.toMatchObject({ code: "SMART_PASSKEY_PROFILE_INVALID" });
    changed.ownerProfile = structuredClone(manifest.ownerProfile!);
    changed.ownerProfile.signerSingleton.runtimeCodeHash = zeroHash;
    await expect(inspectOwners({ manifest: changed })).rejects.toMatchObject({ code: "SMART_PASSKEY_PROFILE_INVALID" });
  });
});
