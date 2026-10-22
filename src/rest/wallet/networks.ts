import { randomUUID } from "node:crypto";
import { encodeFunctionData, getAddress, hashTypedData, keccak256, parseAbi, recoverAddress, toHex, zeroAddress, type Address, type Hex, type TransactionSerializableEIP1559 } from "viem";
import { RestError, type RestRpc } from "../core.js";
import type { ServerSigner } from "../signer.js";
import { RELAYR_PAYMENT_CODE_HASH, RELAYR_PAYMENT_GAS } from "../sponsorship/constants.js";
import { assertPaymentEligible, bindIndependentQuoteStatus, parseIndependentQuoteBinding, parseIndependentStatus, type RelayrProvider } from "../sponsorship/provider.js";
import type { RelayrIndependentEntry, RelayrPayment, RelayrQuote } from "../sponsorship/types.js";
import type { preparePasskeySafe7579Creation } from "../smartAccounts/creation.js";
import type { SmartAccountManifest } from "../smartAccounts/types.js";
import { predictPasskeySignerAddress } from "../smartAccounts/passkeyCreation.js";
import { canonicalEoaSignature } from "../smartAccounts/accountExecution.js";
import { walletOwnerChangeSafeTx } from "../web/walletRecoveryReview.js";
import type { WalletEnrollment } from "./enrollment.js";
import type { WalletCentralSession } from "./login.js";
import type { WalletAuthorityContext } from "./authority.js";
import { verifyWalletAssertion, WalletAssertionError, type WalletAssertion } from "./webauthn.js";
import { SIGNA_HOME_CHAIN_ID, signaChainName, signaChains } from "./chains.js";
import { observeWalletOwners, readWalletSafe, type WalletOwnerStateStore } from "./ownerState.js";
import { walletOwnerSteps, type WalletOwnerApproval, type WalletOwnerCall, type WalletOwnerChainRow, type WalletOwnerTarget } from "./ownerChains.js";

/** The account on more chains. The Base creation call carries no chain id, so replaying the exact
 * factory call reaches the same CREATE2 address wherever the stack sits at the same addresses;
 * every pin was verified on all eight chains on 2026-09-15, and each destination is compared to
 * Base again before a quote. Relayr executes the calls from one prepaid bundle per family; Center's
 * payer funds the bundle for the chains marked centerPays, within explicit caps. */
export type WalletNetworkFamily = "mainnet" | "testnet";
export interface WalletNetwork { chainId: number; name: string; family: WalletNetworkFamily; paymentChainId: number; centerPays: boolean; offered: boolean }
export const walletNetworkCatalog: readonly WalletNetwork[] = Object.freeze(signaChains.filter(({ chainId }) => chainId !== SIGNA_HOME_CHAIN_ID)
  .map(({ enabled: _enabled, ...network }) => network));
export { signaChains };
export const WALLET_HOME_NETWORK = Object.freeze({ chainId: SIGNA_HOME_CHAIN_ID, name: signaChainName(SIGNA_HOME_CHAIN_ID) });
/** What Center pays Relayr for one bundle, at most, per family; and how many funded bundles one account may hold per family. */
export const WALLET_NETWORKS_MAXIMUM_PAYMENT_WEI = Object.freeze({ mainnet: 3n * 10n ** 15n, testnet: 10n ** 16n });
export const WALLET_NETWORKS_MAXIMUM_BUNDLES_PER_FAMILY = 3;
export const WALLET_NETWORKS_MAXIMUM_FEE_PER_GAS = 20_000_000_000n;
export const WALLET_NETWORKS_PRIORITY_FEE_PER_GAS = 1_000_000n;
const networkById = new Map(walletNetworkCatalog.map(network => [network.chainId, network]));
function invalid(message: string, status = 400): never { throw new RestError(status, "WALLET_NETWORKS_INVALID", message); }
/** Relayr's words for a call that will not run. */
const relayFailed = /fail|revert|cancel|reject|expire/i;
function state(): never { throw new RestError(409, "WALLET_NETWORKS_STATE", "Check the current networks and retry."); }
function ownersChanged(): never { throw new RestError(409, "WALLET_NETWORKS_OWNERS_CHANGED", "This account's owners changed in a way Signa cannot copy to another network. Adding networks is paused for this account."); }
function ownersLost(): never { throw new RestError(409, "WALLET_NETWORKS_OWNERS_LOST", "This account can no longer be opened on new networks."); }
function backupInvalid(): never { throw new RestError(403, "WALLET_NETWORKS_BACKUP_INVALID", "The backup signatures do not match this update. Open the backup for this account and try again."); }
const factoryAbi = parseAbi(["function createSigner(uint256 x,uint256 y,uint176 verifiers) returns(address)"]);
const execAbi = parseAbi(["function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns(bool)"]);
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every(item => b.some(other => other.toLowerCase() === item.toLowerCase()));
const includes = (list: readonly string[], item: string) => list.some(entry => entry.toLowerCase() === item.toLowerCase());

export function walletNetworkFamily(chainIds: readonly number[]): WalletNetworkFamily {
  if (!Array.isArray(chainIds) || !chainIds.length || chainIds.length > walletNetworkCatalog.length || new Set(chainIds).size !== chainIds.length) invalid("Choose distinct networks.");
  const networks = chainIds.map(chainId => networkById.get(chainId) ?? invalid("Unsupported network."));
  const family = networks[0]!.family;
  if (networks.some(network => network.family !== family)) invalid("Choose networks of one family: mainnets or testnets.");
  return family;
}
export function walletNetworkEntries(creation: ReturnType<typeof preparePasskeySafe7579Creation>, chainIds: readonly number[]): RelayrIndependentEntry[] {
  walletNetworkFamily(chainIds);
  if (chainIds.some(chainId => !networkById.get(chainId)!.offered)) invalid("That network is not offered yet.");
  return [...chainIds].sort((a, b) => a - b).map(chain => ({ chain, target: creation.transaction.to, data: creation.transaction.data, value: "0" }));
}

const documentTypes = { WalletNetworks: [
  { name: "accountId", type: "string" }, { name: "purpose", type: "string" }, { name: "bundleUuid", type: "string" },
  { name: "chainIds", type: "uint256[]" }, { name: "factory", type: "address" }, { name: "calldataHash", type: "bytes32" },
  { name: "paymentChainId", type: "uint256" }, { name: "paymentTo", type: "address" }, { name: "paymentValue", type: "uint256" },
  { name: "paymentDeadline", type: "uint256" }, { name: "rpId", type: "string" }, { name: "origin", type: "string" },
  { name: "nonce", type: "bytes32" }, { name: "issuedAtMs", type: "uint256" }, { name: "expiresAtMs", type: "uint256" } ] } as const;
export interface WalletNetworksDocumentInput {
  accountId: string; walletAddress: Address; bundleUuid: string; chainIds: readonly number[]; factory: Address; calldataHash: Hex;
  payment: { chainId: number; to: Address; value: string; deadline: string }; rpId: string; origin: string; nonce: Hex; issuedAtMs: number; expiresAtMs: number;
}
/** One passkey prompt approves the chain list, the bundle and the exact payment; the calldata is
 * bound by hash so the approval cannot be reused for another initializer or account. */
export function walletNetworksDocument(input: WalletNetworksDocumentInput) {
  return {
    domain: { name: "Juicebox Center Networks", version: "1", chainId: SIGNA_HOME_CHAIN_ID, verifyingContract: getAddress(input.walletAddress) },
    types: structuredClone(documentTypes), primaryType: "WalletNetworks" as const,
    message: { accountId: input.accountId, purpose: "networks", bundleUuid: input.bundleUuid, chainIds: input.chainIds.map(chainId => BigInt(chainId)),
      factory: getAddress(input.factory), calldataHash: input.calldataHash, paymentChainId: BigInt(input.payment.chainId), paymentTo: getAddress(input.payment.to),
      paymentValue: BigInt(input.payment.value), paymentDeadline: BigInt(input.payment.deadline), rpId: input.rpId, origin: input.origin,
      nonce: input.nonce, issuedAtMs: BigInt(input.issuedAtMs), expiresAtMs: BigInt(input.expiresAtMs) },
  };
}

export type WalletNetworkState = "quoted" | "pending" | "deployed" | "failed";
export interface WalletNetworkRow { chainId: number; state: WalletNetworkState; bundleId: string | null; txHash: Hex | null; updatedAtMs: number }
export type WalletNetworkBundleState = "quoted" | "paying" | "paid" | "settled" | "failed";
export interface WalletNetworkBundle {
  id: string; accountId: string; family: WalletNetworkFamily; chainIds: number[]; state: WalletNetworkBundleState; centerPays: boolean;
  /** An owner-change bundle carries reviewed owner changes (`ownerChains.ts`), which hold their own owner signatures; it has no passkey document and no chain rows. */
  purpose?: "owners"; changeId?: string;
  /** A deployment's Base owners at the quote, and the owner change that brings its new chains to them. */
  expectedOwners?: Address[]; ownerChangeId?: string;
  quote: RelayrQuote<RelayrIndependentEntry>; /** Relayr returns transaction uuids in its own order; the first status read binds them. */ bound: boolean;
  payment: RelayrPayment; document: WalletNetworksDocumentInput | null;
  paymentTx: { hash: Hex; raw: Hex; nonce: number; sentAtMs: number | null } | null; createdAtMs: number; updatedAtMs: number;
}
export interface WalletNetworksStore {
  /** Serializes funding by chain and sender across processes; no transaction spans RPC. */
  withPayer<T>(chainId: number, payer: Address, run: (store: WalletNetworksStore) => Promise<T>): Promise<T>;
  assertPayerNonceAvailable(chainId: number, payer: Address, nonce: number): Promise<void>;
  listNetworks(accountId: string): Promise<WalletNetworkRow[]>;
  listBundles(accountId: string): Promise<WalletNetworkBundle[]>;
  getBundle(accountId: string, id: string): Promise<WalletNetworkBundle | null>;
  createBundle(bundle: WalletNetworkBundle, now: number): Promise<void>;
  /** Writes the bundle only while it is still in `from`; false means another request moved it first. */
  transitionBundle(bundle: WalletNetworkBundle, from: WalletNetworkBundleState, now: number): Promise<boolean>;
  /** Takes the chain rows for a new quote; only failed or absent rows can be taken. Returns how many were. */
  claimNetworks(accountId: string, chainIds: number[], bundleId: string, now: number): Promise<number>;
  upsertNetwork(accountId: string, row: Omit<WalletNetworkRow, "updatedAtMs">, now: number): Promise<void>;
  /** The owner-change rows (`ownerChains.ts`) a network's update to Base's owners is kept in. */
  recordOwnerChain(input: { changeId: string; kind: "network"; accountId: string; chainId: number; state: "review"; review: WalletNetworkOwners; target: WalletOwnerTarget; reason: null; now: number }): Promise<void>;
  ownerChainRows(changeId: string): Promise<WalletOwnerChainRow[]>;
  approveOwnerChains(changeId: string, approvals: { chainId: number; review: unknown; approval: WalletOwnerApproval }[], now: number): Promise<void>;
  ownerChainsUnderway(accountId: string): Promise<number[]>;
}
/** One chain's update to Base's owners, signed by the recovery owner: the Safe owner calls in order from `from` at `safeNonce`. */
export interface WalletNetworkOwners {
  version: "center-wallet-network-owners-v1"; chainId: number; walletAddress: Address; recoveryOwner: Address;
  from: Address[]; owners: Address[]; safeNonce: string; steps: Hex[]; createSigners: WalletOwnerCall[];
}
export interface WalletNetworksDependencies {
  enrollments: { get(id: string): Promise<WalletEnrollment | null> };
  authority: { loadContext(accountId: string): Promise<WalletAuthorityContext> };
  store: WalletNetworksStore;
  provider: Pick<RelayrProvider, "createIndependent" | "status">;
  rpc: RestRpc;
  ownerStates?: WalletOwnerStateStore;
  payer?: ServerSigner;
  now?: () => number;
  /** Approval window after a quote; the Relayr payment deadline may be shorter. */
  approvalWindowMs?: number;
  maximumPaymentWei?: { mainnet: bigint; testnet: bigint };
  maximumBundlesPerFamily?: number;
}
const quantity = (value: unknown, label: string): bigint => {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i.test(value)) throw new RestError(502, "WALLET_NETWORKS_RPC_INVALID", `Invalid ${label}.`);
  return BigInt(value);
};
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const hexBytes = (value: unknown): Hex => { if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new RestError(502, "WALLET_NETWORKS_RPC_INVALID", "Invalid code."); return value as Hex; };
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
/** The creation stack a destination must carry byte-for-byte as Base does before the same call is replayed there. */
function creationPins(manifest: SmartAccountManifest): Address[] {
  const profile = manifest.ownerProfile!, addresses = [manifest.factory.address, manifest.singleton.address, manifest.safe7579.address, manifest.launchpad.address,
    manifest.creationProfile!.multiSend.address, profile.signerFactory.address, profile.signerSingleton.address, profile.p256Verifier.address];
  return addresses.map(address => getAddress(address));
}

export function createWalletNetworks(options: WalletNetworksDependencies) {
  const now = options.now ?? Date.now, approvalWindowMs = options.approvalWindowMs ?? 300_000;
  const maximumPayment = options.maximumPaymentWei ?? WALLET_NETWORKS_MAXIMUM_PAYMENT_WEI, maximumBundles = options.maximumBundlesPerFamily ?? WALLET_NETWORKS_MAXIMUM_BUNDLES_PER_FAMILY;
  const { store, provider, rpc } = options;
  function name(chainId: number) { return chainId === WALLET_HOME_NETWORK.chainId ? WALLET_HOME_NETWORK.name : networkById.get(chainId)?.name ?? `Chain ${chainId}`; }
  /** The bundles that deploy the account; owner-change bundles hold no chain rows and no passkey document. */
  async function deployments(accountId: string, source = store) {
    return (await source.listBundles(accountId)).filter((bundle): bundle is WalletNetworkBundle & { document: WalletNetworksDocumentInput } => !bundle.purpose);
  }
  /** Each deployed chain carries its owner state: code on a chain says the account exists there, not that Base's owners hold it.
   * A diverged chain with an approved update on its way reads `updating`. With the account's creation, `backup` says whether a
   * new or out-of-date network needs the backup (`needed`), or can no longer be opened at all (`lost`). */
  async function view(accountId: string, source = store, owners = true, enrollment?: WalletEnrollment) {
    const rows = await source.listNetworks(accountId), bundles = await deployments(accountId, source);
    const listed = [{ chainId: WALLET_HOME_NETWORK.chainId, name: WALLET_HOME_NETWORK.name, state: "deployed" as WalletNetworkState, txHash: null as Hex | null },
      ...rows.sort((a, b) => a.chainId - b.chainId).map(row => ({ chainId: row.chainId, name: name(row.chainId), state: row.state, txHash: row.txHash }))];
    const deployed = listed.filter(network => network.state === "deployed").map(network => network.chainId);
    const states = owners ? await observeWalletOwners({ account: getAddress(accountId.slice(`eip155:${SIGNA_HOME_CHAIN_ID}:`.length)), chains: deployed, rpc, now,
      ...(options.ownerStates ? { store: options.ownerStates } : {}) }) : [];
    const underway = owners ? await source.ownerChainsUnderway(accountId) : [];
    const networks = listed.map(network => {
      const state = states.find(item => item.chainId === network.chainId);
      return state ? { ...network, owners: state.status === "diverged" && underway.includes(network.chainId) ? "updating" as const : state.status } : network;
    });
    const home = states.find(item => item.chainId === WALLET_HOME_NETWORK.chainId), creation = enrollment?.creation;
    const backup = !creation || !home || home.status === "unknown" || sameSet(home.owners, creation.owners) ? null
      : !creation.owners.some(owner => includes(home.owners, owner)) ? "lost" as const : includes(home.owners, enrollment!.intent.recoveryOwner) ? "needed" as const : null;
    const busy = new Set(rows.filter(row => row.state !== "failed").map(row => row.chainId));
    const offered = walletNetworkCatalog.filter(network => network.offered && !busy.has(network.chainId))
      .map(network => ({ chainId: network.chainId, name: network.name, family: network.family, centerPays: network.centerPays }));
    return { networks, offered, pending: bundles.filter(bundle => ["paying", "paid"].includes(bundle.state)).map(bundle => ({ id: bundle.id, state: bundle.state, chainIds: bundle.chainIds })),
      ...(enrollment ? { backup } : {}) };
  }
  async function enrollmentOf(session: WalletCentralSession) {
    const enrollment = await options.enrollments.get(session.enrollmentId);
    if (!enrollment?.creation || enrollment.receipt?.accountId !== session.accountId || !same(enrollment.creation.address, session.accountId.slice(`eip155:${SIGNA_HOME_CHAIN_ID}:`.length))) state();
    return enrollment;
  }
  async function deployedOn(chainId: number, address: Address) {
    return hexBytes(await rpc.request(chainId, "eth_getCode", [address, "latest"])) !== "0x";
  }
  /** Fails the bundle and frees its chain rows so they can be quoted again. */
  async function fail(bundle: WalletNetworkBundle, from: WalletNetworkBundleState, source = store) {
    const current = now(); bundle.state = "failed";
    if (!await source.transitionBundle(bundle, from, current) || bundle.purpose) return;
    for (const chainId of bundle.chainIds) await source.upsertNetwork(bundle.accountId, { chainId, state: "failed", bundleId: bundle.id, txHash: null }, current);
  }
  /** Quotes older than their approval window, and quoted bundles replaced by a new quote, stop holding chains. */
  async function expireQuotes(accountId: string, replacing: readonly number[] = []) {
    for (const bundle of await deployments(accountId)) {
      if (bundle.state !== "quoted") continue;
      if (now() >= bundle.document.expiresAtMs || bundle.chainIds.some(chainId => replacing.includes(chainId))) await fail(bundle, "quoted");
    }
  }
  /** The creation stack bytes on Base, read once per quote and compared on every destination. */
  async function homeStack(enrollment: WalletEnrollment) {
    const pins = creationPins(enrollment.intent.manifest);
    const codes = await Promise.all(pins.map(address => rpc.request(WALLET_HOME_NETWORK.chainId, "eth_getCode", [address, "latest"])));
    return pins.map((address, index) => {
      const bytes = hexBytes(codes[index]);
      if (bytes === "0x") throw new RestError(409, "WALLET_NETWORKS_DESTINATION", `Base no longer carries the account's creation stack (${address}).`);
      return { address, hash: keccak256(bytes) };
    });
  }
  /** The exact Base call must succeed on the destination against the same creation stack bytes. */
  async function verifyDestination(chainId: number, enrollment: WalletEnrollment, home: { address: Address; hash: Hex }[]) {
    const creation = enrollment.creation!;
    const there = await Promise.all(home.map(pin => rpc.request(chainId, "eth_getCode", [pin.address, "latest"])));
    for (const [index, pin] of home.entries()) {
      if (keccak256(hexBytes(there[index])) !== pin.hash)
        throw new RestError(409, "WALLET_NETWORKS_DESTINATION", `${name(chainId)} does not carry the account's creation stack (${pin.address}).`);
    }
    let predicted: unknown;
    try { predicted = await rpc.request(chainId, "eth_call", [{ to: creation.transaction.to, data: creation.transaction.data, value: "0x0" }, "latest"]); }
    catch { throw new RestError(409, "WALLET_NETWORKS_DESTINATION", `The account cannot be created on ${name(chainId)} right now.`); }
    if (!same(hexBytes(predicted).slice(-40), creation.address.slice(2))) throw new RestError(409, "WALLET_NETWORKS_DESTINATION", `${name(chainId)} would create a different account.`);
  }
  /** Base's owners now, which every chain must carry. */
  async function homeOwners(account: Address) {
    const home = await readWalletSafe({ account, chainId: SIGNA_HOME_CHAIN_ID, rpc, now })
      .catch(() => { throw new RestError(503, "WALLET_NETWORKS_UNAVAILABLE", "Base could not be read. Try again shortly."); });
    return home;
  }
  /** A new network replays the creation call, so it starts with the original owners; a chain already deployed may
   * hold other owners. Each one that differs from Base gets the Safe owner calls that bring it to Base's owners,
   * signed by the recovery owner, which must be an owner both on Base and on that chain. Every passkey owner it
   * adds is one the account has recorded, and its signer is created there first. */
  async function ownerPlan(session: WalletCentralSession, enrollment: WalletEnrollment, home: Awaited<ReturnType<typeof homeOwners>>, deployed: number[], fresh: number[]) {
    const creation = enrollment.creation!, recoveryOwner = getAddress(enrollment.intent.recoveryOwner), account = getAddress(creation.address);
    const sources = [...fresh.map(chainId => ({ chainId, owners: creation.owners.map(owner => getAddress(owner)), threshold: BigInt(creation.threshold), nonce: 0n })),
      ...await Promise.all(deployed.map(async chainId => ({ chainId, ...await readWalletSafe({ account, chainId, rpc, now })
        .catch(() => { throw new RestError(503, "WALLET_NETWORKS_UNAVAILABLE", `${name(chainId)} could not be read. Try again shortly.`); }) })))];
    const differ = sources.filter(source => source.threshold !== 1n || home.threshold !== 1n || !sameSet(source.owners, home.owners));
    if (!differ.length) return null;
    if (!creation.owners.some(owner => includes(home.owners, owner))) ownersLost();
    if (home.threshold !== 1n || !includes(home.owners, recoveryOwner) || differ.some(source => source.threshold !== 1n || !includes(source.owners, recoveryOwner))) ownersChanged();
    const context = await options.authority.loadContext(session.accountId), manifest = enrollment.intent.manifest, profile = manifest.ownerProfile!;
    const passkeys = [{ signer: context.binding.state.ownerProfile!.signer.address, publicKey: context.credential.publicKey },
      ...(context.devices ?? []).map(device => ({ signer: device.device.signerAddress, publicKey: device.publicKey }))]
      .filter(passkey => same(predictPasskeySignerAddress({ manifest, publicKey: passkey.publicKey }), passkey.signer));
    // An owner the account has not recorded (an addition still being activated) is never copied anywhere.
    if (home.owners.some(owner => !same(owner, recoveryOwner) && !passkeys.some(passkey => same(passkey.signer, owner)))) ownersChanged();
    const changeId = randomUUID(), current = now(), chains: WalletNetworkOwners[] = [];
    for (const source of differ) {
      const review: WalletNetworkOwners = { version: "center-wallet-network-owners-v1", chainId: source.chainId, walletAddress: account, recoveryOwner,
        from: source.owners, owners: home.owners, safeNonce: source.nonce.toString(), steps: walletOwnerSteps(source.owners, home.owners),
        createSigners: passkeys.filter(passkey => !includes(source.owners, passkey.signer) && includes(home.owners, passkey.signer)).map(passkey => ({
          to: getAddress(profile.signerFactory.address), value: "0" as const, data: encodeFunctionData({ abi: factoryAbi, functionName: "createSigner",
            args: [BigInt(passkey.publicKey.x), BigInt(passkey.publicKey.y), BigInt(profile.p256Verifier.address)] }) })) };
      await store.recordOwnerChain({ changeId, kind: "network", accountId: session.accountId, chainId: source.chainId, state: "review", review, reason: null, now: current,
        target: { safeNonce: review.safeNonce, requires: source.owners, add: home.owners.filter(owner => !includes(source.owners, owner)),
          remove: source.owners.filter(owner => !includes(home.owners, owner)) } });
      chains.push(review);
    }
    return { changeId, recoveryOwner, chains };
  }
  /** Keeps the recovery owner's signature for every Safe owner call of an update, all or none, each recovered from
   * the SafeTx rebuilt from the stored update; then the owner-chains worker sends them once each chain exists. */
  async function approveOwners(session: WalletCentralSession, enrollment: WalletEnrollment, input: unknown) {
    const value = input as { changeId?: unknown; signatures?: unknown } | null;
    if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== "changeId,signatures" || typeof value.changeId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.changeId) || !Array.isArray(value.signatures)) invalid("Sign the owner update with your backup.");
    const rows = (await store.ownerChainRows(value.changeId)) as WalletOwnerChainRow<WalletNetworkOwners>[];
    if (!rows.length || rows.some(row => row.kind !== "network" || row.account_id !== session.accountId)) state();
    const open = rows.filter(row => row.state === "review");
    if (!open.length) return;
    const recoveryOwner = getAddress(enrollment.intent.recoveryOwner), signatures = value.signatures as unknown[];
    if (signatures.length !== open.length) backupInvalid();
    const approvals = await Promise.all(open.map(async row => {
      const review = row.review!, item = signatures.find(entry => (entry as { chainId?: unknown })?.chainId === review.chainId) as { chainId: number; signatures?: unknown } | undefined;
      if (!item || Object.keys(item).sort().join(",") !== "chainId,signatures" || !Array.isArray(item.signatures) || item.signatures.length !== review.steps.length
        || !same(review.recoveryOwner, recoveryOwner)) backupInvalid();
      const calls: WalletOwnerCall[] = [...review.createSigners];
      for (const [index, step] of review.steps.entries()) {
        let signature: Hex;
        try { signature = canonicalEoaSignature(item.signatures[index] as Hex); } catch { return backupInvalid(); }
        const hash = hashTypedData(walletOwnerChangeSafeTx(review.walletAddress, step, (BigInt(review.safeNonce) + BigInt(index)).toString(), review.chainId));
        if (!same(await recoverAddress({ hash, signature }).catch(() => zeroAddress), recoveryOwner)) backupInvalid();
        calls.push({ to: review.walletAddress, value: "0", data: encodeFunctionData({ abi: execAbi, functionName: "execTransaction",
          args: [review.walletAddress, 0n, step, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, signature] }) });
      }
      return { chainId: review.chainId, review, approval: { calls } };
    }));
    await store.approveOwnerChains(value.changeId, approvals, now());
  }
  /** The owners the quote was made against must still be Base's when it is paid. */
  async function assertExpectedOwners(bundle: WalletNetworkBundle, creation: NonNullable<WalletEnrollment["creation"]>) {
    const home = await homeOwners(getAddress(creation.address));
    if (home.threshold !== 1n || !sameSet(home.owners, bundle.expectedOwners ?? creation.owners))
      throw new RestError(409, "WALLET_NETWORKS_OWNERS_CHANGED", "This account's owners changed since the quote. Get a new quote.");
  }
  return {
    async list(session: WalletCentralSession) { await expireQuotes(session.accountId); return view(session.accountId, store, true, await enrollmentOf(session)); },
    /** Quotes one Relayr bundle for the chosen chains of one family; chains already holding the account are recorded, not quoted.
     * A chain that will not carry Base's owners gets an owner update, signed with the backup alongside the passkey approval. */
    async quote(session: WalletCentralSession, input: { chainIds: number[] }) {
      if (!input || !Array.isArray(input.chainIds) || input.chainIds.length > 8 || input.chainIds.some(id => !Number.isSafeInteger(id))) invalid("Choose networks.");
      const family = walletNetworkFamily(input.chainIds), networks = input.chainIds.map(chainId => networkById.get(chainId)!);
      if (networks.some(network => !network.offered)) invalid("That network is not offered yet.");
      if (networks.some(network => !network.centerPays)) throw new RestError(501, "WALLET_NETWORKS_PAYER_REQUIRED", "That network needs the account to pay; not available yet.");
      const enrollment = await enrollmentOf(session), creation = enrollment.creation!, address = creation.address;
      await expireQuotes(session.accountId, input.chainIds);
      const existing = await store.listNetworks(session.accountId);
      if (existing.some(row => input.chainIds.includes(row.chainId) && row.state !== "failed" && row.state !== "deployed")) state();
      if ((await store.ownerChainsUnderway(session.accountId)).some(chainId => input.chainIds.includes(chainId)))
        throw new RestError(409, "WALLET_NETWORKS_UPDATING", "That network is still being updated. Check it again shortly.");
      const funded = (await deployments(session.accountId)).filter(bundle => bundle.family === family && ["paying", "paid", "settled"].includes(bundle.state));
      // Every chosen chain is checked at once against one read of the Base stack; the first failure ends the quote.
      const [home, stack] = await Promise.all([homeOwners(getAddress(address)), homeStack(enrollment)]);
      const checked = await Promise.all(input.chainIds.map(async chainId => {
        if (await deployedOn(chainId, address)) return { chainId, deployed: true };
        await verifyDestination(chainId, enrollment, stack);
        return { chainId, deployed: false };
      }));
      const remaining: number[] = [];
      for (const { chainId, deployed } of checked) {
        if (deployed) await store.upsertNetwork(session.accountId, { chainId, state: "deployed", bundleId: null, txHash: null }, now());
        else remaining.push(chainId);
      }
      if (remaining.length && funded.length >= maximumBundles) throw new RestError(429, "WALLET_NETWORKS_LIMIT", "This account has used its network deployments for now.");
      const entries = remaining.length ? walletNetworkEntries(creation, remaining) : [];
      const owners = await ownerPlan(session, enrollment, home, checked.filter(item => item.deployed).map(item => item.chainId), entries.map(entry => entry.chain));
      if (!remaining.length) return { bundle: null, challenge: null, owners, view: await view(session.accountId, store, true, enrollment) };
      const { quote, payment } = await relayQuote(entries, networks[0]!.paymentChainId, family);
      const issuedAtMs = now(), expiresAtMs = Math.min(issuedAtMs + approvalWindowMs, Number(payment.deadline) * 1000 - 60_000);
      if (expiresAtMs <= issuedAtMs) throw new RestError(502, "WALLET_NETWORKS_QUOTE_UNSUPPORTED", "The quote expires too soon to approve.");
      const chainIds = entries.map(entry => entry.chain);
      const document: WalletNetworksDocumentInput = { accountId: session.accountId, walletAddress: address, bundleUuid: quote.bundleUuid, chainIds,
        factory: creation.transaction.to, calldataHash: keccak256(creation.transaction.data), payment: { chainId: payment.chainId, to: payment.to, value: payment.value, deadline: payment.deadline },
        rpId: session.rpId, origin: enrollment.intent.origin, nonce: keccak256(toHex(randomUUID())), issuedAtMs, expiresAtMs };
      const bundle: WalletNetworkBundle = { id: randomUUID(), accountId: session.accountId, family, chainIds, state: "quoted", centerPays: true,
        expectedOwners: home.owners, ...(owners ? { ownerChangeId: owners.changeId } : {}),
        quote, bound: false, payment, document, paymentTx: null, createdAtMs: issuedAtMs, updatedAtMs: issuedAtMs };
      await store.createBundle(bundle, issuedAtMs);
      // The chain rows are taken atomically per chain; a parallel quote for the same chain loses here.
      if (await store.claimNetworks(session.accountId, chainIds, bundle.id, issuedAtMs) !== chainIds.length) { await fail(bundle, "quoted"); state(); }
      return { bundle: publicBundle(bundle), challenge: hashTypedData(walletNetworksDocument(document)), owners, view: await view(session.accountId, store, true, enrollment) };
    },
    /** The passkey approves the exact quoted bundle and the backup signs its owner update; Center's payer then funds it with
     * one simulated, capped transaction. The owner update is kept before anything is paid. */
    async approve(session: WalletCentralSession, input: { bundleId: string; assertion: WalletAssertion; owners?: unknown }) {
      if (!input || typeof input.bundleId !== "string") invalid("Choose the quoted bundle.");
      const bundleId = input.bundleId, bundle = await store.getBundle(session.accountId, bundleId);
      if (!bundle?.document) state();
      if (bundle.state !== "quoted") return { bundle: publicBundle(bundle), replayed: bundle.state !== "failed", view: await view(session.accountId, store, false) };
      if (now() >= bundle.document.expiresAtMs) { await fail(bundle, "quoted"); throw new RestError(410, "WALLET_NETWORKS_EXPIRED", "The quote expired. Get a new quote."); }
      const rows = await store.listNetworks(session.accountId);
      if (bundle.chainIds.some(chainId => !rows.some(row => row.chainId === chainId && row.bundleId === bundle.id && row.state === "quoted"))) state();
      const context = await options.authority.loadContext(session.accountId), credential = context.credential;
      if (credential.credentialId !== session.credentialId) state();
      try {
        verifyWalletAssertion(input.assertion, { purpose: "networks", challenge: hashTypedData(walletNetworksDocument(bundle.document)),
          rpId: bundle.document.rpId, origin: bundle.document.origin, requireUserHandle: true,
          credential: { id: credential.credentialId, userHandle: credential.userHandle, publicKey: credential.publicKey, backupEligible: credential.backupEligible } });
      } catch (error) {
        if (error instanceof WalletAssertionError) throw new RestError(403, "WALLET_NETWORKS_PROOF_INVALID", "The passkey approval does not match this quote.");
        throw error;
      }
      if (!options.payer) throw new RestError(503, "WALLET_NETWORKS_UNAVAILABLE", "Network deployment funding is not configured.");
      const enrollment = await enrollmentOf(session);
      await assertExpectedOwners(bundle, enrollment.creation!);
      // A new chain never starts paid for without the update that brings it to Base's owners.
      if (bundle.ownerChangeId) {
        if (!input.owners || (input.owners as { changeId?: unknown }).changeId !== bundle.ownerChangeId) invalid("Sign the owner update with your backup.");
        await approveOwners(session, enrollment, input.owners);
      }
      return store.withPayer(bundle.payment.chainId, options.payer.address, async funding => {
        // A previous request may have completed while this one verified the passkey.
        const bundle = await funding.getBundle(session.accountId, bundleId);
        if (!bundle?.document) state();
        if (bundle.state !== "quoted") return { bundle: publicBundle(bundle), replayed: bundle.state !== "failed", view: await view(session.accountId, funding, false) };
        if (now() >= bundle.document.expiresAtMs) { await fail(bundle, "quoted", funding); throw new RestError(410, "WALLET_NETWORKS_EXPIRED", "The quote expired. Get a new quote."); }
        if (!await pay(bundle, funding)) { const current = (await funding.getBundle(session.accountId, bundle.id))!; return { bundle: publicBundle(current), replayed: true, view: await view(session.accountId, funding, false) }; }
        return { bundle: publicBundle(bundle), replayed: false, view: await view(session.accountId, funding, false) };
      });
    },
    /** The backup's signatures for an update of networks the account is already on; nothing to pay up front. */
    async approveOwners(session: WalletCentralSession, input: unknown) {
      const enrollment = await enrollmentOf(session);
      await approveOwners(session, enrollment, input);
      return view(session.accountId, store, true, enrollment);
    },
    /** Rebroadcasts a signed payment the chain has not seen, then reads the payment receipt, Relayr and code per chain. */
    async status(session: WalletCentralSession) {
      await expireQuotes(session.accountId);
      for (const bundle of await deployments(session.accountId)) {
        const observed = await relayed(bundle);
        if (!observed) continue;
        let settled = true;
        // One read per chain, all at once; the rows are then settled in Relayr's order.
        const deployedFlags = await Promise.all(bundle.quote.entries.map(entry => deployedOn(entry.entry.chain, bundle.document.walletAddress)));
        for (const [index, entry] of bundle.quote.entries.entries()) {
          // The parser lists rows in Relayr's order and names the quote step on each.
          const chainId = entry.entry.chain, item = observed.find(row => row.step === index), current = now();
          if (deployedFlags[index]) { await store.upsertNetwork(session.accountId, { chainId, state: "deployed", bundleId: bundle.id, txHash: item?.hash ?? null }, current); continue; }
          if (item && relayFailed.test(item.providerState)) { await store.upsertNetwork(session.accountId, { chainId, state: "failed", bundleId: bundle.id, txHash: item.hash ?? null }, current); continue; }
          settled = false;
        }
        if (settled) { bundle.state = "settled"; await store.transitionBundle(bundle, "paid", now()); }
      }
      return view(session.accountId, store, true, await enrollmentOf(session));
    },
    /** Quotes one bundle for an owner change's reviewed calls on chains of one family. Nothing is paid yet: the
     * caller records the bundle first, then funds it, so a crash never leaves a payment it does not know about. */
    async quoteOwnerCalls(input: { accountId: string; changeId: string; calls: { chainId: number; to: Address; data: Hex }[] }): Promise<string> {
      if (!options.payer) throw new RestError(503, "WALLET_NETWORKS_UNAVAILABLE", "Network funding is not configured.");
      const chainIds = [...new Set(input.calls.map(call => call.chainId))].sort((a, b) => a - b), family = walletNetworkFamily(chainIds);
      if (chainIds.some(chainId => !networkById.get(chainId)!.centerPays)) throw new RestError(501, "WALLET_NETWORKS_PAYER_REQUIRED", "That network needs the account to pay; not available yet.");
      const entries = input.calls.map(call => ({ chain: call.chainId, target: getAddress(call.to), data: call.data, value: "0" }));
      const { quote, payment } = await relayQuote(entries, networkById.get(chainIds[0]!)!.paymentChainId, family), current = now();
      const bundle: WalletNetworkBundle = { id: randomUUID(), accountId: input.accountId, family, chainIds, state: "quoted", centerPays: true,
        purpose: "owners", changeId: input.changeId, quote, bound: false, payment, document: null, paymentTx: null, createdAtMs: current, updatedAtMs: current };
      await store.createBundle(bundle, current);
      return bundle.id;
    },
    /** Funds a quoted owner-change bundle; one that cannot be paid in time fails instead and is quoted again by the caller. */
    async payOwnerCalls(accountId: string, bundleId: string): Promise<void> {
      if (!options.payer) throw new RestError(503, "WALLET_NETWORKS_UNAVAILABLE", "Network funding is not configured.");
      const quoted = await store.getBundle(accountId, bundleId);
      if (quoted?.purpose !== "owners") state();
      await store.withPayer(quoted.payment.chainId, options.payer.address, async funding => {
        const bundle = (await funding.getBundle(accountId, bundleId))!;
        if (bundle.state !== "quoted") return;
        // A payment signed this close to its deadline might never be sent and would hold the payer's nonce.
        if (now() >= Number(bundle.payment.deadline) * 1000 - 60_000) { await fail(bundle, "quoted", funding); return; }
        await pay(bundle, funding);
      });
    },
    /** An owner-change bundle's progress, whether a payment was ever signed for it, and the chains Relayr reports will not run. */
    async ownerCallsStatus(accountId: string, bundleId: string): Promise<{ state: WalletNetworkBundleState; paid: boolean; failed: number[] }> {
      const bundle = await store.getBundle(accountId, bundleId);
      if (bundle?.purpose !== "owners") state();
      const observed = await relayed(bundle);
      const failed = (observed ?? []).filter(item => relayFailed.test(item.providerState)).map(item => bundle.quote.entries[item.step]!.entry.chain);
      return { state: bundle.state, paid: bundle.paymentTx !== null, failed: [...new Set(failed)] };
    },
  };
  /** A funded bundle's progress: rebroadcasts a payment the chain has not seen, fails a reverted payment,
   * then reads Relayr's rows, binding its identifiers on the first read. Null while unpaid or failed. */
  async function relayed(bundle: WalletNetworkBundle) {
    if (bundle.state === "paying") await broadcast(bundle);
    if (bundle.state !== "paid") return null;
    const receipt = await rpc.request(bundle.payment.chainId, "eth_getTransactionReceipt", [bundle.paymentTx!.hash]).catch(() => null);
    if (isObject(receipt) && quantity(receipt.status, "payment status") === 0n) { await fail(bundle, "paid"); return null; }
    let observed: { step: number; providerState: string; hash?: Hex }[] = [];
    try {
      const raw = await provider.status(bundle.quote.bundleUuid);
      if (!bundle.bound) { bundle.quote = bindIndependentQuoteStatus(raw, bundle.quote); bundle.bound = true; await store.transitionBundle(bundle, "paid", now()); }
      observed = parseIndependentStatus(raw, bundle.quote);
    } catch { /* The next read tries again; the chain is the proof either way. */ }
    return observed;
  }
  /** One Relayr quote for exact calls on one family, payable on its funding chain within Center's cap and with time left to approve it. */
  async function relayQuote(entries: RelayrIndependentEntry[], paymentChainId: number, family: WalletNetworkFamily) {
    const quote = parseIndependentQuoteBinding(await provider.createIndependent(entries), entries, now()), payment = quote.payments.find(item => item.chainId === paymentChainId);
    if (!payment) throw new RestError(502, "WALLET_NETWORKS_QUOTE_UNSUPPORTED", "The execution service offered no payment on the funding chain.");
    try { assertPaymentEligible(payment, now(), maximumPayment[family]); }
    catch { throw new RestError(502, "WALLET_NETWORKS_QUOTE_UNSUPPORTED", "The quote exceeds what Center covers, or expires too soon."); }
    return { quote, payment };
  }
  /** Center's payer funds one quoted bundle with one simulated, capped transaction, under the payer lock.
   * False when another request moved the bundle first. */
  async function pay(bundle: WalletNetworkBundle, funding: WalletNetworksStore): Promise<boolean> {
    const payment = bundle.payment, chainId = payment.chainId, payer = options.payer!.address, value = BigInt(payment.value);
    if (value > maximumPayment[bundle.family]) throw new RestError(502, "WALLET_NETWORKS_QUOTE_UNSUPPORTED", "The quote exceeds what Center covers.");
    const call = { from: payer, to: payment.to, data: payment.data, value: toHex(value) };
    const [block, nonce, balance, code, estimate] = await Promise.all([
      rpc.request(chainId, "eth_getBlockByNumber", ["latest", false]), rpc.request(chainId, "eth_getTransactionCount", [payer, "pending"]),
      rpc.request(chainId, "eth_getBalance", [payer, "latest"]), rpc.request(chainId, "eth_getCode", [payment.to, "latest"]),
      rpc.request(chainId, "eth_estimateGas", [call, "latest"]).catch(() => { throw new RestError(502, "WALLET_NETWORKS_QUOTE_UNSUPPORTED", "The payment would not go through right now."); })]);
    // Only the reviewed prepayment contract receives funds; a different runtime at that address gets nothing.
    if (keccak256(hexBytes(code)).toLowerCase() !== RELAYR_PAYMENT_CODE_HASH.toLowerCase()) throw new RestError(502, "WALLET_NETWORKS_PAYMENT_RUNTIME", "The payment contract differs from the reviewed one.");
    if (quantity(estimate, "payment gas") > RELAYR_PAYMENT_GAS) throw new RestError(502, "WALLET_NETWORKS_QUOTE_UNSUPPORTED", "The payment needs more gas than allowed.");
    const baseFee = quantity((block as { baseFeePerGas?: unknown })?.baseFeePerGas, "base fee"), priority = WALLET_NETWORKS_PRIORITY_FEE_PER_GAS;
    const maxFee = 2n * baseFee + priority;
    if (maxFee > WALLET_NETWORKS_MAXIMUM_FEE_PER_GAS) throw new RestError(503, "WALLET_NETWORKS_UNAVAILABLE", "Network fees are too high right now. Try again later.");
    if (quantity(balance, "payer balance") < value + RELAYR_PAYMENT_GAS * maxFee) throw new RestError(503, "WALLET_NETWORKS_UNFUNDED", "Network deployment funding is short right now. Try again later.");
    const payerNonce = Number(quantity(nonce, "payer nonce"));
    if (!Number.isSafeInteger(payerNonce)) throw new RestError(502, "WALLET_NETWORKS_RPC_INVALID", "Invalid payer nonce.");
    await funding.assertPayerNonceAvailable(chainId, payer, payerNonce);
    const transaction: TransactionSerializableEIP1559 = { type: "eip1559", chainId, nonce: payerNonce, to: payment.to, data: payment.data,
      value, gas: RELAYR_PAYMENT_GAS, maxFeePerGas: maxFee, maxPriorityFeePerGas: priority, accessList: [] };
    const raw = await options.payer!.signTransaction(transaction), hash = keccak256(raw);
    bundle.state = "paying"; bundle.paymentTx = { hash, raw, nonce: payerNonce, sentAtMs: null };
    // The signed bytes are on record before they leave; a concurrent approval of the same bundle loses here and signs nothing that is sent.
    if (!await funding.transitionBundle(bundle, "quoted", now())) return false;
    await broadcast(bundle, funding);
    return true;
  }
  /** Sends the signed payment and decides by what the chain reports, never by an error message. */
  async function broadcast(bundle: WalletNetworkBundle, source = store) {
    const tx = bundle.paymentTx!, chainId = bundle.payment.chainId;
    const seen = async () => {
      const known = await rpc.request(chainId, "eth_getTransactionByHash", [tx.hash]).catch(() => null);
      return isObject(known) && typeof known.hash === "string" && same(known.hash, tx.hash);
    };
    if (!await seen()) {
      // A lost response can hide a payment already included before its deadline. Keep its
      // signed bytes and chain reservations; neither expiry nor another transaction is proof.
      if (now() >= Number(bundle.payment.deadline) * 1000) return;
      try { await rpc.request(chainId, "eth_sendRawTransaction", [tx.raw]); } catch { /* Decided below by the chain's own view. */ }
      if (!await seen()) return;
    }
    const current = now();
    bundle.state = "paid"; bundle.paymentTx = { ...tx, sentAtMs: tx.sentAtMs ?? current };
    if (!await source.transitionBundle(bundle, "paying", current) || bundle.purpose) return;
    for (const chainId of bundle.chainIds) await source.upsertNetwork(bundle.accountId, { chainId, state: "pending", bundleId: bundle.id, txHash: null }, current);
  }
  function publicBundle(bundle: WalletNetworkBundle) {
    return { id: bundle.id, family: bundle.family, chainIds: bundle.chainIds, state: bundle.state, centerPays: bundle.centerPays,
      payment: { chainId: bundle.payment.chainId, value: bundle.payment.value, deadline: bundle.payment.deadline, hash: bundle.paymentTx?.hash ?? null },
      expiresAtMs: bundle.document!.expiresAtMs, networks: bundle.chainIds.map(chainId => ({ chainId, name: name(chainId) })) };
  }
}
