import { getAddress, hashTypedData, type Address, type Hex } from 'viem';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { RestError } from '../core.js';
import { validateAudience } from '../auth/signatures.js';
import { stable } from '../smartAccounts/service.js';
import { enrollmentDigest } from './enrollment.js';
import { walletDeviceAdditionDocument, walletDeviceDocument, type WalletDeviceAddition } from './deviceAddition.js';
import type { WalletCredentialDevice } from './devices.js';
import type { PostgresWalletDeviceStore, WalletDeviceRecord } from './devicesPostgres.js';
import type { createWalletDeviceRelay } from './deviceRelay.js';
import type { createSmartAccountService } from '../smartAccounts/service.js';
import type { PostgresWalletAuthorityStore } from './authorityPostgres.js';
import type { WalletRegistrationResponse } from './registration.js';
import type { WalletAssertion } from './webauthn.js';
import { copyWalletSignupAssertion } from './signupPostgres.js';
import type { WalletCentralSession } from './login.js';

export type WalletDevicePhase = 'awaiting_registration' | 'awaiting_possession' | 'awaiting_approval' | 'adding' | 'addition_failed' | 'awaiting_activation' | 'ready' | 'expired';
/** What either page sees. The link is only ever handed to the primary's page once, at begin. */
export interface WalletDeviceView {
  id: string; passkeyName: string | null; rpId: string; origin: string; expiresAtMs: number; walletAddress: Address; primarySigner: Address;
  deviceSigner: Address | null; phase: WalletDevicePhase; transactionHashes: Hex[];
  /** `excludeCredentialIds` are the account's passkeys: they share this user handle, so a passkey
   * manager that already holds one would otherwise replace it with the new device's passkey. */
  registration: { challenge: string; userHandle: string; excludeCredentialIds: string[] } | null;
  possession: { credentialId: string; document: ReturnType<typeof walletDeviceDocument>; challenge: Hex } | null;
}
export interface LocalWalletDeviceDependencies {
  audience: string; devices: PostgresWalletDeviceStore; addition: ReturnType<typeof createWalletDeviceRelay>;
  smart: ReturnType<typeof createSmartAccountService>; authority: PostgresWalletAuthorityStore;
  /** With it, the added device is signed in from its possession proof once the addition is done (see `sessionForLink`). */
  login?: { completeFromDevice(input: { record: WalletDeviceRecord; assertion: WalletAssertion }): Promise<{ session: unknown; sessionToken: string }> };
  onEvent?: (event: { stage: 'addition' | 'activation'; outcome: string; deviceId: string }) => void;
}
function state(): never { throw new RestError(409, 'WALLET_DEVICE_STATE', 'Check the device addition and complete its current step.'); }
function unauthorized(): never { throw new RestError(403, 'WALLET_DEVICE_UNAUTHORIZED', 'This device addition belongs to another account or session.'); }

/** Explicit host composition for adding a device. The primary's session begins and approves; the
 * new device registers and proves by link; either page may drive activation once the owner
 * addition is canonical. Neither the link nor a session is transaction authority. */
export function createLocalWalletDevices(options: LocalWalletDeviceDependencies) {
  const { devices, addition, smart, authority } = options, audience = validateAudience(options.audience);
  const event = (value: Parameters<NonNullable<LocalWalletDeviceDependencies['onEvent']>>[0]) => { try { options.onEvent?.(value); } catch { /* observation only */ } };
  // Worker state sits ahead of the returned object: the runtime calls start() right after creation.
  let stopped = false, timer: ReturnType<typeof setTimeout> | null = null, running: Promise<void> | null = null;
  const controller = new AbortController();
  async function accountCredentialIds(accountId: string) {
    const context = await authority.loadContext(accountId);
    return [context.credential.credentialId, ...(context.devices ?? []).map(device => device.credentialId)];
  }
  async function view(record: WalletDeviceRecord): Promise<WalletDeviceView> {
    const { intent, candidate, proof, activation } = record;
    let phase: WalletDevicePhase, transactionHashes: Hex[] = [];
    if (activation) phase = 'ready';
    else if (!proof) phase = intent.expiresAtMs <= Date.now() ? 'expired' : candidate ? 'awaiting_possession' : 'awaiting_registration';
    else {
      const observed = await addition.status(intent.id);
      transactionHashes = Object.values(observed.transactions).filter((value): value is Hex => value !== null);
      phase = observed.state === 'review' ? 'awaiting_approval' : observed.state === 'ready' ? 'awaiting_activation' : observed.state === 'failed' ? 'addition_failed' : 'adding';
    }
    return { id: intent.id, passkeyName: record.passkeyName, rpId: intent.rpId, origin: intent.origin, expiresAtMs: intent.expiresAtMs,
      walletAddress: getAddress(intent.accountId.slice(12)), primarySigner: intent.primarySigner, deviceSigner: candidate?.signerAddress ?? null, phase, transactionHashes,
      registration: phase === 'awaiting_registration' ? { challenge: intent.registration.challenge, userHandle: intent.userHandle, excludeCredentialIds: await accountCredentialIds(intent.accountId) } : null,
      possession: phase === 'awaiting_possession' ? { credentialId: candidate!.credential.credentialId, document: walletDeviceDocument(candidate!), challenge: hashTypedData(walletDeviceDocument(candidate!)) } : null };
  }
  const owned = async (id: string, session: WalletCentralSession) => (await devices.get(id, session.accountId)) ?? unauthorized();
  const linked = async (linkToken: string) => (await devices.getByToken(linkToken)) ?? unauthorized();
  const proofs = new Map<string, { assertion: WalletAssertion; at: number; claim: string }>();
  return {
    /** Primary: start, and hand the page the one-time link for the other device. */
    async begin(session: WalletCentralSession, input: { passkeyName?: string } = {}) {
      const begun = await devices.begin({ accountId: session.accountId, id: session.id, credentialId: session.credentialId }, input);
      return { linkToken: begun.linkToken, view: await view(begun.record) };
    },
    async statusForSession(id: string, session: WalletCentralSession) { return view(await owned(id, session)); },
    async statusForLink(linkToken: string) { return view(await linked(linkToken)); },
    /** New device: its passkey, then its possession proof. */
    async register(linkToken: string, input: WalletRegistrationResponse, options: { passkeyName?: string } = {}) { return view(await devices.register(linkToken, input, options)); },
    async prove(linkToken: string, input: WalletAssertion) {
      const proved = await devices.prove(linkToken, input);
      if (proved.replayed) return { view: await view(proved.record), sessionClaim: null };
      // The possession assertion is held for the device's session (in memory, this process, ≤ 15 min,
      // once) behind a claim handed only to the page that proved: the link itself is a shown bearer
      // (a QR on the primary's screen) and must not become a session on its own.
      for (const [id, held] of proofs) if (Date.now() - held.at > 900_000) proofs.delete(id);
      if (proofs.size >= 256) proofs.delete(proofs.keys().next().value!);
      const sessionClaim = randomBytes(32).toString('base64url');
      proofs.set(proved.record.intent.id, { assertion: copyWalletSignupAssertion(input), at: Date.now(), claim: sessionClaim });
      return { view: await view(proved.record), sessionClaim };
    },
    /** The added device's session from the possession proof this process verified: once the primary
     * approved and the addition is active, the device is signed in without another prompt. The store
     * re-verifies the assertion against the recorded proof; a restarted process, or anything older
     * than 15 minutes, gets the ordinary sign-in instead. */
    async sessionForLink(linkToken: string, claim: string) {
      const record = await linked(linkToken), held = proofs.get(record.intent.id);
      if (!options.login || !held || Date.now() - held.at > 900_000 || !record.activation) state();
      if (typeof claim !== 'string' || claim.length !== held.claim.length || !timingSafeEqual(Buffer.from(claim), Buffer.from(held.claim))) unauthorized();
      proofs.delete(record.intent.id);
      const result = await options.login.completeFromDevice({ record, assertion: held.assertion });
      event({ stage: 'activation', outcome: 'session', deviceId: record.intent.id });
      return result;
    },
    /** Primary: the exact addition to sign, then the signed approval. */
    async prepareAddition(id: string, session: WalletCentralSession) {
      const record = await owned(id, session);
      if (!record.proof || record.activation || record.sessionId !== session.id) state();
      const review = await addition.prepare(record.intent.id);
      return { review, document: walletDeviceAdditionDocument(review), challenge: hashTypedData(walletDeviceAdditionDocument(review)) };
    },
    async approveAddition(id: string, session: WalletCentralSession, input: { review: WalletDeviceAddition; assertion: WalletAssertion }) {
      const record = await owned(id, session);
      if (!record.proof || record.sessionId !== session.id) state();
      if (record.activation) return view(record);
      const context = await authority.loadContext(session.accountId);
      if (context.credential.credentialId !== session.credentialId) unauthorized();
      const primary = { credentialId: context.credential.credentialId, userHandle: context.credential.userHandle,
        publicKey: context.credential.publicKey, backupEligible: context.credential.backupEligible };
      await addition.approve(record.intent.id, input.review, { assertion: input.assertion, primary }, session.id);
      event({ stage: 'addition', outcome: 'approved', deviceId: record.intent.id });
      return view(record);
    },
    /** Either page, once the owner addition is canonical: rebind the account with the device as an
     * owner, then record the device passkey. Idempotent across lost replies. */
    async activate(record: WalletDeviceRecord) {
      const candidate = record.candidate;
      if (!candidate || !record.proof) state();
      if (record.activation) return view(record);
      const observed = await addition.status(record.intent.id, 5000);
      if (observed.state !== 'ready') state();
      const bindingDigest = `0x${enrollmentDigest({ device: record.intent.id, proof: record.proof.verificationDigest, transaction: observed.transactions.ownerChange })}` as Hex;
      await smart.bindPasskeyAccount({ manifestId: record.intent.manifest.id, address: record.intent.accountId.slice(12) as Address,
        consent: { id: record.intent.id, digest: bindingDigest },
        expected: { signerAddress: record.intent.primarySigner, initializerHash: record.intent.initializerHash,
          deviceSigners: [...record.intent.existingSigners, candidate.signerAddress] } });
      const context = await authority.loadContextRaw(record.intent.accountId);
      // Database time, like the proof's verifiedAtMs and recovery's acceptedAtMs, so consent ordering never depends on the app clock.
      const anchor = context.binding.state.evidence, now = await devices.now();
      const receipt: WalletCredentialDevice = { version: 'center-wallet-device-v1', id: record.intent.id, accountId: record.intent.accountId,
        enrollmentId: record.intent.enrollmentId, rpId: record.intent.rpId, origin: record.intent.origin, credential: candidate.credential,
        signerAddress: candidate.signerAddress.toLowerCase() as Address, approvalDigest: `0x${record.proof.verificationDigest}` as Hex,
        transactionHash: observed.transactions.ownerChange!, anchor, bindingDigest, verifiedAtMs: record.proof.verifiedAtMs, acceptedAtMs: now };
      await devices.activate(record.intent.id, receipt);
      event({ stage: 'activation', outcome: 'committed', deviceId: record.intent.id });
      return view({ ...record, activation: receipt });
    },
    async activateForSession(id: string, session: WalletCentralSession) { return this.activate(await owned(id, session)); },
    async activateForLink(linkToken: string) { return this.activate(await linked(linkToken)); },
    tick, start, stop, audience, stable,
  };
  function tick(signal?: AbortSignal) { return addition.tick(signal); }
  /** One bounded relay pass per second while an addition is active, like recovery. */
  function start() {
    if (stopped || timer) return;
    const pass = async () => {
      try { await (running ??= addition.tick(controller.signal).finally(() => { running = null; })); } catch { /* durable attempts reconcile later */ }
      if (!stopped) timer = setTimeout(() => { void pass(); }, 1000);
    };
    timer = setTimeout(() => { void pass(); }, 0);
  }
  async function stop() { stopped = true; controller.abort(); if (timer) clearTimeout(timer); await running?.catch(() => {}); }
}
