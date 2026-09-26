import { nativePasskeyError } from './walletPasskeyError.js';
import { defaultPasskeyName } from './passkeyName.js';
import { base } from './walletBase.js';
import { getAddress, hashTypedData, isAddress, type TypedDataDefinition } from 'viem';
import type { WalletDeviceView } from '../wallet/deviceService.js';

/** The second device: registers its own passkey, proves it, waits for the other device's approval
 * and the owner addition, then finishes. The link token lives in the URL fragment for this tab. */
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = el('wallet-status'), next = el<HTMLButtonElement>('device-next'), signIn = el<HTMLAnchorElement>('device-signin');
const details = el('device-details'), intro = el('device-intro');
const steps: Record<WalletDeviceView['phase'], string> = {
  awaiting_registration: 'Create a passkey on this device.', awaiting_possession: 'Confirm the new passkey.',
  awaiting_approval: 'Approve this device from the device you started on. It shows this device as TAG.', adding: 'Adding this device to your account…',
  addition_failed: 'Adding the device did not complete. Start again from your account.', awaiting_activation: 'Finishing…',
  ready: 'This device is added.', expired: 'This link expired. Start again from your account.' };
let view: WalletDeviceView | null = null, busy = false, native: AbortController | null = null, disposed = false, alreadyHere = false;
const linkToken = (() => { const value = location.hash.slice(1); return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null; })();
const polling = () => view?.phase === 'awaiting_approval' || view?.phase === 'adding' || view?.phase === 'awaiting_activation';
// The mark spins only while the service works; waiting for the other device's approval is not work in flight.
const waiting = () => (busy && !native) || view?.phase === 'adding' || view?.phase === 'awaiting_activation';
function message(value: string, error = false) { status.textContent = value; status.dataset.state = error ? 'error' : waiting() ? 'busy' : 'ready'; }
function invalid(): never { throw new Error('The device link changed. Start again from your account.'); }
const encode = (value: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]{1,4096}$/.test(value)) invalid();
  const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
  if (encode(bytes.buffer) !== value) invalid(); return bytes;
}
const challengeBytes = (value: string) => { if (!/^0x[0-9a-fA-F]{64}$/.test(value)) invalid(); return Uint8Array.from(value.slice(2).match(/../g)!.map(pair => parseInt(pair, 16))); };
async function request(path: string, body: Record<string, unknown>): Promise<any> {
  if (!linkToken) invalid();
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), path === 'activate' ? 100000 : 15000);
  try {
    const response = await fetch(`${base}/devices/link/${path}`, { method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-center-wallet-request': '1' }, body: JSON.stringify({ linkToken, ...body }) });
    if (!response.ok) throw Object.assign(new Error(response.status === 403 ? 'This link is not valid on this device.' : response.status >= 500 ? 'The account service is temporarily unavailable. Try again.' : 'This step could not be completed. Start again from your account.'), { status: response.status });
    return await response.json();
  } finally { clearTimeout(timer); }
}
function accept(result: { view: WalletDeviceView }) {
  const value = result.view;
  if (!value || value.origin !== location.origin || value.rpId !== location.hostname || !(value.phase in steps) || !isAddress(value.walletAddress)) invalid();
  view = value; message(steps[value.phase].replace('TAG', value.deviceSigner?.slice(-6).toUpperCase() ?? ''), value.phase === 'expired' || value.phase === 'addition_failed');
}
function render() {
  const phase = view?.phase;
  details.hidden = !view; intro.hidden = !!view && (phase === 'ready' || phase === 'expired');
  if (view) { el('device-address').textContent = getAddress(view.walletAddress); el('device-name').textContent = view.passkeyName ?? ''; }
  const label = phase === 'awaiting_registration' ? 'Create passkey' : phase === 'awaiting_possession' ? 'Confirm passkey' : '';
  next.hidden = !label || busy || alreadyHere; next.textContent = label; next.disabled = busy;
  signIn.hidden = phase !== 'ready' && !alreadyHere;
  if (status.dataset.state !== 'error') status.dataset.state = waiting() ? 'busy' : 'ready';
}
async function run(action: () => Promise<void>) {
  if (busy || disposed) return;
  busy = true; render();
  try { await action(); }
  catch (error) {
    if (error instanceof DOMException && native) {
      const feedback = nativePasskeyError(error, native.signal.aborted);
      message(feedback.message, feedback.state === 'error');
    } else message(error instanceof Error ? error.message : 'Adding the device is unavailable. Check again.', true);
  } finally { native = null; busy = false; if (!disposed) render(); }
}
async function assertion(challenge: string, rpId: string) {
  if (rpId !== location.hostname || !window.isSecureContext) throw new Error('Open the original secure account page.');
  native = new AbortController(); render();
  // Discoverable on purpose: Center pins the expected passkey when it verifies.
  const value = await navigator.credentials.get({ publicKey: { rpId, challenge: challengeBytes(challenge), userVerification: 'required', timeout: 90000 }, signal: native.signal });
  if (!(value instanceof PublicKeyCredential) || !(value.response instanceof AuthenticatorAssertionResponse)) throw new Error('The passkey response is unavailable.');
  const response = value.response; native = null;
  return { credentialId: encode(value.rawId), userHandle: response.userHandle ? encode(response.userHandle) : null,
    authenticatorData: encode(response.authenticatorData), clientDataJSON: encode(response.clientDataJSON), signature: encode(response.signature) };
}
async function advance() {
  if (!view) return;
  if (view.phase === 'awaiting_registration' && view.registration) {
    message('Use Face ID, Touch ID, a screen lock, or a security key.'); native = new AbortController(); render();
    const passkeyName = view.passkeyName ?? defaultPasskeyName();
    let value: Credential | null;
    try {
      value = await navigator.credentials.create({ publicKey: { rp: { id: view.rpId, name: 'Signa' },
        user: { id: decode(view.registration.userHandle), name: passkeyName, displayName: passkeyName },
        challenge: decode(view.registration.challenge), pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        // The account's passkeys share this user handle: a passkey manager that holds one would replace it.
        excludeCredentials: view.registration.excludeCredentialIds.map(id => ({ type: 'public-key' as const, id: decode(id) })),
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
        attestation: 'none', timeout: 90000 }, signal: native.signal });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'InvalidStateError')) throw error;
      native = null; alreadyHere = true;
      message('This device already has your account’s passkey. Sign in here instead.'); return;
    }
    if (!(value instanceof PublicKeyCredential) || !(value.response instanceof AuthenticatorAttestationResponse)) throw new Error('The passkey response is unavailable.');
    native = null;
    accept(await request('register', { type: 'public-key', credentialId: encode(value.rawId), rawId: encode(value.rawId),
      clientDataJSON: encode(value.response.clientDataJSON), attestationObject: encode(value.response.attestationObject), passkeyName }));
    if ((view as WalletDeviceView | null)?.phase === 'awaiting_possession') await advance();
  } else if (view.phase === 'awaiting_possession' && view.possession) {
    const document = view.possession.document as unknown as TypedDataDefinition;
    if (hashTypedData(document) !== view.possession.challenge) invalid();
    message('Confirm the new passkey in the prompt.');
    const proved = await request('prove', { assertion: await assertion(view.possession.challenge, view.rpId) });
    accept(proved); if (typeof proved.sessionClaim === 'string') sessionClaim = proved.sessionClaim;
  } else if (view.phase === 'awaiting_activation') {
    accept(await request('activate', {}));
    if ((view as WalletDeviceView | null)?.phase === 'ready') await session();
  }
}
// The passkey this device just proved signs it in once it is added: no second prompt. Only when that
// is not on offer (a restarted server, an old link) does "Sign in on this device" remain.
let sessionTried = false, sessionClaim: string | null = null;
async function session() {
  if (sessionTried || !linkToken || !sessionClaim) return;
  sessionTried = true; message('Signing in on this device…');
  try {
    const response = await fetch(`${base}/devices/link/session`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { 'content-type': 'application/json', 'x-center-wallet-request': '1' }, body: JSON.stringify({ linkToken, claim: sessionClaim }) });
    if (!response.ok) throw new Error('not on offer');
    location.replace(base || '/');
  } catch { message(steps.ready + ' Sign in with its passkey.'); render(); }
}
async function poll() {
  if (disposed || busy || !polling()) return;
  try {
    accept(await request('state', {}));
    if (view?.phase === 'awaiting_activation') await run(advance);
    else if (view?.phase === 'ready') await run(session);
  }
  catch { /* keep polling */ } finally { render(); }
}
next.addEventListener('click', () => void run(advance));
setInterval(() => void poll(), 3000);
window.addEventListener('pagehide', () => { disposed = true; });
void run(async () => {
  if (!linkToken) throw new Error('Open this page from the link your account showed.');
  accept(await request('state', {}));
  if (view?.phase === 'awaiting_activation') await advance();
  else if (view?.phase === 'awaiting_registration' || view?.phase === 'awaiting_possession') {
    // Open the passkey prompt at once. A browser that wants a tap first, or a dismissed prompt,
    // leaves the button for the user rather than an error.
    try { await advance(); }
    catch (error) { if (!(error instanceof DOMException && error.name === 'NotAllowedError') || !view) throw error; native = null; message(steps[view.phase]); }
  }
});
