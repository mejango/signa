import { createHash, timingSafeEqual } from 'node:crypto';
import { RestError } from '../core.js';
import { validateWalletRpConfiguration } from './webauthn.js';
import type { WalletAssertion } from './webauthn.js';

export const walletSessionCookie = '__Host-center-wallet';
export const walletFlowCookie = '__Host-center-wallet-flow';
export const walletSignupCookie = '__Host-center-wallet-signup';
export const walletSignupResumeCookie = '__Host-center-wallet-signup-resume';
export const walletRecoveryCookie = '__Host-center-wallet-recovery';
export const walletRecoveryResumeCookie = '__Host-center-wallet-recovery-resume';
export const walletLaunchCookie = '__Host-center-wallet-launch';
export type WalletCookieName = typeof walletSessionCookie | typeof walletFlowCookie | typeof walletSignupCookie | typeof walletSignupResumeCookie
  | typeof walletRecoveryCookie | typeof walletRecoveryResumeCookie | typeof walletLaunchCookie;

/** Coinbase's Apple Pay button is the one frame the account page embeds; it needs the Payment Request API. */
export const walletPageHeaders = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-src https://pay.coinbase.com; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY', 'Permissions-Policy': 'publickey-credentials-get=(self), publickey-credentials-create=(self), payment=(self "https://pay.coinbase.com")',
};

function invalid(status = 400, code = 'WALLET_HTTP_INVALID'): never {
  throw new RestError(status, code, 'Wallet request fields or browser context are invalid.');
}
function secret(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)
    || Buffer.from(value, 'base64url').toString('base64url') !== value) invalid();
  return value;
}
function cookieName(name: WalletCookieName): void {
  if (![walletSessionCookie, walletFlowCookie, walletSignupCookie, walletSignupResumeCookie, walletRecoveryCookie, walletRecoveryResumeCookie, walletLaunchCookie].includes(name)) invalid();
}
export function walletLaunchClaim(value: string) {
  if (typeof value !== 'string' || value.length !== 176 || !/^[A-Za-z0-9_-]{43}\.0x[0-9a-f]{130}$/.test(value)) invalid();
  const [intentId, signature] = value.split('.'); secret(intentId);
  return { intentId: intentId!, signature: signature! as `0x${string}` };
}
function cookieToken(name: WalletCookieName, token: string): string {
  if (name === walletLaunchCookie) { walletLaunchClaim(token); return token; }
  return secret(token);
}

/** Central cookies never inherit the general API's trusted-app CORS policy. Reverse proxy
 * TLS termination may change the local scheme; it may not substitute Host or browser Origin. */
export function assertWalletHttpHost(request: Request, origin: string): void {
  const configured = new URL(origin);
  validateWalletRpConfiguration({ origin, rpId: configured.hostname });
  const host = request.headers.get('host') ?? new URL(request.url).host;
  if (host !== configured.host) invalid(403, 'WALLET_HTTP_ORIGIN');
}
export function assertWalletHttpRequest(request: Request, origin: string, mode: 'navigation' | 'central'): void {
  assertWalletHttpHost(request, origin);
  if (mode === 'navigation') {
    if (request.method !== 'GET') invalid(405, 'WALLET_HTTP_METHOD');
    return;
  }
  if (mode !== 'central' || request.method !== 'POST') invalid(405, 'WALLET_HTTP_METHOD');
  const site = request.headers.get('sec-fetch-site');
  if (request.headers.get('origin') !== origin || (site !== null && !['same-origin', 'none'].includes(site))
    || request.headers.get('x-center-wallet-request') !== '1') invalid(403, 'WALLET_HTTP_ORIGIN');
  if (!/^application\/json(?:; ?charset=utf-8)?$/i.test(request.headers.get('content-type') ?? ''))
    invalid(415, 'WALLET_HTTP_CONTENT_TYPE');
}

/** Reject duplicate cookie names instead of choosing whichever value a parser encounters first. */
export function readWalletCookie(request: Request, name: WalletCookieName): string | null {
  cookieName(name);
  const header = request.headers.get('cookie');
  if (header === null) return null;
  if (header.length > 8192) invalid();
  let found: string | null = null;
  for (const part of header.split(';')) {
    const pair = part.trim(), separator = pair.indexOf('=');
    if ((separator < 0 ? pair : pair.slice(0, separator).trim()) !== name) continue;
    if (found !== null || separator < 0) invalid();
    found = cookieToken(name, pair.slice(separator + 1));
  }
  return found;
}
export function walletCookie(name: WalletCookieName, token: string | null, maxAge: number): string {
  cookieName(name);
  // New proofs expire after 3min in the store. A flow bearer survives that deadline solely
  // to recover the original live 1h session when its committed response was lost.
  const maximum = name === walletLaunchCookie ? 930 : name === walletFlowCookie ? 3780 : [walletSignupCookie, walletSignupResumeCookie, walletRecoveryCookie, walletRecoveryResumeCookie].includes(name) ? 86400 : 3600;
  if (!Number.isSafeInteger(maxAge) || maxAge < 0 || maxAge > maximum
    || ((token === null) !== (maxAge === 0))) invalid();
  return `${name}=${token === null ? '' : cookieToken(name, token)}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
}
export function walletCsrfToken(token: string): string {
  return createHash('sha256').update('center-wallet-csrf-v1\0' + secret(token)).digest('base64url');
}
export function assertWalletCsrf(request: Request, token: string): void {
  const expected = Buffer.from(walletCsrfToken(token));
  const supplied = Buffer.from(request.headers.get('x-center-wallet-csrf') ?? '');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) invalid(403, 'WALLET_HTTP_CSRF');
}

export function walletHttpBytes(value: unknown, min: number, max = min): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(max * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) invalid();
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length < min || decoded.length > max || decoded.toString('base64url') !== value) invalid();
  return decoded;
}
export function walletHttpAssertion(value: unknown): WalletAssertion {
  const names = ['credentialId', 'userHandle', 'authenticatorData', 'clientDataJSON', 'signature'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) invalid();
  const a = value as Record<string, unknown>;
  walletHttpBytes(a.credentialId, 1, 1023);
  if (a.userHandle !== null) walletHttpBytes(a.userHandle, 1, 64);
  return { credentialId: a.credentialId as string, userHandle: a.userHandle as string | null,
    authenticatorData: walletHttpBytes(a.authenticatorData, 37), clientDataJSON: walletHttpBytes(a.clientDataJSON, 1, 2048), signature: walletHttpBytes(a.signature, 8, 72) };
}

/** Bound bytes and total body-read time before parsing. No raw body or caller values enter errors. */
async function readWalletBody(request: Request, timeoutMs = 5000, maximumBytes = 16384): Promise<string> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) invalid();
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^(0|[1-9][0-9]{0,4})$/.test(declared) || Number(declared) > maximumBytes))
    invalid(413, 'WALLET_HTTP_BODY_LIMIT');
  if (!request.body || request.bodyUsed) invalid();
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  const deadline = performance.now() + timeoutMs;
  const timedOut = () => new RestError(408, 'WALLET_HTTP_BODY_TIMEOUT', 'Wallet request body did not arrive in time.');
  const checkDeadline = () => {
    if (performance.now() >= deadline) { void reader.cancel().catch(() => {}); throw timedOut(); }
  };
  let timer: ReturnType<typeof setTimeout> | undefined, length = 0;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(timedOut());
      void reader.cancel().catch(() => {});
    }, timeoutMs);
  });
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), timeout]);
      checkDeadline();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximumBytes) { void reader.cancel().catch(() => {}); invalid(413, 'WALLET_HTTP_BODY_LIMIT'); }
      chunks.push(chunk.value);
    }
    if (declared !== null && length !== Number(declared)) invalid();
    let value: string;
    try { value = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
    catch { invalid(); }
    checkDeadline();
    return value;
  } finally { clearTimeout(timer); reader.releaseLock(); }
}
export async function readWalletJson(request: Request, timeoutMs = 5000): Promise<Record<string, unknown>> {
  const deadline = performance.now() + timeoutMs;
  const body = await readWalletBody(request, timeoutMs);
  let value: unknown;
  try { value = JSON.parse(body); } catch { invalid(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  if (performance.now() >= deadline) throw new RestError(408, 'WALLET_HTTP_BODY_TIMEOUT', 'Wallet request body did not arrive in time.');
  return value as Record<string, unknown>;
}
/** The app's launch form, submitted into this tab, a window the app opened, or (`framed`) a frame the
 * app owns; the route decides whether that app may frame. */
export async function readWalletLaunchForm(request: Request) {
  const destination = request.headers.get('sec-fetch-dest');
  if (request.method !== 'POST' || (destination !== 'document' && destination !== 'iframe')
    || request.headers.get('sec-fetch-mode') !== 'navigate') invalid(403, 'WALLET_HTTP_ORIGIN');
  if (!/^application\/x-www-form-urlencoded(?:; ?charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')) invalid(415, 'WALLET_HTTP_CONTENT_TYPE');
  const fields = new URLSearchParams(await readWalletBody(request, 5000, 512));
  if (fields.size !== 2 || fields.getAll('intentId').length !== 1 || fields.getAll('signature').length !== 1) invalid();
  return { ...walletLaunchClaim(`${fields.get('intentId')}.${fields.get('signature')}`), framed: destination === 'iframe' };
}
