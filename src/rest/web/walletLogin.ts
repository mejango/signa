import { base } from './walletBase.js';
import { encode, type Proof } from './ceremony.js';
/** The passkey login the wallet page and the signup page share: begin, the one prompt, then complete.
 * A completion whose reply was lost completes again with the same proof, after checking whether its
 * session already arrived; it never asks for the passkey twice. Each page is its own bundle, so this
 * state is that page's. */
type Json = Record<string, any>;
type Send = (path: string, body?: unknown, proof?: string, timeoutMs?: number) => Promise<Json>;
type Prove = (challenge: Uint8Array<ArrayBuffer>, rpId: string) => Promise<Proof>;
let send: Send, say: (text: string) => void, invalid: () => never;
/** The proved login waiting on its completion; it outlives a failed reply so a retry sends the same proof. */
export let pendingLogin: { loginId: string; csrf: string; assertion: Proof } | null = null;
let attempted = false;
export function loginWith(request: Send, status: (text: string) => void, unverifiable: () => never) { send = request; say = status; invalid = unverifiable; }
export function forgetLogin() { pendingLogin = null; attempted = false; }

/** Retries a 503 while the wallet's authority is being checked. Reads stop after three quick attempts;
 * an action the person is waiting on (`attempts`, `delayMs`) may wait out a hosted authority refresh,
 * which takes tens of seconds after the account has been idle. */
export async function whileChecking(path: string, body?: unknown, proof?: string, timeoutMs?: number, attempts = 3, delayMs?: number): Promise<Json> {
  for (let attempt = 0; ; attempt++) {
    try { return await send(path, body, proof, timeoutMs); }
    catch (error) {
      if ((error as { status?: number }).status !== 503 || attempt === attempts - 1) throw error;
      say('Checking current wallet access. This may take a moment…');
      await new Promise(resolve => setTimeout(resolve, delayMs ?? (attempt + 1) * 400));
    }
  }
}
function bytes(value: unknown) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) invalid();
  const decoded = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
  if (encode(decoded.buffer) !== value) invalid();
  return decoded;
}
/** Begins a login at `path` and runs its one passkey prompt. `token` names the begun flow's own proof:
 * the CSRF token of a page login, or the flow token of a framed one. */
export async function beginLogin(path: string, token: 'csrfToken' | 'flowToken', prove: Prove, rpId: string) {
  const begun = await send(path, {}), publicKey = begun.publicKey ?? invalid(), challenge = bytes(publicKey.challenge);
  bytes(begun[token]);
  if (publicKey.rpId !== rpId || publicKey.userVerification !== 'required' || publicKey.timeout !== 90000
    || typeof begun.loginId !== 'string' || !begun.loginId || begun.loginId.length > 36 || !(begun.expiresAtMs > Date.now())) invalid();
  return { loginId: begun.loginId as string, token: begun[token] as string, assertion: await prove(challenge, rpId) };
}
/** A page login, answered with its session; a pending one completes again instead of asking for the passkey. */
export async function passkeyLogin(prove: Prove, rpId: string): Promise<Json> {
  if (!pendingLogin) {
    const { loginId, token, assertion } = await beginLogin(`${base}/login/begin`, 'csrfToken', prove, rpId);
    pendingLogin = { loginId, csrf: token, assertion }; attempted = false;
  }
  const { loginId, csrf, assertion } = pendingLogin;
  say('Confirming your account access…');
  if (attempted) {
    // Success headers can install the session and clear the flow cookie before its body arrives.
    // Only this exact login recovers it; another tab's session neither replaces it nor its CSRF.
    const recovered = await whileChecking(`${base}/session`);
    if (recovered.session?.loginId === loginId) { forgetLogin(); return recovered; }
  }
  attempted = true;
  // Completion may refresh the account's authority on Base first; the site holds the request up to 90 s.
  say('Checking your account. This can take up to a minute…');
  const result = await whileChecking(`${base}/login/complete`, { loginId, assertion }, csrf, 100_000);
  if (result.session?.loginId !== loginId) invalid();
  forgetLogin(); return result;
}
