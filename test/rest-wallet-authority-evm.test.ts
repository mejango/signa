import { type ChildProcess } from "node:child_process";
import { anvilAvailable, spawnAnvil } from "./support/anvil.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { concatHex, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, getAddress, hashTypedData,
  keccak256, padHex, toHex, zeroAddress, zeroHash, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { RestRpc } from "../src/rest/core.js";
import type { ContractPin, SmartAccountManifest, SmartAccountState } from "../src/rest/smartAccounts/types.js";
import { createSmartAccountService } from "../src/rest/smartAccounts/service.js";
import { createSafe7579Inspector, SAFE7579_INSPECTOR_ID } from "../src/rest/smartAccounts/inspector.js";
import { createInstalledSessionVerifier } from "../src/rest/smartAccounts/installed.js";
import { MemorySmartAccountRegistry } from "../src/rest/smartAccounts/registry.js";
import { MemoryOnboardingStore } from "../src/rest/smartAccounts/onboardingMemory.js";
import { MemoryAccountStore } from "../src/rest/auth/memory.js";
import { passkeyOnboardingProofDocument } from "../src/rest/smartAccounts/passkeyOnboarding.js";
import { encodeSafe7579MessageSignature } from "../src/rest/smartAccounts/passkeySignatures.js";
import { LEGACY_SESSION_PARAMETERS, type LegacySession } from "../src/rest/smartAccounts/setup.js";
import { permissionIdOf } from "../src/rest/smartAccounts/compiler/encoding.js";
import { verifyWalletAssertion } from "../src/rest/wallet/webauthn.js";
import { createWalletEnrollmentIntent, enrollmentDigest, prepareWalletEnrollmentCandidate,
  verifyWalletEnrollmentProof, walletEnrollmentDocument, type WalletEnrollment } from "../src/rest/wallet/enrollment.js";
import { createWalletAuthorityChain } from "../src/rest/wallet/authorityChain.js";
import { MemorySafe7579CheckpointStore } from "../src/rest/smartAccounts/checkpoints.js";
import { reconcileWalletAuthority, validateWalletAuthorityObservation, walletAuthorityIdentityDigest,
  walletAuthorityMaximumAgeMs, type WalletAuthorityContext, type WalletAuthorityObservation, type WalletAuthoritySnapshot } from "../src/rest/wallet/authority.js";
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
  ownable = artifact("OwnableValidator"), signerFactory = artifact("SafeWebAuthnSignerFactory", "passkey/"),
  signerSingleton = artifact("SafeWebAuthnSignerSingleton", "passkey/"), fcl = artifact("FCLP256Verifier", "passkey/"),
  multiSend = artifact("MultiSend", "passkey/bootstrap/");
const pin = (a: Artifact): ContractPin => ({ address: a.address, runtimeCodeHash: a.runtimeCodeHash,
  source: { repository: a.source.repo!, commit: a.source.commit, artifactSha256: a.source.artifactSha256! } });
const available = anvilAvailable();
const browser = privateKeyToAccount(`0x${"43".repeat(32)}`);

describe.skipIf(!available)("canonical wallet authority from genuine enrollment and setup in the pinned Base EVM", () => {
  let child: ChildProcess | undefined, endpoint: string, baseline: Hex, sender: Address, account: Address;
  let manifest: SmartAccountManifest, enrollment: WalletEnrollment, credential: ReturnType<typeof createRegistration>;
  let context: WalletAuthorityContext, creationTransaction: Hex, setupState: SmartAccountState, clock: number, requestId = 0;
  const observed: { method: string; params: readonly unknown[] }[] = [];
  const traces: { bytes: number; nodes: number; depth: number }[] = [];
  async function rpc<T = unknown>(method: string, params: readonly unknown[] = [], signal?: AbortSignal): Promise<T> {
    const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) });
    const result = await response.json() as { result: T; error?: { message: string } };
    if (result.error) { if (process.env.DEBUG_RPC) console.info('rpc error', method, result.error.message.slice(0, 200)); throw new Error(`${method}: ${result.error.message}`); } return result.result;
  }
  // Only setup helpers below can mutate Anvil. The configured authority producer gets read methods.
  const transport: RestRpc = { request: (chainId, method, params, signal) => {
    expect(chainId).toBe(8453);
    expect(["eth_chainId", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getCode", "eth_getStorageAt",
      "eth_getBalance", "eth_getTransactionCount", "eth_call", "eth_getTransactionReceipt", "eth_getTransactionByHash",
      "eth_getTransactionByBlockHashAndIndex", "eth_getLogs", "debug_traceTransaction"]).toContain(method);
    observed.push({ method, params: structuredClone(params) });
    return rpc(method, params, signal).then(result => {
      if (method === "debug_traceTransaction") {
        let nodes = 0, depth = 0;
        const walk = (value: unknown, level = 0) => {
          nodes++; depth = Math.max(depth, level);
          if (value && typeof value === "object") for (const next of Object.values(value)) walk(next, level + 1);
        };
        walk(result); traces.push({ bytes: Buffer.byteLength(JSON.stringify(result)), nodes, depth });
      }
      return result;
    });
  } };
  async function receipt(hash: Hex) {
    for (let i = 0; i < 100; i++) {
      const result = await rpc<{ status: Hex; contractAddress: Address | null; transactionHash: Hex } | null>("eth_getTransactionReceipt", [hash]);
      if (result) { expect(result.status).toBe("0x1"); return result; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("The local fixture transaction did not mine before its deadline");
  }
  const send = async (data: Hex, to?: Address) => receipt(await rpc<Hex>("eth_sendTransaction", [
    { from: sender, ...(to ? { to } : {}), data, gas: "0xf42400" },
  ]));
  async function read(abi: Abi, address: Address, functionName: string, args: readonly unknown[] = []) {
    return decodeFunctionResult({ abi, functionName, data: await rpc<Hex>("eth_call", [
      { to: address, data: encodeFunctionData({ abi, functionName, args }) }, "latest"]) });
  }
  async function deployedPin(name: string, a: Artifact, address: Address): Promise<ContractPin> {
    return { address: getAddress(address), runtimeCodeHash: keccak256(await rpc<Hex>("eth_getCode", [address, "latest"])),
      source: { repository: a.source.repository!, commit: a.source.commit,
        artifactSha256: createHash("sha256").update(files.get(name)!).digest("hex") } };
  }
  function service() {
    const accounts = new MemoryAccountStore(), registry = new MemorySmartAccountRegistry();
    return { accounts, registry, shared: createSmartAccountService({ rpc: transport, manifests: [manifest], registry,
      onboarding: new MemoryOnboardingStore(accounts, registry), audience: enrollment.intent.origin,
      moduleInspectors: [createSafe7579Inspector({ rpc: transport, utility: pin(utility),
        inspectSessions: createInstalledSessionVerifier({ rpc: transport }).inspectAllAt })] }) };
  }
  const inspect = () => service().shared.inspect({ manifestId: manifest.id, address: account });
  async function ownerCall(to: Address, data: Hex = "0x") {
    const signatures = concatHex([padHex(enrollmentBackupAccount.address, { size: 32 }), zeroHash, "0x01"]);
    const execution = encodeFunctionData({ abi: safe.abi, functionName: "execTransaction", args: [
      to, 0n, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, signatures,
    ] });
    const nonce = Number(BigInt(await rpc<Hex>("eth_getTransactionCount", [enrollmentBackupAccount.address, "latest"])));
    const raw = await enrollmentBackupAccount.signTransaction({ type: "eip1559", chainId: 8453, nonce,
      to: account, data: execution, gas: 2_000_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000n });
    return receipt(await rpc<Hex>("eth_sendRawTransaction", [raw]));
  }
  async function swapSigner(old: Address, next: Address) {
    const owners = await read(safe.abi, account, "getOwners") as Address[], index = owners.findIndex(owner => owner.toLowerCase() === old.toLowerCase());
    expect(index).toBeGreaterThanOrEqual(0);
    const previous = index === 0 ? "0x0000000000000000000000000000000000000001" : owners[index - 1]!;
    await ownerCall(account, encodeFunctionData({ abi: safe.abi, functionName: "swapOwner", args: [previous, old, next] }));
    expect(await read(safe.abi, account, "isOwner", [next])).toBe(true);
  }
  async function anotherSigner() {
    const replacement = createRegistration({ challenge: zeroHash, rpId: enrollment.intent.rpId,
      origin: enrollment.intent.origin, userHandle: enrollment.intent.userHandle });
    const args = [BigInt(replacement.publicKey.x), BigInt(replacement.publicKey.y), BigInt(manifest.ownerProfile!.p256Verifier.address)];
    const address = await read(signerFactory.abi, manifest.ownerProfile!.signerFactory.address, "getSigner", args) as Address;
    await send(encodeFunctionData({ abi: signerFactory.abi, functionName: "createSigner", args }), manifest.ownerProfile!.signerFactory.address);
    return getAddress(address);
  }
  async function unchangedState() {
    return { block: await rpc("eth_blockNumber"), nonce: await read(safe.abi, account, "nonce"),
      senderNonce: await rpc("eth_getTransactionCount", [sender, "latest"]),
      backupNonce: await rpc("eth_getTransactionCount", [enrollmentBackupAccount.address, "latest"]),
      balance: await rpc("eth_getBalance", [account, "latest"]) };
  }
  beforeAll(async () => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const port = (server.address() as { port: number }).port;
    await new Promise<void>(resolve => server.close(() => resolve())); endpoint = `http://127.0.0.1:${port}`;
    child = spawnAnvil(["--host", "127.0.0.1", "--port", String(port), "--chain-id", "8453", "--hardfork", "cancun", "--silent"]);
    for (let i = 0; i < 100; i++) { try { await rpc("eth_chainId"); break; } catch { await new Promise(resolve => setTimeout(resolve, 30)); } }
    [sender] = await rpc<[Address]>("eth_accounts");
    for (const a of [safe, factory, adapter, launchpad, utility, entry, senderCreator, sessions, ownable]) {
      const code = a.deployedRuntimeBytecode ?? a.deployedBytecode;
      expect(keccak256(code)).toBe(a.runtimeCodeHash); await rpc("anvil_setCode", [a.address, code]);
    }
    expect(keccak256(multiSend.deployedRuntimeBytecode!)).toBe(multiSend.runtimeCodeHash);
    await rpc("anvil_setCode", [multiSend.canonicalAddress!, multiSend.deployedRuntimeBytecode!]);
    await rpc("anvil_setBalance", [enrollmentBackupAccount.address, toHex(10n ** 20n)]);
    const fclAddress = (await send(fcl.bytecode)).contractAddress!, factoryAddress = (await send(signerFactory.bytecode)).contractAddress!;
    const singletonAddress = await read(signerFactory.abi, factoryAddress, "SINGLETON") as Address;
    manifest = { id: "wallet-authority-local", mode: "execution-candidate", chainId: 8453,
      revision: keccak256(toHex("wallet-authority-local")), safeVersion: "1.4.1", proxyRuntimeCodeHash: proxy.runtimeCodeHash,
      singleton: pin(safe), factory: pin(factory), safe7579: pin(adapter), launchpad: pin(launchpad),
      entryPoint: { ...pin(entry), version: "0.7" }, smartSessions: { ...pin(sessions), generation: "legacy-validator" },
      policies: [], moduleInspectorId: SAFE7579_INSPECTOR_ID,
      ownerProfile: { version: "center-passkey-v1", signerFactory: await deployedPin("SafeWebAuthnSignerFactory", signerFactory, factoryAddress),
        signerSingleton: await deployedPin("SafeWebAuthnSignerSingleton", signerSingleton, singletonAddress),
        p256Verifier: await deployedPin("FCLP256Verifier", fcl, fclAddress) },
      creationProfile: { version: "center-passkey-bootstrap-v1", multiSend: { address: getAddress(multiSend.canonicalAddress!), runtimeCodeHash: multiSend.runtimeCodeHash,
        source: { repository: multiSend.source.repository!, commit: multiSend.source.commit,
          artifactSha256: createHash("sha256").update(files.get("MultiSend")!).digest("hex") } } } };
    const createdAt = Date.now();
    const intent = createWalletEnrollmentIntent({ manifest, rpId: "wallet.juicebox.center", origin: "https://wallet.juicebox.center",
      recoveryOwner: enrollmentBackupAccount.address, expiresAt: createdAt + 120_000 });
    const empty: WalletEnrollment = { intent, createdAt, state: "awaiting_registration", candidate: null,
      candidateDigest: null, creation: null, possession: null, receipt: null };
    credential = createRegistration({ challenge: `0x${Buffer.from(intent.registration.challenge, "base64url").toString("hex")}`,
      rpId: intent.rpId, origin: intent.origin, userHandle: intent.userHandle });
    const pending: WalletEnrollment = { ...empty, ...prepareWalletEnrollmentCandidate(empty, credential.response), state: "awaiting_possession" };
    const document = walletEnrollmentDocument(pending);
    const proof = await verifyWalletEnrollmentProof(pending, { assertion: signGet({ ...credential, challenge: hashTypedData(document),
      rpId: intent.rpId, origin: intent.origin }), backupSignature: await signBackupProof(document) });
    // W3 PostgreSQL admission has separate atomic tests. The receipt is a stand-in over actual
    // registration, possession and backup proofs; the Safe deployment and setup below are real.
    enrollment = { ...pending, state: "verified", receipt: { id: intent.id, enrollmentId: intent.id,
      accountId: `eip155:8453:${pending.creation!.address.toLowerCase()}`, credentialId: credential.credentialId,
      initializerHash: pending.creation!.initializerHash, manifestCommitment: `0x${enrollmentDigest(intent.manifest)}`,
      manifestRevision: intent.manifest.revision, creationCommitment: `0x${enrollmentDigest(pending.creation)}`,
      verificationDigest: proof.verificationDigest, verifiedAt: Date.now() } };
    account = getAddress(enrollment.creation!.address);
    creationTransaction = (await send(enrollment.creation!.transaction.data, enrollment.creation!.transaction.to)).transactionHash;
    const { accounts, registry, shared } = service();
    setupState = await inspect();
    const issuedAt = Number(setupState.evidence.timestamp), input = {
      profile: "center-passkey-v1" as const, address: account, manifestId: manifest.id,
      nonce: toHex(1n, { size: 32 }), issuedAt, expiresAt: issuedAt + 300,
      grant: { id: "550e8400-e29b-41d4-a716-446655440000", botAddress: browser.address,
        scopes: ["read", "plan", "relay"] as ("read" | "plan" | "relay")[], expiresAt: issuedAt + 3600, label: "Local authority setup" },
    };
    const challenge = await shared.passkeyOnboardingChallenge(input);
    const assertion = verifyWalletAssertion(signGet({ ...credential, challenge: challenge.signingPayload.digest, rpId: intent.rpId, origin: intent.origin }),
      { challenge: challenge.signingPayload.digest, purpose: "session", rpId: intent.rpId, origin: intent.origin,
        requireUserHandle: true, credential: { id: credential.credentialId, userHandle: credential.userHandle,
          publicKey: credential.publicKey, backupEligible: true } });
    const signature = encodeSafe7579MessageSignature([{ kind: "contract", owner: enrollment.creation!.bootstrap.signerAddress,
      signature: assertion.contractSignature }]);
    const proofSignature = await browser.signTypedData(passkeyOnboardingProofDocument(challenge.typedData));
    const result = await shared.finalizePasskeyOnboarding({ ...input, manifestRevision: challenge.state.manifestRevision,
      initializerHash: challenge.typedData.message.initializerHash, stateHash: challenge.state.stateHash, signature, proofSignature });
    expect(await accounts.getAccount(result.account.id)).toEqual(result.account);
    expect(await accounts.listBots(result.account.id)).toEqual([result.grant]);
    expect(await registry.get(result.account.id, result.binding.id)).toEqual(result.binding);
    expect(result.binding.authorization.method).toBe("safe-passkey-owner-threshold-and-api-grant");
    context = { version: "center-wallet-authority-context-v1", accountId: result.account.id, enrollment,
      credential: { accountId: result.account.id, enrollmentId: intent.id, rpId: intent.rpId,
        credentialId: credential.credentialId, userHandle: credential.userHandle, publicKey: credential.publicKey,
        backupEligible: true, verifiedAtMs: enrollment.receipt!.verifiedAt, supersededAtMs: null },
      binding: result.binding, prior: null };
    baseline = await rpc<Hex>("evm_snapshot");
  }, 30_000);
  beforeEach(async () => {
    expect(await rpc("evm_revert", [baseline])).toBe(true); baseline = await rpc<Hex>("evm_snapshot");
    clock = Date.now(); observed.length = 0; traces.length = 0;
  });
  afterAll(async () => {
    if (child && child.exitCode === null) { const done = new Promise<void>(resolve => child!.once("exit", () => resolve())); child.kill("SIGTERM"); await done; }
  });
  const withPrior = (prior: WalletAuthoritySnapshot | null): WalletAuthorityContext => ({ ...context, prior });
  const observer = (rpcOverride: RestRpc = transport, limits?: { rpcCalls?: number }) => createWalletAuthorityChain({
    rpc: rpcOverride, manifest, utility: pin(utility), now: () => clock, ...(limits ? { limits } : {}),
  });
  async function observe(prior: WalletAuthoritySnapshot | null = null, rpcOverride = transport, limits?: { rpcCalls?: number }) {
    const input = withPrior(prior);
    return validateWalletAuthorityObservation(await observer(rpcOverride, limits).observe(input), input);
  }
  const reconcile = (prior: WalletAuthoritySnapshot | null, observation: WalletAuthorityObservation) =>
    reconcileWalletAuthority(withPrior(prior), observation, clock);
  function unknown(value: WalletAuthorityObservation) {
    expect(value.identity).toBeNull(); expect(value.eligibility).toBeNull(); expect(value.validUntilMs).toBeNull(); expect(value.reason).toBeTruthy();
  }

  it("produces full read-only canonical authority from the actual enrollment, atomic creation and finalized setup", async () => {
    const before = await unchangedState(), original = structuredClone(context), result = await observe();
    expect(result).toMatchObject({ version: "center-wallet-authority-observation-v1", accountId: context.accountId,
      eligibility: "matched", priorAnchor: { status: "none", expected: null, observed: null }, reason: null,
      identity: { accountId: context.accountId, bindingId: context.binding.id,
        bindingAuthorizationDigest: context.binding.authorization.digest, stateHash: setupState.stateHash,
        creationTransaction, initializerHash: enrollment.creation!.initializerHash, sessionAdministration: { epoch: "0" } } });
    expect(result.validUntilMs).toBeGreaterThan(clock); expect(result.validUntilMs).toBeLessThanOrEqual(clock + walletAuthorityMaximumAgeMs);
    const firstCalls = observed.length, stored = reconcile(null, result);
    expect(stored).toMatchObject({ readiness: "verified", authorityEpoch: "1", sessionEpoch: "1", bootstrapRequired: false, activeFence: null });
    const repeated = await observe(stored);
    expect(repeated.priorAnchor).toMatchObject({ status: "same", expected: stored.acceptedAnchor, observed: stored.acceptedAnchor });
    expect(repeated.identity).toEqual(result.identity);
    expect(reconcile(stored, repeated)).toMatchObject({ readiness: "verified", authorityEpoch: "1", sessionEpoch: "1" });
    expect(traces.length).toBeGreaterThan(0);
    for (const trace of traces) { expect(trace.bytes).toBeLessThan(1_048_576); expect(trace.nodes).toBeLessThan(32768); expect(trace.depth).toBeLessThan(64); }
    const refreshCalls = observed.length - firstCalls;
    expect(firstCalls).toBeLessThanOrEqual(256); expect(refreshCalls).toBeLessThanOrEqual(256);
    console.info("Local canonical authority evidence", JSON.stringify({ firstCalls, refreshCalls, traces }));
    expect(await unchangedState()).toEqual(before); expect(context).toEqual(original);
  });

  it("keeps identity and both epochs stable when ordinary Safe and EntryPoint nonces advance", async () => {
    const before = await observe(), stored = reconcile(null, before);
    const safeNonce = await read(safe.abi, account, "nonce") as bigint;
    await ownerCall(sender);
    await ownerCall(entry.address, encodeFunctionData({ abi: entry.abi, functionName: "incrementNonce", args: [0n] }));
    expect(await read(safe.abi, account, "nonce")).toBe(safeNonce + 2n);
    expect(await read(entry.abi, entry.address, "getNonce", [account, 0n])).toBe(1n);
    const after = await observe(stored);
    expect(after.identity).toEqual(before.identity); expect(after.eligibility).toBe("matched");
    expect(reconcile(stored, after)).toMatchObject({ readiness: "verified", authorityEpoch: "1", sessionEpoch: "1" });
  });

  it("invalidates owner swap and A-to-B-to-A on the same Safe using complete authority history", async () => {
    const before = await observe(), initial = reconcile(null, before), originalSigner = enrollment.creation!.bootstrap.signerAddress;
    const replacement = await anotherSigner();
    await swapSigner(originalSigner, replacement);
    const rotated = await observe(initial), rotatedState = reconcile(initial, rotated);
    expect(rotated.accountId).toBe(context.accountId); expect(rotated.eligibility).toBe("changed");
    expect(rotated.identity).not.toBeNull(); expect(rotated.identity!.stateHash).not.toBe(before.identity!.stateHash);
    expect(rotatedState).toMatchObject({ readiness: "changed", authorityEpoch: "2", sessionEpoch: "2" });
    await swapSigner(replacement, originalSigner);
    const returned = await observe(rotatedState), returnedState = reconcile(rotatedState, returned);
    expect(returned.accountId).toBe(context.accountId); expect(returned.eligibility).toBe("changed");
    expect(returned.identity!.stateHash).not.toBe(before.identity!.stateHash);
    expect(returned.identity!.stateHash).not.toBe(rotated.identity!.stateHash);
    expect(returnedState).toMatchObject({ readiness: "changed", authorityEpoch: "3", sessionEpoch: "3" });
    expect((await inspect()).owners).toEqual(setupState.owners);
    expect(reconcile(returnedState, await observe(returnedState))).toMatchObject({ authorityEpoch: "3", sessionEpoch: "3" });
  });

  it("detects actual session enable/remove ABA even when current permissions and legacy stateHash return unchanged", async () => {
    const before = await observe(), stored = reconcile(null, before);
    // A test-only owner session with no actions exercises real administration; it grants no
    // executable product policy. The final authority scan must independently prove emptiness.
    const session: LegacySession = { sessionValidator: ownable.address,
      sessionValidatorInitData: encodeAbiParameters([{ type: "uint256" }, { type: "address[]" }], [1n, [browser.address]]),
      salt: keccak256(toHex("authority session ABA")), userOpPolicies: [],
      erc7739Policies: { allowedERC7739Content: [], erc1271Policies: [] }, actions: [], permitERC4337Paymaster: false };
    const permissionId = permissionIdOf(session);
    await ownerCall(sessions.address, encodeFunctionData({ abi: sessions.abi, functionName: "onInstall", args: [
      concatHex(["0x02", encodeAbiParameters(LEGACY_SESSION_PARAMETERS, [[session]])]),
    ] }));
    expect(await read(sessions.abi, sessions.address, "getPermissionIDs", [account])).toEqual([permissionId]);
    await ownerCall(sessions.address, encodeFunctionData({ abi: sessions.abi, functionName: "removeSession", args: [permissionId] }));
    expect(await read(sessions.abi, sessions.address, "getPermissionIDs", [account])).toEqual([]);
    const state = await inspect(), after = await observe(stored);
    expect(state.stateHash).toBe(setupState.stateHash); expect(after.identity!.stateHash).toBe(before.identity!.stateHash);
    expect(after.identity!.sessionAdministration.epoch).toBe("2");
    expect(after.identity!.sessionAdministration.hash).not.toBe(before.identity!.sessionAdministration.hash);
    expect(walletAuthorityIdentityDigest(after.identity!)).not.toBe(walletAuthorityIdentityDigest(before.identity!));
    expect(reconcile(stored, after)).toMatchObject({ authorityEpoch: "2", sessionEpoch: "2" });
  });

  it("fences a higher replacement fork even with the original identity, then requires a complete rechecked recovery candidate", async () => {
    const initial = reconcile(null, await observe()), forkPoint = await rpc<Hex>("evm_snapshot");
    await ownerCall(sender);
    const accepted = reconcile(initial, await observe(initial));
    expect(accepted.identity).toEqual(initial.identity);
    expect(await rpc("evm_revert", [forkPoint])).toBe(true);
    const oldHead = accepted.acceptedAnchor!;
    await rpc("evm_setNextBlockTimestamp", [Number(oldHead.timestamp) + 2]);
    await rpc("evm_mine"); await rpc("evm_mine");
    const conflict = await observe(accepted);
    expect(BigInt(conflict.head!.blockNumber)).toBeGreaterThan(BigInt(oldHead.blockNumber));
    expect(conflict.priorAnchor.status).toBe("replaced"); expect(conflict.priorAnchor.expected).toEqual(oldHead);
    expect(conflict.priorAnchor.observed!.blockHash).not.toBe(oldHead.blockHash);
    expect(conflict.identity).toBeNull();
    const fenced = reconcile(accepted, conflict);
    expect(fenced).toMatchObject({ readiness: "fenced", authorityEpoch: "2", sessionEpoch: "2",
      activeFence: { abandonedAnchor: oldHead, recoveryAnchor: null } });
    const candidate = reconcile(fenced, await observe(fenced));
    expect(candidate).toMatchObject({ readiness: "fenced", authorityEpoch: "2", sessionEpoch: "2" });
    expect(candidate.activeFence!.recoveryAnchor).not.toBeNull();
    const noHistory: RestRpc = { request: (chain, method, params, signal) => method === "debug_traceTransaction"
      ? Promise.reject(new Error("Local trace deliberately unavailable")) : transport.request(chain, method, params, signal) };
    const unavailable = await observe(candidate, noHistory); unknown(unavailable);
    const retained = reconcile(candidate, unavailable);
    expect(retained).toMatchObject({ readiness: "fenced", authorityEpoch: "2", sessionEpoch: "2", activeFence: candidate.activeFence });
    const recoveredProof = await observe(retained);
    expect(recoveredProof.priorAnchor).toMatchObject({ status: "same", expected: candidate.activeFence!.recoveryAnchor });
    expect(recoveredProof.identity).toEqual(initial.identity);
    const recovered = reconcile(retained, recoveredProof);
    expect(recovered).toMatchObject({ readiness: "verified", authorityEpoch: "2", sessionEpoch: "2", activeFence: null,
      lastClosedFence: { abandonedAnchor: oldHead } });
    expect(recovered.authorityEpoch).not.toBe(initial.authorityEpoch);
    expect(recovered.sessionEpoch).not.toBe(initial.sessionEpoch);
  });

  it.each(["signer", "delegated-backup"] as const)("keeps %s runtime changes unready without inventing authority", async kind => {
    const stored = reconcile(null, await observe());
    await rpc("anvil_setCode", kind === "signer" ? [enrollment.creation!.bootstrap.signerAddress, "0x60006000f3"]
      : [enrollmentBackupAccount.address, concatHex(["0xef0100", sender])]);
    await rpc("evm_mine");
    const result = await observe(stored); unknown(result);
    expect(reconcile(stored, result)).toMatchObject({ readiness: "unknown", authorityEpoch: "1", sessionEpoch: "1", validUntilMs: null });
  });

  it("keeps missing complete history and exhausted shared call budgets unknown and read-only", async () => {
    const stored = reconcile(null, await observe()), before = await unchangedState();
    const noHistory: RestRpc = { request: (chain, method, params, signal) => {
      if (method === "debug_traceTransaction") throw new Error("Synchronous local trace unavailability");
      return transport.request(chain, method, params, signal);
    } };
    const missing = await observe(stored, noHistory); unknown(missing); expect(missing.head).toBeNull();
    expect(reconcile(stored, missing)).toMatchObject({ readiness: "unknown", authorityEpoch: "1", sessionEpoch: "1" });
    observed.length = 0;
    const exhausted = await observe(stored, transport, { rpcCalls: 4 }); unknown(exhausted);
    expect(observed.length).toBeLessThanOrEqual(4);
    expect(await unchangedState()).toEqual(before);
  });

  // Ages the chain past what anvil can trace, so it runs last.
  it("catches a long dormant history up in bounded stages through the durable checkpoint, then verifies at the head", async () => {
    // Hosted providers cap eth_getLogs windows, so a full-history rescan grows with the account's age.
    // With a checkpoint store, each observation advances at most catchUpBlocks and reports that it is
    // still catching up; the refresh worker's next attempt continues from the retained checkpoint.
    const checkpoints = new MemorySafe7579CheckpointStore(), failures: string[] = [];
    const staged = () => createWalletAuthorityChain({ rpc: transport, manifest, utility: pin(utility), now: () => clock,
      checkpointStore: checkpoints, limits: { catchUpBlocks: 100 }, onError: code => failures.push(code) });
    await rpc("anvil_mine", [toHex(350)]);
    const reasons: (string | null)[] = [], calls: number[] = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      // Blocks are mined at real time; the observation clock must not fall behind them under load.
      clock = Date.now(); observed.length = 0;
      const result = await staged().observe(withPrior(null));
      reasons.push(result.reason); calls.push(observed.length);
      if (result.reason !== "authority-history-catching-up") break;
      unknown(result); expect(result.head).toBeNull();
    }
    expect(reasons.slice(0, -1).every(reason => reason === "authority-history-catching-up")).toBe(true);
    expect(reasons.length).toBeGreaterThanOrEqual(4); expect(reasons.at(-1)).toBeNull();
    expect(Math.max(...calls)).toBeLessThanOrEqual(256); expect(failures).toEqual([]);
    // Once caught up, a repeat observation is cheap: it scans only the blocks since the checkpoint.
    clock = Date.now(); observed.length = 0; const again = await staged().observe(withPrior(null));
    expect(again.eligibility).toBe("matched");
    expect(observed.filter(call => call.method === "eth_getLogs").length).toBeLessThanOrEqual(12);
    // At the production stage size with 500-block pages, one stage plus the final leg stay in budget.
    // (Anvil serves historical state only a few hundred blocks back, so the checkpoint is seeded at
    // the current head first and the stage block lands within that window.)
    const production = new MemorySafe7579CheckpointStore();
    const sized = () => createWalletAuthorityChain({ rpc: transport, manifest, utility: pin(utility), now: () => clock, checkpointStore: production, onError: code => failures.push(code) });
    clock = Date.now(); expect((await sized().observe(withPrior(null))).eligibility).toBe("matched");
    // Small chunks: each call must answer inside the helper's 10 s fetch timeout, even under gate load.
    for (let chunk = 0; chunk < 24; chunk++) await rpc("anvil_mine", [toHex(350)]);
    clock = Date.now(); observed.length = 0; const first = await sized().observe(withPrior(null));
    expect(first.reason, JSON.stringify(failures)).toBe("authority-history-catching-up"); expect(observed.length).toBeLessThanOrEqual(256);
    expect(observed.filter(call => call.method === "eth_getLogs").length).toBeLessThanOrEqual(3 * 17);
    clock = Date.now(); observed.length = 0; const last = await sized().observe(withPrior(null));
    expect(last.eligibility).toBe("matched"); expect(observed.length).toBeLessThanOrEqual(256); expect(failures).toEqual([]);
    // The failure code reaches the observer when an observation cannot complete.
    clock = Date.now(); const exhausted = createWalletAuthorityChain({ rpc: transport, manifest, utility: pin(utility), now: () => clock, limits: { rpcCalls: 4 }, onError: code => failures.push(code) });
    unknown(await exhausted.observe(withPrior(null))); expect(failures).toEqual(["WALLET_DEPLOYMENT_RPC_BUDGET"]);
  }, 120_000);
});
