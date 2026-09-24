import { nativePasskeyError } from './walletPasskeyError.js';
import { defaultPasskeyName } from './passkeyName.js';
import { getAddress, hashTypedData, isAddress, type Address, type Hex } from 'viem';
import type { createLocalWalletSignup } from '../wallet/signup.js';
import { base } from './walletBase.js';
import { checkedRedirect, framed, listenForTheme } from './walletFramed.js';
import { createWalletRecoverySecret, readWalletRecoveryKit, recoveryAccountFromPhrase, serializeWalletRecoveryKit,
  type WalletRecoveryKitIdentity, type WalletRecoverySecret } from './walletRecoveryKit.js';

type Signup = ReturnType<typeof createLocalWalletSignup>;
type View = Awaited<ReturnType<Signup['status']>>;
type Ethereum = { request(input: { method: string; params?: unknown[] }): Promise<unknown> };
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = el<HTMLFormElement>('signup-form'), name = el<HTMLInputElement>('passkey-name');
const next = el<HTMLButtonElement>('signup-next'), resume = el<HTMLAnchorElement>('signup-resume');
const check = el<HTMLButtonElement>('signup-check'), cancel = el<HTMLButtonElement>('signup-cancel');
const status = el('wallet-status'), details = el('signup-details'), restart = el<HTMLButtonElement>('signup-restart');
const explain = el<HTMLDialogElement>('signup-explain');
/** An in-page question the person must answer before going on; a native passkey prompt is its own explanation. */
function announce(title: string, text: string) {
  el('explain-title').textContent = title; el('explain-text').textContent = text;
  return new Promise<void>((resolve, reject) => {
    explain.addEventListener('close', () => explain.returnValue === 'continue' ? resolve() : reject(new Error('Cancelled. You can try again.')), { once: true });
    explain.returnValue = ''; explain.showModal();
  });
}
let view: View | null = null, known = false, busy = false, csrf = '', native: AbortController | null = null;
// Inside an admitted app's frame the signup is the app's intent's: no cookie reaches a cross-site frame, so the
// flow token rides in every request body and each request is admitted by the intent behind the framed launch.
// The account made here is the same account; at the end the app gets its code and the frame returns to it.
let intentId: string | null = null, flowToken = '', resumeToken = '';
const inFrame = () => framed && !!intentId;
/** The intent the frame was launched with, as the app's return is checked against it. */
let intentReturn: { callbackUri: string; state: string } | null = null;
const intentView = () => { if (!intentReturn) throw new Error('Return to the original app to start this signup.'); return intentReturn; };
// A log-in in progress is the whole page; the signup form waits until it fails.
let loggingIn = false;
let pending: { path: string; body: unknown; csrf: string } | null = null;
let disposed = false, pollCount = 0;
let recoverySecret: WalletRecoverySecret | null = null, kitSavedWallet: string | null = null;
let approvedHere = false, sessionTried = false, activationTried = false;
const downloadUrls = new Set<string>();
// The choice outlives the form: a resumed signup reads it back by enrollment.
type RecoveryChoice = 'kit' | 'wallet';
const choice = (): RecoveryChoice => (el<HTMLFieldSetElement>('recovery-method').querySelector<HTMLInputElement>('input:checked')?.value ?? 'kit') as RecoveryChoice;
const modeKey = (id: string) => 'center:signup:kit:' + id;
// Storage may be refused to a cross-site frame (third-party storage blocked): the choice made on this
// page is kept in memory as well, and storage only carries it across a reload.
let chosen: RecoveryChoice | null = null;
const remembered = (id: string) => { try { return localStorage.getItem(modeKey(id)); } catch { return null; } };
const remember = (id: string, value: RecoveryChoice) => { chosen = value; try { localStorage.setItem(modeKey(id), value); } catch { /* not kept */ } };
const mode = (): RecoveryChoice => {
  if (!view) return choice();
  if (chosen) return chosen;
  const stored = remembered(view.enrollmentId);
  return stored === '1' || stored === 'kit' ? 'kit' : 'wallet';
};
/** The backup words live in this browser (made-for-you password or chosen password) rather than in an external wallet. */
const kitMode = () => mode() !== 'wallet';
function kitIdentity(): WalletRecoveryKitIdentity {
  if (!view?.walletAddress || !view.initializerHash) throw new Error('Create your passkey before saving the complete backup file.');
  return { network: 'base', chainId: 8453, walletAddress: view.walletAddress, recoveryOwner: view.recoveryOwner, initializerHash: view.initializerHash };
}
const steps: Record<View['phase'], string> = {
  awaiting_registration: 'Create your passkey.', awaiting_possession: 'Your passkey is ready. Create your account with it.',
  awaiting_deployment_approval: 'Your passkey is ready. Approve creation of your account.',
  deploying: 'Creating your account…',
  deployment_failed: 'Account creation did not complete. Keep this signup for recovery; do not send funds.',
  awaiting_activation: 'Your account is ready.', preparing_sign_in: 'Finishing sign in…',
  ready_to_sign_in: 'Your account is ready. Sign in with your passkey.',
  expired: "This recent signup wasn't completed in time. Try again.",
};
// While work is in flight the status line's mark spins (Croptop's text ticker) instead of showing the lightning.
// A native prompt waiting on the user is not work in flight, so the mark holds still for it.
const polling = () => view?.phase === 'deploying' || view?.phase === 'preparing_sign_in';
const waiting = () => (busy && !native) || polling();
function message(value: string, error = false) { status.textContent = value; status.dataset.state = error ? 'error' : waiting() ? 'busy' : 'ready'; }
/** The first word links to the creation transaction on Basescan when the signup has one. */
function messageLinked(word: string, rest: string) {
  const hash = view?.transactionHash;
  if (!hash) { message(word + rest); return; }
  const link = document.createElement('a'); link.href = 'https://basescan.org/tx/' + hash; link.target = '_blank'; link.rel = 'noopener'; link.textContent = word;
  status.replaceChildren(link, document.createTextNode(rest)); status.dataset.state = waiting() ? 'busy' : 'ready';
}
function spin() { if (waiting()) { if (status.dataset.state !== 'error') status.dataset.state = 'busy'; } else if (status.dataset.state === 'busy') status.dataset.state = 'ready'; }
function encode(value: ArrayBuffer) { return btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
function decode(value: string): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,4096}$/.test(value)) throw new Error('Invalid passkey challenge.');
  const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
  if (encode(bytes.buffer) !== value) throw new Error('Invalid passkey challenge.');
  return bytes;
}
function hexBytes(value: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error('Invalid passkey challenge.');
  return Uint8Array.from(value.slice(2).match(/../g)!.map(pair => parseInt(pair, 16)));
}
class HttpFailure extends Error {
  constructor(readonly status: number, readonly code = '') {
    super(code === 'WALLET_DEPLOYMENT_BUSY' ? 'Another account is being created right now. Try again in a few seconds.' : 'Signup could not be confirmed. Check the original signup and retry.');
  }
}
async function failure(response: Response) {
  try { const code = (await response.json())?.error?.code; return new HttpFailure(response.status, typeof code === 'string' ? code : ''); }
  catch { return new HttpFailure(response.status); }
}
// Setup reviews inspect the wallet on Base (tens of provider reads); they get a longer budget.
const slowPaths = new Set(['activate', 'login/complete']);
async function request(path: string, body?: unknown, proof = csrf): Promise<any> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), slowPaths.has(path) ? 90000 : 15000);
  // Framed: every step is a POST carrying the intent and the flow token; a resume carries its own token.
  const framedBody = inFrame() ? { intentId, ...(path === 'begin' || path === 'resume/begin' ? {} : path === 'resume/complete' ? { resumeToken } : { flowToken }), ...(body as object ?? {}) } : body;
  try {
    const response = await fetch(`${base}/signup/` + (inFrame() ? 'framed/' : '') + path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
      ...(framedBody === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-center-wallet-request': '1',
        ...(proof && !inFrame() ? { 'x-center-wallet-csrf': proof } : {}) }, body: JSON.stringify(framedBody) }) });
    if (!response.ok) throw await failure(response);
    return await response.json();
  } finally { clearTimeout(timer); }
}
function accept(result: { view: View | null; csrfToken?: string; flowToken?: string }) {
  if (typeof result.flowToken === 'string') { if (!/^[A-Za-z0-9_-]{43}$/.test(result.flowToken)) throw new Error('Invalid signup context.'); flowToken = result.flowToken; }
  if (result.view) {
    if (result.view.origin !== location.origin || result.view.rpId !== location.hostname || !(result.view.phase in steps)) throw new Error('The account host or signup changed.');
    if (view && view.enrollmentId !== result.view.enrollmentId && !pending?.path.startsWith('resume/')) throw new Error('Another signup replaced this page. Reload before continuing.');
  }
  view = result.view; known = true;
  if (result.csrfToken) { if (decode(result.csrfToken).length !== 32) throw new Error('Invalid signup context.'); csrf = result.csrfToken; }
  // Flashblocks: the receipt arrives before the block; the page says so, and waits for the block.
  if (view?.phase === 'deploying') view.preconfirmed ? messageLinked('Almost', ' there…' + (mode() === 'kit' && recoverySecret ? ' Meanwhile, save your backup password.' : ''))
    : messageLinked('Creating', steps.deploying.slice('Creating'.length) + (mode() === 'kit' && recoverySecret ? ' Meanwhile, save your backup password.' : ''));
  else message(view ? steps[view.phase] + (view.phase === 'awaiting_activation' ? mode() === 'kit' ? recoverySecret ? ' Now, save your backup password.' : '' : ' Continue to sign in.' : '')
    : 'Name your passkey and pick a way back in.');
  if (view?.phase === 'ready_to_sign_in' && kitSavedWallet === view.walletAddress) recoverySecret = null;
}
function render() {
  spin(); stream();
  if (view?.phase === 'awaiting_activation' && approvedHere && kitSavedWallet === view.walletAddress && !activationTried && !busy && !pending) {
    activationTried = true; void run(advance);
  }
  if (view?.phase === 'ready_to_sign_in' && approvedHere && !sessionTried && !busy) void run(async () => { if (!(await session())) render(); });
  form.querySelector('button')!.disabled = engaged;
  name.disabled = engaged;
  // Registration fixes the complete recovery identity. A resumed or cancelled approval
  // can still save or reopen its backup; activation waits for that backup.
  const kitPhase = !!view?.walletAddress && !!view.initializerHash && view.phase !== 'expired';
  const stranded = kitMode() && !recoverySecret && view?.phase === 'awaiting_registration';
  // A stranded attempt that never created a passkey lost nothing worth mentioning: show the clean form.
  if (stranded) message('');
  form.hidden = !known || (!!view && !stranded) || loggingIn; details.hidden = !view || stranded;
  // A default name that tells passkeys apart later: the site, then when it was made.
  if (!form.hidden && !name.value) name.value = defaultPasskeyName();
  el<HTMLFieldSetElement>('recovery-method').disabled = engaged; // Inside the form: gone once signup begins.
  const showKit = kitPhase && mode() === 'kit';
  el('recovery-kit').hidden = !showKit;
  const phrase = el<HTMLInputElement>('recovery-phrase');
  phrase.value = recoverySecret?.mnemonic ?? ''; el('recovery-secret').hidden = !(showKit && recoverySecret);
  el('recovery-show').textContent = phrase.type === 'password' ? 'Show' : 'Hide';
  // Only a reload before saving loses the password from memory; pasting it back allows the file save.
  el('recovery-restore-box').hidden = !showKit || !!recoverySecret;
  el('recovery-kit-note').hidden = !recoverySecret; el('recovery-warning').hidden = !recoverySecret; el<HTMLButtonElement>('recovery-download').hidden = !recoverySecret;
  el<HTMLButtonElement>('recovery-download').disabled = engaged;
  el<HTMLButtonElement>('recovery-share').hidden = !recoverySecret || typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function';
  el<HTMLButtonElement>('recovery-share').disabled = engaged;
  el<HTMLInputElement>('recovery-file').disabled = engaged;
  el<HTMLTextAreaElement>('recovery-words').disabled = engaged;
  el<HTMLButtonElement>('recovery-restore').disabled = engaged;
  el('signup-name').textContent = view?.passkeyName ?? '';
  el('signup-recovery-label').textContent = mode() === 'wallet' ? 'Recovery wallet' : showKit && recoverySecret ? 'Backup password'
    : showKit ? 'Backup password address' : 'Recovery';
  el('signup-recovery').textContent = mode() === 'wallet' ? view?.recoveryOwner ?? ''
    : kitPhase ? recoverySecret ? '' : view?.recoveryOwner ?? '' : 'A backup password you save before creating the account';
  el('signup-address').textContent = view?.walletAddress ?? 'Not created yet';
  const label = view?.phase === 'awaiting_registration' ? 'Signa up'
    : view?.phase === 'awaiting_possession' || view?.phase === 'awaiting_deployment_approval' ? 'Create account'
    : view?.phase === 'awaiting_activation' ? 'Continue' : view?.phase === 'deploying' && mode() === 'kit' ? 'Continue' : view?.phase === 'ready_to_sign_in' ? 'Signa in' : view?.phase === 'expired' ? 'Signa up' : null;
  next.hidden = !label || !!pending || stranded; next.textContent = label; next.disabled = engaged || view?.phase === 'deploying';
  if (view && view.phase === 'awaiting_activation'
    && kitMode() && kitSavedWallet !== view.walletAddress) next.disabled = true;
  el<HTMLButtonElement>('recovery-show').disabled = engaged; el<HTMLButtonElement>('recovery-copy').disabled = engaged;
  // "log in" resumes with a passkey; a finished wallet lands at sign-in. Once the state is known (or its load failed),
  // it stays offered unless a signup with a passkey is under way, so a returning user is never without a way in.
  resume.hidden = !known || loggingIn || (!!view && view.phase !== 'expired' && view.phase !== 'awaiting_registration');
  // "Check signup" only matters for a lost reply; creation and login preparation are pushed.
  check.hidden = stranded || !pending; check.disabled = engaged;
  // One filled button per page: the check is the primary only when it stands alone.
  check.classList.toggle('link', !form.hidden); check.classList.toggle('secondary', form.hidden && !next.hidden);
  cancel.hidden = !native;
  // Forgetting this browser's continuation; the signup and its passkey stay usable through "log in".
  // Not while a paid creation is in flight or awaiting its activation: a restart there orphans it.
  restart.hidden = !view || stranded || ['expired', 'deploying', 'awaiting_activation', 'preparing_sign_in'].includes(view.phase); restart.disabled = engaged;
}
async function send(path: string, body: unknown, proof = csrf) {
  pending = { path, body, csrf: proof };
  const result = await request(path, body, proof); accept(result); pending = null;
  // A replayed activation (its first reply lost) may have signed the account in: the session
  // cookie is set, so this page is done.
  if (result?.signedIn) { sessionTried = true; message('Signing in…'); location.replace((base || '/') + location.search); }
  // A framed activation that signed the account in answers with the app's return: the frame goes there.
  if (typeof result?.redirectUri === 'string') { sessionTried = true; message('Returning to your app…'); location.replace(checkedRedirect(result, intentView(), location.origin)); }
}
async function observe() {
  if (pending) { const saved = pending; await send(saved.path, saved.body, saved.csrf); }
  else accept(await request('state', inFrame() ? {} : undefined));
}
// A background poll (`quiet`) guards re-entrancy like any run but never dims the controls: the
// person is not waiting on a button, so nothing should flash every couple of seconds.
let engaged = false;
async function run(action: () => Promise<void>, quiet = false) {
  if (busy || disposed) return;
  busy = true; engaged = !quiet; render();
  try { await action(); }
  catch (error) {
    known = true; // Whatever failed, the page stops waiting and offers its ways in.
    if (error instanceof HttpFailure && error.status >= 400 && error.status < 500) {
      pending = null;
      try { accept(await request('state')); } catch { /* Resume with a fresh proof if the cookie is no longer valid. */ }
    }
    if (error instanceof DOMException && native) {
      const feedback = nativePasskeyError(error, native.signal.aborted);
      const fullscreen = inFrame() && error.name === 'NotAllowedError' && !native.signal.aborted && view?.phase === 'awaiting_registration'
        ? ' You can also open Fullscreen below to try on a page of its own.' : '';
      message(feedback.message + fullscreen, feedback.state === 'error');
    } else message(error instanceof DOMException && error.name === 'AbortError'
      ? 'The account service took too long to answer. Try again.'
      : error instanceof Error ? error.message : 'Signup is unavailable. Check the original signup again.', true);
  } finally { native = null; busy = false; engaged = false; if (!disposed) render(); }
}
function provider(): Ethereum {
  const value = (window as unknown as { ethereum?: Ethereum }).ethereum;
  if (!value?.request) throw new Error('Open this page with your recovery wallet browser extension available.');
  return value;
}
async function recoveryOwner(expected?: Address) {
  const accounts = await provider().request({ method: 'eth_requestAccounts' });
  if (!Array.isArray(accounts) || !isAddress(accounts[0]) || (expected && getAddress(accounts[0]) !== getAddress(expected)))
    throw new Error('Select the original recovery wallet before continuing.');
  return getAddress(accounts[0]);
}
/** Discoverable on purpose: Center pins the expected passkey when it verifies; an allow list only lets
 * iOS refuse a passkey it cannot preselect. */
async function assertion(challenge: string, rpId: string) {
  if (rpId !== location.hostname || !window.isSecureContext) throw new Error('Open the original secure wallet page.');
  native = new AbortController(); render();
  const value = await navigator.credentials.get({ publicKey: { rpId, challenge: hexBytes(challenge), userVerification: 'required', timeout: 90000 }, signal: native.signal });
  if (!(value instanceof PublicKeyCredential) || !(value.response instanceof AuthenticatorAssertionResponse)) throw new Error('The passkey response is unavailable.');
  const response = value.response; native = null;
  return { credentialId: encode(value.rawId), userHandle: response.userHandle ? encode(response.userHandle) : null,
    authenticatorData: encode(response.authenticatorData), clientDataJSON: encode(response.clientDataJSON), signature: encode(response.signature) };
}
async function advance() {
  if (!view) return;
  if (view.phase === 'awaiting_activation' && kitMode() && (!view.walletAddress || kitSavedWallet !== view.walletAddress))
    throw new Error('Save your complete backup file, or reopen the saved file, before continuing.');
  if (view.phase === 'awaiting_deployment_approval' && !kitMode()) await recoveryOwner(view.recoveryOwner);
  if (view.phase === 'expired') {
    if (inFrame()) { view = null; flowToken = ''; } else await send('restart', {});
    csrf = '';
  } else if (view.phase === 'awaiting_registration' && view.registration) {
    message('Create the passkey in the prompt.'); native = new AbortController(); render();
    const value = await navigator.credentials.create({ publicKey: { rp: { id: view.rpId, name: 'Signa' },
      user: { id: decode(view.registration.userHandle), name: view.passkeyName, displayName: view.passkeyName },
      challenge: decode(view.registration.challenge), pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      attestation: 'none', timeout: 90000 }, signal: native.signal });
    if (!(value instanceof PublicKeyCredential) || !(value.response instanceof AuthenticatorAttestationResponse)) throw new Error('The passkey response is unavailable.');
    native = null;
    await send('register', { type: 'public-key', credentialId: encode(value.rawId), rawId: encode(value.rawId),
      clientDataJSON: encode(value.response.clientDataJSON), attestationObject: encode(value.response.attestationObject) });
    // The same signup continues into its fresh passkey approval. A cancelled or uncertain
    // prompt leaves the explicit Create account button as a retry.
    if (current()?.phase === 'awaiting_possession') await advance();
  } else if (view.phase === 'awaiting_possession' && view.possession) {
    // The recovery owner signs the enrollment document; the single passkey prompt then approves
    // creation, which also proves possession of the new passkey.
    const document = view.possession.document, value = document.message;
    if (document.domain.name !== 'Juicebox Center Wallet Enrollment' || document.domain.version !== '1' || document.domain.chainId !== 8453
      || document.primaryType !== 'WalletEnrollment' || value.purpose !== 'registration' || value.enrollmentId !== view.enrollmentId
      || value.origin !== location.origin || value.rpId !== location.hostname || value.initializerHash !== view.initializerHash
      || getAddress(value.recoveryOwner) !== getAddress(view.recoveryOwner) || getAddress(value.predictedSafe) !== getAddress(view.walletAddress!)
      || getAddress(document.domain.verifyingContract) !== getAddress(view.walletAddress!)
      || hashTypedData(document) !== view.possession.challenge || BigInt(value.expiresAtMs) <= BigInt(Date.now())) throw new Error('The account enrollment review changed.');
    let backupSignature: unknown;
    if (kitMode()) {
      if (!recoverySecret) throw new Error('Restore your backup password or saved backup file before continuing this signup.');
      backupSignature = await recoveryAccountFromPhrase(recoverySecret.mnemonic, view.recoveryOwner).signTypedData(document);
    } else {
      const owner = await recoveryOwner(view.recoveryOwner);
      backupSignature = await provider().request({ method: 'eth_signTypedData_v4', params: [owner, JSON.stringify(document)] });
    }
    await approve(backupSignature as Hex);
  } else if (view.phase === 'awaiting_deployment_approval') {
    await approve();
  } else if (view.phase === 'awaiting_activation') {
    // The passkey already consented to this account when it created the wallet; Center binds the
    // account from that proof. No prompt: reading and preparing need no grant, payments still do.
    messageLinked('Finishing', ' your account…');
    // Activation carries through to the session in one request when the approval's signature is on
    // offer. Otherwise: wait briefly for the login to be ready, ask for the session, or log in.
    await send('activate', {});
    if (sessionTried) return;
    for (let i = 0; i < 12 && current()?.phase === 'preparing_sign_in'; i++) { await new Promise(resolve => setTimeout(resolve, 500)); await observe(); }
    if (current()?.phase === 'ready_to_sign_in' && !(await session())) await login();
  } else if (view.phase === 'ready_to_sign_in') {
    await login();
  }
}
const current = () => view;
async function approve(backupSignature?: Hex) {
  const deployment: Awaited<ReturnType<Signup['prepareDeployment']>> = await request('deployment/review', {});
  if (deployment.walletAddress.toLowerCase() !== view!.walletAddress?.toLowerCase() || deployment.recoveryOwner.toLowerCase() !== view!.recoveryOwner.toLowerCase()
    || deployment.initializerHash !== view!.initializerHash) throw new Error('The account creation review changed.');
  message('Approve creating your account: use your passkey in the prompt.');
  const proof = await assertion(deployment.challenge, view!.rpId);
  await send('deployment/approve', { approvalId: deployment.id, assertion: proof, ...(backupSignature ? { backupSignature } : {}) });
  approvedHere = true;
}
// The approval's passkey signature signs the new account in once it is ready: no login prompt. Only
// when that is not on offer (a resumed signup, a restarted server) does the login button appear.
async function session(): Promise<boolean> {
  if (!approvedHere || sessionTried) return false;
  sessionTried = true; message('Signing in…');
  try {
    const result = await request('session', {});
    location.replace(inFrame() ? checkedRedirect(result, intentView(), location.origin) : (base || '/') + location.search); return true;
  }
  catch { return false; }
}
form.addEventListener('submit', event => { event.preventDefault(); void run(async () => {
  const passkeyName = name.value.trim(), selected = choice();
  if (selected === 'kit' && !recoverySecret) recoverySecret = createWalletRecoverySecret();
  const owner = selected === 'wallet' ? await recoveryOwner() : recoverySecret!.recoveryOwner;
  await send('begin', { recoveryOwner: owner, passkeyName });
  remember(view!.enrollmentId, selected);
  // Go straight into the passkey prompt; a cancelled prompt leaves the explicit button as the fallback.
  if (view?.phase === 'awaiting_registration') await advance();
}); });
el('recovery-method').addEventListener('change', render);
const backupFileName = 'signa-account-backup.json';
el('recovery-download').addEventListener('click', () => { void run(async () => {
  if (!recoverySecret) throw new Error('Restore your backup password first.');
  const encoded = serializeWalletRecoveryKit(recoverySecret, kitIdentity());
  const url = URL.createObjectURL(new Blob([encoded], { type: 'application/json' })); downloadUrls.add(url);
  const link = document.createElement('a'); link.href = url; link.download = backupFileName;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => { URL.revokeObjectURL(url); downloadUrls.delete(url); }, 1000);
  kitSavedWallet = view!.walletAddress!;
  message('Backup file saved. Keep it somewhere private, then continue.');
}); });
el('recovery-share').addEventListener('click', () => { void run(async () => {
  if (!recoverySecret) throw new Error('Restore your backup password first.');
  const file = new File([serializeWalletRecoveryKit(recoverySecret, kitIdentity())], backupFileName, { type: 'application/json' });
  if (!navigator.canShare({ files: [file] })) throw new Error('This device cannot share files. Save the backup file instead.');
  try { await navigator.share({ files: [file], title: 'Signa account backup' }); }
  catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('Sharing cancelled. Save the backup file, or share again.');
    throw new Error('Your browser would not open its share sheet. Save the backup file instead.');
  }
  kitSavedWallet = view!.walletAddress!;
  message('Backup file shared. Make sure it reached somewhere you trust, then continue.');
}); });
el('recovery-show').addEventListener('click', () => {
  const input = el<HTMLInputElement>('recovery-phrase'); input.type = input.type === 'password' ? 'text' : 'password'; render();
});
el('recovery-copy').addEventListener('click', () => { void run(async () => {
  if (!recoverySecret) throw new Error('Restore your backup password first.');
  await navigator.clipboard.writeText(recoverySecret.mnemonic);
  message('Backup password copied. Keep it private and save the complete backup file before continuing.');
}); });
el('recovery-file').addEventListener('change', () => { void run(async () => {
  const input = el<HTMLInputElement>('recovery-file'), file = input.files?.[0];
  if (!file || file.size > 8192) throw new Error('Choose a valid backup file.');
  try {
    const kit = readWalletRecoveryKit(await file.text(), kitIdentity());
    recoverySecret = { mnemonic: kit.mnemonic, recoveryOwner: kit.recoveryOwner };
    kitSavedWallet = view!.walletAddress!;
    message('Backup file verified. You can continue.');
  } finally { input.value = ''; }
}); });
el('recovery-restore').addEventListener('click', () => { void run(async () => {
  const input = el<HTMLTextAreaElement>('recovery-words');
  const mnemonic = input.value.trim().toLowerCase().replace(/\s+/g, ' ');
  try {
    const owner = recoveryAccountFromPhrase(mnemonic, kitIdentity().recoveryOwner);
    recoverySecret = { mnemonic, recoveryOwner: owner.address }; kitSavedWallet = null;
    message('Backup password restored. Save the complete backup file before continuing.');
  } finally { input.value = ''; }
}); });
next.addEventListener('click', () => { void run(advance); });
el('recovery-restart-link').addEventListener('click', event => { event.preventDefault(); restart.click(); });
restart.addEventListener('click', () => { void run(async () => {
  // A framed page holds its continuation in memory alone: forgetting it is local.
  if (inFrame()) { view = null; flowToken = ''; } else await send('restart', {});
  csrf = ''; pending = null; recoverySecret = null; kitSavedWallet = null;
}); });
check.addEventListener('click', () => { void run(async () => {
  message('Checking your signup…'); await observe(); pollCount = 0;
  if (view?.phase === 'deploying') message('Still creating your account. Checked just now; this page keeps checking while it is open.');
}); });
cancel.addEventListener('click', () => native?.abort());
// Login completion may refresh the account's authority on Base first (the site waits up to 90 s for it).
async function walletRequest(path: string, body: unknown, proof?: string, timeoutMs = 15000): Promise<any> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
      ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-center-wallet-request': '1',
        ...(proof ? { 'x-center-wallet-csrf': proof } : {}) }, body: JSON.stringify(body) }) });
    if (!response.ok) throw await failure(response);
    return await response.json();
  } finally { clearTimeout(timer); }
}
/** The same sign-in as the wallet landing page, then that page shows the session (and any app return). */
async function login() {
  loggingIn = true; render();
  try { await loginFlow(); } finally { loggingIn = false; }
}
async function loginFlow() {
  if (inFrame()) return framedLogin();
  message('Signing in…');
  const begun = await walletRequest(`${base}/login/begin`, {}), publicKey = begun.publicKey;
  if (publicKey?.rpId !== location.hostname || publicKey.userVerification !== 'required' || typeof begun.loginId !== 'string' || typeof begun.csrfToken !== 'string') throw new Error('The account host changed.');
  const challenge = decode(publicKey.challenge); if (challenge.length !== 32) throw new Error('Invalid passkey challenge.');
  message('Sign in with the prompt.');
  const proof = await assertion('0x' + Array.from(challenge, byte => byte.toString(16).padStart(2, '0')).join(''), publicKey.rpId);
  message('Signing in…');
  const result = await walletRequest(`${base}/login/complete`, { loginId: begun.loginId, assertion: proof }, begun.csrfToken, 100000);
  if (result?.session?.loginId !== begun.loginId) throw new Error('Sign-in could not be confirmed.');
  location.replace((base || '/') + location.search);
}
/** Inside the frame: the passkey sign-in the wallet landing page runs framed (the intent admits it, no cookie), then the app's return. */
async function framedLogin() {
  message('Signing in…');
  const begun = await walletRequest(`${base}/authorize/${intentId}/begin`, {}), publicKey = begun.publicKey;
  if (publicKey?.rpId !== location.hostname || publicKey.userVerification !== 'required' || typeof begun.loginId !== 'string' || typeof begun.flowToken !== 'string') throw new Error('The account host changed.');
  const challenge = decode(publicKey.challenge); if (challenge.length !== 32) throw new Error('Invalid passkey challenge.');
  message('Sign in with the prompt.');
  const proof = await assertion('0x' + Array.from(challenge, byte => byte.toString(16).padStart(2, '0')).join(''), publicKey.rpId);
  message('Signing in…');
  const result = await walletRequest(`${base}/authorize/${intentId}/approve`, { loginId: begun.loginId, flowToken: begun.flowToken, assertion: proof }, undefined, 100000);
  message('Returning to your app…');
  location.replace(checkedRedirect(result, intentView(), location.origin));
}
async function resumeSignup() {
  await announce('Pick up your signup', 'That passkey belongs to an unfinished signup. One more passkey prompt picks it up where you left off.');
  const begun = await request('resume/begin', {}); message('Pick up your signup with the prompt.');
  if (inFrame()) { if (typeof begun.resumeToken !== 'string') throw new Error('Invalid signup context.'); resumeToken = begun.resumeToken; }
  const proof = await assertion(begun.challenge.challenge, begun.challenge.rpId);
  await send('resume/complete', { resumeId: begun.challenge.id, assertion: proof }, begun.csrfToken);
}
resume.addEventListener('click', event => { event.preventDefault(); if (busy || pending) return; void run(async () => {
  // A passkey with a finished wallet logs in; one from an unfinished signup resumes it.
  try { await login(); return; } catch (error) { if (!(error instanceof HttpFailure) || ![400, 401, 403, 404, 410].includes(error.status)) throw error; }
  await resumeSignup();
}); });
// Phase changes are pushed over the events stream while creation or login preparation is under way.
// The poll stays behind it: every 10 s while the stream is live (a change made in another replica
// reaches the stream's own timed re-read, and this poll, within seconds), every 2 s once the stream
// went quiet for 40 s (no view, no 15 s ping) or where EventSource is unavailable. A stream that
// errors is closed and reopened after 30 s, never in a tight loop.
let source: EventSource | null = null, heard = 0, lastPoll = 0, retryAt = 0;
const live = () => Date.now() - heard < 40000;
function stream() {
  if (!polling() || disposed) { source?.close(); source = null; return; }
  // The stream rides the continuation cookie, which a frame does not have: there, the poll alone carries the view.
  if (source || inFrame() || typeof EventSource !== 'function' || Date.now() < retryAt) return;
  try {
    source = new EventSource(`${base}/signup/events`);
    source.onmessage = event => { try { const result = JSON.parse(event.data); if (!busy && !pending) { accept(result); render(); } heard = Date.now(); } catch { /* The poll still carries the view. */ } };
    source.addEventListener('ping', () => { heard = Date.now(); });
    source.onerror = () => { heard = 0; source?.close(); source = null; retryAt = Date.now() + 30000; };
  } catch { source = null; retryAt = Date.now() + 30000; }
}
const timer = setInterval(() => {
  stream();
  if (busy || pending || !polling() || document.hidden || !navigator.onLine || pollCount >= 150) return;
  const interval = source && live() ? 10000 : 2000;
  if (Date.now() - lastPoll < interval) return;
  lastPoll = Date.now(); pollCount++; void run(observe, true);
}, 2000);
window.addEventListener('pagehide', () => {
  disposed = true; native?.abort(); clearInterval(timer); source?.close(); recoverySecret = null;
  el<HTMLInputElement>('recovery-phrase').value = '';
  el<HTMLTextAreaElement>('recovery-words').value = ''; el<HTMLInputElement>('recovery-file').value = '';
  for (const url of downloadUrls) URL.revokeObjectURL(url); downloadUrls.clear();
}, { once: true });
void run(async () => {
  const url = new URL(location.href);
  if (url.hash || url.searchParams.size > 1 || [...url.searchParams].some(([key, value]) => key === 'intent' ? !/^[A-Za-z0-9_-]{43}$/.test(value)
    : key === 'payment' ? !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value) : true)) throw new Error('Return to the original app to start this signup.');
  el<HTMLAnchorElement>('wallet-back').href = (base || '/') + url.search;
  if (framed && url.searchParams.has('intent')) {
    intentId = url.searchParams.get('intent');
    // The intent behind this frame: its app is the one framing the page, and its return is where the frame ends up.
    const result = await walletRequest(`${base}/authorize/${intentId}`, undefined);
    const requested = result?.request, callbackUri = requested?.callbackUri;
    if (typeof callbackUri !== 'string' || typeof requested?.state !== 'string' || typeof requested?.origin !== 'string') throw new Error('Return to the original app to start this signup.');
    intentReturn = { callbackUri, state: requested.state };
    listenForTheme(requested.origin);
    // The ways out of the frame: "log in" stays in the frame; the page of its own opens on top.
    const fullscreen = el<HTMLAnchorElement>('signup-fullscreen'); fullscreen.href = `${base}/create${url.search}`; fullscreen.hidden = false;
  }
  await observe();
});
