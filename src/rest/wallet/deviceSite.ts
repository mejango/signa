import { mountAssets } from '../web/assets.js';
import type { Context, Hono } from 'hono';
import { RestError } from '../core.js';
import { walletAppFields } from './appGrants.js';
import { assertWalletHttpHost, assertWalletHttpRequest, walletCookie, walletHttpAssertion, walletHttpBytes, walletSigningPageHeaders, walletSessionCookie } from './http.js';
import type { WalletCentralSession } from './login.js';
import type { createLocalWalletDevices } from './deviceService.js';
import type { WalletDeviceAddition } from './deviceAddition.js';
import { walletDevicePage, walletDeviceCss } from '../web/walletDevicePage.js';

export interface WalletDeviceSiteOptions {
  origin: string; basePath?: string; browserScript: string;
  devices: Pick<ReturnType<typeof createLocalWalletDevices>, 'begin' | 'statusForSession' | 'statusForLink' | 'register' | 'prove' | 'sessionForLink'
    | 'prepareAddition' | 'approveAddition' | 'activateForSession' | 'activateForLink'>;
  /** The primary's page: a mutating call carries the session cookie and CSRF; a read carries the cookie. */
  session(c: Context, mutate: boolean): Promise<WalletCentralSession>;
  onEvent?(action: string, outcome: 'ok'): void;
}
function invalid(status = 400): never { throw new RestError(status, 'WALLET_DEVICE_HTTP_INVALID', 'Check the device addition and retry its current step.'); }
const token = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value) || Buffer.from(value, 'base64url').toString('base64url') !== value) invalid(403);
  return value;
};

/** Two ways in to one addition: the primary's signed-in page under `/devices/*`, and the new
 * device's page at `/add`, which carries its one-time link token in the URL fragment and sends it
 * in each request body. App allowlisting grants neither. */
export function mountWalletDevices(app: Hono, options: WalletDeviceSiteOptions) {
  const { devices, origin } = options, base = options.basePath ?? '/wallet';
  for (const path of [`${base}/add`, `${base}/devices/*`, `${base}/assets/wallet-device.*`]) app.use(path, async (c, next) => {
    assertWalletHttpHost(c.req.raw, origin);
    for (const [name, value] of Object.entries(walletSigningPageHeaders)) c.header(name, value);
    await next();
  });
  async function body(c: Context, keys: string[], optional: string[] = []) {
    assertWalletHttpRequest(c.req.raw, origin, 'central');
    const value = await c.req.json().catch(() => invalid());
    try { return walletAppFields(value, keys, optional); } catch { return invalid(); }
  }
  const json = (c: Context, value: unknown) => c.body(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item), 200, { 'Content-Type': 'application/json' });
  const emit = (action: string) => { try { options.onEvent?.(action, 'ok'); } catch { /* observation only */ } };

  const assets = mountAssets(app, base, { 'wallet-device.js': options.browserScript, 'wallet-device.css': walletDeviceCss() });
  app.get(`${base}/add`, c => c.html(walletDevicePage({ base, assets })));

  // The primary's page.
  app.post(`${base}/devices/begin`, async c => {
    const session = await options.session(c, true), input = await body(c, ['passkeyName']);
    if (input.passkeyName !== null && typeof input.passkeyName !== 'string') invalid();
    const begun = await devices.begin(session, { ...(typeof input.passkeyName === 'string' ? { passkeyName: input.passkeyName } : {}) });
    emit('device_begin');
    return json(c, { view: begun.view, link: `${origin}${base}/add#${begun.linkToken}` });
  });
  app.get(`${base}/devices/:id{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}}`, async c => {
    const session = await options.session(c, false);
    return json(c, { view: await devices.statusForSession(c.req.param('id'), session) });
  });
  app.post(`${base}/devices/:id{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}}/review`, async c => {
    const session = await options.session(c, true); await body(c, []);
    return json(c, await devices.prepareAddition(c.req.param('id'), session));
  });
  app.post(`${base}/devices/:id{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}}/approve`, async c => {
    const session = await options.session(c, true), input = await body(c, ['review', 'assertion']);
    const view = await devices.approveAddition(c.req.param('id'), session, { review: input.review as WalletDeviceAddition, assertion: walletHttpAssertion(input.assertion) });
    emit('device_approve');
    return json(c, { view });
  });
  app.post(`${base}/devices/:id{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}}/activate`, async c => {
    const session = await options.session(c, true); await body(c, []);
    const view = await devices.activateForSession(c.req.param('id'), session);
    emit('device_activate');
    return json(c, { view });
  });

  // The new device's page, by its link.
  app.post(`${base}/devices/link/state`, async c => {
    const input = await body(c, ['linkToken']);
    return json(c, { view: await devices.statusForLink(token(input.linkToken)) });
  });
  app.post(`${base}/devices/link/register`, async c => {
    const input = await body(c, ['linkToken', 'type', 'credentialId', 'rawId', 'clientDataJSON', 'attestationObject'], ['passkeyName']);
    if (input.type !== 'public-key' || (input.passkeyName !== undefined && typeof input.passkeyName !== 'string')) invalid();
    walletHttpBytes(input.credentialId, 1, 1023);
    const view = await devices.register(token(input.linkToken), { type: 'public-key', credentialId: input.credentialId as string,
      rawId: walletHttpBytes(input.rawId, 1, 1023), clientDataJSON: walletHttpBytes(input.clientDataJSON, 1, 2048), attestationObject: walletHttpBytes(input.attestationObject, 1, 2048) },
      typeof input.passkeyName === 'string' ? { passkeyName: input.passkeyName } : {});
    emit('device_register');
    return json(c, { view });
  });
  app.post(`${base}/devices/link/prove`, async c => {
    const input = await body(c, ['linkToken', 'assertion']);
    const proved = await devices.prove(token(input.linkToken), walletHttpAssertion(input.assertion));
    emit('device_prove');
    return json(c, proved);
  });
  app.post(`${base}/devices/link/activate`, async c => {
    const input = await body(c, ['linkToken']);
    const view = await devices.activateForLink(token(input.linkToken));
    emit('device_activate');
    return json(c, { view });
  });
  // The added device's session, from its possession proof (see `devices.sessionForLink`): the
  // session cookie is set as a login sets it. The page sends this one request with credentials.
  app.post(`${base}/devices/link/session`, async c => {
    const input = await body(c, ['linkToken', 'claim']);
    const result = await devices.sessionForLink(token(input.linkToken), token(input.claim)), session = result.session as { expiresAtMs: number };
    c.header('Set-Cookie', walletCookie(walletSessionCookie, result.sessionToken,
      Math.max(1, Math.min(3600, Math.floor((session.expiresAtMs - Date.now()) / 1000)))), { append: true });
    emit('device_session');
    return c.json({ signedIn: true });
  });
}
