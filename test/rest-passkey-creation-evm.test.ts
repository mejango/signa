import { type ChildProcess } from "node:child_process";
import { anvilAvailable, spawnAnvil } from "./support/anvil.js";
import { createECDH, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { concatHex, decodeFunctionResult, encodeFunctionData, getAddress, keccak256, padHex, toHex, zeroAddress, zeroHash,
  type Abi, type Address, type Hex } from "viem";
import type { RestRpc } from "../src/rest/core.js";
import { createSmartAccountService } from "../src/rest/smartAccounts/service.js";
import { preparePasskeySafe7579Creation } from "../src/rest/smartAccounts/creation.js";
import { createSafe7579Inspector, SAFE7579_INSPECTOR_ID } from "../src/rest/smartAccounts/inspector.js";
import { createInstalledSessionVerifier } from "../src/rest/smartAccounts/installed.js";
import { MemorySmartAccountRegistry } from "../src/rest/smartAccounts/registry.js";
import { MemorySafe7579CheckpointStore } from "../src/rest/smartAccounts/checkpoints.js";
import type { ContractPin, SmartAccountManifest } from "../src/rest/smartAccounts/types.js";

type Artifact = { address: Address; canonicalAddress?: Address; abi: Abi; bytecode: Hex; deployedBytecode: Hex;
  deployedRuntimeBytecode?: Hex; runtimeCodeHash: Hex; source: { repo?: string; repository?: string; commit: string; artifactSha256?: string } };
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
const publicKey = { x: "0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296" as Hex,
  y: "0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5" as Hex };
const available = anvilAvailable();

describe.skipIf(!available)("versioned atomic passkey creation and canonical history in the pinned EVM", () => {
  let child: ChildProcess | undefined, endpoint: string, baseline: Hex, manifest: SmartAccountManifest;
  let sender: Address, backup: Address, creationBlockHash: Hex, requestId = 0;
  async function rpc<T = unknown>(method: string, params: readonly unknown[] = []): Promise<T> {
    const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }), signal: AbortSignal.timeout(10_000) });
    const result = await response.json() as { result: T; error?: { message: string } };
    if (result.error) throw new Error(`${method}: ${result.error.message}`); return result.result;
  }
  const transport: RestRpc = { request: (_chain, method, params) => rpc(method, params) };
  async function send(data: Hex, to?: Address, from = sender) {
    const hash = await rpc<Hex>("eth_sendTransaction", [{ from, ...(to ? { to } : {}), data, gas: "0xf42400" }]);
    let receipt: { status: Hex; contractAddress: Address | null; blockHash: Hex } | null = null;
    for (let i = 0; i < 100; i++) { receipt = await rpc("eth_getTransactionReceipt", [hash]); if (receipt) break;
      await new Promise((resolve) => setTimeout(resolve, 10)); }
    if (!receipt) throw new Error("Local creation did not mine before its deadline");
    expect(receipt.status).toBe("0x1"); return { ...receipt, hash };
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
  const prepare = (m = manifest) => preparePasskeySafe7579Creation({ manifest: m, publicKey, recoveryOwner: backup, saltNonce: "8181" });
  async function deploy() {
    const prepared = prepare(), receipt = await send(prepared.transaction.data, prepared.transaction.to);
    creationBlockHash = receipt.blockHash; await rpc("evm_mine"); return prepared;
  }
  function service(rpcOverride = transport, m = manifest, checkpointStore?: MemorySafe7579CheckpointStore) {
    return createSmartAccountService({ rpc: rpcOverride, manifests: [m], registry: new MemorySmartAccountRegistry(), audience: "https://wallet.juicebox.center",
      moduleInspectors: [createSafe7579Inspector({ rpc: rpcOverride, utility: pin(utility),
        inspectSessions: createInstalledSessionVerifier({ rpc: rpcOverride }).inspectAllAt, ...(checkpointStore ? { checkpointStore } : {}) })] });
  }
  const inspect = (rpcOverride = transport, m = manifest, checkpointStore?: MemorySafe7579CheckpointStore) =>
    service(rpcOverride, m, checkpointStore).inspect({ manifestId: m.id, address: prepare().address });
  beforeAll(async () => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const port = (server.address() as { port: number }).port; await new Promise<void>((resolve) => server.close(() => resolve()));
    endpoint = `http://127.0.0.1:${port}`;
    child = spawnAnvil(["--host", "127.0.0.1", "--port", String(port), "--chain-id", "8453", "--hardfork", "cancun", "--silent"]);
    for (let i = 0; i < 100; i++) { try { await rpc("eth_chainId"); break; } catch { await new Promise((resolve) => setTimeout(resolve, 30)); } }
    [sender, backup] = await rpc<[Address, Address]>("eth_accounts"); backup = getAddress(backup);
    for (const a of [safe, factory, adapter, launchpad, utility, entry, senderCreator, sessions]) {
      const code = a.deployedRuntimeBytecode ?? a.deployedBytecode; expect(keccak256(code)).toBe(a.runtimeCodeHash);
      await rpc("anvil_setCode", [a.address, code]); }
    await rpc("anvil_setCode", [multiSend.canonicalAddress!, multiSend.deployedRuntimeBytecode!]);
    const fclAddress = (await send(fcl.bytecode)).contractAddress!, factoryAddress = (await send(signerFactory.bytecode)).contractAddress!;
    const singletonAddress = await read(signerFactory.abi, factoryAddress, "SINGLETON") as Address;
    manifest = { id: "local-passkey-bootstrap-v1", mode: "execution-candidate", chainId: 8453, revision: keccak256(toHex("local-passkey-bootstrap-v1")),
      safeVersion: "1.4.1", proxyRuntimeCodeHash: proxy.runtimeCodeHash, singleton: pin(safe), factory: pin(factory), safe7579: pin(adapter),
      launchpad: pin(launchpad), entryPoint: { ...pin(entry), version: "0.7" }, smartSessions: { ...pin(sessions), generation: "legacy-validator" },
      policies: [], moduleInspectorId: SAFE7579_INSPECTOR_ID,
      ownerProfile: { version: "center-passkey-v1", signerFactory: await deployedPin("SafeWebAuthnSignerFactory", signerFactory, factoryAddress),
        signerSingleton: await deployedPin("SafeWebAuthnSignerSingleton", signerSingleton, singletonAddress), p256Verifier: await deployedPin("FCLP256Verifier", fcl, fclAddress) },
      creationProfile: { version: "center-passkey-bootstrap-v1", multiSend: { address: getAddress(multiSend.canonicalAddress!), runtimeCodeHash: multiSend.runtimeCodeHash,
        source: { repository: multiSend.source.repository!, commit: multiSend.source.commit,
          artifactSha256: createHash("sha256").update(files.get("MultiSend")!).digest("hex") } } } };
    baseline = await rpc<Hex>("evm_snapshot");
  }, 30_000);
  beforeEach(async () => { expect(await rpc("evm_revert", [baseline])).toBe(true); baseline = await rpc<Hex>("evm_snapshot"); });
  afterAll(async () => { if (child && child.exitCode === null) { const done = new Promise<void>((resolve) => child!.once("exit", () => resolve())); child.kill("SIGTERM"); await done; } });

  it("creates the signer and Safe atomically from the TS producer and verifies their complete canonical history", async () => {
    const prepared = prepare();
    expect(await rpc("eth_getCode", [prepared.address, "latest"])).toBe("0x");
    expect(await rpc("eth_getCode", [prepared.bootstrap.signerAddress, "latest"])).toBe("0x");
    await deploy();
    const state = await inspect();
    expect(state.ownerProfile!.signer.address).toBe(prepared.bootstrap.signerAddress);
    expect(state.owners).toEqual([prepared.bootstrap.signerAddress, backup]);
    expect(state.moduleConfigurationVerified).toBe(true);
    expect(state.modules!.details).toMatchObject({ sessions: { permissionIds: [] }, provenance: { initializerHash: prepared.initializerHash } });
  });
  it("cannot reinterpret bootstrap history through the legacy creation profile", async () => {
    await deploy(); const { creationProfile: _profile, ...legacy } = manifest;
    await expect(inspect(transport, legacy)).rejects.toMatchObject({ code: "SMART_CREATION_UNSUPPORTED" });
  });
  it.each(["creation", "current"])("rejects MultiSend runtime replacement at %s", async (at) => {
    await deploy();
    const changed: RestRpc = { request: (chain, method, params, signal) => method === "eth_getCode" &&
      String(params[0]).toLowerCase() === multiSend.canonicalAddress!.toLowerCase() &&
      ((params[1] as { blockHash?: Hex })?.blockHash === creationBlockHash) === (at === "creation") ?
      Promise.resolve("0x60006000") : transport.request(chain, method, params, signal) };
    await expect(inspect(changed)).rejects.toMatchObject({ code: at === "creation" ? "SMART_HISTORY_CODE_MISMATCH" : "SMART_INSPECTION_CODE_MISMATCH" });
  });
  it.each(["multisend", "launch", "factory-call"])("rejects a missing required creation trace frame: %s", async (removed) => {
    await deploy();
    const remove = (frame: { calls?: Record<string, unknown>[] }) => {
      if (!frame.calls) return;
      frame.calls = frame.calls.filter((call) => !(String(call.to).toLowerCase() ===
        (removed === "multisend" ? multiSend.canonicalAddress : removed === "launch" ? launchpad.address : manifest.ownerProfile!.signerFactory.address)!.toLowerCase()));
      frame.calls?.forEach((call) => remove(call));
    };
    const changed: RestRpc = { request: async (chain, method, params, signal) => {
      const result = await transport.request(chain, method, params, signal);
      if (method === "debug_traceTransaction") remove(result as { calls?: Record<string, unknown>[] }); return result;
    } };
    await expect(inspect(changed)).rejects.toMatchObject({ code: "SMART_CREATION_TRACE_INVALID" });
  });
  it.each(["extra-call", "wrong-operation", "nonzero-value", "wrong-target", "changed-launch-data"])("rejects a substituted bootstrap trace: %s", async (change) => {
    await deploy();
    const tamper = (frame: Record<string, unknown>) => {
      const calls = frame.calls as Record<string, unknown>[] | undefined;
      if (String(frame.to).toLowerCase() === multiSend.canonicalAddress!.toLowerCase()) {
        if (!calls || calls.length !== 2) throw new Error("Expected the actual two-entry MultiSend trace");
        if (change === "extra-call") calls.push(structuredClone(calls[0]!));
        if (change === "wrong-operation") calls[0]!.type = "DELEGATECALL";
        if (change === "nonzero-value") calls[0]!.value = "0x1";
        if (change === "wrong-target") calls[0]!.to = backup;
        if (change === "changed-launch-data") calls[1]!.input = `${calls[1]!.input}00`;
      } else calls?.forEach(tamper);
    };
    const changed: RestRpc = { request: async (chain, method, params, signal) => {
      const result = await transport.request(chain, method, params, signal);
      if (method === "debug_traceTransaction") tamper(result as Record<string, unknown>); return result;
    } };
    await expect(inspect(changed)).rejects.toMatchObject({ code: "SMART_CREATION_TRACE_INVALID" });
  });
  it("retains the direct Safe-factory transaction root requirement", async () => {
    await deploy();
    const changed: RestRpc = { request: async (chain, method, params, signal) => {
      const result = await transport.request(chain, method, params, signal);
      return method === "eth_getTransactionByHash" ? { ...result as Record<string, unknown>, to: multiSend.canonicalAddress } : result;
    } };
    await expect(inspect(changed)).rejects.toMatchObject({ code: "SMART_CREATION_PROOF_REQUIRED" });
  });
  it("rejects a later owner MultiSend delegatecall even to the same pinned implementation", async () => {
    const prepared = await deploy();
    await send(encodeFunctionData({ abi: safe.abi, functionName: "execTransaction", args: [multiSend.canonicalAddress!, 0n,
      encodeFunctionData({ abi: multiSend.abi, functionName: "multiSend", args: ["0x"] }), 1, 0n, 0n, 0n, zeroAddress, zeroAddress,
      concatHex([padHex(backup, { size: 32 }), zeroHash, "0x01"])] }), prepared.address, backup);
    await expect(inspect()).rejects.toMatchObject({ code: "SMART_AUTHORITY_HISTORY_UNSUPPORTED" });
  });
  it("isolates checkpoints from legacy keys and same-revision profile substitutions", async () => {
    await deploy(); const checkpoints = new MemorySafe7579CheckpointStore(), get = vi.spyOn(checkpoints, "get");
    await inspect(transport, manifest, checkpoints);
    const first = get.mock.calls[0]![0];
    expect(first).not.toBe(`8453:${prepare().address.toLowerCase()}:${manifest.revision}:${utility.runtimeCodeHash}`);
    // A source metadata change is harmless to runtime, but must not reuse a prior profile certification.
    const changed = structuredClone(manifest); changed.ownerProfile!.p256Verifier.source.contentSha256 = "a".repeat(64);
    await inspect(transport, changed, checkpoints);
    expect(get.mock.calls.at(-1)![0]).not.toBe(first);
    // A warm, canonically valid checkpoint still requires current bootstrap dependency code.
    await rpc("anvil_setCode", [multiSend.canonicalAddress!, "0x60006000"]);
    await expect(inspect(transport, manifest, checkpoints)).rejects.toMatchObject({ code: "SMART_INSPECTION_CODE_MISMATCH" });
  });
  it("accepts real credential rotation through cold and retained history while preserving the original initializer", async () => {
    const prepared = await deploy(), checkpoints = new MemorySafe7579CheckpointStore();
    const initial = await inspect(transport, manifest, checkpoints), curve = createECDH("prime256v1");
    curve.setPrivateKey(Buffer.from(toHex(2n, { size: 32 }).slice(2), "hex"));
    const point = curve.getPublicKey(undefined, "uncompressed"), args = [BigInt(toHex(point.subarray(1, 33))),
      BigInt(toHex(point.subarray(33))), BigInt(manifest.ownerProfile!.p256Verifier.address)];
    const nextSigner = getAddress(await read(signerFactory.abi, manifest.ownerProfile!.signerFactory.address, "getSigner", args) as Address);
    await send(encodeFunctionData({ abi: signerFactory.abi, functionName: "createSigner", args }), manifest.ownerProfile!.signerFactory.address);
    const swap = encodeFunctionData({ abi: safe.abi, functionName: "swapOwner", args: [
      "0x0000000000000000000000000000000000000001", prepared.bootstrap.signerAddress, nextSigner] });
    await send(encodeFunctionData({ abi: safe.abi, functionName: "execTransaction", args: [prepared.address, 0n, swap, 0,
      0n, 0n, 0n, zeroAddress, zeroAddress, concatHex([padHex(backup, { size: 32 }), zeroHash, "0x01"])] }), prepared.address, backup);
    const cold = await inspect(), warm = await inspect(transport, manifest, checkpoints);
    expect(cold.ownerProfile!.signer.address).toBe(nextSigner);
    expect(warm.ownerProfile).toEqual(cold.ownerProfile);
    expect(warm.stateHash).toBe(cold.stateHash);
    expect(cold.stateHash).not.toBe(initial.stateHash);
    for (const state of [cold, warm]) expect(state.modules!.details).toMatchObject({ provenance: { initializerHash: prepared.initializerHash } });
  });
});
