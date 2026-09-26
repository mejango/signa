import { FAVICON_SVG } from '../../branding.js';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Hex } from 'viem';
import { RestError } from '../core.js';
import { RestAuthError } from '../auth/shared.js';
import { walletPage, walletCss } from '../web/walletPage.js';
import { walletPaymentPage, walletPaymentCss } from '../web/walletPaymentPage.js';
import { walletAppAudience, walletAppFields } from './appGrants.js';
import { validateWalletPolicyOrigin } from './policy.js';
import { validateWalletRpConfiguration } from './webauthn.js';
import type { WalletCentralSession } from './login.js';
import { verifyWalletHandoffLaunchSignature, type WalletHandoffExchangeInput, type WalletHandoffRequest } from './handoff.js';
import { assertWalletHttpHost, assertWalletHttpRequest, assertWalletCsrf, readWalletCookie,
  readWalletLaunchForm, walletLaunchClaim, walletLaunchCookie,
  readWalletJson, walletCookie, walletCsrfToken, walletFlowCookie, walletSessionCookie, walletSignupCookie, walletHttpAssertion as assertion, walletPageHeaders as pageHeaders } from './http.js';
import type { PostgresWalletLoginStore } from './loginPostgres.js';
import type { PostgresWalletHandoffStore } from './handoffPostgres.js';
import type { PostgresWalletPolicyStore } from './policyPostgres.js';
import type { PostgresWalletPaymentReviewStore } from './paymentReviewsPostgres.js';
import type { createWalletNetworks } from './networks.js';
import { publicWalletPaymentCentralReview } from './paymentPublic.js';
import { mountWalletSignup, type WalletSignupSiteOptions } from './signupSite.js';
import { mountWalletRecovery, type WalletRecoverySiteOptions } from './recoverySite.js';
import { mountWalletDevices, type WalletDeviceSiteOptions } from './deviceSite.js';

export interface WalletSiteOptions {
  origin: string;
  audience: string;
  /** Former wallet origins; requests on their hosts move to the same path on `origin`. */
  legacyOrigins?: string[];
  /** The app origins admitted to frame their own payment reviews; none by default. */
  frameableAppOrigins?: string[];
  /** Mount path of the wallet pages: (base || '/') beside other routes, '' on a dedicated host. */
  basePath?: string;
  browserScript: string;
  paymentBrowserScript?: string;
  signup?: WalletSignupSiteOptions['signup'];
  signupBrowserScript?: string;
  recovery?: WalletRecoverySiteOptions['recovery'];
  recoveryBrowserScript?: string;
  devices?: WalletDeviceSiteOptions['devices'];
  deviceBrowserScript?: string;
  login: Pick<PostgresWalletLoginStore, 'begin' | 'identifyCompletion' | 'complete' | 'identifySession' | 'identityKnown' | 'readSession' | 'viewSession' | 'logout' | 'passkeyName'>;
  handoff: Pick<PostgresWalletHandoffStore, 'prepare' | 'getIntent' | 'issue' | 'identifyExchange' | 'exchange'>
    & Partial<Pick<PostgresWalletHandoffStore, 'frameOrigin' | 'claimLaunch' | 'framedLaunch'>>;
  policy: Pick<PostgresWalletPolicyStore, 'readActivePolicy'>;
  refresh: { request(accountId: string): Promise<unknown>; tick(): Promise<unknown> };
  payments?: Pick<PostgresWalletPaymentReviewStore, 'get' | 'approve' | 'cancel'> & Partial<Pick<PostgresWalletPaymentReviewStore, 'frameOrigin'>>;
  /** The account on more chains (quote, one passkey approval, Center-paid Relayr bundle, per-chain status). */
  networks?: Pick<ReturnType<typeof createWalletNetworks>, 'list' | 'quote' | 'approve' | 'status'>;
  onEvent?: (event: { action: string; outcome: 'ok' | 'rejected' | 'unavailable'; code?: string; detail?: Record<string, unknown> }) => void;
}

function reject(status = 400, code = 'WALLET_HTTP_INVALID'): never {
  throw new RestError(status, code, 'Wallet request could not be completed.');
}
function fields(value: unknown, names: string[]): Record<string, unknown> {
  try { return walletAppFields(value, names); } catch { return reject(); }
}
function publicSession(session: WalletCentralSession, passkeyName: string | null) {
  return { loginId: session.loginId, accountId: session.accountId, walletAddress: session.accountId.slice('eip155:8453:'.length),
    chainId: 8453, expiresAtMs: session.expiresAtMs, passkeyName };
}

/** Dedicated cookie origin. Trusted app CORS applies only to credentialless discovery/handoff;
 * authority remains in the durable stores, including their final transaction-time checks. */
export function createWalletSite(options: WalletSiteOptions): Hono {
  const { login, handoff, policy, refresh, onEvent, browserScript } = options;
  const origin = validateWalletPolicyOrigin(options.origin), audience = walletAppAudience(options.audience);
  if (new URL(audience).origin === origin) reject(400, 'WALLET_HTTP_CONFIG');
  const rpId = new URL(origin).hostname;
  validateWalletRpConfiguration({ origin, rpId });
  const app = new Hono(), base = options.basePath ?? '/wallet';
  const emit = (action: string, outcome: 'ok' | 'rejected' | 'unavailable', code?: string, detail?: Record<string, unknown>) => {
    try { onEvent?.({ action, outcome, ...(code ? { code } : {}), ...(detail ? { detail } : {}) }); } catch { /* Observation cannot undo committed authority. */ }
  };
  // Bounded scalar details of a failure (stage, counts, elapsed), never payloads.
  const scalars = (error: unknown) => error instanceof RestError && error.details && typeof error.details === 'object'
    ? Object.fromEntries(Object.entries(error.details as Record<string, unknown>).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)).slice(0, 12)) : undefined;
  const protect: MiddlewareHandler = async (c, next) => {
    for (const [key, value] of Object.entries(pageHeaders)) c.header(key, value);
    assertWalletHttpHost(c.req.raw, origin);
    await next();
  };
  // A retired wallet host moves every request to the same path on the current origin, before
  // the host guard below would refuse it.
  const retiredHosts = new Set((options.legacyOrigins ?? []).map(value => new URL(value).host));
  if (retiredHosts.has(new URL(origin).host)) reject(500, 'WALLET_CONFIG_INVALID');
  app.use('*', async (c, next) => {
    const host = c.req.header('Host') ?? new URL(c.req.url).host;
    if (!retiredHosts.has(host)) return next();
    const url = new URL(c.req.url);
    for (const [key, value] of Object.entries(pageHeaders)) c.header(key, value);
    return c.redirect(origin + url.pathname + url.search, 301);
  });
  // The wallet's own paths under `base`. On the credential host nothing else may execute.
  const walletPrefixes = ['/assets/', '/authorize/', '/config', '/create', '/handoff/', '/launch', '/login/', '/logout', '/payment',
    '/networks', '/payment-reviews/', '/recover', '/recovery/', '/session', '/signup/', '/add', '/devices/'];
  const isWalletPath = (path: string) => path === (base || '/') || path === `${base}/` || walletPrefixes.some(prefix => path.startsWith(base + prefix));
  const legacyPrefix = '/wallet';
  if (base === '') app.use('*', async (c, next) => {
    // Links minted while the pages lived under the old prefix keep working: navigations move, calls are served.
    const url = new URL(c.req.url);
    if (url.pathname !== legacyPrefix && !url.pathname.startsWith(legacyPrefix + '/')) return next();
    const stripped = url.pathname.slice(legacyPrefix.length) || '/';
    // A stripped path must be one absolute path on this origin: "//host" and "/\host" are not.
    if (!/^\/(?![\/\\])/.test(stripped)) return c.text('Not found', 404);
    url.pathname = stripped;
    if (c.req.method === 'GET' && (c.req.header('Sec-Fetch-Mode') === 'navigate' || c.req.header('Accept')?.includes('text/html'))) {
      for (const [key, value] of Object.entries(pageHeaders)) c.header(key, value);
      return c.redirect(origin + url.pathname + url.search, 301);
    }
    return app.fetch(new Request(url, c.req.raw));
  });
  app.use(base || '/', protect);
  app.use(`${base}/*`, protect);
  app.use('*', async (c, next) => {
    // When mounted alongside the legacy site, no Accounts or other app code may
    // execute on this credential origin and inherit its cookie authority.
    if (!isWalletPath(c.req.path) && (c.req.header('Host') ?? new URL(c.req.url).host) === new URL(origin).host) {
      for (const [key, value] of Object.entries(pageHeaders)) c.header(key, value);
      return c.req.path === '/' && base ? c.redirect(base, 302) : c.text('Not found', 404);
    }
    await next();
  });
  app.onError((error, c) => {
    const known = error instanceof RestError || error instanceof RestAuthError;
    const status = known && error.status >= 400 && error.status <= 599 ? error.status : 503;
    const code = known && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'WALLET_UNAVAILABLE';
    // Unknown failures (database, provider) keep a bounded reason so the log names them.
    emit('request', status >= 500 ? 'unavailable' : 'rejected', code, known ? scalars(error)
      : { reason: String((error as { message?: unknown })?.message ?? error).slice(0, 160), path: c.req.path.slice(0, 80) });
    if (c.req.path === `${base}/launch` && c.req.header('Sec-Fetch-Mode') === 'navigate') {
      // A launch that failed inside an admitted app's frame shows this page there rather than the browser's own
      // "refused to connect"; the form's Origin header names the app, and the page holds nothing private.
      const framer = c.req.header('Origin');
      if (c.req.header('Sec-Fetch-Dest') === 'iframe' && framer && frameable.has(framer)) framedBy(c, framer);
      return c.html('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connection unavailable</title><link rel="stylesheet" href="' + base + '/assets/wallet.css"></head><body><main><h1>Connection unavailable</h1><p>This connection expired or could not be verified. Return to the app and connect again.</p></main></body></html>', status as ContentfulStatusCode);
    }
    // An expired app request names the app's public origin so the page can send the person back.
    const appOrigin = code === 'WALLET_HANDOFF_EXPIRED' && known ? (scalars(error)?.origin as unknown) : undefined;
    const app = typeof appOrigin === 'string' && /^https?:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(appOrigin) ? { app: { origin: appOrigin } } : {};
    return c.json({ error: { code, message: status >= 500 ? 'Wallet service is temporarily unavailable. Try again.' : 'Wallet request could not be completed. Try again or start over.' }, ...app }, status as ContentfulStatusCode);
  });
  const central = (c: Context) => assertWalletHttpRequest(c.req.raw, origin, 'central');
  const cookie = (c: Context, name: typeof walletSessionCookie | typeof walletFlowCookie) => {
    const token = readWalletCookie(c.req.raw, name);
    if (!token) reject(403, 'WALLET_HTTP_SESSION');
    assertWalletCsrf(c.req.raw, token); return token;
  };
  const demand = async (accountId: string, wait = true) => {
    // Queue admission follows trusted proof/cookie identity and runs after its SQL locks release.
    // The worker owns cancellation. A short HTTP wait never cancels shared background work.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await refresh.request(accountId);
      const work = refresh.tick();
      if (!wait) { void work.catch(() => emit('refresh', 'unavailable', 'WALLET_REFRESH_UNAVAILABLE')); return; }
      // One hosted observation takes ~25 s; a login that arrives after the snapshot expired waits
      // for the worker's fresh one rather than failing WALLET_LOGIN_INACTIVE.
      await Promise.race([work, new Promise<void>(resolve => { timer = setTimeout(resolve, 90_000); })]);
    } catch { emit('refresh', 'unavailable', 'WALLET_REFRESH_UNAVAILABLE'); }
    finally { clearTimeout(timer); }
  };
  const sessionFor = async (token: string) => {
    const current = await login.readSession(token);
    if (current) { void demand(current.accountId, false); return current; }
    const identity = await login.identifySession(token);
    if (!identity) return null;
    await demand(identity.accountId);
    const session = await login.readSession(token);
    // Readiness may have expired during an RPC outage. Preserve the valid browser cookie;
    // a later attempt must recheck identity and fresh authority before returning a session.
    if (!session) reject(503, 'WALLET_AUTHORITY_CHECKING');
    return session;
  };
  const appOrigin = async (c: Context) => {
    const candidate = c.req.header('Origin');
    if (!candidate || c.req.header('Cookie') !== undefined) reject(403, 'WALLET_HTTP_ORIGIN');
    const snapshot = await policy.readActivePolicy();
    const entry = snapshot?.apps.find(item => item.origin === candidate && item.enabled && item.walletCallbacks.length > 0);
    if (!entry) reject(403, 'WALLET_POLICY_INACTIVE');
    c.header('Vary', 'Origin'); c.header('Access-Control-Allow-Origin', candidate);
    return entry;
  };
  const appPost = async (c: Context) => {
    const entry = await appOrigin(c);
    if (c.req.header('x-center-wallet-request') !== '1') reject(403, 'WALLET_HTTP_ORIGIN');
    if (!/^application\/json(?:; ?charset=utf-8)?$/i.test(c.req.header('Content-Type') ?? '')) reject(415, 'WALLET_HTTP_CONTENT_TYPE');
    return entry;
  };
  app.options(`${base}/*`, async c => {
    const path = c.req.path;
    const method = path === `${base}/config` ? 'GET' : [`${base}/handoff/prepare`, `${base}/handoff/exchange`].includes(path) ? 'POST' : null;
    if (!method || c.req.header('Access-Control-Request-Method') !== method) reject(403, 'WALLET_HTTP_ORIGIN');
    const requested = c.req.header('Access-Control-Request-Headers')?.split(',').map(header => header.trim().toLowerCase()) ?? [];
    if (requested.some(header => !['content-type', 'x-center-wallet-request'].includes(header))) reject(403, 'WALLET_HTTP_ORIGIN');
    await appOrigin(c);
    c.header('Access-Control-Allow-Methods', method);
    c.header('Access-Control-Allow-Headers', 'content-type, x-center-wallet-request');
    return c.body(null, 204);
  });
  // Pages an admitted app may frame: inside a frame the app controls what surrounds the approval,
  // so the set of apps is the operator's, not every app with a grant. Anything else keeps the
  // default: no framing.
  const frameable = new Set((options.frameableAppOrigins ?? []).map(value => validateWalletPolicyOrigin(value)));
  const framedBy = (c: Context, framer: string | undefined) => {
    if (!framer || !frameable.has(framer)) return;
    c.header('Content-Security-Policy', pageHeaders['Content-Security-Policy'].replace("frame-ancestors 'none'", `frame-ancestors ${framer}`));
    c.header('X-Frame-Options', undefined);
  };
  // An intent launched into an admitted app's frame: the launch signature kept on its row is the
  // browser-launch claim, and its app is the one origin a framed ceremony may name.
  const framedIntent = async (id: string) => {
    if (!handoff.framedLaunch || !frameable.size) reject(403, 'WALLET_HANDOFF_UNCLAIMED');
    const launched = await handoff.framedLaunch(id);
    if (!frameable.has(launched.intent.request.origin)) reject(403, 'WALLET_HANDOFF_UNCLAIMED');
    return launched;
  };
  const issued = async (intentId: string, sessionId: string, launchSignature: Hex) => {
    const code = await handoff.issue(intentId, sessionId, launchSignature);
    if (code.issuer !== origin) reject(503, 'WALLET_UNAVAILABLE');
    const callback = new URL(code.callbackUri);
    callback.searchParams.set('code', code.code); callback.searchParams.set('state', code.state); callback.searchParams.set('iss', code.issuer);
    emit('handoff_issue', 'ok'); return callback.href;
  };
  if (options.signup) {
    if (!options.signupBrowserScript) reject(503, 'WALLET_SIGNUP_UNAVAILABLE');
    mountWalletSignup(app, { origin, signup: options.signup, browserScript: options.signupBrowserScript, basePath: base, refresh,
      framed: { frameOrigin: id => handoff.frameOrigin ? handoff.frameOrigin(id) : Promise.resolve(undefined), framedBy,
        intent: async id => (await framedIntent(id)).intent,
        issue: async (id, sessionId) => { const { intent, launchSignature } = await framedIntent(id); return issued(intent.id, sessionId, launchSignature); } } });
  }
  if (options.recovery) {
    if (!options.recoveryBrowserScript) reject(503, 'WALLET_RECOVERY_UNAVAILABLE');
    mountWalletRecovery(app, { origin, recovery: options.recovery, browserScript: options.recoveryBrowserScript, basePath: base, refresh });
  }
  if (options.devices) {
    if (!options.deviceBrowserScript) reject(503, 'WALLET_DEVICE_UNAVAILABLE');
    mountWalletDevices(app, { origin, devices: options.devices, browserScript: options.deviceBrowserScript, basePath: base,
      session: (c, mutate) => paymentSession(c, mutate), onEvent: (action, outcome) => emit(action, outcome) });
  }
  // Every visit lands on sign-in; signup is the person's choice from there. An app return may be
  // framed by the app whose intent it carries, when that app is admitted to.
  const landing = async (c: Context) => {
    const intentId = c.req.query('intent');
    const framer = intentId && handoff.frameOrigin && frameable.size ? await handoff.frameOrigin(intentId).catch(() => undefined) : undefined;
    if (intentId) framedBy(c, framer);
    return c.html(walletPage(!!options.signup, !!options.recovery, base,
      c.req.header('Sec-Fetch-Dest') === 'iframe' && !!framer && frameable.has(framer)));
  };
  app.get(base || '/', landing);
  if (base) app.get(`${base}/`, landing);
  app.get(`${base}/assets/wallet.js`, c => c.body(browserScript, 200, { 'Content-Type': 'application/javascript; charset=utf-8' }));
  app.get(`${base}/assets/wallet.css`, c => c.body(walletCss(), 200, { 'Content-Type': 'text/css; charset=utf-8' }));
  app.get(`${base}/assets/favicon.svg`, c => c.body(FAVICON_SVG, 200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' }));
  app.get(`${base}/config`, async c => {
    const candidate = c.req.header('Origin');
    const entry = candidate && candidate !== origin ? await appOrigin(c) : undefined;
    return c.json({ version: 'center-wallet-v1', issuer: origin, audience, rpId,
      ...(entry ? { app: { origin: entry.origin, callbackUris: entry.walletCallbacks, generation: entry.generation } } : {}) });
  });
  app.post(`${base}/login/begin`, async c => {
    central(c); fields(await readWalletJson(c.req.raw), []);
    const result = await login.begin();
    c.header('Set-Cookie', walletCookie(walletFlowCookie, result.flowToken, 3780), { append: true });
    emit('login_begin', 'ok');
    return c.json({ loginId: result.login.id, publicKey: { rpId: result.login.rpId,
      challenge: Buffer.from(result.login.challenge.slice(2), 'hex').toString('base64url'), userVerification: 'required', timeout: 90_000 },
      expiresAtMs: result.login.expiresAtMs, csrfToken: walletCsrfToken(result.flowToken) }, 201);
  });
  app.post(`${base}/login/complete`, async c => {
    central(c); const flowToken = cookie(c, walletFlowCookie);
    const body = fields(await readWalletJson(c.req.raw), ['loginId', 'assertion']);
    if (typeof body.loginId !== 'string') reject();
    const input = { loginId: body.loginId, flowToken, assertion: assertion(body.assertion) };
    // A known identity signs in at once while its observation refreshes in the background; only an
    // account never yet observed (fresh from signup) waits for its first one.
    const identity = await login.identifyCompletion(input);
    if (await login.identityKnown(identity.accountId)) void demand(identity.accountId, false); else await demand(identity.accountId);
    const result = await login.complete(input);
    c.header('Set-Cookie', walletCookie(walletSessionCookie, result.sessionToken,
      Math.max(1, Math.min(3600, Math.floor((result.session.expiresAtMs - Date.now()) / 1000)))), { append: true });
    c.header('Set-Cookie', walletCookie(walletFlowCookie, null, 0), { append: true });
    // A signed-in browser has no signup to continue: the next "Sign up" shows the form, not the
    // finished signup's "log in". An unfinished signup can still be picked up with its passkey.
    c.header('Set-Cookie', walletCookie(walletSignupCookie, null, 0), { append: true });
    emit('login_complete', 'ok');
    return c.json({ session: publicSession(result.session, await login.passkeyName(result.session)), csrfToken: walletCsrfToken(result.sessionToken), replayed: result.replayed });
  });
  // Identity is enough to show the account, to hand it to an app and to approve a payment (the
  // approval is verified on chain at submission); a stale authority record refreshes in the
  // background. Only dispatch to other networks still waits for fresh authority through sessionFor.
  const viewFor = async (token: string) => {
    const session = (await login.readSession(token)) ?? (await login.viewSession(token));
    if (session) void demand(session.accountId, false);
    return session;
  };
  app.get(`${base}/session`, async c => {
    const token = readWalletCookie(c.req.raw, walletSessionCookie), session = token ? await viewFor(token) : null;
    return c.json(session && token ? { session: publicSession(session, await login.passkeyName(session)), csrfToken: walletCsrfToken(token) } : { session: null });
  });
  app.post(`${base}/logout`, async c => {
    central(c); const token = cookie(c, walletSessionCookie); fields(await readWalletJson(c.req.raw), []);
    const result = await login.logout(token);
    c.header('Set-Cookie', walletCookie(walletSessionCookie, null, 0), { append: true });
    c.header('Set-Cookie', walletCookie(walletFlowCookie, null, 0), { append: true });
    emit('logout', 'ok'); return c.json(result);
  });
  const payments = () => {
    if (!options.payments) reject(503, 'WALLET_PAYMENTS_UNAVAILABLE');
    return options.payments;
  };
  app.get(`${base}/payment`, async c => {
    const service = payments();
    if (!options.paymentBrowserScript) reject(503, 'WALLET_PAYMENTS_UNAVAILABLE');
    // The page may be framed by the one app its review was prepared for (the app shows it inside
    // its own checkout and delegates the passkey prompt to the frame). A review that is not live,
    // or a page opened without one, keeps the default: no framing.
    const review = c.req.query('review');
    if (review && service.frameOrigin && frameable.size) framedBy(c, await service.frameOrigin(review).catch(() => undefined));
    return c.html(walletPaymentPage(base));
  });
  app.get(`${base}/assets/wallet-payment.js`, c => {
    payments();
    if (!options.paymentBrowserScript) reject(503, 'WALLET_PAYMENTS_UNAVAILABLE');
    return c.body(options.paymentBrowserScript, 200, { 'Content-Type': 'application/javascript; charset=utf-8' });
  });
  app.get(`${base}/assets/wallet-payment.css`, c => {
    payments();
    if (!options.paymentBrowserScript) reject(503, 'WALLET_PAYMENTS_UNAVAILABLE');
    return c.body(walletPaymentCss(), 200, { 'Content-Type': 'text/css; charset=utf-8' });
  });
  const paymentSession = async (c: Context, mutate: boolean, fresh = false) => {
    if (mutate) central(c);
    const token = mutate ? cookie(c, walletSessionCookie) : readWalletCookie(c.req.raw, walletSessionCookie);
    if (!token) reject(403, 'WALLET_HTTP_SESSION');
    const session = await (fresh ? sessionFor(token) : viewFor(token));
    if (!session) reject(403, 'WALLET_HTTP_SESSION');
    return session;
  };
  const networks = () => { if (!options.networks) reject(503, 'WALLET_NETWORKS_UNAVAILABLE'); return options.networks; };
  app.get(`${base}/networks`, async c => {
    const service = networks(), token = readWalletCookie(c.req.raw, walletSessionCookie), session = token ? await viewFor(token) : null;
    if (!session) reject(403, 'WALLET_HTTP_SESSION');
    return c.json(await service.list(session));
  });
  app.post(`${base}/networks/status`, async c => {
    const service = networks(), session = await paymentSession(c, true, true);
    fields(await readWalletJson(c.req.raw), []);
    return c.json(await service.status(session));
  });
  app.post(`${base}/networks/quote`, async c => {
    const service = networks(), session = await paymentSession(c, true, true);
    const body = fields(await readWalletJson(c.req.raw), ['chainIds']);
    const result = await service.quote(session, { chainIds: body.chainIds as number[] });
    emit('networks_quote', 'ok');
    // The account's own passkey id lets the browser prompt offer only that passkey (it already holds the id).
    return c.json({ bundle: result.bundle, challenge: result.challenge ?? null, credentialId: result.bundle ? session.credentialId : null, view: result.view });
  });
  app.post(`${base}/networks/approve`, async c => {
    const service = networks(), session = await paymentSession(c, true, true);
    const body = fields(await readWalletJson(c.req.raw), ['bundleId', 'assertion']);
    const result = await service.approve(session, { bundleId: body.bundleId as string, assertion: assertion(body.assertion) });
    emit('networks_approve', 'ok');
    return c.json(result);
  });
  // The review id is the capability here: the app hands the customer its own link, and the approval
  // is a passkey signature over the review. No Center session is asked for on the way.
  app.get(`${base}/payment-reviews/:id`, async c => {
    const service = payments();
    return c.json(publicWalletPaymentCentralReview(await service.get(c.req.param('id'))));
  });
  app.post(`${base}/payment-reviews/:id/approve`, async c => {
    const service = payments(); central(c);
    const body = fields(await readWalletJson(c.req.raw), ['assertion']);
    const result = await service.approve(c.req.param('id'), assertion(body.assertion));
    if (result.view.draft.issuer !== origin) reject(503, 'WALLET_UNAVAILABLE');
    const callback = new URL(result.view.draft.grant.callbackUri);
    callback.searchParams.set('review', result.view.draft.id);
    callback.searchParams.set('state', result.view.draft.state);
    callback.searchParams.set('iss', result.view.draft.issuer);
    emit('payment_approve', 'ok');
    return c.json({ review: publicWalletPaymentCentralReview(result.view), replayed: result.replayed, redirectUri: callback.href });
  });
  app.post(`${base}/payment-reviews/:id/cancel`, async c => {
    const service = payments(); central(c);
    fields(await readWalletJson(c.req.raw), []);
    const view = await service.cancel(c.req.param('id'));
    emit('payment_cancel', 'ok');
    return c.json(publicWalletPaymentCentralReview(view));
  });
  app.get(`${base}/authorize/:id`, async c => c.json(await handoff.getIntent(c.req.param('id'))));
  app.post(`${base}/launch`, async c => {
    const claim = await readWalletLaunchForm(c.req.raw);
    const intent = await handoff.getIntent(claim.intentId);
    if (c.req.header('Origin') !== intent.request.origin || intent.state !== 'prepared') reject(403, 'WALLET_HANDOFF_UNCLAIMED');
    await verifyWalletHandoffLaunchSignature({ request: intent.request, intentId: intent.id }, claim.signature);
    const remaining = Math.floor((intent.expiresAtMs - Date.now()) / 1000);
    if (remaining < 1) reject(410, 'WALLET_HANDOFF_EXPIRED');
    if (claim.framed) {
      // A frame the app owns gets no cookie (SameSite), so the claim stays on the row; admitted apps only.
      if (!frameable.has(intent.request.origin) || !handoff.claimLaunch) reject(403, 'WALLET_HANDOFF_UNCLAIMED');
      await handoff.claimLaunch(intent.id, claim.signature);
      framedBy(c, intent.request.origin);
    } else {
      c.header('Set-Cookie', walletCookie(walletLaunchCookie, `${claim.intentId}.${claim.signature}`, Math.min(930, remaining)), { append: true });
    }
    emit('handoff_launch', 'ok');
    return c.redirect(origin + (base || '/') + '?intent=' + intent.id, 303);
  });
  // The sign-in inside an admitted app's frame: the intent id admits the page, the launch signature
  // on the row is the browser-launch claim, and one passkey assertion naming the app as its top
  // origin both signs in and approves the grant. No cookie takes part; the flow token rides in the
  // response instead, readable only by this page (the app is cross-origin to the frame), and the
  // session is minted from entropy the page never sees, so nothing it holds can act as the session.
  app.post(`${base}/authorize/:id/begin`, async c => {
    central(c); fields(await readWalletJson(c.req.raw), []);
    await framedIntent(c.req.param('id'));
    const result = await login.begin();
    emit('login_begin', 'ok');
    return c.json({ loginId: result.login.id, flowToken: result.flowToken, publicKey: { rpId: result.login.rpId,
      challenge: Buffer.from(result.login.challenge.slice(2), 'hex').toString('base64url'), userVerification: 'required', timeout: 90_000 },
      expiresAtMs: result.login.expiresAtMs }, 201);
  });
  app.post(`${base}/authorize/:id/approve`, async c => {
    central(c);
    const body = fields(await readWalletJson(c.req.raw), ['loginId', 'flowToken', 'assertion']);
    if (typeof body.loginId !== 'string' || typeof body.flowToken !== 'string') reject();
    const { intent, launchSignature } = await framedIntent(c.req.param('id'));
    const input = { loginId: body.loginId, flowToken: body.flowToken, assertion: assertion(body.assertion) };
    const framed = { topOrigin: intent.request.origin };
    const identity = await login.identifyCompletion(input, framed);
    if (await login.identityKnown(identity.accountId)) void demand(identity.accountId, false); else await demand(identity.accountId);
    const result = await login.complete(input, framed);
    emit('login_complete', 'ok');
    return c.json({ redirectUri: await issued(intent.id, result.session.id, launchSignature) });
  });
  app.post(`${base}/authorize/issue`, async c => {
    central(c); const token = cookie(c, walletSessionCookie);
    const body = fields(await readWalletJson(c.req.raw), ['intentId']);
    if (typeof body.intentId !== 'string') reject();
    const bearer = readWalletCookie(c.req.raw, walletLaunchCookie);
    let launchSignature: Hex;
    if (bearer) {
      const claim = walletLaunchClaim(bearer);
      if (claim.intentId !== body.intentId) reject(403, 'WALLET_HANDOFF_UNCLAIMED');
      const intent = await handoff.getIntent(claim.intentId);
      await verifyWalletHandoffLaunchSignature({ request: intent.request, intentId: intent.id }, claim.signature);
      launchSignature = claim.signature;
    } else {
      // A framed launch opened as a page of its own ("Fullscreen") never set the cookie; the claim the
      // frame left on the row stands for it. The code still lands only at the app's callback and is
      // exchanged only with the request key that prepared the intent.
      launchSignature = (await framedIntent(body.intentId)).launchSignature;
    }
    const session = await viewFor(token); if (!session) reject(403, 'WALLET_HTTP_SESSION');
    const issued = await handoff.issue(body.intentId, session.id, launchSignature);
    c.header('Set-Cookie', walletCookie(walletLaunchCookie, null, 0), { append: true });
    if (issued.issuer !== origin) reject(503, 'WALLET_UNAVAILABLE');
    const callback = new URL(issued.callbackUri);
    callback.searchParams.set('code', issued.code); callback.searchParams.set('state', issued.state); callback.searchParams.set('iss', issued.issuer);
    emit('handoff_issue', 'ok'); return c.json({ redirectUri: callback.href });
  });
  app.post(`${base}/handoff/prepare`, async c => {
    const entry = await appPost(c); const body = fields(await readWalletJson(c.req.raw), ['request', 'signature']);
    const intent = await handoff.prepare({ request: body.request as WalletHandoffRequest, signature: body.signature as Hex }, entry.origin);
    emit('handoff_prepare', 'ok'); return c.json(intent, 201);
  });
  app.post(`${base}/handoff/exchange`, async c => {
    const entry = await appPost(c); const body = await readWalletJson(c.req.raw) as unknown as WalletHandoffExchangeInput;
    const identity = await handoff.identifyExchange(body, entry.origin); void demand(identity.accountId, false);
    const result = await handoff.exchange(body, entry.origin);
    emit('handoff_exchange', 'ok'); return c.json(result);
  });
  return app;
}
