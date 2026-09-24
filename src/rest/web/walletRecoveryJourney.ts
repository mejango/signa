import { nativePasskeyError } from './walletPasskeyError.js';
import { defaultPasskeyName } from './passkeyName.js';
import { base } from './walletBase.js';
import { getAddress, hashTypedData, isAddress, type Address, type TypedDataDefinition } from 'viem';
import type { WalletRecoveryView } from '../wallet/recoveryService.js';
import { readWalletRecoveryKit, recoveryAccountFromPhrase, type WalletRecoveryKit, type WalletRecoverySecret } from './walletRecoveryKit.js';
import { assertWalletRecoveryRotationReview } from './walletRecoveryReview.js';

type Ethereum = { request(input: { method: string; params?: unknown[] }): Promise<unknown> };
type TypedDocument = { domain: Record<string, any>; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Record<string, any> };
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = el<HTMLFormElement>('recovery-form'), name = el<HTMLInputElement>('passkey-name'), wallet = el<HTMLInputElement>('recovery-wallet');
const next = el<HTMLButtonElement>('recovery-next'), check = el<HTMLButtonElement>('recovery-check'), cancel = el<HTMLButtonElement>('recovery-cancel');
const resume = el<HTMLButtonElement>('recovery-resume'), reference = el<HTMLInputElement>('recovery-id'), signIn = el<HTMLAnchorElement>('recovery-signin');
const status = el('wallet-status'), locatorKey = 'center:recovery:reference';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, word = /^0x[0-9a-f]{64}$/;
let view: WalletRecoveryView | null = null, known = false, busy = false, csrf = '', native: AbortController | null = null;
let pending: { path: string; body: unknown; csrf: string } | null = null;
let rotation: Parameters<typeof assertWalletRecoveryRotationReview>[0] | null = null;
let secret: WalletRecoverySecret | null = null, kit: WalletRecoveryKit | null = null, selectedWallet: Address | null = null;
let disposed = false, pollCount = 0;
const method = () => el<HTMLFieldSetElement>('recovery-method').querySelector<HTMLInputElement>('input:checked')?.value ?? 'kit';
// Backup file and backup password both hold the backup key; a wallet signs with the browser's provider instead.
const kitMode = () => method() !== 'wallet';
const words = () => el<HTMLTextAreaElement>('recovery-words');
const steps: Record<WalletRecoveryView['phase'], string> = {
  awaiting_registration: 'Create your replacement passkey.', awaiting_possession: 'Prove access to the replacement passkey and your backup key.',
  awaiting_rotation_approval: 'Review and approve replacement of the lost passkey.', rotating: 'Replacing your passkey. Check again for the transaction results.',
  rotation_failed: 'The replacement did not complete. Check again before approving a new attempt.',
  awaiting_activation: 'Your replacement passkey is in place. Continue to finish setting up your account.',
  preparing_sign_in: 'Preparing to sign in. This can take up to a minute…',
  ready_to_sign_in: 'Your replacement passkey is ready. Sign in with it.', expired: 'This unfinished recovery expired. Its replacement passkey is not active.',
};
// While work is in flight the status line's mark spins (Croptop's text ticker) instead of showing the lightning.
// A native prompt waiting on the person is not work in flight; the mark holds still for it.
const polling = () => view?.phase === 'rotating' || view?.phase === 'preparing_sign_in';
const waiting = () => (busy && !native) || polling();
function message(value: string, error = false) { status.textContent = value; status.dataset.state = error ? 'error' : waiting() ? 'busy' : 'ready'; }
function spin() { if (waiting()) { if (status.dataset.state !== 'error') status.dataset.state = 'busy'; } else if (status.dataset.state === 'busy') status.dataset.state = 'ready'; }
function invalid(): never { throw new Error('The recovery review changed. Check the original recovery before continuing.'); }
function sameAddress(a: unknown, b: unknown): boolean { return typeof a === 'string' && typeof b === 'string' && isAddress(a) && isAddress(b) && getAddress(a) === getAddress(b); }
function fields(value: unknown, expected: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) invalid();
}
function schema(document: TypedDocument, primaryType: string, entries: readonly (readonly [string, string])[], domainKeys: string[]) {
  fields(document, ['domain', 'types', 'primaryType', 'message']); fields(document.domain, domainKeys);
  fields(document.types, [primaryType]); fields(document.message, entries.map(([field]) => field));
  if (document.primaryType !== primaryType || JSON.stringify(document.types[primaryType]) !== JSON.stringify(entries.map(([name, type]) => ({ name, type })))) invalid();
}
function hash(document: unknown) { return hashTypedData(document as TypedDataDefinition); }
const encode = (value: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
function decode(value: string): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,4096}$/.test(value)) invalid();
  const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
  if (encode(bytes.buffer) !== value) invalid(); return bytes;
}
function challengeBytes(value: string) { if (!/^0x[0-9a-fA-F]{64}$/.test(value)) invalid(); return Uint8Array.from(value.slice(2).match(/../g)!.map(pair => parseInt(pair, 16))); }
class HttpFailure extends Error { constructor(readonly status: number) { super('Recovery could not be confirmed. Check the original recovery and retry.'); } }
async function request(path: string, body?: unknown, proof = csrf): Promise<any> {
  // Activation re-inspects the wallet over the hosted provider; give it the long budget.
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), path === 'activate' ? 90000 : 15000);
  try {
    const response = await fetch(`${base}/recovery/` + path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
      ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-center-wallet-request': '1',
        ...(proof ? { 'x-center-wallet-csrf': proof } : {}) }, body: JSON.stringify(body) }) });
    if (!response.ok) throw new HttpFailure(response.status);
    const text = await response.text(); if (text.length > 131072) invalid(); return JSON.parse(text);
  } finally { clearTimeout(timer); }
}
function kitMatches(identity: { walletAddress: string; recoveryOwner: string; initializerHash: string }) {
  if (kit && (!sameAddress(kit.walletAddress, identity.walletAddress) || !sameAddress(kit.recoveryOwner, identity.recoveryOwner) || kit.initializerHash !== identity.initializerHash))
    throw new Error('This backup file does not match this account.');
  if (secret && !sameAddress(secret.recoveryOwner, identity.recoveryOwner)) throw new Error('Use the backup password for this account.');
}
function accept(result: { view: WalletRecoveryView | null; csrfToken?: string }) {
  const value = result.view;
  if (value) {
    if (!uuid.test(value.id) || value.origin !== location.origin || value.rpId !== location.hostname || !Object.hasOwn(steps, value.phase)
      || !isAddress(value.walletAddress) || !isAddress(value.recoveryOwner) || !isAddress(value.priorSigner) || !word.test(value.initializerHash)
      || !Number.isSafeInteger(value.expiresAtMs) || !Number.isSafeInteger(value.proofExpiresAtMs)
      || (selectedWallet && !sameAddress(value.walletAddress, selectedWallet)) || (view && view.id !== value.id)
      || !Array.isArray(value.transactionHashes) || value.transactionHashes.length > 2 || value.transactionHashes.some(value => !word.test(value))) invalid();
    kitMatches(value); selectedWallet = getAddress(value.walletAddress);
    // A public locator helps resume after cookie loss. It never authorizes recovery.
    sessionStorage.setItem(locatorKey, value.id); reference.value = value.id;
  }
  if (result.csrfToken) { if (decode(result.csrfToken).length !== 32) invalid(); csrf = result.csrfToken; }
  if (!value || value.phase !== view?.phase) { rotation = null; pollCount = 0; }
  view = value; known = true;
  if (value?.phase === 'ready_to_sign_in') { secret = null; kit = null; sessionStorage.removeItem('center:recovery:browser:' + value.id); }
  message(value ? steps[value.phase] : reference.value ? 'Resume the original recovery with its replacement passkey and your backup.' : 'Open your backup file, or choose another way in below.');
}
function render() {
  spin();
  form.hidden = !known || !!view; form.querySelector('button')!.disabled = engaged || !!pending || !!reference.value;
  if (!form.hidden && !name.value) name.value = defaultPasskeyName();
  name.disabled = engaged; wallet.disabled = engaged;
  const recoverable = view?.phase !== 'ready_to_sign_in';
  el<HTMLFieldSetElement>('recovery-method').hidden = !known || !recoverable; el<HTMLFieldSetElement>('recovery-method').disabled = engaged;
  el('recovery-kit').hidden = !known || !recoverable || method() !== 'kit';
  el('recovery-password').hidden = !known || !recoverable || method() !== 'password';
  // The backup file carries the account address; the other ways in ask for it.
  el('recovery-wallet-box').hidden = method() === 'kit';
  el<HTMLInputElement>('recovery-file').disabled = engaged; words().disabled = engaged;
  el('recovery-details').hidden = !view;
  el('recovery-name').textContent = view?.passkeyName ?? ''; el('recovery-address').textContent = view?.walletAddress ?? '';
  el('recovery-owner').textContent = view?.recoveryOwner ?? ''; el('recovery-prior').textContent = view?.priorSigner ?? '';
  el('recovery-replacement').textContent = view?.replacementSigner ?? 'Not created yet';
  el('recovery-review').hidden = !rotation;
  const label = view?.phase === 'awaiting_registration' ? 'Create replacement passkey' : view?.phase === 'awaiting_possession' ? 'Verify both owners'
    : view?.phase === 'awaiting_rotation_approval' ? rotation ? 'Approve passkey replacement' : 'Review passkey replacement'
    : view?.phase === 'awaiting_activation' ? 'Continue' : null;
  next.hidden = !label || !!pending; next.textContent = label; next.disabled = engaged;
  check.hidden = !known || (!view && !pending); check.disabled = engaged; cancel.hidden = !native;
  el<HTMLButtonElement>('recovery-restart').hidden = view?.phase !== 'expired' || !!pending;
  el<HTMLButtonElement>('recovery-restart').disabled = engaged;
  el('recovery-resume-section').hidden = !known || !recoverable; reference.disabled = engaged || !!view; resume.disabled = engaged || !!pending;
  signIn.hidden = view?.phase !== 'ready_to_sign_in';
  el('recovery-transactions').hidden = !view?.transactionHashes.length;
  el('recovery-hashes').replaceChildren(...(view?.transactionHashes ?? []).map(hash => { const item = document.createElement('li'); item.textContent = hash; return item; }));
}
async function send(path: string, body: unknown, proof = csrf) {
  pending = { path, body, csrf: proof };
  const result = await request(path, body, proof);
  if (path === 'restart') {
    fields(result, ['restarted', 'view']); if (result.restarted !== true || result.view !== null) invalid();
    sessionStorage.removeItem(locatorKey); reference.value = ''; wallet.value = '';
    secret = null; kit = null; selectedWallet = null; csrf = '';
    words().value = ''; el<HTMLInputElement>('recovery-file').value = '';
  }
  accept(result); pending = null;
  if (path === 'restart') message('Expired recovery closed. Start again to create a new replacement passkey.');
}
async function observe() {
  if (pending?.path === 'begin') {
    const result = await request('state');
    if (!result.view) throw new Error('The first recovery result is still unknown. Check again before starting another recovery.');
    accept(result); pending = null;
  } else if (pending) { const saved = pending; await send(saved.path, saved.body, saved.csrf); }
  else accept(await request('state'));
}
// A background poll (`quiet`) guards re-entrancy like any run but never dims the controls.
let engaged = false;
async function run(action: () => Promise<void>, quiet = false) {
  if (busy || disposed) return; busy = true; engaged = !quiet; render();
  try { await action(); }
  catch (error) {
    if (error instanceof HttpFailure && error.status >= 400 && error.status < 500) {
      pending = null; rotation = null;
      try { accept(await request('state')); } catch { /* Fresh resume proves both owners if the cookie was lost. */ }
    }
    if (error instanceof DOMException && native) {
      const feedback = nativePasskeyError(error, native.signal.aborted);
      message(feedback.message, feedback.state === 'error');
    } else message(error instanceof Error ? error.message : 'Recovery is unavailable. Check the original recovery again.', true);
  } finally { native = null; busy = false; engaged = false; if (!disposed) render(); }
}
function provider(): Ethereum {
  const value = (window as unknown as { ethereum?: Ethereum }).ethereum;
  if (!value?.request) throw new Error('Open this page in the browser that has the wallet you chose at signup.'); return value;
}
async function recoveryOwner(expected?: string) {
  const accounts = await provider().request({ method: 'eth_requestAccounts' });
  if (!Array.isArray(accounts) || !isAddress(accounts[0]) || (expected && !sameAddress(accounts[0], expected))) throw new Error('Select the wallet you chose at signup before continuing.');
  return getAddress(accounts[0]);
}
async function signBackup(document: TypedDataDefinition, owner: string) {
  let signature: unknown;
  if (kitMode()) {
    // After a reload the password field is the only place the backup can come from mid-recovery.
    if (method() === 'password') loadPassword();
    if (!secret) throw new Error('Open your backup file or enter your backup password again.');
    signature = await recoveryAccountFromPhrase(secret.mnemonic, getAddress(owner)).signTypedData(document);
  } else signature = await provider().request({ method: 'eth_signTypedData_v4', params: [await recoveryOwner(owner),
    JSON.stringify(document, (_key, value) => typeof value === 'bigint' ? value.toString() : value)] });
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error('The recovery owner signature is unavailable.');
  return signature;
}
async function assertion(challenge: string, rpId: string) {
  if (rpId !== location.hostname || !window.isSecureContext) throw new Error('Open the original secure account page.');
  native = new AbortController(); render();
  const value = await navigator.credentials.get({ publicKey: { rpId, challenge: challengeBytes(challenge), userVerification: 'required', timeout: 90000 }, signal: native.signal });
  if (!(value instanceof PublicKeyCredential) || !(value.response instanceof AuthenticatorAssertionResponse)) throw new Error('The passkey response is unavailable.');
  const response = value.response; native = null;
  return { credentialId: encode(value.rawId), userHandle: response.userHandle ? encode(response.userHandle) : null,
    authenticatorData: encode(response.authenticatorData), clientDataJSON: encode(response.clientDataJSON), signature: encode(response.signature) };
}
function possessionDocument() {
  if (!view?.possession || !view.replacementSigner) invalid();
  const document = view.possession.document as unknown as TypedDocument, value = document.message;
  schema(document, 'WalletRecovery', [['purpose','string'],['recoveryId','string'],['accountId','string'],['enrollmentId','string'],['enrollmentDigest','bytes32'],
    ['priorCredentialDigest','bytes32'],['priorBindingDigest','bytes32'],['initializerHash','bytes32'],['manifestCommitment','bytes32'],['priorSigner','address'],
    ['replacementSigner','address'],['recoveryOwner','address'],['replacementCredentialDigest','bytes32'],['rpId','string'],['origin','string'],['nonce','bytes32'],
    ['issuedAtMs','uint64'],['expiresAtMs','uint64']], ['name','version','chainId','verifyingContract']);
  if (document.domain.name !== 'Juicebox Center Wallet Recovery' || document.domain.version !== '1' || document.domain.chainId !== 8453
    || !sameAddress(document.domain.verifyingContract, view.walletAddress) || value.purpose !== 'replace-passkey' || value.recoveryId !== view.id
    || value.accountId !== 'eip155:8453:' + view.walletAddress.toLowerCase() || value.origin !== location.origin || value.rpId !== location.hostname
    || value.initializerHash !== view.initializerHash || !sameAddress(value.priorSigner, view.priorSigner) || !sameAddress(value.replacementSigner, view.replacementSigner)
    || !sameAddress(value.recoveryOwner, view.recoveryOwner) || BigInt(value.expiresAtMs) !== BigInt(view.proofExpiresAtMs)
    || BigInt(value.expiresAtMs) <= BigInt(Date.now()) || BigInt(value.issuedAtMs) > BigInt(Date.now() + 30000)
    || BigInt(value.expiresAtMs) > BigInt(value.issuedAtMs) + 300000n || hash(document) !== view.possession.challenge) invalid();
  return document as unknown as TypedDataDefinition;
}
async function advance() {
  if (!view) return;
  if (view.phase === 'awaiting_registration' && view.registration) {
    native = new AbortController(); render();
    const value = await navigator.credentials.create({ publicKey: { rp: { id: view.rpId, name: 'Signa' },
      user: { id: decode(view.registration.userHandle), name: view.passkeyName, displayName: view.passkeyName },
      challenge: decode(view.registration.challenge), pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' }, attestation: 'none', timeout: 90000 }, signal: native.signal });
    if (!(value instanceof PublicKeyCredential) || !(value.response instanceof AuthenticatorAttestationResponse)) throw new Error('The passkey response is unavailable.');
    native = null;
    await send('register', { type: 'public-key', credentialId: encode(value.rawId), rawId: encode(value.rawId),
      clientDataJSON: encode(value.response.clientDataJSON), attestationObject: encode(value.response.attestationObject) });
  } else if (view.phase === 'awaiting_possession' && view.possession) {
    const document = possessionDocument(), backupSignature = await signBackup(document, view.recoveryOwner);
    const proof = await assertion(view.possession.challenge, view.rpId);
    await send('prove', { assertion: proof, backupSignature });
  } else if (view.phase === 'awaiting_rotation_approval') {
    if (!view.replacementSigner || !view.candidateDigest || !view.rotationContext) invalid();
    const selected = { ...view, replacementSigner: view.replacementSigner, candidateDigest: view.candidateDigest, rotationContext: view.rotationContext };
    if (!rotation) {
      const result = await request('rotation/review', {}); assertWalletRecoveryRotationReview(result, selected); rotation = result;
      el('recovery-nonce').textContent = result.review.safeNonce; el('recovery-factory').textContent = result.review.createSigner.to;
      el('recovery-calls').textContent = JSON.stringify({ createSigner: result.review.createSigner, swapOwner: result.review.swapOwner }, null, 2);
      message('Review the account and both exact calls below, then approve the replacement with your backup.');
    } else {
      const document = assertWalletRecoveryRotationReview(rotation, selected), backupSignature = await signBackup(document, view.recoveryOwner);
      await send('rotation/approve', { backupSignature }); rotation = null;
    }
  } else if (view.phase === 'awaiting_activation') {
    // The replacement passkey and the recovery owner already signed this recovery; Center binds
    // the account from that proof and activates the passkey. No prompt, no browser grant.
    message('Activating your replacement passkey. This can take up to a minute…');
    await send('activate', {});
  }
}
async function resumeRecovery() {
  const recoveryId = reference.value.trim(); if (!uuid.test(recoveryId)) throw new Error('Enter the recovery reference from the original recovery.');
  const expectedWallet = view?.walletAddress ?? kit?.walletAddress ?? wallet.value.trim();
  if (!isAddress(expectedWallet)) throw new Error('Enter the account address or open its backup file.');
  selectedWallet = getAddress(expectedWallet);
  if (method() === 'password') loadPassword();
  const owner = kitMode() ? secret?.recoveryOwner : await recoveryOwner(view?.recoveryOwner);
  if (!owner) throw new Error('Open your backup file or enter your backup password again.');
  const begun = await request('resume/begin', { recoveryId }), challenge = begun.challenge, document = challenge.document as TypedDocument, value = document.message;
  schema(document, 'WalletRecoveryResume', [['purpose','string'],['resumeId','string'],['recoveryId','string'],['accountId','string'],['rpId','string'],['origin','string'],
    ['contextDigest','bytes32'],['issuedAtMs','string'],['expiresAtMs','string']], ['name','version','chainId','verifyingContract']);
  if (!uuid.test(challenge.id) || challenge.recoveryId !== recoveryId || challenge.rpId !== location.hostname || challenge.origin !== location.origin
    || challenge.accountId !== 'eip155:8453:' + selectedWallet.toLowerCase() || !sameAddress(challenge.recoveryOwner, owner)
    || !word.test(challenge.initializerHash) || !sameAddress(document.domain.verifyingContract, selectedWallet)
    || document.domain.name !== 'Juicebox Center Recovery Continuation' || document.domain.version !== '1' || document.domain.chainId !== 8453
    || value.purpose !== 'resume-recovery-continuation' || value.resumeId !== challenge.id || value.recoveryId !== recoveryId
    || value.accountId !== challenge.accountId || value.rpId !== location.hostname || value.origin !== location.origin || !word.test(value.contextDigest)
    || value.expiresAtMs !== String(challenge.expiresAtMs) || BigInt(value.expiresAtMs) <= BigInt(Date.now())
    || BigInt(value.issuedAtMs) > BigInt(Date.now() + 30000) || BigInt(value.expiresAtMs) > BigInt(value.issuedAtMs) + 300000n
    || hash(document) !== challenge.challenge) invalid();
  kitMatches({ walletAddress: selectedWallet, recoveryOwner: owner, initializerHash: challenge.initializerHash });
  if (decode(begun.csrfToken).length !== 32) invalid();
  const backupSignature = await signBackup(document as unknown as TypedDataDefinition, owner), proof = await assertion(challenge.challenge, challenge.rpId);
  if (proof.userHandle !== challenge.userHandle || proof.credentialId !== challenge.credentialId) invalid();
  await send('resume/complete', { resumeId: challenge.id, assertion: proof, backupSignature }, begun.csrfToken); rotation = null;
}
form.addEventListener('submit', event => { event.preventDefault(); void run(async () => {
  if (reference.value || pending) throw new Error('Resume or check the original recovery before starting another.');
  if (method() === 'password') loadPassword();
  const address = wallet.value.trim(); if (!isAddress(address)) throw new Error(method() === 'kit' ? 'Open your backup file first.' : 'Enter the account address. It is in your backup file.');
  if (kitMode() && !secret) throw new Error('Open your backup file or enter your backup password first.');
  if (kit && !sameAddress(kit.walletAddress, address)) throw new Error('Use the account address in your backup file.');
  if (!kitMode()) await recoveryOwner(); selectedWallet = getAddress(address);
  await send('begin', { walletAddress: selectedWallet, passkeyName: name.value.trim() });
  // Wallet mode: say so now if the connected wallet is not this account's backup, before a passkey is created for nothing.
  if (!kitMode() && view && !sameAddress(await recoveryOwner(), view.recoveryOwner))
    throw new Error("The connected wallet is not this account's backup wallet. Switch wallets before creating the replacement passkey.");
}); });
el('recovery-method').addEventListener('change', () => { secret = null; kit = null; words().value = ''; if (!view) wallet.value = ''; render(); });
el<HTMLInputElement>('recovery-file').addEventListener('change', event => { void run(async () => {
  const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = '';
  if (!file || file.size > 8192) throw new Error('Choose the backup file you saved for this account.');
  const value = readWalletRecoveryKit(await file.text(), view ? { network: 'base', chainId: 8453, walletAddress: view.walletAddress,
    recoveryOwner: view.recoveryOwner, initializerHash: view.initializerHash } : undefined);
  kit = value; secret = { mnemonic: value.mnemonic, recoveryOwner: value.recoveryOwner }; wallet.value = value.walletAddress;
  words().value = ''; el('recovery-kit-status').textContent = 'Backup file loaded in this tab.';
  message('Backup file loaded. Continue the original recovery, or name your replacement passkey.');
}); });
/** The backup password is read at the moment it is needed and never kept in the field. */
function loadPassword() {
  const mnemonic = words().value; if (!mnemonic.trim()) { if (secret) return; throw new Error('Enter your backup password.'); }
  words().value = '';
  const account = recoveryAccountFromPhrase(mnemonic, view?.recoveryOwner); kit = null;
  secret = { mnemonic: mnemonic.trim().toLowerCase().replace(/\s+/g, ' '), recoveryOwner: account.address };
}
next.addEventListener('click', () => { void run(advance); }); check.addEventListener('click', () => { void run(observe); });
el('recovery-restart').addEventListener('click', () => { void run(() => send('restart', {})); });
resume.addEventListener('click', () => { void run(resumeRecovery); }); cancel.addEventListener('click', () => native?.abort());
const timer = setInterval(() => {
  if (!busy && !pending && polling() && !document.hidden && navigator.onLine && pollCount++ < 90) void run(observe, true);
}, 2000);
window.addEventListener('pagehide', () => { disposed = true; native?.abort(); clearInterval(timer); secret = null; kit = null;
  words().value = ''; el<HTMLInputElement>('recovery-file').value = ''; }, { once: true });
void run(async () => {
  const url = new URL(location.href);
  if (url.hash || url.searchParams.size > 1 || [...url.searchParams].some(([key, value]) => key === 'intent' ? !/^[A-Za-z0-9_-]{43}$/.test(value)
    : key === 'payment' ? !uuid.test(value) : true)) throw new Error('Return to the original app to start this recovery.');
  signIn.href = (base || '/') + url.search; el<HTMLAnchorElement>('wallet-back').href = signIn.href;
  const locator = sessionStorage.getItem(locatorKey); if (locator && uuid.test(locator)) reference.value = locator;
  await observe();
});
