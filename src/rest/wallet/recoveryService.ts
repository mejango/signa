import { getAddress, hashTypedData, isAddress, type Address, type Hex } from 'viem';
import { RestError } from '../core.js';
import { validateAudience } from '../auth/signatures.js';
import { enrollmentDigest } from './enrollment.js';
import { walletRecoveryDocument } from './recovery.js';
import { walletRecoveryRotationDocument } from './recoveryRotation.js';
import type { PostgresWalletRecoveryStore } from './recoveryPostgres.js';
import type { PostgresWalletRecoveryFlowStore } from './recoveryFlowPostgres.js';
import type { createLocalAnvilWalletRecovery } from './recoveryLocalAnvil.js';
import type { createSmartAccountService } from '../smartAccounts/service.js';
import type { createWalletAuthorityService } from './authorityService.js';
import type { WalletRegistrationResponse } from './registration.js';
import type { WalletAssertion } from './webauthn.js';
import type { createWalletRecoveryChains, WalletRecoveryChain } from './recoveryChains.js';

export type WalletRecoveryPhase = 'awaiting_registration' | 'awaiting_possession' | 'awaiting_rotation_approval'
  | 'rotating' | 'rotation_failed' | 'awaiting_activation' | 'preparing_sign_in' | 'ready_to_sign_in' | 'expired';
export interface WalletRecoveryView {
  id: string; passkeyName: string; rpId: string; origin: string; audience: string; expiresAtMs: number; proofExpiresAtMs: number;
  walletAddress: Address; recoveryOwner: Address; initializerHash: Hex; priorSigner: Address; replacementSigner: Address | null;
  phase: WalletRecoveryPhase; candidateDigest: string | null;
  rotationContext: { publicKey: { x: Hex; y: Hex }; signerFactory: Address; verifiers: Hex } | null;
  registration: { challenge: string; userHandle: string } | null;
  possession: { credentialId: string; document: ReturnType<typeof walletRecoveryDocument>; challenge: Hex } | null;
  transactionHashes: Hex[];
  /** The account's other chains and how far each is with the same replacement. */
  chains: WalletRecoveryChain[];
}
export interface LocalWalletRecoveryDependencies {
  audience: string;
  recoveries: PostgresWalletRecoveryStore; flows: PostgresWalletRecoveryFlowStore;
  rotation: ReturnType<typeof createLocalAnvilWalletRecovery>;
  smart: ReturnType<typeof createSmartAccountService>; authority: ReturnType<typeof createWalletAuthorityService>;
  /** The same replacement on every other chain the account is deployed on. */
  chains?: ReturnType<typeof createWalletRecoveryChains>;
  onEvent?: (event: { stage: 'rotation' | 'setup' | 'activation'; outcome: string; recoveryId: string }) => void;
}
function state(): never { throw new RestError(409, 'WALLET_RECOVERY_STATE', 'Check the original recovery and complete its current step.'); }
function unauthorized(): never { throw new RestError(403, 'WALLET_RECOVERY_UNAUTHORIZED', 'Resume the original recovery with both owners.'); }
function fields(value: unknown, names: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).length !== names.length
    || names.some(key => !Object.hasOwn(value, key) || !('value' in Object.getOwnPropertyDescriptor(value, key)!))) state();
}

/** Explicit local-host composition. Neither a locator, continuation nor proof receipt is
 * transaction authority. Rotation dispatch retains its independent exact owner approval,
 * local chain capability and durable fee reservations. A fresh W6 login remains separate. */
export function createLocalWalletRecovery(options: LocalWalletRecoveryDependencies) {
  const { recoveries, flows, rotation, smart, authority } = options;
  const audience = validateAudience(options.audience);
  const event = (value: Parameters<NonNullable<LocalWalletRecoveryDependencies['onEvent']>>[0]) => {
    try { options.onEvent?.(value); } catch { /* Observation is not authority. */ }
  };
  async function context(flowToken: string) {
    const flow = await flows.authenticate(flowToken);
    if (!flow) unauthorized();
    const record = await recoveries.get(flow.id, flowToken);
    if (!record) unauthorized();
    return { flow, record };
  }
  async function status(flowToken: string): Promise<WalletRecoveryView> {
    const { flow, record } = await context(flowToken), { intent, candidate, proof, activation } = record;
    let phase: WalletRecoveryPhase;
    let transactionHashes: Hex[] = [];
    if (activation) {
      // Old completed recovery continuations cannot claim to be the current identity.
      if (!await recoveries.isCurrentActivation(intent.id, flowToken)) state();
      // Login needs the worker's verified observation of the replaced owner (~25 s hosted); the
      // page polls the "preparing" phase and the site asks the worker for it.
      const current = await authority.currentAuthority(intent.accountId);
      phase = current?.readiness === 'verified' && !current.bootstrapRequired ? 'ready_to_sign_in' : 'preparing_sign_in';
    } else if (!proof) {
      phase = intent.expiresAtMs <= Date.now() ? 'expired' : candidate ? 'awaiting_possession' : 'awaiting_registration';
    } else {
      const observed = await rotation.status(intent.id);
      transactionHashes = Object.values(observed.transactions).filter((value): value is Hex => value !== null);
      phase = observed.state === 'review' ? 'awaiting_rotation_approval' : observed.state === 'ready' ? 'awaiting_activation'
        : observed.state === 'failed' ? 'rotation_failed' : 'rotating';
    }
    return { id: intent.id, passkeyName: flow.passkeyName, rpId: intent.rpId, origin: intent.origin, audience,
      expiresAtMs: flow.expiresAtMs, proofExpiresAtMs: intent.expiresAtMs, walletAddress: getAddress(intent.accountId.slice(12)),
      recoveryOwner: intent.recoveryOwner, initializerHash: intent.initializerHash, priorSigner: intent.priorSigner,
      replacementSigner: candidate?.signerAddress ?? null, phase, transactionHashes, chains: await options.chains?.status(intent.id) ?? [],
      candidateDigest: candidate ? enrollmentDigest(candidate) : null,
      rotationContext: candidate ? { publicKey: candidate.credential.publicKey, signerFactory: intent.manifest.ownerProfile!.signerFactory.address,
        verifiers: intent.manifest.ownerProfile!.p256Verifier.address } : null,
      registration: phase === 'awaiting_registration' ? { challenge: intent.registration.challenge, userHandle: intent.userHandle } : null,
      possession: phase === 'awaiting_possession' ? { credentialId: candidate!.credential.credentialId,
        document: walletRecoveryDocument(candidate!), challenge: hashTypedData(walletRecoveryDocument(candidate!)) } : null };
  }
  async function begin(input: { walletAddress: Address; passkeyName: string }) {
    fields(input, ['walletAddress', 'passkeyName']);
    if (!isAddress(input.walletAddress) || BigInt(input.walletAddress) <= 1n || typeof input.passkeyName !== 'string'
      || !input.passkeyName.length || input.passkeyName !== input.passkeyName.trim() || Buffer.byteLength(input.passkeyName) > 120
      || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(input.passkeyName)) state();
    const begun = await recoveries.begin('eip155:8453:' + input.walletAddress.toLowerCase());
    await flows.initialize({ recoveryId: begun.record.intent.id, flowToken: begun.flowToken, passkeyName: input.passkeyName });
    return { flowToken: begun.flowToken, view: await status(begun.flowToken) };
  }
  async function register(flowToken: string, input: WalletRegistrationResponse) {
    const { record } = await context(flowToken);
    await recoveries.register(record.intent.id, flowToken, input); return status(flowToken);
  }
  async function prove(flowToken: string, input: { assertion: WalletAssertion; backupSignature: Hex }) {
    const { record } = await context(flowToken);
    await recoveries.prove(record.intent.id, flowToken, input); return status(flowToken);
  }
  /** After activation only the other chains can still need the swap: one that failed, or one reached since the review. */
  async function activeChains(flowToken: string) {
    const { record } = await context(flowToken);
    if (!record.activation) return null;
    if (!options.chains || !await recoveries.isCurrentActivation(record.intent.id, flowToken)) state();
    return { record, chains: options.chains };
  }
  async function prepareRotation(flowToken: string) {
    const active = await activeChains(flowToken);
    if (active) return { review: null, document: null,
      chains: (await active.chains.prepare(active.record.candidate!)).map(item => ({ review: item, document: walletRecoveryRotationDocument(item) })) };
    const { record } = await context(flowToken);
    if (!record.proof) state();
    const review = await rotation.prepare(record.intent.id), chains = await options.chains?.prepare(record.candidate!) ?? [];
    // One review: Base's swap and the same swap on each other chain, each signed by the backup key in the same approval.
    return { review, document: walletRecoveryRotationDocument(review),
      chains: chains.map(item => ({ review: item, document: walletRecoveryRotationDocument(item) })) };
  }
  async function approveRotation(flowToken: string, backupSignature: Hex | undefined, chainSignatures: unknown = []) {
    const active = await activeChains(flowToken);
    if (active) {
      // A repeated approval with nothing left to review is answered with the current state.
      if ((await active.chains.status(active.record.intent.id)).some(chain => chain.state === 'review')) await active.chains.approve(active.record.candidate!, chainSignatures);
      return status(flowToken);
    }
    const { record } = await context(flowToken);
    if (!record.proof || typeof backupSignature !== 'string') state();
    // The other chains' approvals are kept first; none is sent before Base's own swap is on chain.
    await options.chains?.approve(record.candidate!, chainSignatures);
    const review = await rotation.prepare(record.intent.id);
    await rotation.approve(record.intent.id, review, backupSignature, flowToken);
    event({ stage: 'rotation', outcome: 'checked_original_attempt', recoveryId: record.intent.id });
    return status(flowToken);
  }
  /** Binds the wallet under its replacement passkey from this recovery's own proof, then activates
   * the replacement credential. No prompt and no browser grant. Idempotent across lost replies. */
  async function activate(flowToken: string) {
    const { flow, record } = await context(flowToken), candidate = record.candidate;
    if (!candidate || !record.proof) state();
    if (!record.activation) {
      if ((await rotation.status(record.intent.id, 5000)).state !== 'ready') state();
      await smart.bindPasskeyAccount({ manifestId: record.intent.manifest.id, address: record.intent.accountId.slice(12) as Address,
        consent: { id: record.intent.id, digest: `0x${record.proof.verificationDigest}` },
        expected: { signerAddress: candidate.signerAddress, initializerHash: record.intent.initializerHash } });
      event({ stage: 'setup', outcome: 'committed', recoveryId: record.intent.id });
    }
    await recoveries.activate(record.intent.id, flowToken, null, { passkeyName: flow.passkeyName });
    event({ stage: 'activation', outcome: 'committed', recoveryId: record.intent.id });
    return status(flowToken);
  }
  let stopped = false, timer: ReturnType<typeof setTimeout> | null = null, running: Promise<void> | null = null;
  const controller = new AbortController();
  const tick = () => {
    if (stopped) return Promise.resolve();
    return running ??= (async () => {
      try { await rotation.tick(controller.signal); }
      finally { await options.chains?.tick(controller.signal); }
    })().finally(() => { running = null; });
  };
  function start() {
    if (stopped || timer) return;
    const pass = async () => {
      try { await tick(); } catch { /* Durable original attempts remain available for reconciliation. */ }
      if (!stopped) timer = setTimeout(() => { void pass(); }, 1000);
    };
    timer = setTimeout(() => { void pass(); }, 0);
  }
  async function stop() {
    stopped = true; controller.abort(); if (timer) clearTimeout(timer);
    await running?.catch(() => {});
  }
  return { begin, status, register, prove, prepareRotation, approveRotation, activate, tick, start, stop,
    restart: (flowToken: string) => flows.assertRestartable(flowToken),
    beginResume: (id: string) => flows.beginResume(id),
    completeResume: (input: Parameters<PostgresWalletRecoveryFlowStore['completeResume']>[0]) => flows.completeResume(input) };
}
