import type { Hex } from "viem";
import {
  RestClientError, assertReviewedOperation, isSettledUserOperation, ownerOperationSignature, ownerOperationSigning,
  signWalletTypedData, smartRequestKey, type PreparedUserOperation, type SmartAccountClient,
  type SmartWalletPlan, type WalletProvider,
} from "../client/index.js";
import type { SmartAccountBinding, SmartAccountManifest } from "../smartAccounts/types.js";
import type { SmartWalletConnection } from "./smartSessions.js";
import { recordWalletRecovery, removeWalletRecovery, walletRecoveries } from "./walletRecovery.js";

export interface QueuedOperationInput {
  record: PreparedUserOperation;
  plan: SmartWalletPlan;
  binding: SmartAccountBinding;
  manifest: SmartAccountManifest;
  client: SmartAccountClient;
}
interface QueueEntry extends QueuedOperationInput {
  key: string;
  signature?: Hex;
  additional: HTMLTextAreaElement;
  attempted: boolean;
  state: string;
}
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const button = (id: string) => element<HTMLButtonElement>(id);
const fail = (message: string): never => { throw new RestClientError("SMART_QUEUE_REVIEW_REQUIRED", message); };
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const exactJson = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item, 2);
function immutableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(immutableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${immutableJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function assertSameOperation(result: PreparedUserOperation, reviewed: PreparedUserOperation) {
  for (const key of ["id", "planId", "planCommitment", "accountBindingId", "accountStateHash", "chainId", "entryPoint", "operationHash", "commitment", "gasPolicyId", "providerId", "stepIndexes", "expiresAt", "createdAt", "operation", "signing", "session"] as const) {
    if (immutableJson(result[key]) !== immutableJson(reviewed[key])) fail("The returned operation differs from the reviewed transaction. Keep its original operation ID for recovery.");
  }
}

/** Each queue item retains its own reviewed bytes, owner approval and submission identity. */
export function installOperationQueue(options: {
  connection(): SmartWalletConnection | undefined;
  execution(c: SmartWalletConnection, chainId: number): Promise<WalletProvider>;
  run(operation: () => Promise<void>): Promise<void>;
  status(message: string, error?: boolean): void;
  current(): QueuedOperationInput | undefined;
  takeCurrent(): void;
  networkName(chainId: number): string;
  refreshRecovery(): void;
}) {
  let entries: QueueEntry[] = [], generation = 0;
  function checkpoint() {
    const c = options.connection(), currentGeneration = generation;
    if (!c) fail("Sign in first.");
    return { c: c!, check() {
      if (options.connection() !== c || generation !== currentGeneration)
        fail("The signed-in account changed. Review the queue again.");
    } };
  }
  function render() {
    const list = element("operation-queue-review");
    list.replaceChildren();
    list.hidden = entries.length === 0;
    for (const entry of entries) {
      const row = document.createElement("li"); row.className = "network-progress-item";
      const summary = document.createElement("p");
      summary.textContent = `${options.networkName(entry.record.chainId)} / ${entry.binding.wallet.address} / ${entry.state}. ${entry.plan.draft.calls.filter((_call, index) => entry.record.stepIndexes.includes(index)).map((call) => `${call.label}: ${call.value} wei`).join("; ")}`;
      const details = document.createElement("details"), title = document.createElement("summary"), raw = document.createElement("pre");
      title.textContent = "Exact calls, network fees and approval";
      raw.textContent = exactJson({ calls: entry.plan.draft.calls, operation: entry.record });
      details.append(title, raw); row.append(summary, details);
      if (entry.binding.state.threshold > 1) {
        const label = document.createElement("label");
        label.textContent = `Additional owner signatures for ${options.networkName(entry.record.chainId)} (JSON array)`;
        label.append(entry.additional); row.append(label);
      }
      if (!entry.attempted) {
        const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "Remove from queue";
        remove.addEventListener("click", () => void options.run(async () => {
          generation++; entries = entries.filter((item) => item !== entry); render();
        }));
        row.append(remove);
      }
      list.append(row);
    }
    button("operation-queue-sign").disabled = !entries.some((entry) => !entry.attempted && !entry.signature);
    button("operation-queue-submit").disabled = !entries.some((entry) => !entry.attempted && entry.signature);
    button("operation-queue-status").disabled = entries.length === 0;
    refresh();
  }
  function refresh() {
    const current = options.current();
    button("operation-queue-add").disabled = !current || !!current.record.session ||
      entries.some((entry) => entry.binding.id === current.binding.id);
  }
  async function currentBinding(entry: QueueEntry) {
    const fresh = await entry.client.binding(entry.binding.id);
    if (fresh.ownerAccountId !== options.connection()?.accountId || fresh.id !== entry.binding.id ||
      fresh.wallet.chainId !== entry.record.chainId || !same(fresh.wallet.address, entry.binding.wallet.address) ||
      fresh.manifestId !== entry.manifest.id || !same(fresh.state.stateHash, entry.binding.state.stateHash) ||
      !same(fresh.state.manifestRevision, entry.manifest.revision))
      fail("A queued wallet's ownership or configuration changed. Remove it and prepare a fresh operation.");
    return fresh;
  }
  function additionalSignatures(entry: QueueEntry): Hex[] {
    if (!entry.additional.value.trim()) return [];
    let value: unknown;
    try { value = JSON.parse(entry.additional.value); } catch { return fail("Enter additional owner signatures as a JSON array."); }
    if (!Array.isArray(value) || value.length > 16 || value.some((item) => typeof item !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(item)))
      fail("Use the exact owner signatures for this queued operation.");
    return value as Hex[];
  }
  const event = (id: string, action: () => Promise<void>) => button(id).addEventListener("click", () => void options.run(action));
  event("operation-queue-add", async () => {
    const { c } = checkpoint(), current = options.current();
    if (!current || current.record.session) fail("Prepare an operation with fresh owner approval first.");
    if (current!.binding.ownerAccountId !== c.accountId || entries.some((entry) => entry.binding.id === current!.binding.id))
      fail("Add one operation per wallet. Combine its calls into one reviewed plan.");
    if (walletRecoveries(c.accountId).some((record) => record.kind === "user-operation" && record.chainId === current!.record.chainId && same(record.walletAddress, current!.binding.wallet.address)))
      fail("Check the saved transaction for this wallet before preparing another queued payment.");
    if (entries.length >= 32) fail("Finish the current transaction queue before adding more wallets.");
    assertReviewedOperation(current!.record, current!.plan);
    const additional = document.createElement("textarea"); additional.rows = 2; additional.spellcheck = false;
    entries.push({ ...structuredClone({ record: current!.record, plan: current!.plan, binding: current!.binding, manifest: current!.manifest }),
      client: current!.client, key: smartRequestKey(), additional, attempted: false, state: "Review required" });
    options.takeCurrent(); render();
    options.status("Operation added. Choose another connected wallet to add another network, then review the complete queue.");
  });
  event("operation-queue-sign", async () => {
    const { c, check } = checkpoint();
    for (const entry of entries.filter((item) => !item.attempted && !item.signature)) {
      assertReviewedOperation(entry.record, entry.plan);
      const fresh = await currentBinding(entry); check();
      if (!entry.manifest.entryPoint) fail("This wallet has no reviewed transaction entry point.");
      const signing = ownerOperationSigning({ record: entry.record, binding: fresh, operation: entry.record.operation,
        chainId: entry.record.chainId, safe7579: entry.manifest.safe7579.address, entryPoint: entry.manifest.entryPoint!.address,
        validAfter: String(Math.floor(entry.record.createdAt / 1000)), validUntil: String(Math.floor(entry.record.expiresAt / 1000)) });
      const provider = await options.execution(c, entry.record.chainId); check();
      entry.signature = await signWalletTypedData({ provider, address: c.owner, chainId: entry.record.chainId,
        document: signing.typedData, stillCurrent: () => options.connection() === c });
      check(); entry.state = entry.binding.state.threshold > 1 ? "Your approval collected; additional owners required" : "Approved; not submitted"; render();
    }
    options.status("Owner approvals collected for the queue. Review all networks before submitting; each transaction completes separately.");
  });
  event("operation-queue-submit", async () => {
    const { c, check } = checkpoint();
    const pending = entries.filter((entry) => !entry.attempted);
    if (!pending.length) fail("Refresh the submitted transactions to check their results.");
    // Validate every queued approval before publishing the first transaction.
    const signed: { entry: QueueEntry; signature: Hex }[] = [];
    for (const entry of pending) {
      if (!entry.signature) fail("Approve every queued operation before submitting.");
      assertReviewedOperation(entry.record, entry.plan);
      const fresh = await currentBinding(entry); check();
      const signature = await ownerOperationSignature(entry.record.signing as ReturnType<typeof ownerOperationSigning>, fresh,
        [entry.signature!, ...additionalSignatures(entry)]); check();
      signed.push({ entry, signature });
    }
    for (const { entry, signature } of signed) {
      check();
      recordWalletRecovery({ accountId: c.accountId, chainId: entry.record.chainId, walletAddress: entry.binding.wallet.address,
        kind: "user-operation", attemptId: entry.key, idempotencyKey: entry.key, operationId: entry.record.id });
      options.refreshRecovery(); entry.attempted = true; entry.additional.readOnly = true; entry.state = "Submission outcome unknown"; render();
      let result: PreparedUserOperation;
      try { result = await entry.client.submitUserOperation(entry.record.id, signature, entry.key); }
      catch (error) {
        if (error && typeof error === "object" && "requestNotSent" in error && error.requestNotSent === true) {
          entry.attempted = false; entry.additional.readOnly = false; entry.state = "API approval did not complete; transaction not submitted"; render();
          removeWalletRecovery(c.accountId, entry.key); options.refreshRecovery();
        }
        throw error;
      }
      check(); assertSameOperation(result, entry.record); entry.record = result; entry.state = result.state; render();
    }
    options.status("Queue submitted. Refresh results to verify each network independently.");
  });
  event("operation-queue-status", async () => {
    const { c, check } = checkpoint();
    for (const entry of entries) {
      const result = await entry.client.userOperation(entry.record.id); check();
      assertSameOperation(result, entry.record); entry.record = result;
      entry.state = entry.attempted && result.state === "prepared" ? "Submission unconfirmed; check before taking another action" : result.state;
      if (isSettledUserOperation(result.state)) removeWalletRecovery(c.accountId, entry.key);
      render();
    }
    options.status("Queue status refreshed. Confirmation is tracked separately for each network.");
    options.refreshRecovery();
  });
  return { refresh, reset() { generation++; entries = []; render(); } };
}
