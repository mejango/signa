/** The runner the passkey ceremony pages share (signup, recovery and the added device): one action at
 * a time, the native passkey prompt it may hold open, and the status line with its spinning mark. A
 * page keeps its own phases, copy and requests, and says how a failed action reads. Each page is its
 * own bundle, so this state is that page's. */
export type CeremonyFailure = { message: string; state: 'ready' | 'error' };
let status: HTMLElement, working: () => boolean, render: () => void;
let failed: (error: unknown, prompt: AbortController | null) => CeremonyFailure | Promise<CeremonyFailure>;
let shown: ((value: string) => void) | undefined;
/** `engaged`: a person is waiting on the action, so the controls dim; a background poll runs quiet.
 * `native`: the open passkey prompt, which the page's Cancel aborts. */
export let busy = false, engaged = false, native: AbortController | null = null, disposed = false;

/** `working`: the service is moving the page on by itself, so the mark spins. `failed`: how a failed action
 * reads; it may re-read the page's state first, and `prompt` is the native prompt it came from. `onShown`:
 * called after the status line changes, for a page that marks some lines. */
export function ceremony(line: HTMLElement, isWorking: () => boolean, draw: () => void,
  onFailed: (error: unknown, prompt: AbortController | null) => CeremonyFailure | Promise<CeremonyFailure>, onShown?: (value: string) => void) {
  status = line; working = isWorking; render = draw; failed = onFailed; shown = onShown;
  window.addEventListener('pagehide', leave, { once: true });
}
/** The page is leaving: nothing runs or repaints after this, and an open prompt closes. */
export function leave() { disposed = true; native?.abort(); }
/** Work in flight spins the mark; a prompt waiting on the person does not. */
export const waiting = () => (busy && !native) || working();
export function message(value: string, error = false) {
  status.textContent = value; status.dataset.state = error ? 'error' : waiting() ? 'busy' : 'ready'; shown?.(value);
}
export function spin() {
  if (waiting()) { if (status.dataset.state !== 'error') status.dataset.state = 'busy'; }
  else if (status.dataset.state === 'busy') status.dataset.state = 'ready';
}
export async function run(action: () => Promise<void>, quiet = false) {
  if (busy || disposed) return;
  busy = true; engaged = !quiet; render();
  try { await action(); }
  catch (error) { const failure = await failed(error, native); message(failure.message, failure.state === 'error'); }
  finally { native = null; busy = false; engaged = false; if (!disposed) render(); }
}
/** Opens one native passkey prompt; a failure keeps `native` set for the failure's reading. */
export async function prompt<T>(open: (signal: AbortSignal) => Promise<T>): Promise<T> {
  native = new AbortController(); render();
  const value = await open(native.signal); native = null; return value;
}
export const encode = (value: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
/** One assertion over `challenge`, for this host only. Discoverable on purpose: Center pins the expected
 * passkey when it verifies, and an allow list only lets iOS refuse a passkey it cannot preselect. */
export async function assertion(challenge: Uint8Array<ArrayBuffer>, rpId: string) {
  if (rpId !== location.hostname || !window.isSecureContext) throw new Error('Open the original secure account page.');
  return proof(await prompt(signal => navigator.credentials.get({ publicKey: { rpId, challenge, userVerification: 'required', timeout: 90000 }, signal })));
}
/** The assertion's fields as the service reads them. */
export function proof(value: Credential | null, unavailable = () => { throw new Error('The passkey response is unavailable.'); }) {
  if (!(value instanceof PublicKeyCredential) || !(value.response instanceof AuthenticatorAssertionResponse)) return unavailable();
  const response = value.response;
  return { credentialId: encode(value.rawId), userHandle: response.userHandle ? encode(response.userHandle) : null,
    authenticatorData: encode(response.authenticatorData), clientDataJSON: encode(response.clientDataJSON), signature: encode(response.signature) };
}
export type Proof = ReturnType<typeof proof>;
