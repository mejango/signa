import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  hashTypedData,
  isAddress,
  keccak256,
  padHex,
  parseAbi,
  recoverAddress,
  stringToHex,
  toHex,
  zeroAddress,
  type Address,
  type Abi,
  type Hex,
} from "viem";
import { RestError, type RestBlockEvidence } from "../core.js";
import { parseAccountId } from "../auth/signatures.js";
import type { RestPrincipal } from "../auth/store.js";
import { exactObject } from "../protocol/abi.js";
import { rpcHex } from "../protocol/code.js";
import { SMART_ACCOUNT_RESEARCH } from "./observations.js";
import { prepareSafe7579Creation } from "./creation.js";
import { inspectPasskeyOwnerProfile, passkeyOwnerProfileHolds } from "./passkeyProfile.js";
import { onboardingDocument, validateOnboardingInput, verifyOnboardingSignatures, type OnboardingFinalizationInput } from "./onboarding.js";
import {
  passkeyOnboardingDocument, passkeyOnboardingSigningPayload, validatePasskeyOnboardingInput,
  verifyPasskeyOnboardingSignatures, type PasskeyOnboardingFinalizationInput, assertPasskeyOnboardingState } from "./passkeyOnboarding.js";
import { createPasskeyContractSignatureVerifier } from "./passkeyContractVerifier.js";
import type {
  SmartAccountBinding,
  SmartAccountDependencies,
  SmartAccountManifest,
  SmartAccountState,
  SmartSnapshot,
} from "./types.js";
import { walletPasskeyConsentBinding } from "../wallet/bindingConsent.js";

export const safeAbi = parseAbi([
  "function VERSION() view returns (string)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function getModulesPaginated(address start,uint256 pageSize) view returns (address[] array,address next)",
]);
const sentinel = "0x0000000000000000000000000000000000000001" as const;
const moduleAbi = parseAbi([
  "function getValidatorsPaginated(address cursor,uint256 pageSize) view returns(address[] array,address next)",
  "function getExecutorsPaginated(address cursor,uint256 pageSize) view returns(address[] array,address next)",
  "function getActiveHook() view returns(address)",
  "function getPrevalidationHook(uint256 moduleType) view returns(address)",
]);
const initializedTopic = keccak256(stringToHex("Safe7579Initialized(address)"));
const userOperationTopic = keccak256(stringToHex("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)"));
/** A verified state is carried to another block only this close to its full verification. */
const maximumAdvanceBlocks = 2_000n;
const slot0 = `0x${"00".repeat(32)}` as Hex;
const fallbackSlot = keccak256(stringToHex("fallback_manager.handler.address"));
const guardSlot = keccak256(stringToHex("guard_manager.guard.address"));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const bytes32 = (value: unknown): value is Hex =>
  typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
export function stable(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value))
    return String(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  throw new RestError(
    400,
    "SMART_ACCOUNT_INPUT_INVALID",
    "Expected canonical bounded JSON.",
  );
}
export const fingerprint = (value: unknown) =>
  keccak256(stringToHex(stable(value)));
function fail(code: string, message: string, status = 422): never {
  throw new RestError(status, code, message);
}
function quantity(value: unknown): bigint {
  if (
    typeof value !== "string" ||
    !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value) ||
    value.length > 66
  )
    return fail("SMART_RPC_INVALID", "RPC returned an invalid quantity.", 502);
  return BigInt(value);
}
const addressFromSlot = (value: unknown): Address => {
  if (!bytes32(value) || !/^0x0{24}/i.test(value))
    return fail(
      "SMART_ACCOUNT_STORAGE_INVALID",
      "Account storage did not contain a canonical address.",
    );
  return getAddress(`0x${value.slice(-40)}`);
};
export interface BindingChallengeInput {
  manifestId: string;
  address: Address;
  nonce: Hex;
  expiresAt: number;
}
export function createSmartAccountService(options: SmartAccountDependencies) {
  const now = options.now ?? Date.now;
  const audience = new URL(options.audience);
  if (
    audience.protocol !== "https:" &&
    !(
      audience.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(audience.hostname)
    )
  )
    fail(
      "SMART_ACCOUNT_CONFIG_INVALID",
      "Use a configured HTTPS service audience.",
      500,
    );
  const activeManifestIds = new Set(
    options.manifests.map((manifest) => manifest.id),
  );
  const manifests = structuredClone([
    ...options.manifests,
    ...(options.retainedManifests ?? []),
  ]);
  if (new Set(manifests.map((item) => item.id)).size !== manifests.length)
    fail(
      "SMART_ACCOUNT_CONFIG_INVALID",
      "Duplicate deployment manifest ID.",
      500,
    );
  function pins(manifest: SmartAccountManifest) {
    return [
      manifest.singleton,
      manifest.factory,
      manifest.safe7579,
      manifest.launchpad,
      ...(manifest.entryPoint ? [manifest.entryPoint] : []),
      manifest.smartSessions,
      ...manifest.policies,
    ];
  }
  for (const m of manifests) {
    if (
      !m.id ||
      !["ownership-only", "execution-candidate"].includes(m.mode) ||
      !Number.isSafeInteger(m.chainId) ||
      m.chainId < 1 ||
      !bytes32(m.revision) ||
      !bytes32(m.proxyRuntimeCodeHash) ||
      m.safeVersion !== "1.4.1" ||
      (m.entryPoint !== undefined && m.entryPoint.version !== "0.7") ||
      !m.moduleInspectorId ||
      m.policies.length > 16
    )
      fail(
        "SMART_ACCOUNT_CONFIG_INVALID",
        "Incomplete reviewed deployment manifest.",
        500,
      );
    for (const pin of pins(m))
      if (
        !isAddress(pin.address) ||
        same(pin.address, zeroAddress) ||
        !bytes32(pin.runtimeCodeHash) ||
        !(
          (/^https:\/\/github\.com\//.test(pin.source.repository) &&
            /^[a-f0-9]{40}$/.test(pin.source.commit ?? "")) ||
          (pin.source.repository === "juicebox-center" &&
            pin.source.commit === undefined &&
            /^[a-f0-9]{64}$/.test(pin.source.contentSha256 ?? ""))
        ) ||
        !/^[a-f0-9]{64}$/.test(pin.source.artifactSha256)
      )
        fail(
          "SMART_ACCOUNT_CONFIG_INVALID",
          "Deployment pins require exact source and runtime identities.",
          500,
        );
  }
  function manifest(id: string) {
    return (
      manifests.find((item) => item.id === id) ??
      fail(
        "SMART_MANIFEST_UNAVAILABLE",
        "No reviewed smart-account deployment manifest is configured for this selection.",
      )
    );
  }
  function owner(principal: RestPrincipal) {
    const identity = parseAccountId(principal.account.id);
    if (
      !principal.isOwner ||
      principal.grantId !== null ||
      !same(identity.ownerAddress, principal.signer) ||
      !same(identity.ownerAddress, principal.account.ownerAddress)
    )
      fail(
        "SMART_OWNER_REQUIRED",
        "Only the authenticated API owner can link or revoke a smart account.",
        403,
      );
    return identity;
  }
  const chainIdentities = new Map<number, { at: number }>();
  async function snapshot(
    chainId: number,
    signal?: AbortSignal,
    at?: RestBlockEvidence,
  ): Promise<SmartSnapshot> {
    const deadline = AbortSignal.any([
      AbortSignal.timeout(45_000),
      ...(signal ? [signal] : []),
    ]);
    // The chain's identity is asked once a minute, not once per snapshot: it guards against a
    // misconfigured endpoint, and a round trip to the provider is the unit of latency here.
    const identity = chainIdentities.get(chainId);
    const [identityRaw, block] = await Promise.all([
      identity && now() - identity.at < 60_000 ? Promise.resolve(null) : options.rpc.request(chainId, "eth_chainId", [], deadline),
      options.rpc.request(
      chainId,
      "eth_getBlockByNumber",
      [at ? `0x${BigInt(at.blockNumber).toString(16)}` : "latest", false],
      deadline,
    ) as Promise<Record<string, unknown>>,
    ]);
    if (identityRaw !== null) {
      if (quantity(identityRaw) !== BigInt(chainId))
        fail(
          "SMART_CHAIN_MISMATCH",
          "RPC chain identity does not match the requested account.",
        );
      chainIdentities.set(chainId, { at: now() });
    }
    if (!block || !bytes32(block.hash))
      fail("SMART_RPC_INVALID", "A mined canonical block is required.", 502);
    const evidence = {
      chainId,
      blockNumber: String(quantity(block.number)),
      blockHash: block.hash,
      timestamp: String(quantity(block.timestamp)),
      source: "onchain" as const,
    };
    if (
      at &&
      (at.chainId !== chainId ||
        !same(at.blockHash, evidence.blockHash) ||
        at.blockNumber !== evidence.blockNumber ||
        at.timestamp !== evidence.timestamp)
    )
      fail(
        "SMART_EVIDENCE_REORGED",
        "The requested account evidence is not canonical.",
        409,
      );
    const tag = { blockHash: block.hash, requireCanonical: true as const };
    return {
      evidence,
      tag,
      request: (method, params) =>
        options.rpc.request(chainId, method, [...params, tag], deadline),
    };
  }
  // Every verification is remembered; only a caller that opts in (the binding read behind a
  // payment's plan and operation) is served from it: at the very block already verified, or at
  // the latest head at any age, with the chain read again behind the answer once the entry is
  // older than the reuse window, as sign-in serves a verified identity at any age. Onboarding,
  // authority and dispatch checks always read the chain, and a submission verifies the account
  // again at its own head, so a stale answer can only make a payment fail there, never pass. A
  // read that fails behind the answer forgets the entry, so the next read waits on the chain and
  // sees the failure. The wallet authority refresh hands each verified state in through `remember`.
  // An entry names the block of its last full verification; a state carried across an empty
  // authority gap keeps that block, so the chain of derivations stays bounded by it.
  const recent = new Map<string, { state: SmartAccountState; fullBlock: bigint; full: SmartAccountState }>();
  const refreshing = new Map<string, Promise<void>>();
  const reuseMs = options.reuseMs ?? 900_000;
  const advancing = options.advance ?? true;
  function refresh(key: string, input: { manifestId: string; address: Address }) {
    if (refreshing.has(key)) return;
    refreshing.set(key, inspectFresh(input).then(keep, (error: unknown) => {
      recent.delete(key);
      console.info(JSON.stringify({ service: "smart-accounts", action: "state_refresh", outcome: "failed",
        manifestId: input.manifestId, code: error instanceof RestError ? error.code : "unknown" }));
    }).then(() => undefined).finally(() => refreshing.delete(key)));
  }
  const keyOf = (manifestId: string, address: string) => `${manifestId}:${address.toLowerCase()}`;
  // A verification at an older block (a historical check behind a receipt) never replaces a
  // newer entry: the entry always describes the account at the latest block anyone verified.
  function keep(state: SmartAccountState, fullBlock = BigInt(state.evidence.blockNumber)) {
    const key = keyOf(state.manifestId, state.address);
    const existing = recent.get(key), block = BigInt(state.evidence.blockNumber);
    const derived = fullBlock !== block;
    // A full verification replaces a carried state at any block; otherwise the newer block wins.
    if (existing && BigInt(existing.state.evidence.blockNumber) > block && (derived || existing.fullBlock === BigInt(existing.state.evidence.blockNumber))) return false;
    // A derived entry keeps the full verification it was carried from, at that verification's block.
    const full = derived && existing && existing.fullBlock === fullBlock ? existing.full : structuredClone(state);
    recent.set(key, { state: structuredClone(state), fullBlock, full });
    return true;
  }
  /** Forgets an account's verified state, so the next read inspects it in full. */
  function forget(manifestId: string, address: Address) {
    recent.delete(keyOf(manifestId, address));
  }
  /** The account's last full verification, if this service made or was handed one: the block it
   * describes is the block it was verified at, never a derivation. Callers re-check that block. */
  function remembered(manifestId: string, address: Address): SmartAccountState | undefined {
    const entry = recent.get(keyOf(manifestId, address));
    return entry && entry.fullBlock === BigInt(entry.full.evidence.blockNumber) ? structuredClone(entry.full) : undefined;
  }
  function remember(state: SmartAccountState) {
    const known = manifests.some((m) => m.id === state.manifestId && m.revision === state.manifestRevision);
    const kept = known && keep(state);
    console.info(JSON.stringify({ service: "smart-accounts", action: "state_remember", outcome: kept ? "kept" : known ? "older" : "ignored",
      manifestId: state.manifestId, block: state.evidence.blockNumber }));
  }
  async function inspect(
    input: { manifestId: string; address: Address },
    signal?: AbortSignal,
    at?: RestBlockEvidence,
    reuse = false,
  ): Promise<SmartAccountState> {
    exactObject(input, ["manifestId", "address"], "account");
    const key = keyOf(input.manifestId, String(input.address));
    // A full inspection already under way for this account (the creation worker's, behind a
    // released lane) is joined rather than doubled: its result is then carried to `at` below.
    if (reuse && at && !recent.has(key) && inflight.has(key)) await inflight.get(key)!.catch(() => undefined);
    const entry = recent.get(key), cached = entry?.state;
    const age = cached === undefined ? null : now() - Number(cached.evidence.timestamp) * 1000;
    const fresh = age !== null && age < reuseMs;
    const hit = reuse && cached !== undefined && (at ? same(cached.evidence.blockHash, at.blockHash) : true);
    if (reuse)
      console.info(JSON.stringify({ service: "smart-accounts", action: "state_reuse", outcome: hit ? fresh ? "hit" : "stale" : "miss",
        manifestId: input.manifestId, ageMs: age === null ? null : Math.round(age), pinned: at !== undefined }));
    if (hit) {
      if (!fresh && !at) refresh(key, input);
      return structuredClone(cached);
    }
    if (reuse && at && entry && advancing) {
      const carried = await advance(entry, at, signal);
      // A full verification that landed meanwhile is the better entry; the carried state is still right at its block.
      if (carried) { if (recent.get(key) === entry) keep(carried, entry.fullBlock); return carried; }
    }
    const work = inspectFresh(input, signal, at).then(state => { keep(state); return state; });
    if (!inflight.has(key)) { inflight.set(key, work); void work.catch(() => undefined).finally(() => { if (inflight.get(key) === work) inflight.delete(key); }); }
    return work;
  }
  const inflight = new Map<string, Promise<SmartAccountState>>();
  /** Carries a verified state to a pinned block when nothing that could change the account's
   * authority happened in between. Every change to owners, threshold, singleton, fallback, guard or
   * modules leaves one of three logs (the account's own, the adapter's initialization for it, or an
   * EntryPoint event with it as sender) — the invariant the durable history already rests on — and
   * the fields those changes would touch are read again at the block and must equal the verified
   * ones, so the logs confirm rather than prove. Any doubt (a read that fails, a lagging node, a log,
   * a difference, a gap past the bound) is a full inspection. The durable checkpoint never advances here. */
  async function advance(
    entry: { state: SmartAccountState; fullBlock: bigint },
    at: RestBlockEvidence,
    signal?: AbortSignal,
  ): Promise<SmartAccountState | null> {
    const { state } = entry, m = manifest(state.manifestId), account = getAddress(state.address);
    const from = BigInt(state.evidence.blockNumber), to = BigInt(at.blockNumber);
    const gap = from < to ? to - from : from - to;
    const report = (outcome: string, extra: Record<string, unknown> = {}) =>
      console.info(JSON.stringify({ service: "smart-accounts", action: "state_advance", outcome, manifestId: state.manifestId,
        gap: String(gap), fromFull: String(to > entry.fullBlock ? to - entry.fullBlock : entry.fullBlock - to), ...extra }));
    if (gap === 0n || (to > entry.fullBlock ? to - entry.fullBlock : entry.fullBlock - to) > maximumAdvanceBlocks) { report("full", { reason: "bound" }); return null; }
    const [low, high] = from < to ? [from, to] : [to, from];
    try {
      const snap = await snapshot(m.chainId, signal, at);
      const call = async (functionName: "getValidatorsPaginated" | "getExecutorsPaginated" | "getActiveHook" | "getPrevalidationHook", args: readonly unknown[] = []) => decodeFunctionResult({ abi: moduleAbi, functionName, data: rpcHex(
        await snap.request("eth_call", [{ from: account, to: m.safe7579.address, data: encodeFunctionData({ abi: moduleAbi, functionName, args: args as never }) }]), "module read") });
      const safe = async (functionName: string, args: readonly unknown[] = []) => decodeFunctionResult({ abi: safeAbi as Abi, functionName, data: rpcHex(
        await snap.request("eth_call", [{ to: account, data: encodeFunctionData({ abi: safeAbi as Abi, functionName, args }), gas: "0xf4240" }]), "Safe read") });
      const range = { fromBlock: toHex(low + 1n), toBlock: toHex(high) };
      const logs = (address: Address, topics: (Hex | null)[]) => options.rpc.request(m.chainId, "eth_getLogs", [{ address, topics, ...range }], signal);
      const [head, origin, ingress, slots, owners, threshold, validators, executors, hooks, passkey] = await Promise.all([
        options.rpc.request(m.chainId, "eth_blockNumber", [], signal),
        options.rpc.request(m.chainId, "eth_getBlockByNumber", [toHex(from), false], signal) as Promise<{ hash?: string } | null>,
        Promise.all([
          logs(account, []),
          logs(m.safe7579.address, [initializedTopic, padHex(account, { size: 32 })]),
          logs(m.entryPoint!.address, [userOperationTopic, null, padHex(account, { size: 32 })]),
        ]),
        Promise.all([slot0, fallbackSlot, guardSlot].map(async (slot) => addressFromSlot(await snap.request("eth_getStorageAt", [account, slot])))),
        safe("getOwners") as Promise<unknown>,
        safe("getThreshold") as Promise<unknown>,
        call("getValidatorsPaginated", [sentinel, 33n]) as Promise<unknown>,
        call("getExecutorsPaginated", [sentinel, 33n]) as Promise<unknown>,
        Promise.all([call("getActiveHook"), call("getPrevalidationHook", [9n]), call("getPrevalidationHook", [8n])]),
        m.ownerProfile && state.ownerProfile ? passkeyOwnerProfileHolds({ profile: state.ownerProfile, snapshot: snap }) : Promise.resolve(!m.ownerProfile),
      ]);
      // The re-read fields are the proof; the logs confirm, and only mean something from a node
      // that had the whole range (each read is its own request, so this is a bound, not a proof).
      if (quantity(head) < high) { report("full", { reason: "head" }); return null; }
      if (!same(origin?.hash ?? "", state.evidence.blockHash)) { report("full", { reason: "origin" }); return null; }
      const logCount = ingress.reduce<number>((count, list) => count + (Array.isArray(list) ? list.length : 1), 0);
      const [singleton, fallback, guard] = slots;
      const list = (value: unknown) => Array.isArray(value) && Array.isArray(value[0]) && same(String(value[1]), sentinel) ? value[0].map((a) => String(a).toLowerCase()) : null;
      const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].map((x) => x.toLowerCase()).sort().every((x, i) => x === [...b].map((y) => y.toLowerCase()).sort()[i]);
      const agrees = logCount === 0
        && same(singleton!, m.singleton.address) && same(fallback!, m.safe7579.address) && same(guard!, zeroAddress)
        && Array.isArray(owners) && sameSet(owners.map(String), state.owners) && threshold === BigInt(state.threshold)
        && sameSet(list(validators) ?? ["-"], [m.smartSessions.address]) && list(executors)?.length === 0
        && (hooks as unknown[]).every((hook) => same(String(hook), zeroAddress))
        && passkey;
      if (!agrees) { report("full", { reason: "disagreement", logs: logCount }); return null; }
      report("carried", { logs: 0 });
      return { ...structuredClone(state), evidence: snap.evidence };
    } catch (error) {
      report("full", { reason: "unavailable", code: error instanceof RestError ? error.code : "unknown" });
      return null;
    }
  }
  async function inspectFresh(
    input: { manifestId: string; address: Address },
    signal?: AbortSignal,
    at?: RestBlockEvidence,
  ): Promise<SmartAccountState> {
    const m = manifest(input.manifestId);
    if (!isAddress(input.address) || same(input.address, zeroAddress))
      fail(
        "SMART_ACCOUNT_INPUT_INVALID",
        "Use a deployed smart account address.",
        400,
      );
    const account = getAddress(input.address),
      snap = await snapshot(m.chainId, signal, at);
    async function requireCode(address: Address, expected: Hex) {
      const code = rpcHex(
        await snap.request("eth_getCode", [address]),
        "runtime code",
      );
      if (code === "0x" || keccak256(code) !== expected.toLowerCase())
        fail(
          "SMART_RUNTIME_MISMATCH",
          "Smart account or dependency runtime does not match its reviewed deployment pin.",
        );
      return { address, runtimeCodeHash: keccak256(code) };
    }
    const [codeHashes, [singleton, fallback, guard]] = await Promise.all([
      Promise.all([
        requireCode(account, m.proxyRuntimeCodeHash),
        ...pins(m).map(pin => requireCode(pin.address, pin.runtimeCodeHash)),
      ]),
      Promise.all(
        [slot0, fallbackSlot, guardSlot].map(async (slot) =>
          addressFromSlot(
            await snap.request("eth_getStorageAt", [account, slot]),
          ),
        ),
      ),
    ]);
    if (
      !same(singleton!, m.singleton.address) ||
      !same(fallback!, m.safe7579.address) ||
      !same(guard!, zeroAddress)
    )
      fail(
        "SMART_ACCOUNT_LAYOUT_UNSUPPORTED",
        "The Safe singleton, fallback handler or guard differs from the reviewed account layout.",
      );
    // The module inspection is the slow read; it runs alongside the owner checks below, past the
    // layout gate so an unrecognised layout never starts it. Its result is only read after those
    // checks, so which failure surfaces first is unchanged; a failed check cancels it and waits.
    const inspector = options.moduleInspectors?.find(
      (item) => item.id === m.moduleInspectorId,
    );
    const abort = new AbortController();
    const inspecting = inspector
      ? inspector.inspect({ account, manifest: m, snapshot: snap, signal: abort.signal }).then(
          (value) => ({ value, failure: null as unknown }),
          (failure: unknown) => ({ value: null, failure }),
        )
      : null;
    try {
      async function read(
        functionName: string,
        args: readonly unknown[] = [],
      ): Promise<unknown> {
        const data = encodeFunctionData({
          abi: safeAbi as Abi,
          functionName,
          args,
        });
        const result = rpcHex(
          await snap.request("eth_call", [{ to: account, data, gas: "0xf4240" }]),
          "Safe read",
        );
        return decodeFunctionResult({
          abi: safeAbi as Abi,
          functionName,
          data: result,
        });
      }
      const [version, ownersRaw, thresholdRaw, nonceRaw, moduleList] =
        await Promise.all([
          read("VERSION"),
          read("getOwners"),
          read("getThreshold"),
          read("nonce"),
          read("getModulesPaginated", [sentinel, 33n]),
        ]);
      if (
        version !== m.safeVersion ||
        !Array.isArray(ownersRaw) ||
        ownersRaw.length < 1 ||
        ownersRaw.length > 16 ||
        !ownersRaw.every(
          (entry) => typeof entry === "string" && isAddress(entry),
        ) ||
        typeof thresholdRaw !== "bigint" ||
        thresholdRaw < 1n ||
        thresholdRaw > BigInt(ownersRaw.length) ||
        typeof nonceRaw !== "bigint"
      )
        fail(
          "SMART_ACCOUNT_OWNERS_INVALID",
          "The Safe owner configuration is unsupported.",
        );
      const owners = ownersRaw.map((entry) => getAddress(entry as string));
      if (
        new Set(owners.map((entry) => entry.toLowerCase())).size !==
          owners.length ||
        owners.some((entry) => same(entry, zeroAddress))
      )
        fail("SMART_ACCOUNT_OWNERS_INVALID", "Invalid Safe owner set.");
      const passkey = m.ownerProfile ? await inspectPasskeyOwnerProfile({
        manifest: m, owners, threshold: Number(thresholdRaw), snapshot: snap,
      }) : undefined;
      if (passkey) codeHashes.push(...passkey.codeHashes);
      // An absent profile preserves the legacy EOA-only authority and state hash exactly.
      for (const address of passkey ? [] : owners)
        if (
          rpcHex(await snap.request("eth_getCode", [address]), "owner code") !==
          "0x"
        )
          fail(
            "SMART_CONTRACT_OWNER_UNSUPPORTED",
            "Contract or delegated Safe owners require a separately reviewed owner-signature adapter.",
          );
      if (
        !Array.isArray(moduleList) ||
        !Array.isArray(moduleList[0]) ||
        moduleList[0].length !== 1 ||
        !same(String(moduleList[0][0]), m.safe7579.address) ||
        !same(String(moduleList[1]), sentinel)
      )
        fail(
          "SMART_SAFE_MODULES_UNSUPPORTED",
          "The Safe must enable only the pinned Safe7579 adapter; pagination must be complete.",
        );
      const inspected = inspecting ? await inspecting : null;
      if (inspected?.failure) throw inspected.failure;
      const modules = inspected?.value ?? null;
      if (
        modules &&
        (!bytes32(modules.stateHash) ||
          modules.complete !== true ||
          modules.arbitrarySigningDisabled !== true ||
          modules.wildcardExecutionDisabled !== true ||
          Buffer.byteLength(stable(modules)) > 8192)
      )
        fail(
          "SMART_MODULE_PROOF_INVALID",
          "Complete bounded module and signing-policy evidence is required.",
        );
      const stateHash = fingerprint({
        address: account.toLowerCase(),
        manifestRevision: m.revision,
        owners: owners.map((a) => a.toLowerCase()).sort(),
        threshold: String(thresholdRaw),
        singleton,
        fallback,
        guard,
        modules: modules?.stateHash ?? null,
        ...(passkey ? { ownerProfile: { pins: m.ownerProfile, state: passkey.ownerProfile } } : {}),
      });
      return {
        chainId: m.chainId,
        address: account,
        manifestId: m.id,
        manifestRevision: m.revision,
        owners,
        threshold: Number(thresholdRaw),
        safeNonce: String(nonceRaw),
        stateHash,
        evidence: snap.evidence,
        codeHashes,
        modules,
        moduleConfigurationVerified: modules !== null,
        executionVerified: false,
        ...(passkey ? { ownerProfile: passkey.ownerProfile } : {}),
      };
    } catch (error) {
      abort.abort();
      if (inspecting) await inspecting;
      throw error;
    }
  }
  async function challenge(
    principal: RestPrincipal,
    input: BindingChallengeInput,
    signal?: AbortSignal,
  ) {
    owner(principal);
    exactObject(
      input,
      ["manifestId", "address", "nonce", "expiresAt"],
      "binding",
    );
    if (
      !bytes32(input.nonce) ||
      BigInt(input.nonce) === 0n ||
      !Number.isSafeInteger(input.expiresAt) ||
      input.expiresAt <= Math.floor(now() / 1000) ||
      input.expiresAt > Math.floor(now() / 1000) + 900
    )
      fail(
        "SMART_BINDING_INVALID",
        "Use a random nonce and an owner binding expiry within fifteen minutes.",
        400,
      );
    if (same(input.address, principal.account.ownerAddress))
      fail(
        "SMART_WALLET_IDENTITY_REQUIRED",
        "The smart-account wallet must be distinct from the API owner EOA.",
      );
    const state = await inspect(
      { manifestId: input.manifestId, address: input.address },
      signal,
    );
    if (
      !state.owners.some((item) => same(item, principal.account.ownerAddress))
    )
      fail(
        "SMART_OWNER_NOT_MEMBER",
        "The API owner is not a current owner of this Safe.",
        403,
      );
    const typedData = {
      domain: {
        name: "Juicebox Center Smart Account",
        version: "1",
        chainId: state.chainId,
        verifyingContract: state.address,
        salt: keccak256(stringToHex(audience.toString())),
      },
      types: {
        BindSmartAccount: [
          { name: "accountId", type: "string" },
          { name: "owner", type: "address" },
          { name: "stateHash", type: "bytes32" },
          { name: "nonce", type: "bytes32" },
          { name: "expiresAt", type: "uint64" },
        ],
      },
      primaryType: "BindSmartAccount" as const,
      message: {
        accountId: principal.account.id,
        owner: principal.account.ownerAddress,
        stateHash: state.stateHash,
        nonce: input.nonce,
        expiresAt: BigInt(input.expiresAt),
      },
    };
    return { state, typedData, digest: hashTypedData(typedData) };
  }
  async function prepareCreation(
    principal: RestPrincipal,
    input: {
      manifestId: string;
      owners: Address[];
      threshold: number;
      saltNonce: string;
    },
    signal?: AbortSignal,
  ) {
    owner(principal);
    exactObject(
      input,
      ["manifestId", "owners", "threshold", "saltNonce"],
      "creation",
    );
    if (
      !Array.isArray(input.owners) ||
      !input.owners.every(
        (address) => typeof address === "string" && isAddress(address),
      ) ||
      !input.owners.some((address) =>
        same(address, principal.account.ownerAddress),
      )
    )
      fail(
        "SMART_OWNER_NOT_MEMBER",
        "The API owner must be an owner of the new Safe.",
        403,
      );
    const m = manifest(input.manifestId);
    const creation = prepareSafe7579Creation({
      manifest: m,
      owners: input.owners,
      threshold: input.threshold,
      saltNonce: input.saltNonce,
    });
    const snap = await snapshot(m.chainId, signal);
    for (const pin of pins(m)) {
      const code = rpcHex(
        await snap.request("eth_getCode", [pin.address]),
        "creation dependency",
      );
      if (
        code === "0x" ||
        keccak256(code) !== pin.runtimeCodeHash.toLowerCase()
      )
        fail(
          "SMART_RUNTIME_MISMATCH",
          "A wallet creation dependency differs from its reviewed runtime.",
        );
    }
    const code = rpcHex(
      await snap.request("eth_getCode", [creation.address]),
      "predicted account",
    );
    if (code !== "0x")
      fail(
        "SMART_ACCOUNT_ALREADY_DEPLOYED",
        "The predicted wallet already exists. Verify and bind it, or select a fresh salt.",
        409,
      );
    return {
      ...creation,
      manifest: m,
      evidence: snap.evidence,
      deploymentConfirmed: false,
    };
  }
  /** Public canonical read; it neither enrolls an identity nor grants authority. */
  async function onboardingChallenge(input: unknown, signal?: AbortSignal) {
    if (!options.onboarding) fail("SMART_ONBOARDING_UNAVAILABLE", "Account setup is not configured.", 503);
    const value = validateOnboardingInput(input, Math.floor(now() / 1000));
    const state = await inspect({manifestId:value.manifestId,address:value.address}, signal);
    const current = Math.floor(now() / 1000);
    validateOnboardingInput(value, current);
    requireFreshOnboardingState(state, current);
    signal?.throwIfAborted();
    const typedData = onboardingDocument(options.audience, value, state);
    return {state,typedData,digest:hashTypedData(typedData)};
  }
  /** The one purpose-specific signature is not a generic owner REST credential. */
  async function finalizeOnboarding(input: unknown, signal?: AbortSignal) {
    if (!options.onboarding) fail("SMART_ONBOARDING_UNAVAILABLE", "Account setup is not configured.", 503);
    const value = validateOnboardingInput(input, Math.floor(now() / 1000), true);
    const signed = input as OnboardingFinalizationInput;
    const state = await inspect({manifestId:value.manifestId,address:value.address}, signal);
    const document = onboardingDocument(options.audience, value, state);
    if (!same(signed.stateHash, state.stateHash) || !same(signed.manifestRevision, state.manifestRevision)
      || !same(signed.initializerHash, document.message.initializerHash))
      fail("SMART_ACCOUNT_CHANGED", "The wallet configuration changed since setup review.", 409);
    await verifyOnboardingSignatures(document, signed.signature, signed.proofSignature);
    const current = Math.floor(now() / 1000);
    validateOnboardingInput(input, current, true);
    requireFreshOnboardingState(state, current);
    signal?.throwIfAborted();
    const accountId = document.message.accountId;
    const binding: SmartAccountBinding = {
      id: fingerprint({ownerAccountId:accountId,wallet:state.address,chainId:state.chainId}),
      ownerAccountId:accountId,ownerAddress:value.owner,wallet:{chainId:state.chainId,address:state.address},manifestId:value.manifestId,
      authorization:{digest:hashTypedData(document),nonce:value.nonce,expiresAt:value.expiresAt,method:"safe-current-owner-threshold-and-api-grant",
        setup:{manifestRevision:state.manifestRevision,initializerHash:document.message.initializerHash,issuedAt:value.issuedAt,
          grantId:value.grant.id,botAddress:value.grant.botAddress,scopes:[...value.grant.scopes],grantExpiresAt:value.grant.expiresAt,label:value.grant.label}},
      state,
    };
    return options.onboarding.finalize({
      account:{id:accountId,ownerAddress:value.owner,authorityChainId:8453,profile:{displayName:"",bio:"",avatarUri:null},createdAt:current,updatedAt:current},
      binding,
      grant:{id:value.grant.id,accountId,botAddress:value.grant.botAddress,scopes:[...value.grant.scopes],label:value.grant.label,
        createdAt:current,expiresAt:value.grant.expiresAt,revokedAt:null},
    });
  }
  function requireFreshOnboardingState(state: SmartAccountState, current: number) {
    const timestamp = Number(state.evidence.timestamp);
    if (!Number.isSafeInteger(timestamp) || timestamp < current - 300 || timestamp > current + 30)
      fail("SMART_EVIDENCE_STALE", "Account setup requires a recent canonical wallet observation.", 409);
  }
  /** Explicit v2 setup of a deployed passkey pilot. It does not enroll a credential or submit a deployment. */
  async function passkeyOnboardingChallenge(input: unknown, signal?: AbortSignal) {
    if (!options.onboarding) fail("SMART_ONBOARDING_UNAVAILABLE", "Account setup is not configured.", 503);
    const value = validatePasskeyOnboardingInput(input, Math.floor(now() / 1000));
    const state = await inspect({ manifestId: value.manifestId, address: value.address }, signal);
    const typedData = passkeyOnboardingDocument(options.audience, value, state);
    await snapshot(state.chainId, signal, state.evidence);
    const current = Math.floor(now() / 1000);
    validatePasskeyOnboardingInput(value, current);
    requireFreshOnboardingState(state, current);
    signal?.throwIfAborted();
    return { state, typedData, digest: hashTypedData(typedData), signingPayload: passkeyOnboardingSigningPayload(typedData) };
  }
  /** Binds a wallet the passkey created through Center to its account from the consent that passkey
   * already gave (its enrollment or recovery proof). No prompt, no owner signature over Center state,
   * no browser grant: reads and preparation need none, every execution still takes the passkey. */
  async function bindPasskeyAccount(input: { manifestId: string; address: Address; consent: { id: string; digest: Hex };
    expected: { signerAddress: Address; initializerHash: Hex; deviceSigners?: Address[] } }, signal?: AbortSignal) {
    if (!options.onboarding) fail("SMART_ONBOARDING_UNAVAILABLE", "Account setup is not configured.", 503);
    // A verification made moments ago (the creation worker's, behind the released lane) is carried
    // to the current head when the gap holds no authority-changing log and every re-read field
    // agrees (`advance`); any doubt, or no such verification, is a full inspection at the head.
    const head = (await snapshot(manifest(input.manifestId).chainId, signal)).evidence;
    const state = await inspect({ manifestId: input.manifestId, address: input.address }, signal, head, true);
    // The consent names one passkey signer, one initializer and, when devices were added, exactly
    // those device signers; a wallet in any other state is not bound, so a stale or divergent read
    // can never write a binding the credential cannot use.
    const observed = assertPasskeyOnboardingState(state);
    // Recovery leaves devices alone and passes none to check; a device addition names the whole set.
    const devices = (observed.profile.devices ?? []).map(device => device.address.toLowerCase()).sort();
    const expectedDevices = input.expected.deviceSigners?.map(device => device.toLowerCase()).sort();
    if (!same(observed.profile.signer.address, input.expected.signerAddress) || !same(observed.initializerHash, input.expected.initializerHash)
      || (expectedDevices && (devices.length !== expectedDevices.length || devices.some((device, index) => device !== expectedDevices[index]))))
      fail("SMART_ACCOUNT_CHANGED", "The wallet is not in the state its passkey consented to.", 409);
    await snapshot(state.chainId, signal, state.evidence);
    const bound = Math.floor(now() / 1000);
    requireFreshOnboardingState(state, bound);
    signal?.throwIfAborted();
    return options.onboarding.finalize(walletPasskeyConsentBinding({ accountId: `eip155:8453:${state.address.toLowerCase()}`, state,
      consent: input.consent, nowSeconds: bound }));
  }
  /** Fresh current-owner approval and browser possession commit through the existing atomic setup store. */
  async function finalizePasskeyOnboarding(input: unknown, signal?: AbortSignal) {
    if (!options.onboarding) fail("SMART_ONBOARDING_UNAVAILABLE", "Account setup is not configured.", 503);
    const signed = structuredClone(input) as PasskeyOnboardingFinalizationInput;
    const value = validatePasskeyOnboardingInput(signed, Math.floor(now() / 1000), true);
    const state = await inspect({ manifestId: value.manifestId, address: value.address }, signal);
    const document = passkeyOnboardingDocument(options.audience, value, state);
    if (!same(signed.stateHash, state.stateHash) || !same(signed.manifestRevision, state.manifestRevision)
      || !same(signed.initializerHash, document.message.initializerHash))
      fail("SMART_ACCOUNT_CHANGED", "The wallet configuration changed since setup review.", 409);
    await verifyPasskeyOnboardingSignatures(document, state, signed.signature, signed.proofSignature,
      createPasskeyContractSignatureVerifier({ state, manifest: manifest(value.manifestId), rpc: options.rpc, now,
        ...(signal ? { signal } : {}) }));
    // The backup EOA path must recheck canonicality too, even though it did not call a contract signer.
    await snapshot(state.chainId, signal, state.evidence);
    const current = Math.floor(now() / 1000);
    validatePasskeyOnboardingInput(signed, current, true);
    requireFreshOnboardingState(state, current);
    signal?.throwIfAborted();
    const accountId = document.message.accountId;
    const binding: SmartAccountBinding = {
      id: fingerprint({ ownerAccountId: accountId, wallet: state.address, chainId: state.chainId }),
      ownerAccountId: accountId, ownerAddress: state.address, wallet: { chainId: state.chainId, address: state.address }, manifestId: value.manifestId,
      authorization: { digest: hashTypedData(document), nonce: value.nonce, expiresAt: value.expiresAt,
        method: "safe-passkey-owner-threshold-and-api-grant",
        setup: { manifestRevision: state.manifestRevision, initializerHash: document.message.initializerHash, issuedAt: value.issuedAt,
          grantId: value.grant.id, botAddress: value.grant.botAddress, scopes: [...value.grant.scopes], grantExpiresAt: value.grant.expiresAt, label: value.grant.label } },
      state,
    };
    return options.onboarding.finalize({
      account: { id: accountId, ownerAddress: state.address, authorityChainId: 8453,
        profile: { displayName: "", bio: "", avatarUri: null }, createdAt: current, updatedAt: current },
      binding,
      grant: { id: value.grant.id, accountId, botAddress: value.grant.botAddress, scopes: [...value.grant.scopes], label: value.grant.label,
        createdAt: current, expiresAt: value.grant.expiresAt, revokedAt: null },
    });
  }
  async function bind(
    principal: RestPrincipal,
    input: BindingChallengeInput & { stateHash: Hex; signature: Hex },
    signal?: AbortSignal,
  ): Promise<SmartAccountBinding> {
    exactObject(
      input,
      ["manifestId", "address", "nonce", "expiresAt", "stateHash", "signature"],
      "binding",
    );
    const fresh = await challenge(
      principal,
      {
        manifestId: input.manifestId,
        address: input.address,
        nonce: input.nonce,
        expiresAt: input.expiresAt,
      },
      signal,
    );
    if (fresh.state.stateHash !== input.stateHash)
      fail(
        "SMART_ACCOUNT_CHANGED",
        "The wallet owner/module configuration changed since review.",
        409,
      );
    if (
      typeof input.signature !== "string" ||
      !new RegExp(`^0x[0-9a-fA-F]{${fresh.state.threshold * 130}}$`).test(
        input.signature,
      )
    )
      fail(
        "SMART_OWNER_SIGNATURE_INVALID",
        "Supply exactly the current threshold of packed owner EIP-712 signatures.",
        403,
      );
    let previous = 0n;
    for (let i = 0; i < fresh.state.threshold; i++) {
      const part =
        `0x${input.signature.slice(2 + i * 130, 2 + (i + 1) * 130)}` as Hex;
      if (!["1b", "1c"].includes(part.slice(-2).toLowerCase()))
        fail(
          "SMART_OWNER_SIGNATURE_INVALID",
          "Only direct EIP-712 EOA-owner signatures are accepted; approved hashes and session signatures cannot bind accounts.",
          403,
        );
      let signer: Address;
      try {
        signer = await recoverAddress({
          hash: fresh.digest,
          signature: part,
        });
      } catch {
        fail(
          "SMART_OWNER_SIGNATURE_INVALID",
          "An owner signature is malformed or cannot be recovered.",
          403,
        );
      }
      if (
        BigInt(signer) <= previous ||
        !fresh.state.owners.some((entry) => same(entry, signer))
      )
        fail(
          "SMART_OWNER_SIGNATURE_INVALID",
          "Signatures must satisfy the current Safe owner threshold in address order.",
          403,
        );
      previous = BigInt(signer);
    }
    const record: SmartAccountBinding = {
      id: fingerprint({
        ownerAccountId: principal.account.id,
        wallet: fresh.state.address,
        chainId: fresh.state.chainId,
      }),
      ownerAccountId: principal.account.id,
      ownerAddress: principal.account.ownerAddress,
      wallet: { chainId: fresh.state.chainId, address: fresh.state.address },
      manifestId: input.manifestId,
      authorization: {
        digest: fresh.digest,
        nonce: input.nonce,
        expiresAt: input.expiresAt,
        method: "safe-current-owner-threshold",
      },
      state: fresh.state,
    };
    return options.registry.bind(record);
  }
  async function current(
    ownerAccountId: string,
    id: Hex,
    signal?: AbortSignal,
    at?: RestBlockEvidence,
  ) {
    const record = await options.registry.get(ownerAccountId, id);
    if (!record)
      fail(
        "SMART_BINDING_NOT_FOUND",
        "The account binding is absent or revoked.",
        404,
      );
    const state = await inspect(
      { manifestId: record.manifestId, address: record.wallet.address },
      signal,
      at,
      true,
    );
    if (state.stateHash !== record.state.stateHash)
      fail(
        "SMART_ACCOUNT_CHANGED",
        "The owner or module configuration changed. Obtain a fresh owner account binding.",
        409,
      );
    return { ...record, state };
  }
  async function capabilities() {
    return {
      deploymentResearch: SMART_ACCOUNT_RESEARCH,
      accountOwnershipVerification: "safe-current-eoa-owner-threshold",
      sessionDurationsDays: [7, 30],
      walletCreation: manifests.some(
        (m) =>
          m.safe7579.source.commit ===
          "f22a194148ff087f0c16125e530512e59794e188",
      ),
      userOperations: "/api/v1/capabilities",
      deployments: manifests
        .filter((m) => activeManifestIds.has(m.id))
        .map((m) => ({
          manifestId: m.id,
          mode: m.mode,
          chainId: m.chainId,
          revision: m.revision,
          manifest: m,
          moduleGeneration: m.smartSessions.generation,
          entryPointSourceVerified: m.entryPoint !== undefined,
          moduleInspectionConfigured:
            options.moduleInspectors?.some(
              (i) => i.id === m.moduleInspectorId,
            ) ?? false,
        })),
      requirements: [
        ...(manifests.length
          ? []
          : ["reviewed-per-chain-deployment-manifests"]),
        "version-specific-session-policy-compiler-and-installed-policy-verifier",
        ...(options.bundler ? [] : ["configured-erc4337-bundler"]),
        "account-gas-funding-or-reviewed-paymaster-policy",
      ],
      exclusions: [
        "eoa-fallback",
        "unreviewed-modules",
        "arbitrary-signing",
        "wildcard-execution",
        "contract-owner-threshold-adapter",
        "automatic-cross-chain-budget-reuse",
      ],
    };
  }
  async function list(principal: RestPrincipal) {
    if (!principal.scopes.includes("read"))
      fail(
        "SMART_READ_SCOPE_REQUIRED",
        "Reading wallet bindings requires read scope.",
        403,
      );
    const records = await options.registry.list(principal.account.id);
    return {
      items: records.map((record) => ({
        id: record.id,
        wallet: record.wallet,
        manifestId: record.manifestId,
        stateHash: record.state.stateHash,
        evidence: record.state.evidence,
        moduleConfigurationVerified: record.state.moduleConfigurationVerified,
        executionVerified: false,
        observation: "stored-binding-snapshot",
      })),
    };
  }
  async function revoke(principal: RestPrincipal, id: Hex) {
    owner(principal);
    if (!bytes32(id))
      fail("SMART_BINDING_INVALID", "Use the exact binding identifier.", 400);
    await options.registry.revoke(principal.account.id, id);
    return {
      id,
      status: "unlinked",
      onchainSessionRevoked: false,
      reason:
        "API wallet unlinking does not revoke any installed onchain session.",
    };
  }
  async function bundlerReadiness(manifestId: string, signal?: AbortSignal) {
    const m = manifest(manifestId);
    if (!m.entryPoint)
      return { ready: false, reason: "source-verified-entrypoint-required" };
    const entryPoint = m.entryPoint;
    if (!options.bundler)
      return { ready: false, reason: "configured-erc4337-bundler-required" };
    const [chain, entryPoints] = await Promise.all([
      options.bundler.request(m.chainId, "eth_chainId", [], signal),
      options.bundler.request(
        m.chainId,
        "eth_supportedEntryPoints",
        [],
        signal,
      ),
    ]);
    if (
      quantity(chain) !== BigInt(m.chainId) ||
      !Array.isArray(entryPoints) ||
      entryPoints.length > 32 ||
      !entryPoints.every(
        (entry) => typeof entry === "string" && isAddress(entry),
      ) ||
      !entryPoints.some((entry) => same(entry, entryPoint.address))
    )
      fail(
        "SMART_BUNDLER_MISMATCH",
        "Bundler chain or EntryPoint support differs from the reviewed deployment.",
      );
    return {
      ready: true,
      chainId: m.chainId,
      entryPoint: m.entryPoint.address,
      scope: "transport-discovery-only",
    };
  }
  return {
    inspect,
    remember,
    remembered,
    forget,
    prepareCreation,
    challenge,
    onboardingChallenge,
    passkeyOnboardingChallenge,
    finalizePasskeyOnboarding,
    bindPasskeyAccount,
    finalizeOnboarding,
    bind,
    current,
    currentAt: (
      ownerAccountId: string,
      id: Hex,
      evidence: RestBlockEvidence,
      signal?: AbortSignal,
    ) => current(ownerAccountId, id, signal, evidence),
    capabilities,
    bundlerReadiness,
    list,
    revoke,
  };
}
