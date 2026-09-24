import { getAddress, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum, arbitrumSepolia, base, baseSepolia, mainnet, optimism, optimismSepolia, sepolia } from "viem/chains";
import {
  RestClientError,
  SignedRestClient,
  SmartAccountClient,
  assertReviewedOperation,
  assertWalletIdentity,
  clientAudience,
  newRequestNonce,
  ownerOperationSignature,
  ownerOperationSigning,
  packOwnerSignatures,
  parseConnection,
  readPublicRestJson,
  sessionActionPlanInput,
  signSessionUserOperation,
  signWalletTypedData,
  smartBindingDocument,
  smartRequestKey,
  verifyWalletCreation,
  type BindingChallenge,
  type BindingRequest,
  type PreparedUserOperation,
  type SmartAccountCapabilities,
  type WalletCreationPreparation,
  type WalletCreationRequest,
  type WalletProvider,
  type WalletTypedData,
  type SmartWalletPlan,
} from "../client/index.js";
import type {
  SessionPolicyInput,
  SmartAccountBinding,
  SmartAccountManifest,
} from "../smartAccounts/types.js";
import type { StoredSession } from "../sessions/types.js";
import { assertSameOperation, installOperationQueue } from "./operationQueue.js";
import { recordWalletRecovery, removeWalletRecovery, renderWalletRecovery, walletRecoveries, type WalletRecoveryRecord } from "./walletRecovery.js";

export interface SmartWalletConnection {
  provider: WalletProvider;
  owner: Address;
  chainId: number;
  accountId: string;
  client: SignedRestClient;
  execution?(chainId: number): Promise<WalletProvider>;
}
interface BindingReview {
  request: BindingRequest;
  result: BindingChallenge;
  document: WalletTypedData;
  signatures: Hex[];
  submissionKey: string;
}
interface CreationReview {
  attemptId: string;
  request: WalletCreationRequest;
  result: WalletCreationPreparation;
  manifest: SmartAccountManifest;
  transactionHash?: Hex;
  state: "reviewed" | "submission-unknown" | "pending" | "reverted" | "ready-to-connect" | "connected";
  bindingReview?: BindingReview;
  binding?: SmartAccountBinding;
}
type CreationReceipt = { status?: string; transactionHash?: string; blockHash?: string; blockNumber?: string };
interface HostCapabilities {
  smartAccounts: SmartAccountCapabilities;
  sessions?: { activationReady?: boolean; configuredChainIds?: number[] };
  userOperations?: {
    preparation?: boolean;
    relay?: boolean;
    providers?: {
      chainId: number;
      providerId: string;
      paymasterConfigured: boolean;
    }[];
    activationRequirements?: string[];
  };
}
const element = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const field = (id: string) =>
  element<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(id);
const button = (id: string) => element<HTMLButtonElement>(id);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const supportedNetworks = [mainnet, optimism, base, arbitrum, sepolia, optimismSepolia, baseSepolia, arbitrumSepolia];
const networkName = (chainId: number) => supportedNetworks.find((entry) => entry.id === chainId)?.name ?? `Network ${chainId}`;
function fail(message: string): never {
  throw new RestClientError("SMART_WALLET_REVIEW_REQUIRED", message);
}
const json = (id: string) => {
  const raw = field(id).value;
  if (raw.length > 65_536) fail("The review document is too large.");
  try {
    return JSON.parse(raw);
  } catch {
    return fail("Enter a valid JSON document.");
  }
};
const show = (id: string, value: unknown) => {
  const node = element(id);
  node.textContent = JSON.stringify(
    value,
    (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );
  node.hidden = false;
};
function address(id: string): Address {
  try {
    return getAddress(field(id).value.trim());
  } catch {
    return fail("Enter a complete Ethereum address.");
  }
}
function decimal(id: string): string {
  const value = field(id).value.trim();
  if (!/^(0|[1-9][0-9]{0,77})$/.test(value))
    fail("Use whole decimal integers in raw token units or wei.");
  return value;
}
function signatureList(id: string): Hex[] {
  if (!field(id).value.trim()) return [];
  const list: unknown = json(id);
  if (
    !Array.isArray(list) ||
    list.length > 16 ||
    list.some((s) => typeof s !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(s))
  )
    fail("Enter a JSON array of 65-byte owner signatures.");
  return list as Hex[];
}

/** Keys live only in this closure. Every request facade accepts public fields and signatures. */
export function installSmartWalletUI(options: {
  audience: string;
  connection(): SmartWalletConnection | undefined;
  run(operation: () => Promise<void>): Promise<void>;
  status(message: string, error?: boolean): void;
}) {
  let epoch = 0,
    host: HostCapabilities | undefined,
    binding: SmartAccountBinding | undefined;
  let creations: CreationReview[] = [];
  let challenge: BindingReview | undefined;
  let networkChoices: HTMLInputElement[] = [];
  const savedBindings = new Map<string, Pick<SmartAccountBinding, "id" | "wallet" | "manifestId">>();
  let session: StoredSession | undefined,
    plan: SmartWalletPlan | undefined,
    operation: PreparedUserOperation | undefined;
  let operationClient: SmartAccountClient | undefined,
    operationSignatures: Hex[] = [],
    sessionSignature: Hex | undefined,
    submissionKey: string | undefined;
  let key: ReturnType<typeof privateKeyToAccount> | undefined;
  let queue: ReturnType<typeof installOperationQueue> | undefined;
  function connection() {
    return (
      options.connection() ?? fail("Sign in first.")
    );
  }
  function ownerClient() {
    return new SmartAccountClient(connection().client);
  }
  function creationReference(c: SmartWalletConnection, item: CreationReview): WalletRecoveryRecord {
    return { accountId: c.accountId, chainId: item.result.chainId, walletAddress: item.result.address,
      kind: "creation", attemptId: item.attemptId, ...(item.transactionHash ? { transactionHash: item.transactionHash } : {}) };
  }
  async function canonicalFailedCreation(provider: WalletProvider, receipt: CreationReceipt) {
    if (receipt.status !== "0x0" || !receipt.blockHash || !/^0x[0-9a-fA-F]{64}$/.test(receipt.blockHash) ||
      !receipt.blockNumber || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(receipt.blockNumber)) return false;
    const block = await provider.request({ method: "eth_getBlockByNumber", params: [receipt.blockNumber, false] }) as { hash?: string } | null;
    return !!block?.hash && same(block.hash, receipt.blockHash);
  }
  function refreshRecovery() {
    const c = options.connection();
    if (!c) { element("smart-recovery").hidden = true; return; }
    renderWalletRecovery(c.accountId, { isCurrent: () => options.connection() === c,
      onCheck: (record) => options.run(async () => {
        const { check } = checkpoint();
        if (record.kind === "user-operation") {
          if (!record.operationId) fail("Keep this reference and inspect the wallet activity before trying again.");
          const result = await ownerClient().userOperation(record.operationId!); check();
          if (result.id !== record.operationId || result.chainId !== record.chainId || !same(result.operation.sender, record.walletAddress))
            fail("The recovered operation differs from its saved wallet and network.");
          if (["confirmed", "reverted"].includes(result.state)) removeWalletRecovery(c.accountId, record.attemptId);
          options.status(`Saved transaction on ${networkName(record.chainId)}: ${result.state}. No transaction was submitted by this check.`);
          return;
        }
        if (record.transactionHash) {
          const provider = await executionProvider(c, record.chainId); check();
          const receipt = await provider.request({ method: "eth_getTransactionReceipt", params: [record.transactionHash] }) as CreationReceipt | null;
          check();
          if (!receipt) { options.status("Wallet creation remains unconfirmed. Keep its reference and check again later."); return; }
          if (!receipt.transactionHash || !same(receipt.transactionHash, record.transactionHash))
            fail("This creation has no successful matching receipt. Inspect the saved transaction before starting another.");
          if (await canonicalFailedCreation(provider, receipt)) {
            check(); removeWalletRecovery(c.accountId, record.attemptId);
            options.status("The saved creation transaction reverted. Its result is checked; you can review a new setup."); return;
          }
          if (receipt.status !== "0x1") fail("The saved creation result is not canonically resolved. Keep the reference and check again.");
        }
        const d = host?.smartAccounts.deployments.find((item) => item.chainId === record.chainId && item.manifest);
        if (!d) fail("This network has no configured wallet inspection.");
        const reviewed = await requestBindingReview(d!.manifestId, record.walletAddress); check();
        challenge = reviewed; field("smart-manifest").value = reviewed.request.manifestId;
        field("smart-address").value = reviewed.request.address; renderBindingReview();
        options.status("The saved wallet is deployed and its current ownership is verified. Review and approve its connection to continue.");
      }) });
  }
  async function executionProvider(c: SmartWalletConnection, chainId: number) {
    const provider = c.execution ? await c.execution(chainId) : c.provider;
    await assertWalletIdentity(provider, c.owner, chainId, () => options.connection() === c);
    return provider;
  }
  function selectedChainId() {
    return binding?.wallet.chainId ?? host?.smartAccounts.deployments.find(
      (entry) => entry.manifestId === field("smart-manifest").value,
    )?.chainId;
  }
  function checkpoint() {
    const c = connection(),
      generation = epoch;
    return {
      c,
      check() {
        if (options.connection() !== c || epoch !== generation)
          fail("The wallet connection changed. Review again.");
      },
    };
  }
  function deployment() {
    const d = host?.smartAccounts.deployments.find(
      (x) => x.manifestId === field("smart-manifest").value,
    );
    if (!d) return fail("Select a hosted reviewed deployment.");
    return d;
  }
  function manifest() {
    return (
      deployment().manifest ??
      fail(
        "This host must publish its reviewed deployment pins before wallet signing is available.",
      )
    );
  }
  function bound() {
    if (
      !binding ||
      binding.ownerAccountId !== connection().accountId
    )
      fail("Load or bind a smart wallet on the connected chain.");
    return binding;
  }
  function requireSession() {
    if (!sessionsAvailable())
      return fail(
        "Bot wallet permissions are unavailable on this chain. Use fresh owner approval.",
      );
    if (!session || session.compiled.bindingId !== bound().id)
      return fail("Prepare or load a session for this wallet first.");
    return session;
  }
  function executionClient() {
    if (field("operation-authority").value === "owner") return ownerClient();
    const s = requireSession();
    if (
      !key ||
      !same(key.address, s.compiled.sessionKey) ||
      s.state !== "active"
    )
      fail("Load the exact local bot key for an active session.");
    return new SmartAccountClient(
      new SignedRestClient({
        audience: options.audience,
        accountId: connection().accountId,
        signer: key!,
        grantId: s.compiled.grantId,
      }),
    );
  }
  function clearOperation() {
    operation = undefined;
    operationClient = undefined;
    operationSignatures = [];
    sessionSignature = undefined;
    submissionKey = undefined;
    for (const id of ["operation-sign", "operation-submit", "operation-status"])
      button(id).disabled = true;
    field("operation-owner-signatures").value = "";
    element("operation-review").hidden = true;
    element("operation-result").textContent = "";
    queue?.refresh();
  }
  function setPlan(next: SmartWalletPlan) {
    clearOperation();
    plan = next;
    show("operation-plan-review", next);
    field("operation-steps").value = next.draft.calls
      .map((_c, i) => i)
      .join(",");
    button("operation-prepare").disabled = !executionAvailable();
  }
  function executionAvailable() {
    const provider = host?.userOperations?.providers?.find(
      (entry) => entry.chainId === selectedChainId(),
    );
    return (
      host?.userOperations?.preparation === true &&
      provider !== undefined &&
      (field("operation-authority").value !== "session" ||
        (sessionsAvailable() && provider.paymasterConfigured))
    );
  }
  function sessionsAvailable() {
    const chainId = selectedChainId();
    return (
      host?.sessions?.activationReady === true &&
      chainId !== undefined &&
      Array.isArray(host.sessions.configuredChainIds) &&
      host.sessions.configuredChainIds.includes(chainId)
    );
  }
  function refreshReadiness() {
    const available = sessionsAvailable();
    if (!available) {
      key = undefined;
      element("session-key-status").textContent = "No local key loaded.";
    }
    if (!available && field("operation-authority").value !== "owner") {
      epoch++;
      field("operation-authority").value = "owner";
      plan = undefined;
      clearOperation();
      element("operation-plan-review").hidden = true;
      button("operation-prepare").disabled = true;
    }
    element("session-section").hidden = !available;
    element("session-nav").hidden = !available;
    element<HTMLFieldSetElement>("session-fields").disabled =
      !available || !binding;
    element("operation-authority-label").hidden = !available;
    field("operation-authority").disabled = !available;
    element("operation-session-template").hidden = !available || !session;
    element("session-key-fields").hidden =
      !available || field("operation-authority").value !== "session";
    element("operation-owner-signatures-label").hidden =
      !binding ||
      binding.state.threshold <= 1 ||
      field("operation-authority").value === "session";
    if (!host) return;
    button("smart-switch").hidden = true;
    const sponsored = host.userOperations?.providers?.some(
      (entry) => entry.chainId === selectedChainId() && entry.paymasterConfigured,
    );
    element("smart-readiness").textContent = executionAvailable()
      ? `You can send transactions on this network after reviewing and approving each one.${sponsored ? " Sponsored network fees are available, subject to the checks and limits shown when you prepare a transaction." : ""}`
      : "Transactions are unavailable on your current network. Choose a supported network to continue.";
  }
  function setBinding(next: SmartAccountBinding) {
    if (
      next.ownerAccountId !== connection().accountId
    )
      fail("The returned binding belongs to another account or chain.");
    epoch++;
    binding = next;
    savedBindings.set(next.id, next);
    renderSavedWallets();
    session = undefined;
    plan = undefined;
    key = undefined;
    clearOperation();
    field("smart-binding-id").value = next.id;
    field("smart-address").value = next.wallet.address;
    show("smart-bindings", next);
    field("smart-manifest").value = next.manifestId;
    field("operation-authority").value = "owner";
    refreshReadiness();
    element<HTMLFieldSetElement>("operation-fields").disabled = false;
    button("session-activate").disabled = true;
    button("session-revoke").disabled = true;
    button("operation-prepare").disabled = true;
    field("session-id").value = "";
    element("session-review").hidden = true;
    element("session-quota").hidden = true;
    element("session-key-status").textContent = "No local key loaded.";
  }
  function setSession(next: StoredSession) {
    if (
      next.compiled.bindingId !== bound().id ||
      next.compiled.ownerAccountId !== connection().accountId
    )
      fail("The returned session belongs to another account or wallet.");
    if (
      session &&
      (session.id !== next.id ||
        session.compiled.compiledHash !== next.compiled.compiledHash ||
        (session.state === "active" && next.state !== "active"))
    ) {
      epoch++;
      plan = undefined;
      clearOperation();
      button("operation-prepare").disabled = true;
      element("operation-plan-review").hidden = true;
    }
    session = next;
    refreshReadiness();
    field("session-id").value = next.id;
    field("session-grant").value = next.compiled.grantId;
    show("session-review", next);
    button("session-activate").disabled = !["prepared", "installing"].includes(
      next.state,
    );
    button("session-revoke").disabled = next.state === "revoked";
    if (key && !same(key.address, next.compiled.sessionKey)) {
      key = undefined;
      element("session-key-status").textContent =
        "Local key cleared because this session uses a different key.";
    }
  }
  function event(id: string, action: () => Promise<void>) {
    button(id).addEventListener("click", () => void options.run(action));
  }
  async function discoverHosted() {
    const generation = epoch;
    button("smart-discover").hidden = true;
    let result: HostCapabilities;
    try {
      result = await readPublicRestJson<HostCapabilities>(
        options.audience,
        "/api/v1/capabilities",
      );
    } catch (error) {
      if (generation === epoch) {
        button("smart-discover").hidden = false;
        element("smart-readiness").textContent = "Could not load supported networks. Try again.";
      }
      throw error;
    }
    if (generation !== epoch) return;
    if (!Array.isArray(result.smartAccounts?.deployments)) {
      button("smart-discover").hidden = false;
      fail("This host has not configured smart wallets.");
    }
    host = result;
    const checked = new Set(networkChoices.filter((choice) => choice.checked).map((choice) => choice.value));
    const choices = element("smart-networks"); choices.replaceChildren(); networkChoices = [];
    const offeredChains = new Set<number>();
    for (const d of result.smartAccounts.deployments) {
      if (!d.manifest || offeredChains.has(d.chainId)) continue;
      offeredChains.add(d.chainId);
      const label = document.createElement("label"), input = document.createElement("input"), name = document.createElement("span");
      label.className = "network-choice"; input.type = "checkbox"; input.value = d.manifestId;
      input.checked = checked.size ? checked.has(d.manifestId) : d.chainId === options.connection()?.chainId;
      name.textContent = networkName(d.chainId); label.append(input, name); choices.append(label); networkChoices.push(input);
    }
    const select = element<HTMLSelectElement>("smart-manifest");
    const previous = select.value;
    select.replaceChildren();
    for (const d of result.smartAccounts.deployments) {
      const option = document.createElement("option");
      option.value = d.manifestId;
      const network = supportedNetworks.find((entry) => entry.id === d.chainId);
      const variants = result.smartAccounts.deployments.filter((entry) => entry.chainId === d.chainId);
      option.textContent = `${network?.name ?? `Network ${d.chainId}`}${variants.length > 1 ? ` / setup ${variants.indexOf(d) + 1}` : ""}`;
      select.append(option);
    }
    select.value = binding?.manifestId ??
      result.smartAccounts.deployments.find(
        (d) => d.chainId === options.connection()?.chainId && d.manifestId === previous,
      )?.manifestId ??
      result.smartAccounts.deployments.find(
        (d) => d.chainId === options.connection()?.chainId,
      )?.manifestId ?? select.value;
    refreshReadiness();
    if (plan && !operation)
      button("operation-prepare").disabled = !executionAvailable();
  }
  event("smart-discover", discoverHosted);
  field("smart-manifest").addEventListener("change", () => {
    if (binding && binding.manifestId !== field("smart-manifest").value) {
      epoch++; binding = undefined; session = undefined; key = undefined; plan = undefined; clearOperation();
      element<HTMLFieldSetElement>("operation-fields").disabled = true;
    }
    refreshReadiness();
  });
  function revealLinkedSetup() {
    if (["#smart-heading", "#operation-heading", "#session-heading"].includes(window.location.hash))
      element<HTMLDetailsElement>("smart-setup").open = true;
  }
  window.addEventListener("hashchange", revealLinkedSetup);
  revealLinkedSetup();
  event("smart-switch", async () => {
    const c = connection(),
      d = host?.smartAccounts.deployments.find(
        (x) => x.manifestId === field("smart-manifest").value,
      );
    if (!d) fail("Select a hosted chain first.");
    await executionProvider(c, d!.chainId);
    options.status(
      "Execution network selected. Your API account stays signed in.",
    );
  });
  function renderCreations() {
    const progress = element("smart-creation-progress");
    progress.replaceChildren(); progress.hidden = creations.length === 0;
    for (const item of creations) {
      const row = document.createElement("p"); row.className = "network-progress-item";
      row.textContent = `${networkName(item.result.chainId)} / ${item.result.address} / ${item.state}${item.transactionHash ? ` / transaction ${item.transactionHash}` : ""}`;
      progress.append(row);
    }
    const summary = element("smart-create-review");
    summary.hidden = creations.length === 0;
    summary.textContent = creations.length ? `${creations.length} network${creations.length === 1 ? "" : "s"}. ${new Set(creations.map((item) => item.result.address.toLowerCase())).size === 1 ? `Same wallet address: ${creations[0]!.result.address}.` : "Review the distinct wallet addresses below."} Owners: ${creations[0]!.request.owners.join(", ")}. ${creations[0]!.request.threshold} owner approval(s) required. Each network keeps its own balance, deployment fee and transaction status.` : "";
    if (creations.length) {
      const reviews = creations.map((item) => ({ ...item.result, state: item.state, ...(item.transactionHash ? { transactionHash: item.transactionHash } : {}) }));
      show("smart-creation", reviews.length === 1 ? reviews[0] : reviews);
    }
    button("smart-create-send").hidden = !creations.length;
    button("smart-create-send").disabled = !creations.some((item) => !item.transactionHash && item.state === "reviewed");
    button("smart-create-status").hidden = !creations.some((item) => !!item.transactionHash);
    button("smart-create-status").disabled = !creations.some((item) => !!item.transactionHash && item.state !== "connected");
  }
  event("smart-create-prepare", async () => {
    const { c, check } = checkpoint();
    if (creations.some((item) => item.transactionHash && !["connected", "reverted"].includes(item.state)))
      fail("Finish checking and connecting the wallets already submitted before preparing another setup.");
    const selected = networkChoices.filter((input) => input.checked).map((input) =>
      host?.smartAccounts.deployments.find((item) => item.manifestId === input.value));
    if (!selected.length || selected.some((item) => !item?.manifest)) fail("Choose at least one supported network.");
    const owners = field("smart-owners").value.split(/[\s,]+/).filter(Boolean).map((value) => getAddress(value));
    const threshold = Number(field("smart-threshold").value), saltNonce = BigInt(newRequestNonce()).toString();
    const reviewed: CreationReview[] = [];
    for (const selectedManifest of selected) {
      const m = selectedManifest!.manifest!;
      const request = { manifestId: m.id, owners, threshold, saltNonce };
      const result = (await new SmartAccountClient(c.client).prepareCreation(request)).creation;
      check(); verifyWalletCreation({ manifest: m, request, creation: result });
      reviewed.push({ attemptId: smartRequestKey(), request, result, manifest: m, state: "reviewed" });
    }
    creations = reviewed; challenge = undefined; renderCreations();
    options.status("Review every selected network, wallet address and owner. Creation requires a separate transaction and network fee on each network.");
  });
  event("smart-create-send", async () => {
    const { c, check } = checkpoint();
    const pending = creations.filter((item) => !item.transactionHash && item.state === "reviewed");
    if (!pending.length) fail("Check the existing creation receipts before preparing another wallet.");
    for (const reviewed of pending) {
      verifyWalletCreation({ manifest: reviewed.manifest, request: reviewed.request, creation: reviewed.result });
      const provider = await executionProvider(c, reviewed.result.chainId); check();
      recordWalletRecovery(creationReference(c, reviewed)); refreshRecovery();
      button("smart-create-send").disabled = true;
      let hash: unknown, submissionUnknown = false;
      try {
        hash = await provider.request({ method: "eth_sendTransaction", params: [{ from: c.owner, chainId: toHex(reviewed.result.chainId),
          to: reviewed.result.transaction.to, value: "0x0", data: reviewed.result.transaction.data }] });
      } catch (error) {
        if (!error || typeof error !== "object" || !("broadcastState" in error) || error.broadcastState !== "unknown" ||
          !("transactionHash" in error) || typeof error.transactionHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(error.transactionHash)) {
          if (error && typeof error === "object" && "code" in error && error.code === 4001 && !("broadcastState" in error))
            removeWalletRecovery(c.accountId, reviewed.attemptId);
          check(); throw error;
        }
        hash = error.transactionHash; submissionUnknown = true;
      }
      if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash))
        fail("The wallet did not return a transaction hash. Check its activity before preparing another creation.");
      reviewed.transactionHash = hash as Hex;
      recordWalletRecovery(creationReference(c, reviewed), { requireDurable: false });
      check(); refreshRecovery();
      reviewed.state = submissionUnknown ? "submission-unknown" : "pending"; renderCreations();
      if (submissionUnknown) {
        options.status("A creation submission is uncertain. Its hash is saved below. Check the receipt before continuing with the remaining networks.", true);
        return;
      }
    }
    options.status("Wallet creations submitted. Check each network's receipt before connecting its wallet.");
  });
  event("smart-create-status", async () => {
    const { c, check } = checkpoint();
    if (!creations.some((item) => item.transactionHash)) fail("Submit wallet creation first.");
    for (const reviewed of creations.filter((item) => item.transactionHash && item.state !== "connected")) {
      const provider = await executionProvider(c, reviewed.result.chainId); check();
      const receipt = await provider.request({ method: "eth_getTransactionReceipt", params: [reviewed.transactionHash] }) as CreationReceipt | null;
      check();
      if (!receipt) continue;
      if (!receipt.transactionHash || !same(receipt.transactionHash, reviewed.transactionHash!))
        fail("Creation did not return a matching receipt. Inspect the wallet transaction.");
      if (receipt.status !== "0x1") {
        const reverted = await canonicalFailedCreation(provider, receipt); check();
        if (reverted) { removeWalletRecovery(c.accountId, reviewed.attemptId); refreshRecovery(); }
        reviewed.state = reverted ? "reverted" : "submission-unknown"; renderCreations();
        fail("Creation did not return a successful matching receipt. Inspect the wallet transaction.");
      }
      if (!reviewed.bindingReview || reviewed.bindingReview.request.expiresAt <= Math.floor(Date.now() / 1000))
        reviewed.bindingReview = await requestBindingReview(reviewed.manifest.id, reviewed.result.address);
      check(); reviewed.state = "ready-to-connect"; renderCreations();
    }
    const ready = creations.filter((item) => item.state === "ready-to-connect" && item.bindingReview);
    if (!ready.length) { options.status("Wallet creation is still pending on the displayed networks. Check again later."); return; }
    // The ordinary approval button connects single-owner networks together. Multisigs retain separate signature documents.
    challenge = ready[0]!.bindingReview;
    field("smart-address").value = challenge!.request.address;
    field("smart-manifest").value = challenge!.request.manifestId;
    renderBindingReview();
    options.status("Creation receipts found and wallet setups checked. Review each connection before approving it; no transaction approval is included.");
  });
  async function requestBindingReview(manifestId: string, wallet: Address): Promise<BindingReview> {
    const { c, check } = checkpoint();
    const request = { manifestId, address: wallet, nonce: newRequestNonce(), expiresAt: Math.floor(Date.now() / 1000) + 600 };
    const result = await ownerClient().challenge(request); check();
    const document = smartBindingDocument({ audience: options.audience, accountId: c.accountId, owner: c.owner, request, challenge: result });
    return { request, result, document, signatures: [], submissionKey: smartRequestKey() };
  }
  function pendingConnections() {
    return creations.some((item) => item.bindingReview === challenge)
      ? creations.filter((item) => item.state === "ready-to-connect" && item.bindingReview).map((item) => item.bindingReview!)
      : challenge ? [challenge] : [];
  }
  function renderBindingReview() {
    if (!challenge) return;
    const reviews = pendingConnections();
    element("smart-binding-multisig").hidden = challenge.result.state.threshold <= 1;
    field("smart-binding-signatures").value = "";
    const raw = reviews.map((review) => ({ state: review.result.state, digest: review.result.digest, typedData: review.document }));
    show("smart-binding-review", raw.length === 1 ? raw[0] : raw);
    const summary = element("smart-binding-summary");
    summary.textContent = reviews.map((review) => `${networkName(review.result.state.chainId)} wallet: ${review.result.state.address}. Owners: ${review.result.state.owners.join(", ")}. ${review.result.state.threshold} of ${review.result.state.owners.length} owner approvals required.`).join(" ") + " Connecting wallets approves no transactions.";
    summary.hidden = false; element("smart-binding-document").hidden = false;
    button("smart-bind-sign").disabled = false; button("smart-bind-sign").hidden = false;
    button("smart-bind-sign").textContent = challenge.result.state.threshold > 1 ? `Approve as one owner on ${networkName(challenge.result.state.chainId)}` : reviews.length > 1 ? "Approve and connect wallets" : "Approve and connect wallet";
    button("smart-bind-submit").hidden = challenge.result.state.threshold <= 1;
    button("smart-bind-submit").disabled = challenge.result.state.threshold <= 1;
  }
  async function prepareBinding() {
    challenge = await requestBindingReview(deployment().manifestId, address("smart-address"));
    renderBindingReview();
    options.status("Review this wallet's owners and permissions, then approve its connection. This does not approve any transactions.");
  }
  event("smart-bind-prepare", prepareBinding);
  async function connectReviewedWallet(reviewed: BindingReview, additional: Hex[] = []) {
    const { c, check } = checkpoint();
    const signature = await packOwnerSignatures({ digest: reviewed.result.digest, owners: reviewed.result.state.owners,
      threshold: reviewed.result.state.threshold, signatures: [...reviewed.signatures, ...additional] }); check();
    const result = await ownerClient().bind({ ...reviewed.request, stateHash: reviewed.result.state.stateHash, signature }, reviewed.submissionKey); check();
    if (result.ownerAccountId !== c.accountId || result.wallet.chainId !== reviewed.result.state.chainId ||
      !same(result.wallet.address, reviewed.request.address) || result.manifestId !== reviewed.request.manifestId)
      fail("The returned wallet connection differs from the reviewed wallet and network.");
    savedBindings.set(result.id, result); renderSavedWallets();
    const created = creations.find((item) => item.bindingReview === reviewed);
    if (created) { created.binding = result; created.state = "connected"; renderCreations(); }
    for (const record of walletRecoveries(c.accountId))
      if (record.kind === "creation" && record.chainId === result.wallet.chainId && same(record.walletAddress, result.wallet.address))
        removeWalletRecovery(c.accountId, record.attemptId);
    refreshRecovery();
    return result;
  }
  event("smart-bind-sign", async () => {
    const { c, check } = checkpoint();
    const reviews = pendingConnections();
    if (!reviews.length) fail("Review the wallet connection first.");
    let connected: SmartAccountBinding | undefined;
    for (const reviewed of reviews) {
      challenge = reviewed;
      if (!reviewed.signatures.length) {
        const provider = await executionProvider(c, reviewed.result.state.chainId); check();
        const signature = await signWalletTypedData({ provider, address: c.owner, chainId: reviewed.result.state.chainId,
          document: reviewed.document, stillCurrent: () => options.connection() === c }); check();
        reviewed.signatures = [signature];
      }
      if (reviewed.result.state.threshold > 1) {
        renderBindingReview(); button("smart-bind-sign").disabled = true;
        options.status(`Your approval for ${networkName(reviewed.result.state.chainId)} is collected. Add the other required owners' signatures for this exact network, then connect it.`);
        return;
      }
      try { connected = await connectReviewedWallet(reviewed); }
      catch (error) { button("smart-bind-sign").textContent = "Retry wallet connection"; throw error; }
      check();
    }
    if (connected) setBinding(connected);
    button("smart-bind-sign").disabled = true; button("smart-bind-submit").disabled = true;
    options.status("Transaction wallets connected. Choose a saved wallet to prepare its transactions.");
  });
  event("smart-bind-submit", async () => {
    if (!challenge) fail("Review the wallet connection first.");
    const created = creations.some((item) => item.bindingReview === challenge);
    const result = await connectReviewedWallet(challenge!, signatureList("smart-binding-signatures"));
    const next = created ? pendingConnections()[0] : undefined;
    if (next) { challenge = next; renderBindingReview(); }
    else { setBinding(result); button("smart-bind-sign").disabled = true; button("smart-bind-submit").disabled = true; }
    options.status(next ? "Wallet connected. Review the next network's ownership approval." : "Transaction wallet connected.");
  });
  async function loadBinding(id: Hex) {
    const { check } = checkpoint(), result = await ownerClient().binding(id); check();
    setBinding(result); options.status(`Wallet on ${networkName(result.wallet.chainId)} checked and ready.`);
  }
  function renderSavedWallets() {
    const list = element("smart-wallet-list"); list.replaceChildren();
    for (const item of savedBindings.values()) {
      const row = document.createElement("li"), use = document.createElement("button");
      use.type = "button"; use.className = "wallet-choice";
      use.textContent = `${networkName(item.wallet.chainId)} / ${item.wallet.address}`;
      use.addEventListener("click", () => void options.run(() => loadBinding(item.id))); row.append(use); list.append(row);
    }
    list.hidden = savedBindings.size === 0;
  }
  event("smart-bind-list", async () => {
    const { check } = checkpoint(), result = await ownerClient().bindings(); check();
    savedBindings.clear(); for (const item of result.items) savedBindings.set(item.id, item);
    renderSavedWallets(); show("smart-bindings", result);
  });
  event("smart-bind-load", () => loadBinding(field("smart-binding-id").value as Hex));
  field("session-action").addEventListener("change", () => {
    element("session-payment").hidden =
      field("session-action").value === "v6-project-uri";
    element<HTMLInputElement>("session-budget-consent").checked = false;
  });
  event("session-prepare", async () => {
    if (!sessionsAvailable())
      fail(
        "Bot wallet permissions are unavailable on this chain. Use fresh owner approval.",
      );
    const { check } = checkpoint(),
      b = bound(),
      kind = field("session-action").value;
    const policy: SessionPolicyInput = {
      bindingId: b.id,
      grantId: field("session-grant").value.trim(),
      generation: Date.now().toString(),
      nonce: newRequestNonce(),
      validAfter: Math.floor(Date.now() / 1000) + 300,
      durationDays: Number(field("session-days").value) as 7 | 30,
      maximumCalls: decimal("session-calls"),
      gasBudget: json("session-gas"),
      allocations: [],
      actions: [],
    };
    if (kind === "v6-project-uri")
      policy.actions = [
        {
          kind,
          controller: address("session-target"),
          projectId: decimal("session-project"),
        },
      ];
    else {
      if (!element<HTMLInputElement>("session-budget-consent").checked)
        fail(
          "Explicitly approve the exact isolated repeat-payment budget first.",
        );
      const total = decimal("session-total"),
        perCallLimit = decimal("session-per-call"),
        beneficiary = address("session-beneficiary");
      policy.allocations = [
        {
          id: "isolated",
          total,
          allocations: [
            {
              id: "local",
              chainId: b.wallet.chainId,
              asset: address("session-asset"),
              limit: total,
            },
          ],
        },
      ];
      if (kind === "erc20-transfer")
        policy.actions = [
          {
            kind,
            allocationId: "local",
            beneficiary,
            perCallLimit,
            totalLimit: total,
          },
        ];
      else if (kind === "v6-pay")
        policy.actions = [
          {
            kind,
            allocationId: "local",
            beneficiary,
            perCallLimit,
            totalLimit: total,
            terminal: address("session-target"),
            projectId: decimal("session-project"),
            minReturnedTokens: decimal("session-min-return"),
          },
        ];
      else fail("Select a supported exact action.");
    }
    const result = await ownerClient().prepareSession(policy);
    check();
    if (
      result.compiled.validAfter !== policy.validAfter ||
      result.compiled.validUntil !==
        policy.validAfter + policy.durationDays * 86400 ||
      result.compiled.grantId !== policy.grantId
    )
      fail(
        "The compiled session differs from the selected period or bot grant.",
      );
    setSession(result);
    show("session-review", { requestedPolicy: policy, session: result });
    options.status(
      "Policy prepared, starting in five minutes. Review every limit and the compiled hash before preparing owner activation.",
    );
  });
  for (const kind of ["activation", "revocation"] as const)
    event(
      kind === "activation" ? "session-activate" : "session-revoke",
      async () => {
        const { check } = checkpoint(),
          s = requireSession();
        const result = await ownerClient().sessionPlan(
          s.id,
          kind,
          s.compiled.compiledHash,
        );
        check();
        setSession(result.session);
        field("operation-authority").value = "owner";
        authorityChanged();
        setPlan(result.plan);
        options.status(
          `${kind === "activation" ? "Activation" : "Revocation"} plan prepared. Review and sign the owner operation below; the onchain change is not confirmed yet.`,
        );
        element("operation-plan-review").scrollIntoView({ block: "nearest" });
      },
    );
  event("session-refresh", async () => {
    const { check } = checkpoint(),
      id = field("session-id").value.trim(),
      client = ownerClient();
    const result = await client.session(id);
    check();
    const quota = await client.quota(id);
    check();
    setSession(result);
    show("session-quota", quota);
    options.status(
      `Session state: ${result.state}. Remaining limits reflect the displayed blockchain record.`,
    );
  });
  function authorityChanged() {
    epoch++;
    refreshReadiness();
    const local = field("operation-authority").value === "session";
    element("session-key-fields").hidden = !local;
    plan = undefined;
    clearOperation();
    element("operation-plan-review").hidden = true;
    button("operation-prepare").disabled = true;
  }
  field("operation-authority").addEventListener("change", authorityChanged);
  field("session-key-file").addEventListener(
    "change",
    () =>
      void options.run(async () => {
        const { check } = checkpoint(),
          input = element<HTMLInputElement>("session-key-file"),
          file = input.files?.[0];
        input.value = "";
        key = undefined;
        if (!file || file.size > 4096)
          fail(
            "Choose the small JSON bot key file downloaded during registration.",
          );
        let value: unknown;
        try {
          value = JSON.parse(await file!.text());
        } catch {
          fail("The local key file is invalid.");
        }
        check();
        const s = requireSession();
        let data = value as {
          format?: string;
          botAddress?: string;
          privateKey?: string;
        };
        if (data?.format === "juicebox-center-connection-v1") {
          const imported = parseConnection(value);
          if (clientAudience(imported.audience) !== clientAudience(options.audience) ||
              imported.accountId !== connection().accountId || imported.grantId !== s.compiled.grantId ||
              !imported.scopes.includes("relay") || imported.expiresAt <= Math.floor(Date.now() / 1000))
            fail("The connection must authorize this session's account and bot grant with unexpired relay access.");
          data = imported;
        } else if (
          !data ||
          data.format !== "juicebox-center-bot-key-v1" ||
          typeof data.privateKey !== "string" ||
          !/^0x[0-9a-fA-F]{64}$/.test(data.privateKey)
        )
          fail("Use a bot key file.");
        const signer = privateKeyToAccount(data.privateKey as Hex);
        if (
          !data.botAddress ||
          !same(signer.address, data.botAddress) ||
          !same(signer.address, s.compiled.sessionKey)
        )
          fail("The local key does not match this session's registered bot.");
        epoch++;
        clearOperation();
        key = signer;
        element("session-key-status").textContent =
          `Local signer: ${signer.address}. Private key retained only in this page's memory.`;
        options.status(
          "Local bot key loaded. Prepare an action within its approved permissions.",
        );
      }),
  );
  event("session-key-clear", async () => {
    epoch++;
    key = undefined;
    clearOperation();
    element("session-key-status").textContent = "Local key cleared.";
  });
  event("operation-template", async () => {
    const template = sessionActionPlanInput(requireSession(), {
      uri: field("operation-uri").value.trim(),
      amount: field("operation-amount").value.trim(),
      tokenContractId: field("operation-token-contract").value.trim(),
    });
    field("operation-name").value = "contract_calls";
    field("operation-input").value = JSON.stringify(template, null, 2);
    options.status(
      "Call input filled from the first reviewed session action. Review it, then prepare the plan.",
    );
  });
  event("operation-plan", async () => {
    const { check } = checkpoint(),
      client = executionClient(),
      result = await client.preparePlan(
        bound().id,
        field("operation-name").value.trim(),
        json("operation-input"),
      );
    check();
    setPlan(result);
    options.status(
      "Review the exact calls, values and warnings in the smart-wallet plan.",
    );
  });
  event("operation-prepare", async () => {
    if (!executionAvailable())
      fail(
        "Execution is unavailable for this chain or signing authority. Check the hosted configuration.",
      );
    const { check } = checkpoint(),
      reviewed = plan;
    if (!reviewed) fail("Prepare a plan first.");
    const indexes = field("operation-steps")
      .value.split(",")
      .map((x) => x.trim());
    if (
      !indexes.length ||
      indexes.some((x) => !/^(0|[1-9][0-9]{0,3})$/.test(x))
    )
      fail("Enter exact zero-based step indexes separated by commas.");
    const freshBinding = await ownerClient().binding(bound().id);
    check();
    if (
      freshBinding.ownerAccountId !== connection().accountId ||
      freshBinding.id !== bound().id || freshBinding.wallet.chainId !== bound().wallet.chainId ||
      !same(freshBinding.wallet.address, bound().wallet.address)
    )
      fail("The wallet binding changed.");
    binding = freshBinding;
    refreshReadiness();
    const client = executionClient(),
      result = await client.prepareUserOperation({
        planId: reviewed!.id,
        stepIndexes: indexes.map(Number),
        ...(field("operation-authority").value === "session"
          ? { sessionId: requireSession().id }
          : {}),
      });
    check();
    assertReviewedOperation(result, reviewed!);
    clearOperation();
    operation = result;
    operationClient = client;
    submissionKey = smartRequestKey();
    show("operation-review", result);
    button("operation-prepare").disabled = true;
    button("operation-sign").disabled = false;
    button("operation-status").disabled = false;
    queue?.refresh();
    options.status(
      "Operation prepared and simulated. Review the encoded instructions (calldata), network costs, sponsor (paymaster), expiry and public signing document.",
    );
  });
  event("operation-sign", async () => {
    const { c, check } = checkpoint(),
      reviewed = operation;
    if (!reviewed || !plan) fail("Prepare a fresh operation first.");
    assertReviewedOperation(reviewed!, plan!);
    if (reviewed!.session) {
      if (!key) fail("Load the local session key first.");
      sessionSignature = await signSessionUserOperation({
        record: reviewed!,
        session: requireSession(),
        signer: key!,
      });
      check();
    } else {
      const m = manifest();
      if (
        !m.entryPoint ||
        m.id !== bound().manifestId ||
        !same(m.revision, bound().state.manifestRevision)
      )
        fail("Choose the exact reviewed deployment for this wallet binding.");
      const payload = ownerOperationSigning({
        record: reviewed!,
        binding: bound(),
        operation: reviewed!.operation,
        chainId: m.chainId,
        safe7579: m.safe7579.address,
        entryPoint: m.entryPoint!.address,
        validAfter: String(Math.floor(reviewed!.createdAt / 1000)),
        validUntil: String(Math.floor(reviewed!.expiresAt / 1000)),
      });
      const provider = await executionProvider(c, m.chainId); check();
      const signature = await signWalletTypedData({
        provider,
        address: c.owner,
        chainId: m.chainId,
        document: payload.typedData,
        stillCurrent: () => options.connection() === c,
      });
      check();
      operationSignatures = [signature];
    }
    button("operation-sign").disabled = true;
    button("operation-submit").disabled = false;
    options.status(
      !reviewed!.session && bound().state.threshold > 1
        ? "Signature collected. Add the remaining owner signatures, then submit."
        : "Signature collected. Submit the reviewed transaction when ready.",
    );
  });
  event("operation-submit", async () => {
    const { c, check } = checkpoint(),
      reviewed = operation;
    if (!reviewed || !plan || !operationClient || !submissionKey)
      fail("Prepare and sign an operation first.");
    assertReviewedOperation(reviewed!, plan!);
    const signature = reviewed!.session
      ? sessionSignature
      : await ownerOperationSignature(
          reviewed!.signing as ReturnType<typeof ownerOperationSigning>,
          bound(),
          [
            ...operationSignatures,
            ...signatureList("operation-owner-signatures"),
          ],
        );
    check();
    if (!signature) fail("Sign the exact session operation first.");
    recordWalletRecovery({ accountId: c.accountId, chainId: reviewed!.chainId, walletAddress: reviewed!.operation.sender,
      kind: "user-operation", attemptId: submissionKey!, idempotencyKey: submissionKey!, operationId: reviewed!.id });
    refreshRecovery();
    // Once a request is sent, its outcome can be unknown. Never generate a new submission key or auto-resubmit.
    button("operation-submit").disabled = true;
    button("operation-sign").disabled = true;
    element("operation-result").textContent =
      "Submission started. If the request fails, refresh this operation's status before taking another action.";
    let result: PreparedUserOperation;
    try { result = await operationClient!.submitUserOperation(reviewed!.id, signature!, submissionKey); }
    catch (error) {
      if (error && typeof error === "object" && "requestNotSent" in error && error.requestNotSent === true) {
        removeWalletRecovery(c.accountId, submissionKey!); refreshRecovery();
        if (options.connection() === c) button("operation-submit").disabled = false;
      }
      throw error;
    }
    check();
    assertSameOperation(result, reviewed!);
    operation = result;
    show("operation-review", result);
    element("operation-result").textContent =
      `Operation ${result.id}: ${result.state}. A submission is not confirmation.`;
    options.status(
      "Operation submitted. Refresh its status to check confirmation against the chain.",
    );
  });
  event("operation-status", async () => {
    const { c, check } = checkpoint(),
      reviewed = operation;
    if (!reviewed || !operationClient) fail("Prepare an operation first.");
    const result = await operationClient!.userOperation(reviewed!.id);
    check();
    assertSameOperation(result, reviewed!);
    operation = result;
    if (submissionKey && ["confirmed", "reverted"].includes(result.state)) removeWalletRecovery(c.accountId, submissionKey);
    refreshRecovery();
    show("operation-review", result);
    element("operation-result").textContent =
      `Operation ${result.id}: ${result.state}.`;
    options.status(`Operation state: ${result.state}.`);
  });
  queue = installOperationQueue({
    connection: options.connection, execution: executionProvider, run: options.run, status: options.status, networkName, refreshRecovery,
    current: () => operation && plan && binding && operationClient ? {
      record: operation, plan, binding, client: operationClient, manifest: manifest(),
    } : undefined,
    takeCurrent: clearOperation,
  });
  return {
    async accountReady(ready: boolean) {
      refreshReadiness();
      element<HTMLFieldSetElement>("smart-fields").disabled = !ready;
      if (ready && !field("smart-owners").value)
        field("smart-owners").value = connection().owner;
      if (ready) {
        const generation = epoch;
        try {
          await discoverHosted();
          refreshRecovery();
        } catch {
          if (generation === epoch) {
            button("smart-discover").hidden = false;
            element("smart-readiness").textContent =
              "Could not load supported networks. Try again.";
          }
        }
      }
    },
    reset() {
      epoch++;
      binding = undefined;
      creations = [];
      savedBindings.clear(); renderSavedWallets(); renderCreations();
      challenge = undefined;
      session = undefined;
      plan = undefined;
      key = undefined;
      host = undefined;
      networkChoices = [];
      queue.reset();
      element("smart-recovery").hidden = true;
      button("smart-discover").hidden = true;
      button("smart-switch").hidden = true;
      button("smart-bind-submit").hidden = true;
      for (const id of ["smart-create-send", "smart-create-status", "smart-bind-sign"])
        button(id).hidden = true;
      element("smart-readiness").textContent = "Sign in to see the supported networks.";
      field("operation-authority").value = "owner";
      field("smart-threshold").value = "1";
      refreshReadiness();
      clearOperation();
      for (const id of ["smart-fields", "session-fields", "operation-fields"])
        element<HTMLFieldSetElement>(id).disabled = true;
      for (const id of [
        "smart-create-send",
        "smart-create-status",
        "smart-bind-sign",
        "smart-bind-submit",
        "session-activate",
        "session-revoke",
        "operation-prepare",
      ])
        button(id).disabled = true;
      for (const id of [
        "smart-owners",
        "smart-address",
        "smart-binding-id",
        "smart-binding-signatures",
        "session-id",
        "session-grant",
        "session-key-file",
      ])
        field(id).value = "";
      for (const id of [
        "smart-creation",
        "smart-binding-review",
        "smart-binding-summary",
        "smart-binding-document",
        "smart-bindings",
        "session-review",
        "session-quota",
        "operation-plan-review",
        "smart-binding-multisig",
      ])
        element(id).hidden = true;
      element("session-key-status").textContent = "No local key loaded.";
    },
  };
}
