import { afterEach, expect, it, vi } from "vitest";
import { hashTypedData, keccak256, recoverAddress, sliceHex, stringToHex, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  SignedRestClient,
  connectionForBot,
  type PreparedUserOperation,
  type WalletTypedData,
} from "../src/rest/client/index.js";
import { accountsPage } from "../src/rest/web/page.js";
import { installSmartWalletUI } from "../src/rest/web/smartSessions.js";
import {
  encodeSafe7579Execution,
  legacySessionSigningPayload,
  safe7579OwnerSigningPayload,
  verifyLegacySessionSignature,
  verifySafe7579OwnerSignature,
} from "../src/rest/smartAccounts/accountExecution.js";
import { CHECKED_SMART_ACCOUNT_BINDING_MANIFESTS } from "../src/rest/smartAccounts/manifests.js";
import { prepareSafe7579Creation } from "../src/rest/smartAccounts/creation.js";
import { walletRecoveries } from "../src/rest/web/walletRecovery.js";
import { getUserOperationHash } from "../src/rest/userOperations/codec.js";
import {
  REST_AUTH_HEADERS,
  readRequestClaims,
  verifyRequestSignature,
} from "../src/rest/auth/signatures.js";
import {
  account,
  binding,
  entryPoint,
  owner,
  ownerKey,
  plan,
  record,
} from "./fixtures/user-operations.js";
import {
  sessionBinding,
  sessionFixture,
  sessionObservation,
} from "./fixtures/sessions.js";

/** Small event/field harness. Runs the actual browser controller and real signatures without a browser dependency. */
class Field extends EventTarget {
  value = "";
  textContent = "";
  hidden = false;
  disabled = false;
  checked = false;
  open = false;
  files: { size: number; text(): Promise<string> }[] = [];
  children: Field[] = [];
  constructor(readonly id = "") {
    super();
  }
  append(...children: Field[]) {
    this.children.push(...children);
    if (!this.value && children[0]) this.value = children[0].value;
  }
  replaceChildren() {
    this.children = [];
    this.value = "";
  }
  scrollIntoView() {}
  setAttribute(_name: string, _value: string) {}
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function harness(options: {
  sessions?: { activationReady: boolean; configuredChainIds: number[] } | null;
  loadBinding?: boolean;
  multisig?: boolean;
  multichain?: boolean;
} = {}) {
  let sessionCapabilities = options.sessions === undefined
    ? { activationReady: true, configuredChainIds: [1] }
    : options.sessions;
  const nodes = new Map(
    [...accountsPage().matchAll(/\bid="([^"]+)"/g)].map((x) => [
      x[1]!,
      new Field(x[1]),
    ]),
  );
  const field = (id: string) => {
    const result = nodes.get(id);
    if (!result) throw new Error(`Missing actual page field ${id}`);
    return result;
  };
  vi.stubGlobal("document", {
    getElementById: (id: string) => field(id),
    createElement: () => new Field(),
  });
  const stored = new Map<string, string>();
  const browser = Object.assign(new EventTarget(), { location: { hash: "" }, localStorage: {
    getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); },
  } });
  vi.stubGlobal("window", browser);
  field("operation-authority").value = "owner";
  field("operation-steps").value = "0";
  field("operation-name").value = "contract_calls";
  field("operation-input").value = "{}";
  field("smart-threshold").value = "1";
  field("operation-fields").disabled = true;
  const now = Date.now(),
    a = account(now),
    b = binding(a, now),
    p = plan("web-plan", owner(a), b, now);
  const coowner = privateKeyToAccount(`0x${"28".repeat(32)}`);
  if (options.multisig) {
    b.state.owners.push(coowner.address);
    b.state.threshold = 2;
  }
  const otherBinding = structuredClone(b);
  otherBinding.id = toHex(43n, { size: 32 }); otherBinding.wallet.chainId = 10;
  otherBinding.manifestId = "fixture-optimism";
  otherBinding.state.chainId = 10; otherBinding.state.manifestId = otherBinding.manifestId;
  const otherPlan = plan("web-plan-10", owner(a), otherBinding, now);
  otherPlan.smartAccount!.chainId = 10;
  for (const call of otherPlan.draft.calls) call.chainId = 10;
  const plans = new Map([[p.id, p], [otherPlan.id, otherPlan]]);
  const bindings = new Map([[b.manifestId, b], [otherBinding.manifestId, otherBinding]]);
  const botPrivateKey = `0x${"49".repeat(32)}` as Hex,
    bot = privateKeyToAccount(botPrivateKey);
  let s = sessionFixture(now, { sessionKey: bot.address }).record;
  s.state = "active";
  s.observation = sessionObservation(s, now);
  const manifest = {
    ...CHECKED_SMART_ACCOUNT_BINDING_MANIFESTS[0]!,
    id: b.manifestId,
    chainId: 1,
    revision: b.state.manifestRevision,
    entryPoint: {
      ...CHECKED_SMART_ACCOUNT_BINDING_MANIFESTS[0]!.safe7579,
      address: entryPoint,
      version: "0.7" as const,
    },
  };
  const otherManifest = { ...manifest, id: otherBinding.manifestId, chainId: 10 };
  const manifests = new Map([[manifest.id, manifest], [otherManifest.id, otherManifest]]);
  const preparedById = new Map<string, PreparedUserOperation>();
  let prepared: PreparedUserOperation | undefined,
    holdPreparation: Promise<void> | undefined;
  let operationResponseChange: Partial<PreparedUserOperation> = {};
  let rejectNextDiscovery = false,
    interruptNextBinding = false,
    interruptNextOperation = false,
    cancelNextApiApproval = false,
    invalidateCreationBroadcast = false,
    creationBroadcastError: Error | undefined,
    creationReceipt: { status: string; transactionHash: Hex; blockHash: Hex; blockNumber: string } | null = null;
  const creationHash = `0x${"52".repeat(32)}` as Hex;
  let bindingReview: { typedData: WalletTypedData; digest: Hex } | undefined;
  const requests: { path: string; body: string; grant: string | null; idempotencyKey: string | null }[] = [],
    signatures: Hex[] = [],
    errors: unknown[] = [];
  const transport: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname,
      headers = new Headers(init?.headers),
      bytes = new Uint8Array(init?.body as Uint8Array),
      body = new TextDecoder().decode(bytes);
    requests.push({ path, body, grant: headers.get(REST_AUTH_HEADERS.grant), idempotencyKey: headers.get("Idempotency-Key") });
    if (path === "/api/v1/capabilities") {
      if (rejectNextDiscovery) {
        rejectNextDiscovery = false;
        throw new Error("Network request interrupted");
      }
      return Response.json({
        smartAccounts: {
          deployments: [
            options.multichain ? { manifestId: otherManifest.id, chainId: 10, manifest: otherManifest } : { manifestId: "other-chain", chainId: 10 },
            { manifestId: b.manifestId, chainId: 1, manifest },
          ],
          requirements: [],
        },
        ...(sessionCapabilities ? { sessions: sessionCapabilities } : {}),
        userOperations: {
          preparation: true,
          relay: true,
          providers: [
            { chainId: 1, providerId: "synthetic", paymasterConfigured: true },
            ...(options.multichain ? [{ chainId: 10, providerId: "synthetic", paymasterConfigured: true }] : []),
          ],
        },
      });
    }
    const auth = readRequestClaims({
      method: String(init?.method),
      requestTarget: path,
      headers,
      contentType: headers.get("content-type") ?? "",
      body: bytes,
    });
    await verifyRequestSignature(
      "https://juicebox.center",
      auth.claims,
      auth.signature,
    );
    expect(auth.claims.accountId).toBe(a.id);
    if (path === "/api/v1/smart-accounts/creation-plans") {
      const request = JSON.parse(body);
      return Response.json({ creation: {
        ...prepareSafe7579Creation({ manifest: manifests.get(request.manifestId)!, ...request }),
        evidence: {}, deploymentConfirmed: false,
      } });
    }
    if (path === "/api/v1/smart-accounts/binding-challenges") {
      const request = JSON.parse(body);
      const selectedBinding = bindings.get(request.manifestId)!;
      const state = { ...selectedBinding.state, address: request.address };
      const typedData = {
        domain: {
          name: "Juicebox Center Smart Account", version: "1", chainId: state.chainId,
          verifyingContract: request.address,
          salt: keccak256(stringToHex("https://juicebox.center/")),
        },
        types: { BindSmartAccount: [
          { name: "accountId", type: "string" }, { name: "owner", type: "address" },
          { name: "stateHash", type: "bytes32" }, { name: "nonce", type: "bytes32" },
          { name: "expiresAt", type: "uint64" },
        ] },
        primaryType: "BindSmartAccount",
        message: { accountId: a.id, owner: ownerKey.address, stateHash: state.stateHash, nonce: request.nonce, expiresAt: request.expiresAt },
      } as const;
      bindingReview = { typedData, digest: hashTypedData(typedData) };
      return Response.json({ state, ...bindingReview });
    }
    if (path === "/api/v1/smart-accounts/bindings") {
      if (init?.method === "GET") return Response.json({ items: [...bindings.values()] });
      const request = JSON.parse(body);
      const selectedBinding = bindings.get(request.manifestId)!;
      const expectedTyped = { ...bindingReview!.typedData,
        domain: { ...bindingReview!.typedData.domain, chainId: selectedBinding.wallet.chainId, verifyingContract: request.address },
        message: { ...bindingReview!.typedData.message, nonce: request.nonce, expiresAt: request.expiresAt } };
      expect(request.stateHash).toBe(selectedBinding.state.stateHash);
      const signers = await Promise.all(Array.from({ length: selectedBinding.state.threshold }, (_, i) => recoverAddress({
        hash: hashTypedData(expectedTyped), signature: sliceHex(request.signature, i * 65, (i + 1) * 65),
      })));
      expect(signers.map((x) => x.toLowerCase()).sort()).toEqual(selectedBinding.state.owners.map((x) => x.toLowerCase()).sort());
      if (interruptNextBinding) {
        interruptNextBinding = false;
        throw new Error("Connection response interrupted");
      }
      selectedBinding.wallet.address = request.address; selectedBinding.state.address = request.address;
      return Response.json(selectedBinding);
    }
    if (path === `/api/v1/smart-accounts/bindings/${b.id}`)
      return Response.json(b);
    if (path === `/api/v1/smart-accounts/bindings/${b.id}/plans`)
      return Response.json(p);
    if (path === `/api/v1/smart-accounts/bindings/${otherBinding.id}`) return Response.json(otherBinding);
    if (path === `/api/v1/smart-accounts/bindings/${otherBinding.id}/plans`) return Response.json(otherPlan);
    if (path.endsWith("/quota"))
      return Response.json({ state: s.state, counters: [] });
    if (path.startsWith("/api/v1/smart-accounts/sessions/"))
      return Response.json(s);
    if (path === "/api/v1/user-operations") {
      const request = JSON.parse(body),
        p = plans.get(request.planId)!,
        r = record(p);
      r.id = p.id === "web-plan" ? "web-operation" : "web-operation-10";
      r.chainId = p.smartAccount!.chainId;
      r.operation.callData = encodeSafe7579Execution(
        p.draft.calls.map((c) => ({
          target: c.to,
          value: c.value,
          callData: c.data,
        })),
      );
      if (request.sessionId) {
        r.session = sessionBinding(s);
        r.operation.nonce = toHex(
          BigInt(s.compiled.smartSessions.address) << 96n,
        );
      }
      r.operationHash = getUserOperationHash(r.operation, entryPoint, r.chainId);
      const signing = request.sessionId
        ? legacySessionSigningPayload({
            operation: r.operation,
            chainId: r.chainId,
            entryPoint,
            smartSessions: s.compiled.smartSessions.address,
            permissionId: s.compiled.permissionId,
          })
        : safe7579OwnerSigningPayload({
            operation: r.operation,
            chainId: r.chainId,
            entryPoint,
            safe7579: manifest.safe7579.address,
            validAfter: String(Math.floor(r.createdAt / 1000)),
            validUntil: String(Math.floor(r.expiresAt / 1000)),
          });
      const {
        actor: _a,
        sender: _s,
        preparationKey: _k,
        inputHash: _h,
        ...wire
      } = r;
      prepared = { ...wire, signing };
      preparedById.set(prepared.id, prepared);
      if (holdPreparation) await holdPreparation;
      return Response.json(prepared);
    }
    if (path.endsWith("/submissions")) {
      const prepared = preparedById.get(path.split("/")[4]!)!;
      const signature = JSON.parse(body).signature as Hex;
      signatures.push(signature);
      if (prepared!.session)
        await verifyLegacySessionSignature({
          operation: { ...prepared!.operation, signature },
          chainId: prepared.chainId,
          entryPoint,
          smartSessions: s.compiled.smartSessions.address,
          permissionId: s.compiled.permissionId,
          sessionKey: bot.address,
        });
      else
        await verifySafe7579OwnerSignature({
          operation: { ...prepared!.operation, signature },
          chainId: prepared.chainId,
          entryPoint,
          safe7579: manifest.safe7579.address,
          validAfter: String(Math.floor(prepared!.createdAt / 1000)),
          validUntil: String(Math.floor(prepared!.expiresAt / 1000)),
          owners: b.state.owners,
          threshold: b.state.threshold,
        });
      if (interruptNextOperation) { interruptNextOperation = false; throw new Error("Submission response interrupted"); }
      return Response.json({ ...prepared, state: "pending", ...operationResponseChange });
    }
    if (path === "/api/v1/user-operations/web-operation")
      return Response.json({ ...preparedById.get("web-operation"), state: "confirmed", ...operationResponseChange });
    if (path === "/api/v1/user-operations/web-operation-10")
      return Response.json({ ...preparedById.get("web-operation-10"), state: "confirmed" });
    throw new Error(`Unexpected path ${path}`);
  };
  vi.stubGlobal("fetch", transport);
  const walletRequests: string[] = [], executionRequests: number[] = [],
    receiptLookups: unknown[] = [];
  let connected = true;
  const provider = {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      walletRequests.push(method);
      if (method === "eth_accounts") return [ownerKey.address];
      if (method === "eth_chainId") return "0x1";
      if (method === "eth_signTypedData_v4")
        return ownerKey.signTypedData(JSON.parse(String(params?.[1])));
      if (method === "eth_sendTransaction") {
        if (invalidateCreationBroadcast) { connected = false; ui.reset(); }
        if (creationBroadcastError) throw creationBroadcastError;
        return creationHash;
      }
      if (method === "eth_getTransactionReceipt") {
        receiptLookups.push(params?.[0]);
        return creationReceipt;
      }
      if (method === "eth_getBlockByNumber") return { hash: toHex(91n, { size: 32 }) };
      throw new Error(`Unexpected wallet request ${method}`);
    },
  };
  const connection = {
    provider,
    owner: ownerKey.address,
    chainId: 1,
    execution: async (chainId: number) => {
      executionRequests.push(chainId);
      return { request: async (input: { method: string; params?: unknown[] }) => {
        if (input.method === "eth_chainId") return toHex(chainId);
        if (input.method === "eth_signTypedData_v4")
          expect(JSON.parse(String(input.params?.[1])).domain.chainId).toBe(chainId);
        if (input.method === "eth_sendTransaction") expect((input.params?.[0] as { chainId: string }).chainId).toBe(toHex(chainId));
        return provider.request(input);
      } };
    },
    accountId: a.id,
    client: new SignedRestClient({
      audience: "https://juicebox.center",
      accountId: a.id,
      signer: { address: ownerKey.address, signTypedData: async (data) => {
        if (cancelNextApiApproval && data.primaryType === "CenterRequest" && data.message.requestTarget.endsWith("/submissions")) {
          cancelNextApiApproval = false; throw { code: 4001, message: "User rejected API approval" };
        }
        return data.primaryType === "CenterRequest" ? ownerKey.signTypedData(data) : ownerKey.signTypedData(data);
      } },
      fetch: transport,
    }),
  };
  let running: Promise<void> = Promise.resolve();
  const ui = installSmartWalletUI({
    audience: "https://juicebox.center",
    connection: () => connected ? connection : undefined,
    run: (action) => {
      running = action().catch((e) => {
        errors.push(e);
      });
      return running;
    },
    status: () => {},
  });
  const click = async (id: string) => {
    field(id).dispatchEvent(new Event("click"));
    await running;
  };
  const change = async (id: string) => {
    field(id).dispatchEvent(new Event("change"));
    await running;
  };
  await ui.accountReady(true);
  expect(field("smart-manifest").value).toBe(b.manifestId);
  expect(walletRequests).toEqual([]);
  if (options.loadBinding !== false) {
    field("smart-binding-id").value = b.id;
    await click("smart-bind-load");
  }
  if (options.loadBinding !== false && sessionCapabilities?.activationReady && sessionCapabilities.configuredChainIds.includes(1)) {
    field("session-id").value = s.id;
    await click("session-refresh");
  }
  expect(errors).toEqual([]);
  return {
    ui,
    field,
    click,
    change,
    errors,
    requests,
    signatures,
    walletRequests,
    receiptLookups,
    executionRequests,
    botPrivateKey,
    bot,
    nodes,
    browser,
    accountId: a.id,
    binding: b,
    otherBinding,
    coowner,
    bindingReview: () => bindingReview,
    interruptBinding: () => { interruptNextBinding = true; },
    interruptOperation: () => { interruptNextOperation = true; },
    changeOperationResponse: (changes: Partial<PreparedUserOperation>) => { operationResponseChange = changes; },
    cancelApiApproval: () => { cancelNextApiApproval = true; },
    interruptDiscovery: () => { rejectNextDiscovery = true; },
    interruptCreation: (knownHash = true, invalidate = false) => {
      invalidateCreationBroadcast = invalidate;
      creationBroadcastError = Object.assign(new Error("Creation broadcast response interrupted"),
        knownHash ? { transactionHash: creationHash, broadcastState: "unknown" } : {});
    },
    restore: async () => { connected = true; await ui.accountReady(true); },
    creationReceipt: (status: string | null) => { creationReceipt = status === null ? null : { status, transactionHash: creationHash, blockHash: toHex(91n, { size: 32 }), blockNumber: "0x1" }; },
    session: () => s,
    setSession: (next: typeof s) => {
      s = next;
    },
    hold: (promise: Promise<void>) => {
      holdPreparation = promise;
    },
    idle: () => running,
    setCapabilities: (next: typeof sessionCapabilities) => { sessionCapabilities = next; },
  };
}

it("keeps transaction setup optional, names networks, and only offers discovery retry after an error", async () => {
  const f = await harness({ loadBinding: false });
  expect(accountsPage()).not.toContain("Service settings");
  expect(accountsPage()).not.toContain('id="smart-capabilities"');
  expect(f.field("smart-setup").open).toBe(false);
  expect(f.field("smart-manifest").children.map((node) => node.textContent)).toEqual(["OP Mainnet", "Ethereum"]);
  expect(f.field("smart-switch").hidden).toBe(true);
  expect(f.field("smart-discover").hidden).toBe(true);
  f.field("smart-manifest").value = "other-chain";
  await f.change("smart-manifest");
  expect(f.field("smart-switch").hidden).toBe(true);
  f.interruptDiscovery();
  await f.ui.accountReady(true);
  expect(f.field("smart-discover").hidden).toBe(false);
  await f.click("smart-discover");
  expect(f.field("smart-discover").hidden).toBe(true);
  // A linked section opens from the page itself (test/rest-accounts-browser.test.ts), before this UI loads.
  expect(f.walletRequests).toEqual([]);
});

it("connects a reviewed single-owner wallet with one approval action", async () => {
  const f = await harness({ loadBinding: false });
  f.field("smart-address").value = f.binding.wallet.address;
  await f.click("smart-bind-prepare");
  expect(f.field("smart-binding-review").hidden).toBe(false);
  expect(f.field("smart-bind-submit").hidden).toBe(true);
  expect(f.field("operation-fields").disabled).toBe(true);
  expect(f.walletRequests).toEqual([]);
  await f.click("smart-bind-sign");
  expect(f.errors).toEqual([]);
  expect(f.field("operation-fields").disabled).toBe(false);
  expect(f.field("smart-bind-sign").disabled).toBe(true);
  expect(f.requests.filter((x) => x.path === "/api/v1/smart-accounts/bindings")).toHaveLength(1);
  expect(f.walletRequests.filter((x) => x === "eth_signTypedData_v4")).toHaveLength(1);
});

it("retries an interrupted wallet connection with the same reviewed approval and idempotency key", async () => {
  const f = await harness({ loadBinding: false });
  f.field("smart-address").value = f.binding.wallet.address;
  await f.click("smart-bind-prepare");
  f.interruptBinding();
  await f.click("smart-bind-sign");
  expect(f.errors).toHaveLength(1);
  expect(f.field("operation-fields").disabled).toBe(true);
  expect(f.field("smart-bind-sign").textContent).toBe("Retry wallet connection");
  await f.click("smart-bind-sign");
  expect(f.field("operation-fields").disabled).toBe(false);
  const attempts = f.requests.filter((x) => x.path === "/api/v1/smart-accounts/bindings");
  expect(attempts).toHaveLength(2);
  expect(attempts[0]!.idempotencyKey).toMatch(/^smart-/);
  expect(attempts[0]!.idempotencyKey).toBe(attempts[1]!.idempotencyKey);
  expect(attempts[0]!.body).toBe(attempts[1]!.body);
  expect(f.walletRequests.filter((x) => x === "eth_signTypedData_v4")).toHaveLength(1);
});

it("still requires every current multisig owner approval before connecting", async () => {
  const f = await harness({ loadBinding: false, multisig: true });
  f.field("smart-address").value = f.binding.wallet.address;
  await f.click("smart-bind-prepare");
  expect(f.field("smart-binding-multisig").hidden).toBe(false);
  expect(f.field("smart-bind-submit").hidden).toBe(false);
  await f.click("smart-bind-sign");
  expect(f.field("operation-fields").disabled).toBe(true);
  await f.click("smart-bind-submit");
  expect(f.errors).toHaveLength(1);
  expect(f.requests.filter((x) => x.path === "/api/v1/smart-accounts/bindings")).toHaveLength(0);
  f.field("smart-binding-signatures").value = JSON.stringify([
    await f.coowner.signTypedData(JSON.parse(JSON.stringify(f.bindingReview()!.typedData))),
  ]);
  await f.click("smart-bind-submit");
  expect(f.errors).toHaveLength(1);
  expect(f.field("operation-fields").disabled).toBe(false);
});

it("checks a successful creation receipt before preparing connection review and never signs it automatically", async () => {
  const f = await harness({ loadBinding: false });
  await f.click("smart-create-prepare");
  expect(f.errors).toEqual([]);
  expect(f.walletRequests).toEqual([]);
  await f.click("smart-create-send");
  await f.click("smart-create-status");
  expect(f.requests.some((x) => x.path.endsWith("/binding-challenges"))).toBe(false);
  f.creationReceipt("0x0");
  await f.click("smart-create-status");
  expect(f.errors).toHaveLength(1);
  expect(walletRecoveries(f.accountId)).toEqual([]);
  expect(f.requests.some((x) => x.path.endsWith("/binding-challenges"))).toBe(false);
  f.creationReceipt("0x1");
  await f.click("smart-create-status");
  expect(f.errors).toHaveLength(1);
  expect(f.field("smart-binding-review").hidden).toBe(false);
  expect(f.field("smart-bind-sign").disabled).toBe(false);
  expect(f.field("operation-fields").disabled).toBe(true);
  expect(f.walletRequests.filter((x) => x === "eth_sendTransaction")).toHaveLength(1);
  expect(f.walletRequests.filter((x) => x === "eth_signTypedData_v4")).toHaveLength(0);
  const creation = JSON.parse(f.field("smart-creation").textContent);
  const challenge = f.requests.find((x) => x.path.endsWith("/binding-challenges"));
  expect(JSON.parse(challenge!.body).address).toBe(creation.address);
});

it("recovers an uncertain creation broadcast by its known hash without sending or signing again", async () => {
  const f = await harness({ loadBinding: false });
  await f.click("smart-create-prepare");
  f.interruptCreation();
  await f.click("smart-create-send");
  expect(f.errors).toEqual([]);
  const pending = JSON.parse(f.field("smart-creation").textContent);
  expect(pending.state).toBe("submission-unknown");
  expect(pending.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
  expect(f.field("smart-create-send").disabled).toBe(true);
  expect(f.field("smart-create-status").hidden).toBe(false);
  expect(f.field("smart-create-status").disabled).toBe(false);
  await f.click("smart-create-status");
  expect(f.requests.some((request) => request.path.endsWith("/binding-challenges"))).toBe(false);
  f.creationReceipt("0x1");
  await f.click("smart-create-status");
  expect(f.errors).toEqual([]);
  expect(f.receiptLookups).toEqual([pending.transactionHash, pending.transactionHash]);
  expect(f.field("smart-binding-review").hidden).toBe(false);
  expect(f.field("smart-create-send").disabled).toBe(true);
  expect(f.field("operation-fields").disabled).toBe(true);
  expect(f.walletRequests.filter((method) => method === "eth_sendTransaction")).toHaveLength(1);
  expect(f.walletRequests.filter((method) => method === "eth_signTypedData_v4")).toHaveLength(0);
  expect(f.requests.filter((request) => request.path.endsWith("/creation-plans"))).toHaveLength(1);
  await f.click("smart-create-send");
  expect(f.errors).toHaveLength(1);
  expect(f.walletRequests.filter((method) => method === "eth_sendTransaction")).toHaveLength(1);
});

it("does not invent a recoverable creation when a wallet error has no broadcast hash", async () => {
  const f = await harness({ loadBinding: false });
  await f.click("smart-create-prepare");
  f.interruptCreation(false);
  await f.click("smart-create-send");
  expect(f.errors).toHaveLength(1);
  expect(f.field("smart-create-send").disabled).toBe(true);
  expect(f.field("smart-create-status").hidden).toBe(true);
  expect(JSON.parse(f.field("smart-creation").textContent).transactionHash).toBeUndefined();
});

it("creates the same reviewed wallet on two networks under one API identity and separately verifies each connection", async () => {
  const f = await harness({ multichain: true, loadBinding: false });
  for (const label of f.field("smart-networks").children) label.children[0]!.checked = true;
  await f.click("smart-create-prepare");
  expect(f.errors).toEqual([]);
  const reviews = JSON.parse(f.field("smart-creation").textContent);
  expect(reviews.map((item: { chainId: number }) => item.chainId)).toEqual([10, 1]);
  expect(new Set(reviews.map((item: { address: string }) => item.address)).size).toBe(1);
  expect(new Set(reviews.map((item: { saltNonce: string }) => item.saltNonce)).size).toBe(1);
  expect(f.walletRequests).toEqual([]);
  await f.click("smart-create-send");
  expect(f.walletRequests.filter((method) => method === "eth_sendTransaction")).toHaveLength(2);
  f.creationReceipt("0x1");
  await f.click("smart-create-status");
  expect(f.walletRequests.filter((method) => method === "eth_signTypedData_v4")).toHaveLength(0);
  await f.click("smart-bind-sign");
  expect(f.errors).toEqual([]);
  expect(JSON.parse(f.field("smart-creation").textContent).map((item: { state: string }) => item.state)).toEqual(["connected", "connected"]);
  expect(f.field("smart-wallet-list").children).toHaveLength(2);
  expect(f.executionRequests).toEqual([10, 1, 10, 1, 10, 1]);
  expect(f.walletRequests.filter((method) => method === "eth_signTypedData_v4")).toHaveLength(2);
});

it("queues exact operations from two networks and signs, submits and confirms each independently", async () => {
  const f = await harness({ multichain: true, sessions: null });
  await f.click("operation-plan"); await f.click("operation-prepare"); await f.click("operation-queue-add");
  f.field("smart-binding-id").value = f.otherBinding.id; await f.click("smart-bind-load");
  await f.click("operation-plan"); await f.click("operation-prepare"); await f.click("operation-queue-add");
  expect(f.field("operation-queue-review").children).toHaveLength(2);
  expect(f.requests.filter((request) => request.path.endsWith("/submissions"))).toHaveLength(0);
  await f.click("operation-queue-sign");
  expect(f.errors).toEqual([]);
  expect(f.executionRequests).toEqual([1, 10]);
  await f.click("operation-queue-submit");
  expect(f.errors).toEqual([]);
  expect(f.signatures).toHaveLength(2);
  expect(f.field("operation-queue-submit").disabled).toBe(true);
  expect(f.field("operation-queue-review").children.every((row) => row.children[0]!.textContent.includes("pending"))).toBe(true);
  await f.click("operation-queue-status");
  expect(f.errors).toEqual([]);
  expect(f.field("operation-queue-review").children.every((row) => row.children[0]!.textContent.includes("confirmed"))).toBe(true);
});

it("keeps a lost queue submission uncertain and never republishes it when continuing the other network", async () => {
  const f = await harness({ multichain: true, sessions: null });
  await f.click("operation-plan"); await f.click("operation-prepare"); await f.click("operation-queue-add");
  f.field("smart-binding-id").value = f.otherBinding.id; await f.click("smart-bind-load");
  await f.click("operation-plan"); await f.click("operation-prepare"); await f.click("operation-queue-add");
  await f.click("operation-queue-sign"); f.interruptOperation();
  await f.click("operation-queue-submit");
  expect(f.errors).toHaveLength(1);
  expect(f.signatures).toHaveLength(1);
  expect(f.field("operation-queue-review").children[0]!.children[0]!.textContent).toContain("unknown");
  await f.click("operation-queue-submit");
  expect(f.errors).toHaveLength(1);
  expect(f.signatures).toHaveLength(2);
  const attempts = f.requests.filter((request) => request.path.endsWith("/submissions"));
  expect(attempts.map((request) => request.path)).toEqual(["/api/v1/user-operations/web-operation/submissions", "/api/v1/user-operations/web-operation-10/submissions"]);
  await f.click("operation-queue-status");
  expect(f.errors).toHaveLength(1);
  expect(f.field("operation-queue-review").children.every((row) => row.children[0]!.textContent.includes("confirmed"))).toBe(true);
  expect(walletRecoveries(f.accountId)).toEqual([]);
});

it("retains the public creation hash when account authority is invalidated during broadcast", async () => {
  const f = await harness({ loadBinding: false });
  await f.click("smart-create-prepare");
  f.interruptCreation(true, true);
  await f.click("smart-create-send");
  expect(f.errors).toHaveLength(1);
  expect(walletRecoveries(f.accountId)).toMatchObject([{ kind: "creation", chainId: 1, transactionHash: `0x${"52".repeat(32)}` }]);
  expect(f.field("operation-fields").disabled).toBe(true);
  const sends = f.walletRequests.filter((method) => method === "eth_sendTransaction").length;
  await f.restore();
  expect(f.field("smart-recovery").hidden).toBe(false);
  expect(f.field("operation-fields").disabled).toBe(true);
  expect(f.walletRequests.filter((method) => method === "eth_sendTransaction")).toHaveLength(sends);
});

it("lets an explicitly canceled API approval retry the same queued operation without marking a broadcast", async () => {
  const f = await harness({ sessions: null });
  await f.click("operation-plan"); await f.click("operation-prepare"); await f.click("operation-queue-add");
  await f.click("operation-queue-sign"); f.cancelApiApproval();
  await f.click("operation-queue-submit");
  expect(f.errors).toHaveLength(1);
  expect(f.requests.filter((request) => request.path.endsWith("/submissions"))).toHaveLength(0);
  expect(walletRecoveries(f.accountId)).toEqual([]);
  expect(f.field("operation-queue-submit").disabled).toBe(false);
  await f.click("operation-queue-submit");
  expect(f.errors).toHaveLength(1);
  expect(f.signatures).toHaveLength(1);
  expect(f.walletRequests.filter((method) => method === "eth_signTypedData_v4")).toHaveLength(1);
});

it("restores only public pending operation references after reset and blocks a duplicate queued payment", async () => {
  const f = await harness({ sessions: null });
  await f.click("operation-plan"); await f.click("operation-prepare"); await f.click("operation-queue-add");
  await f.click("operation-queue-sign"); f.interruptOperation(); await f.click("operation-queue-submit");
  expect(walletRecoveries(f.accountId)).toMatchObject([{ kind: "user-operation", operationId: "web-operation" }]);
  f.ui.reset(); await f.restore();
  expect(f.field("smart-recovery").hidden).toBe(false);
  expect(f.field("operation-queue-review").hidden).toBe(true);
  expect(f.field("operation-fields").disabled).toBe(true);
  f.field("smart-binding-id").value = f.binding.id; await f.click("smart-bind-load");
  await f.click("operation-plan"); await f.click("operation-prepare"); await f.click("operation-queue-add");
  expect(f.errors).toHaveLength(2);
  expect(f.signatures).toHaveLength(1);
  expect(f.field("operation-queue-review").hidden).toBe(true);
});

it("drives owner plan, local SafeOp approval, submission and canonical status through the browser controller", async () => {
  const f = await harness({ sessions: { activationReady: false, configuredChainIds: [] } });
  expect(f.field("session-section").hidden).toBe(true);
  expect(f.field("session-nav").hidden).toBe(true);
  expect(f.field("session-fields").disabled).toBe(true);
  expect(f.field("operation-authority-label").hidden).toBe(true);
  expect(f.field("operation-authority").disabled).toBe(true);
  expect(f.field("operation-owner-signatures-label").hidden).toBe(true);
  expect(f.field("operation-fields").disabled).toBe(false);
  await f.click("operation-plan");
  await f.click("operation-prepare");
  await f.click("operation-sign");
  await f.click("operation-submit");
  expect(f.errors).toEqual([]);
  expect(f.signatures).toHaveLength(1);
  expect(f.field("operation-submit").disabled).toBe(true);
  expect(f.field("operation-result").textContent).toContain("pending");
  await f.click("operation-status");
  expect(f.field("operation-result").textContent).toContain("confirmed");
  expect(
    f.requests.filter((x) => x.path.endsWith("/submissions")),
  ).toHaveLength(1);
  expect(f.requests.some((x) => x.path.includes("/sessions/"))).toBe(false);
  expect(f.walletRequests.filter((method) => method === "eth_signTypedData_v4")).toHaveLength(1);
});

it.each([null, { activationReady: true, configuredChainIds: [10] }])(
  "does not offer delegated wallet authority without readiness on the connected chain: %j",
  async (sessions) => {
    const f = await harness({ sessions });
    expect(f.field("session-section").hidden).toBe(true);
    f.field("operation-authority").value = "session";
    await f.change("operation-authority");
    expect(f.field("operation-authority").value).toBe("owner");
    expect(f.field("session-key-fields").hidden).toBe(true);
    const before = f.requests.length;
    await f.click("session-prepare");
    expect(f.errors).toHaveLength(1);
    expect(f.requests).toHaveLength(before);
  },
);

it("clears delegated signatures when hosted activation is withdrawn", async () => {
  const f = await harness();
  f.field("operation-authority").value = "session";
  await f.change("operation-authority");
  f.field("session-key-file").files = [{
    size: 256,
    text: async () => JSON.stringify({
      format: "juicebox-center-bot-key-v1",
      botAddress: f.bot.address,
      privateKey: f.botPrivateKey,
    }),
  }];
  await f.change("session-key-file");
  await f.click("operation-plan");
  await f.click("operation-prepare");
  await f.click("operation-sign");
  expect(f.field("operation-submit").disabled).toBe(false);
  f.setCapabilities({ activationReady: false, configuredChainIds: [] });
  await f.click("smart-discover");
  expect(f.field("operation-submit").disabled).toBe(true);
  expect(f.field("operation-authority").value).toBe("owner");
  expect(f.field("operation-session-template").hidden).toBe(true);
  await f.click("operation-submit");
  expect(f.signatures).toHaveLength(0);
});

it.each(["legacy", "connection"])("keeps the imported %s key local, authenticates with its bot grant, and clears stale signatures when switching sessions", async (format) => {
  const f = await harness();
  f.field("operation-authority").value = "session";
  await f.change("operation-authority");
  f.field("session-key-file").files = [
    {
      size: 256,
      text: async () =>
        JSON.stringify(format === "legacy" ? {
          format: "juicebox-center-bot-key-v1",
          botAddress: f.bot.address,
          privateKey: f.botPrivateKey,
        } : connectionForBot("https://juicebox.center", {
          id: f.session().compiled.grantId, accountId: f.accountId, botAddress: f.bot.address,
          scopes: ["read", "plan", "relay"], label: "Browser fixture", createdAt: Math.floor(Date.now() / 1000),
          expiresAt: Math.floor(Date.now() / 1000) + 3600, revokedAt: null,
        }, f.botPrivateKey)),
    },
  ];
  await f.change("session-key-file");
  await f.click("operation-plan");
  await f.click("operation-prepare");
  await f.click("operation-sign");
  expect(f.errors).toEqual([]);
  expect(f.field("operation-submit").disabled).toBe(false);
  const operationRequest = f.requests.find(
    (x) => x.path === "/api/v1/user-operations",
  )!;
  expect(operationRequest.grant).toBe(f.session().compiled.grantId);
  expect(f.requests.map((x) => x.body).join("")).not.toContain(f.botPrivateKey);
  expect(
    [...f.nodes.values()].map((x) => x.textContent + x.value).join(""),
  ).not.toContain(f.botPrivateKey);
  const replacement = sessionFixture(Date.now(), {
    sessionKey: f.bot.address,
    generation: "2",
  }).record;
  replacement.state = "active";
  f.setSession(replacement);
  f.field("session-id").value = replacement.id;
  await f.click("session-refresh");
  expect(f.errors).toEqual([]);
  expect(f.field("operation-submit").disabled).toBe(true);
  await f.click("operation-submit");
  expect(f.signatures).toHaveLength(0);
});

it.each([
  { audience: "https://another.example" },
  { accountId: `eip155:10:${ownerKey.address.toLowerCase()}` },
  { grantId: "11111111-1111-4111-8111-111111111111" },
  { scopes: ["read", "plan"] },
  { expiresAt: 1 },
])("rejects a connection file that does not authorize this session: %j", async (changes) => {
  const f = await harness();
  f.field("operation-authority").value = "session";
  await f.change("operation-authority");
  f.field("session-key-file").files = [{ size: 512, text: async () => JSON.stringify({
    format: "juicebox-center-connection-v1", audience: "https://juicebox.center", accountId: f.accountId,
    grantId: f.session().compiled.grantId, botAddress: f.bot.address, privateKey: f.botPrivateKey,
    scopes: ["read", "plan", "relay"], expiresAt: Math.floor(Date.now() / 1000) + 3600, ...changes,
  }) }];
  const before = f.requests.length;
  await f.change("session-key-file");
  expect(f.errors).toHaveLength(1);
  await f.click("operation-plan");
  expect(f.requests).toHaveLength(before);
  expect(f.signatures).toEqual([]);
});

it.each(["submit", "status"])("retains the reviewed operation and recovery reference when %s returns a different operation", async (stage) => {
  const f = await harness({ sessions: null });
  await f.click("operation-plan"); await f.click("operation-prepare"); await f.click("operation-sign");
  if (stage === "submit") f.changeOperationResponse({ id: "unrelated-operation", state: "confirmed" });
  await f.click("operation-submit");
  if (stage === "status") {
    f.changeOperationResponse({ commitment: `0x${"ff".repeat(32)}`, state: "confirmed" });
    await f.click("operation-status");
  }
  expect(f.errors).toHaveLength(1);
  expect(walletRecoveries(f.accountId)).toMatchObject([{ operationId: "web-operation" }]);
  expect(f.field("operation-submit").disabled).toBe(true);
  f.changeOperationResponse({});
  await f.click("operation-status");
  expect(f.errors).toHaveLength(1);
  expect(walletRecoveries(f.accountId)).toEqual([]);
  expect(f.signatures).toHaveLength(1);
});

it("submits the session's real EIP191 USE signature and allows expired sessions to be explicitly retired", async () => {
  const f = await harness();
  f.field("operation-authority").value = "session";
  await f.change("operation-authority");
  f.field("session-key-file").files = [
    {
      size: 256,
      text: async () =>
        JSON.stringify({
          format: "juicebox-center-bot-key-v1",
          botAddress: f.bot.address,
          privateKey: f.botPrivateKey,
        }),
    },
  ];
  await f.change("session-key-file");
  await f.click("operation-plan");
  await f.click("operation-prepare");
  await f.click("operation-sign");
  await f.click("operation-submit");
  expect(f.errors).toEqual([]);
  expect(f.signatures).toHaveLength(1);
  expect(f.signatures[0]!.slice(0, 68)).toBe(
    `0x00${f.session().compiled.permissionId.slice(2)}`,
  );
  f.setSession({ ...f.session(), state: "expired" });
  await f.click("session-refresh");
  expect(f.field("session-revoke").disabled).toBe(false);
  expect(f.field("operation-submit").disabled).toBe(true);
});

it("discards a prepared operation if authority changes while its request is pending", async () => {
  const f = await harness();
  await f.click("operation-plan");
  let release!: () => void;
  f.hold(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  f.field("operation-prepare").dispatchEvent(new Event("click"));
  // Wait for the signed preparation to reach the controlled HTTP boundary.
  for (
    let i = 0;
    i < 50 && !f.requests.some((x) => x.path === "/api/v1/user-operations");
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 1));
  expect(f.requests.some((x) => x.path === "/api/v1/user-operations")).toBe(
    true,
  );
  f.field("operation-authority").value = "session";
  f.field("operation-authority").dispatchEvent(new Event("change"));
  release();
  await f.idle();
  expect(f.errors).toHaveLength(1);
  expect(f.field("operation-sign").disabled).toBe(true);
  expect(f.signatures).toHaveLength(0);
});
