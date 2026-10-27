import { toHex, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { RestClientError, type ClientOptions } from './index.js';
import { CenterClient } from './center.js';
import { createCenterWalletPaymentClient, createCenterWalletReviewClient } from './walletPayments.js';
import {
  validateWalletHandoffToken, walletHandoffPkceChallenge, walletHandoffCodeHash,
  walletHandoffRequestDocument, walletHandoffExchangeDocument, walletHandoffLaunchDocument, type WalletHandoffRequest,
} from '../wallet/sharedHandoff.js';
import type { WalletAppGrant } from '../wallet/appGrants.js';
import { walletAppGrantMaximumLifetimeSeconds } from '../wallet/grantLifetime.js';

export interface CenterWalletStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export interface CenterWalletClientOptions {
  /** Fixed trusted transport origin; never taken from a callback or discovery response. */
  issuer: string;
  audience: string;
  callbackUri: string;
  /** Defaults to this tab's sessionStorage. The adapter must preserve exact values across redirects. */
  storage?: CenterWalletStorage;
  fetch?: typeof fetch;
  /** Unix milliseconds. */
  now?: () => number;
  timeoutMs?: number;
  /** replace must remove the query using history.replaceState, without navigating. */
  location?: { href(): string; replace(url: string): void };
}
export interface CenterWalletConnection {
  readonly accountId: string;
  readonly address: Address;
  readonly chainId: 8453;
  /** Unix seconds. This is the original grant expiry, including after receipt recovery. */
  readonly expiresAt: number;
  readonly capabilities: readonly ['read', 'plan', 'relay'];
  /** API access only. Transactions still require fresh owner approval at Center. */
  readonly client: CenterClient;
}
export interface CenterWalletPreparedConnection {
  readonly intentId: string;
  /** Public locator only. Use launch() to establish browser continuity before navigation. */
  readonly authorizationUrl: string;
  readonly expiresAtMs: number;
  /** Navigates this tab, or a window the app opened by name (`target`), to Center. */
  readonly launch: (options?: { target?: string }) => void;
}
interface Intent {
  id: string;
  request: WalletHandoffRequest;
  state: 'prepared';
  createdAtMs: number;
  expiresAtMs: number;
}
interface Saved {
  version: 'center-wallet-client-v1';
  key: Hex;
  verifier?: string;
  request: WalletHandoffRequest;
  signature: Hex;
  intent?: Intent;
  exchange?: { code: string; signature?: Hex };
  grant?: WalletAppGrant;
}
const maximumBytes = 32 * 1024;
const requestFields = ['version', 'issuer', 'origin', 'callbackUri', 'audience', 'appGeneration', 'requestKey',
  'state', 'codeChallenge', 'nonce', 'issuedAtMs', 'expiresAtMs'];
function fail(code: string, message: string): never { throw new RestClientError(code, message); }
function invalid(): never { return fail('WALLET_RESPONSE_INVALID', 'Center returned an invalid wallet connection response.'); }
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const fields = Object.keys(value);
  if (required.some(key => !fields.includes(key)) || fields.some(key => !required.includes(key) && !optional.includes(key))) invalid();
  return value as Record<string, unknown>;
}
function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function signature(value: unknown): value is Hex { return typeof value === 'string' && /^0x[0-9a-f]{130}$/.test(value); }
function canonicalOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512 || /[^\x21-\x7e]|[*\\%?#]/.test(value)) invalid();
  let url: URL;
  try { url = new URL(value); } catch { return invalid(); }
  if (url.origin !== value || url.username || url.password || (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) invalid();
  return value;
}
function canonicalCallback(value: unknown, origin: string): string {
  if (typeof value !== 'string' || value.length > 2048 || /[^\x21-\x7e]|[*\\%?#]/.test(value)) invalid();
  let url: URL;
  try { url = new URL(value); } catch { return invalid(); }
  if (url.href !== value || url.origin !== origin || url.username || url.password || url.pathname.includes('//')) invalid();
  return value;
}
function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** Redirect continuity and exact receipt recovery for an app's local request key. No wallet owner key is created here. */
export function createCenterWalletClient(options: CenterWalletClientOptions) {
  let issuer: string, audience: string, callbackUri: string, origin: string;
  try {
    issuer = canonicalOrigin(options.issuer); audience = canonicalOrigin(options.audience);
    origin = canonicalOrigin(new URL(options.callbackUri).origin);
    callbackUri = canonicalCallback(options.callbackUri, origin);
  } catch { return fail('WALLET_CONFIG_INVALID', 'Use fixed canonical Center origins and an exact app callback URI.'); }
  const now = options.now ?? Date.now, transport = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!integer(timeoutMs) || timeoutMs > 60_000) fail('WALLET_CONFIG_INVALID', 'Use a wallet request timeout from 1 to 60000 milliseconds.');
  const location = options.location ?? {
    href: () => globalThis.location.href,
    replace: (url: string) => globalThis.history.replaceState(null, '', url),
  };
  const storageKey = 'center.wallet.connection.v1:' + issuer + ':' + callbackUri;
  let disconnectVersion = 0;
  function clock(): number {
    const value = now();
    if (!integer(value)) fail('WALLET_CONFIG_INVALID', 'The wallet connection clock is invalid.');
    return value;
  }
  function storage(): CenterWalletStorage {
    try { return options.storage ?? globalThis.sessionStorage; }
    catch { return fail('WALLET_STORAGE_UNAVAILABLE', 'This tab needs session storage to keep its wallet connection.'); }
  }
  function raw(): string | null {
    try { return storage().getItem(storageKey); }
    catch { return fail('WALLET_STORAGE_UNAVAILABLE', 'This tab could not read its wallet connection.'); }
  }
  function save(value: Saved, expected: string | null): string {
    const encoded = JSON.stringify(value);
    if (raw() !== expected) fail('WALLET_HANDOFF_CHANGED', 'This tab changed its wallet connection. Resume the current connection.');
    try {
      if (new TextEncoder().encode(encoded).length > maximumBytes) throw new Error();
      storage().setItem(storageKey, encoded);
      if (storage().getItem(storageKey) !== encoded) throw new Error();
    } catch { return fail('WALLET_STORAGE_UNAVAILABLE', 'This tab could not preserve its wallet connection.'); }
    return encoded;
  }
  function checkRequest(value: unknown): WalletHandoffRequest {
    const r = object(value, requestFields);
    if (r.version !== 'center-wallet-handoff-request-v1' || r.issuer !== issuer || r.audience !== audience ||
      r.origin !== origin || r.callbackUri !== callbackUri || !integer(r.appGeneration) ||
      !integer(r.issuedAtMs) || !integer(r.expiresAtMs) || r.expiresAtMs <= r.issuedAtMs ||
      r.expiresAtMs - r.issuedAtMs > 900_000 || typeof r.requestKey !== 'string' ||
      !/^0x[0-9a-f]{40}$/.test(r.requestKey) || BigInt(r.requestKey) <= 1n ||
      typeof r.nonce !== 'string' || !/^0x[0-9a-f]{64}$/.test(r.nonce)) invalid();
    try { validateWalletHandoffToken(r.state); validateWalletHandoffToken(r.codeChallenge); } catch { invalid(); }
    return r as unknown as WalletHandoffRequest;
  }
  function checkIntent(value: unknown, request: WalletHandoffRequest): Intent {
    const intent = object(value, ['id', 'request', 'state', 'createdAtMs', 'expiresAtMs']);
    try { validateWalletHandoffToken(intent.id); } catch { invalid(); }
    const returned = checkRequest(intent.request);
    if (requestFields.some(field => returned[field as keyof WalletHandoffRequest] !== request[field as keyof WalletHandoffRequest]) ||
      intent.state !== 'prepared' || !integer(intent.createdAtMs) || intent.createdAtMs > clock() + 30_000 ||
      intent.createdAtMs < request.issuedAtMs - 30_000 || intent.expiresAtMs !== request.expiresAtMs ||
      intent.createdAtMs >= request.expiresAtMs) invalid();
    return intent as unknown as Intent;
  }
  function checkGrant(value: unknown, request: WalletHandoffRequest): WalletAppGrant {
    const g = object(value, ['kind', 'id', 'incarnation', 'accountId', 'signerAddress', 'scopes', 'origin', 'callbackUri',
      'audience', 'appGeneration', 'authorityEpoch', 'sessionEpoch', 'createdAt', 'expiresAt', 'revokedAt', 'retainUntil']);
    const epoch = (value: unknown) => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
    if (g.kind !== 'wallet-app' || typeof g.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(g.id) ||
      !epoch(g.incarnation) || !epoch(g.authorityEpoch) || !epoch(g.sessionEpoch) ||
      typeof g.accountId !== 'string' || !/^eip155:8453:0x[0-9a-f]{40}$/.test(g.accountId) || BigInt(g.accountId.slice(12)) <= 1n ||
      g.signerAddress !== request.requestKey || g.signerAddress === g.accountId.slice(12) ||
      !Array.isArray(g.scopes) || g.scopes.length !== 3 || g.scopes.join(',') !== 'read,plan,relay' ||
      g.origin !== origin || g.callbackUri !== callbackUri || g.audience !== audience || g.appGeneration !== request.appGeneration ||
      !integer(g.createdAt) || g.createdAt > Math.floor(clock() / 1000) + 30 || !integer(g.expiresAt) ||
      g.expiresAt <= g.createdAt || g.expiresAt - g.createdAt > walletAppGrantMaximumLifetimeSeconds || g.revokedAt !== null ||
      !integer(g.retainUntil) || g.retainUntil !== g.expiresAt + 86400) invalid();
    return g as unknown as WalletAppGrant;
  }
  function read(): { value: Saved; encoded: string } | null {
    const encoded = raw();
    if (encoded === null) return null;
    try {
      if (new TextEncoder().encode(encoded).length > maximumBytes) invalid();
      const v = object(JSON.parse(encoded), ['version', 'key', 'request', 'signature'], ['verifier', 'intent', 'exchange', 'grant']);
      if (v.version !== 'center-wallet-client-v1' || typeof v.key !== 'string' || !/^0x[0-9a-f]{64}$/.test(v.key) || !signature(v.signature)) invalid();
      const request = checkRequest(v.request);
      if (privateKeyToAccount(v.key as Hex).address.toLowerCase() !== request.requestKey) invalid();
      if (v.grant === undefined || v.verifier !== undefined) {
        if (walletHandoffPkceChallenge(v.verifier) !== request.codeChallenge) invalid();
      }
      if (v.intent !== undefined) checkIntent(v.intent, request);
      if (v.exchange !== undefined) {
        const exchange = object(v.exchange, ['code'], ['signature']);
        if (!v.intent || typeof v.verifier !== 'string' || (exchange.signature !== undefined && !signature(exchange.signature))) invalid();
        validateWalletHandoffToken(exchange.code);
      }
      if (v.grant !== undefined) {
        if (!v.intent) invalid();
        checkGrant(v.grant, request);
      }
      return { value: v as unknown as Saved, encoded };
    } catch { return fail('WALLET_STORAGE_INVALID', 'This tab has an invalid saved wallet connection. Disconnect it before starting again.'); }
  }
  async function json(path: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const monotonicNow = () => globalThis.performance?.now() ?? Date.now(), deadlineAt = monotonicNow() + timeoutMs;
    const checkDeadline = () => {
      if (controller.signal.aborted || monotonicNow() >= deadlineAt) {
        controller.abort();
        fail('WALLET_NETWORK_ERROR', 'The wallet request timed out. Retry the pending connection.');
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new RestClientError('WALLET_NETWORK_ERROR', 'The wallet request timed out. Retry the pending connection.')); }, timeoutMs);
    });
    const execute = async () => {
      const response = await transport(issuer + path, { method: body === undefined ? 'GET' : 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
        signal: controller.signal, headers: { accept: 'application/json', 'x-center-wallet-request': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (controller.signal.aborted || monotonicNow() >= deadlineAt) {
        void response.body?.cancel().catch(() => {});
        checkDeadline();
      }
      if (response.redirected || (response.url && response.url !== issuer + path)) {
        void response.body?.cancel().catch(() => {}); invalid();
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        // A 429 or 5xx is Center unavailable for the moment, not a verdict on the request: the
        // saved record stays usable and a later attempt may complete it. A 4xx is a verdict.
        if (response.status === 429 || response.status >= 500)
          return fail('WALLET_NETWORK_ERROR', 'The wallet request could not complete. Retry the pending connection.');
        return fail('WALLET_REQUEST_REJECTED', 'Center rejected the wallet request. The pending connection has been preserved.');
      }
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') ||
        Number(response.headers.get('content-length')) > maximumBytes || !response.body) {
        void response.body?.cancel().catch(() => {}); invalid();
      }
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      const cancel = () => { void reader.cancel().catch(() => {}); };
      controller.signal.addEventListener('abort', cancel, { once: true });
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          checkDeadline();
          if (part.done) break;
          size += part.value.length;
          if (size > maximumBytes) invalid();
          chunks.push(part.value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        let decoded: unknown;
        try { decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return invalid(); }
        checkDeadline();
        return decoded;
      } finally { controller.signal.removeEventListener('abort', cancel); cancel(); reader.releaseLock(); }
    };
    try { return await Promise.race([execute(), deadline]); }
    catch (error) {
      if (error instanceof RestClientError) throw error;
      return fail('WALLET_NETWORK_ERROR', 'The wallet request could not complete. Retry the pending connection.');
    } finally { clearTimeout(timer); }
  }
  async function prepared(intent: Intent): Promise<CenterWalletPreparedConnection> {
    const pending = read();
    if (!pending?.value.intent || pending.value.intent.id !== intent.id || pending.value.exchange || pending.value.grant)
      fail('WALLET_HANDOFF_CHANGED', 'This tab changed its wallet connection. Start again from the app.');
    const signature = await privateKeyToAccount(pending.value.key).signTypedData(walletHandoffLaunchDocument({request:intent.request,intentId:intent.id}));
    if (raw() !== pending.encoded) fail('WALLET_HANDOFF_CHANGED', 'This tab changed its wallet connection. Start again from the app.');
    return Object.freeze({ intentId: intent.id, authorizationUrl: issuer + '/wallet?intent=' + intent.id, expiresAtMs: intent.expiresAtMs,
      launch(launchOptions?: { target?: string }) {
        const target = launchOptions?.target ?? '_self';
        if (target !== '_self' && !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(target))
          fail('WALLET_LAUNCH_UNAVAILABLE', 'Launch into this tab or a plainly named window the app opened.');
        if (raw() !== pending.encoded || intent.expiresAtMs <= clock())
          fail('WALLET_HANDOFF_CHANGED', 'This tab changed or expired its wallet connection. Start again from the app.');
        if (globalThis.location?.origin !== origin || !globalThis.document?.body)
          fail('WALLET_LAUNCH_UNAVAILABLE', 'Open the wallet connection from its original app tab.');
        const form = document.createElement('form');
        form.method = 'POST'; form.action = issuer + '/wallet/launch'; form.target = target; form.hidden = true;
        for (const [name, value] of Object.entries({intentId:intent.id, signature})) {
          const input = document.createElement('input'); input.type = 'hidden'; input.name = name; input.value = value; form.append(input);
        }
        try { document.body.append(form); HTMLFormElement.prototype.submit.call(form); }
        catch { fail('WALLET_LAUNCH_UNAVAILABLE', 'The wallet connection could not open. Try again from the app.'); }
        finally { form.remove(); }
      } });
  }
  function connection(saved: Saved): CenterWalletConnection {
    const grant = saved.grant!;
    const signer = privateKeyToAccount(saved.key);
    const ensureActive = () => {
      const current = read()?.value;
      if (!current?.grant || current.key !== saved.key || current.grant.id !== grant.id ||
        current.grant.incarnation !== grant.incarnation || current.grant.accountId !== grant.accountId ||
        current.grant.expiresAt !== grant.expiresAt || grant.expiresAt <= Math.floor(clock() / 1000))
        fail('WALLET_CONNECTION_INACTIVE', 'This wallet connection is disconnected, expired or replaced.');
    };
    const config: ClientOptions = { audience, accountId: grant.accountId, grantId: grant.id, signer: {
      address: signer.address,
      signTypedData: async document => {
        ensureActive();
        const signature = document.primaryType === 'CenterRequest' ? await signer.signTypedData(document) : await signer.signTypedData(document);
        ensureActive();
        return signature;
      },
    }, fetch: (input, init) => { ensureActive(); return transport(input, init); },
      now: () => Math.floor(clock() / 1000), timeoutMs };
    return Object.freeze({ accountId: grant.accountId, address: grant.accountId.slice(12) as Address, chainId: 8453,
      expiresAt: grant.expiresAt, capabilities: Object.freeze(['read', 'plan', 'relay'] as const), client: new CenterClient(config) });
  }
  async function prepareConnection(): Promise<CenterWalletPreparedConnection> {
    const startingVersion = disconnectVersion;
    let pending = read();
    if (pending?.value.exchange) fail('WALLET_HANDOFF_PENDING', 'Recover the pending exchange before starting another connection.');
    if (pending?.value.grant) fail('WALLET_ALREADY_CONNECTED', 'Disconnect the current wallet connection before replacing it.');
    if (pending && pending.value.request.expiresAtMs <= clock()) fail('WALLET_HANDOFF_EXPIRED', 'The connection request expired. Disconnect it before starting again.');
    if (pending?.value.intent) return prepared(pending.value.intent);
    if (!pending) {
      const config = object(await json('/wallet/config?appOrigin=' + encodeURIComponent(origin)), ['version', 'issuer', 'audience', 'rpId', 'app']);
      const app = object(config.app, ['origin', 'callbackUris', 'generation']);
      if (config.version !== 'center-wallet-v1' || config.issuer !== issuer || config.audience !== audience ||
        config.rpId !== new URL(issuer).hostname || app.origin !== origin || !integer(app.generation) ||
        !Array.isArray(app.callbackUris) || app.callbackUris.length > 4 || !app.callbackUris.includes(callbackUri) ||
        new Set(app.callbackUris).size !== app.callbackUris.length) invalid();
      app.callbackUris.forEach(uri => canonicalCallback(uri, origin));
      const key = generatePrivateKey(), signer = privateKeyToAccount(key), verifier = randomToken(), issuedAtMs = clock();
      const request: WalletHandoffRequest = { version: 'center-wallet-handoff-request-v1', issuer, audience, origin, callbackUri,
        appGeneration: app.generation, requestKey: signer.address.toLowerCase() as Address, state: randomToken(), codeChallenge: walletHandoffPkceChallenge(verifier),
        nonce: toHex(crypto.getRandomValues(new Uint8Array(32))), issuedAtMs, expiresAtMs: issuedAtMs + 900_000 };
      const value: Saved = { version: 'center-wallet-client-v1', key, verifier, request, signature: await signer.signTypedData(walletHandoffRequestDocument(request)) };
      if (startingVersion !== disconnectVersion) fail('WALLET_HANDOFF_CHANGED', 'This tab disconnected its wallet connection.');
      pending = { value, encoded: save(value, null) };
    }
    const intent = checkIntent(await json('/wallet/handoff/prepare', { request: pending.value.request, signature: pending.value.signature }), pending.value.request);
    save({ ...pending.value, intent }, pending.encoded);
    return prepared(intent);
  }
  async function exchange(pending: { value: Saved; encoded: string }): Promise<CenterWalletConnection> {
    let value = pending.value;
    if (!value.intent || !value.exchange || !value.verifier) fail('WALLET_HANDOFF_MISSING', 'There is no pending wallet exchange in this tab.');
    if (!value.exchange.signature) {
      const signature = await privateKeyToAccount(value.key).signTypedData(walletHandoffExchangeDocument({ request: value.request,
        intentId: value.intent.id, codeHash: walletHandoffCodeHash(value.exchange.code) }));
      value = { ...value, exchange: { code: value.exchange.code, signature } };
      pending = { value, encoded: save(value, pending.encoded) };
    }
    const intent = value.intent!, proof = value.exchange!;
    const response = object(await json('/wallet/handoff/exchange', { intentId: intent.id, request: value.request,
      code: proof.code, verifier: value.verifier, signature: proof.signature }), ['grant', 'replayed']);
    if (typeof response.replayed !== 'boolean') invalid();
    const grant = checkGrant(response.grant, value.request);
    if (grant.expiresAt <= Math.floor(clock() / 1000)) invalid();
    // The confirmed receipt no longer needs its code or PKCE verifier. Keep only the local API key.
    const connected: Saved = { version: value.version, key: value.key, request: value.request, signature: value.signature, intent, grant };
    save(connected, pending.encoded);
    return connection(connected);
  }
  async function completeConnection(callbackUrl?: string): Promise<CenterWalletConnection> {
    const incoming = callbackUrl ?? location.href();
    // Clear the code from this page's address only when it is there: a callback delivered from
    // another window (a popup the app opened) leaves this page where it is.
    try { if (location.href().slice(0, callbackUri.length) === callbackUri) location.replace(callbackUri); }
    catch { return fail('WALLET_CALLBACK_INVALID', 'The wallet callback could not be cleared safely.'); }
    let pending = read();
    if (!pending?.value.intent || pending.value.grant) fail('WALLET_CALLBACK_INVALID', 'There is no matching wallet callback pending in this tab.');
    let code: string;
    try {
      if (typeof incoming !== 'string' || incoming.length > 4096) throw new Error();
      const url = new URL(incoming), entries = [...url.searchParams];
      if (incoming.slice(0, incoming.indexOf('?')) !== callbackUri || url.origin + url.pathname !== callbackUri || url.username || url.password || url.hash ||
        entries.length !== 3 || ['code', 'state', 'iss'].some(name => url.searchParams.getAll(name).length !== 1) ||
        url.searchParams.get('state') !== pending.value.request.state || url.searchParams.get('iss') !== issuer) throw new Error();
      code = validateWalletHandoffToken(url.searchParams.get('code'));
      if (pending.value.exchange && pending.value.exchange.code !== code) throw new Error();
    } catch { return fail('WALLET_CALLBACK_INVALID', 'The wallet callback does not match this tab and configured issuer.'); }
    if (!pending.value.exchange) {
      // Capture the code in this same task, before yielding to local proof signing or transport.
      const value: Saved = { ...pending.value, exchange: { code } };
      pending = { value, encoded: save(value, pending.encoded) };
    }
    return exchange(pending);
  }
  function restoreConnection(): CenterWalletConnection | null {
    const saved = read()?.value;
    // A cached grant is only a local connection candidate. Center rechecks authority on every request.
    return saved?.grant && saved.grant.expiresAt > Math.floor(clock() / 1000) ? connection(saved) : null;
  }
  async function retryConnection(): Promise<CenterWalletConnection> {
    const pending = read();
    if (pending?.value.grant) {
      const restored = restoreConnection();
      if (restored) return restored;
      fail('WALLET_CONNECTION_EXPIRED', 'The wallet connection expired. Disconnect it before starting again.');
    }
    if (!pending?.value.exchange) fail('WALLET_HANDOFF_MISSING', 'There is no pending wallet exchange in this tab.');
    return exchange(pending);
  }
  /** Clears this tab's local key. Account logout and server revocation remain Center actions. */
  function disconnect(): void {
    disconnectVersion++;
    try {
      storage().removeItem(storageKey);
      if (storage().getItem(storageKey) !== null) throw new Error();
    } catch { fail('WALLET_STORAGE_UNAVAILABLE', 'This tab could not clear its wallet connection.'); }
  }
  const journal = () => ({ issuer, audience, callbackUri, location, now: clock,
    storage: { getItem: (key: string) => storage().getItem(key), setItem: (key: string, value: string) => storage().setItem(key, value),
      removeItem: (key: string) => storage().removeItem(key) },
    connection: () => {
      const saved = read()?.value;
      return saved?.grant && saved.grant.expiresAt > Math.floor(clock() / 1000)
        ? { grant: structuredClone(saved.grant), client: connection(saved).client } : null;
    } });
  /** Payments of the configured token through the configured terminal. Kept for 0.5.x apps; `reviews()` covers them. */
  const payments = () => createCenterWalletPaymentClient(journal());
  /** Any call set or signature, reviewed on Signa's own page from the raw request. */
  const reviews = () => createCenterWalletReviewClient(journal());
  return Object.freeze({ prepareConnection, completeConnection, retryConnection, restoreConnection, disconnect, payments, reviews });
}
