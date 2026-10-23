import { mountAssets, type AssetNames } from '../web/assets.js';
import type { Context, Hono } from 'hono';
import type { Address, Hex } from 'viem';
import { RestError } from '../core.js';
import { walletAppFields } from './appGrants.js';
import type { createLocalWalletRecovery } from './recoveryService.js';
import { SIGNA_HOME_CHAIN_ID } from './chains.js';
import { walletRecoveryPage, walletRecoveryCss } from '../web/walletRecoveryPage.js';
import { assertWalletHttpHost, assertWalletHttpRequest, assertWalletCsrf, readWalletCookie, readWalletJson,
  walletCookie, walletCsrfToken, walletRecoveryCookie, walletRecoveryResumeCookie, walletHttpBytes, walletHttpAssertion,
  walletSigningPageHeaders, type WalletCookieName } from './http.js';

export interface WalletRecoverySiteOptions {
  origin: string; browserScript: string;
  /** Assets the wallet site serves for this page too (the backup kit). */
  assets?: AssetNames;
  /** Mount path of the wallet pages on this host ('' on the dedicated host). */
  basePath?: string;
  recovery: Pick<ReturnType<typeof createLocalWalletRecovery>, 'begin' | 'status' | 'register' | 'prove' | 'prepareRotation'
    | 'approveRotation' | 'activate' | 'beginResume' | 'completeResume' | 'restart'>;
  /** The authority refresh worker hooks; a "preparing" view asks it to verify the replaced owner. */
  refresh?: { request(accountId: string): Promise<unknown>; tick(): Promise<unknown> };
}
function invalid(status = 400): never { throw new RestError(status, 'WALLET_RECOVERY_HTTP_INVALID', 'Check the original recovery and retry its current step.'); }
/** Dedicated wallet-host capability. App allowlisting never grants access to recovery cookies. */
export function mountWalletRecovery(app: Hono, options: WalletRecoverySiteOptions) {
  const { recovery, origin } = options, base = options.basePath ?? '/wallet';
  for (const path of [`${base}/recover`, `${base}/recovery/*`, `${base}/assets/wallet-recovery.*`]) app.use(path, async (c, next) => {
    assertWalletHttpHost(c.req.raw, origin);
    for (const [name, value] of Object.entries(walletSigningPageHeaders)) c.header(name, value);
    await next();
  });
  function cookie(c: Context, name: WalletCookieName) {
    const token = readWalletCookie(c.req.raw, name);
    if (!token) invalid(403);
    assertWalletCsrf(c.req.raw, token); return token;
  }
  async function body(c: Context, keys: string[], optional: string[] = []) {
    assertWalletHttpRequest(c.req.raw, origin, 'central');
    const value = await readWalletJson(c.req.raw);
    try { return walletAppFields(value, keys, optional); } catch { return invalid(); }
  }
  const json = (c: Context, value: unknown) => {
    // A view still preparing the login asks the worker for the observation login needs; the queue
    // dedupes by account and the page keeps polling state meanwhile.
    const view = (value as { view?: { phase?: string; walletAddress?: string | null } } | null)?.view;
    if (options.refresh && view?.phase === 'preparing_sign_in' && view.walletAddress) {
      const refresh = options.refresh, accountId = `eip155:${SIGNA_HOME_CHAIN_ID}:${view.walletAddress.toLowerCase()}`;
      void refresh.request(accountId).then(() => refresh.tick()).catch(() => { /* The page polls; the worker retries. */ });
    }
    return c.body(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item), 200, { 'Content-Type': 'application/json' });
  };
  function result(c: Context, token: string, view: Awaited<ReturnType<typeof recovery.status>>, replayed?: boolean) {
    c.header('Set-Cookie', walletCookie(walletRecoveryCookie, token, Math.max(1, Math.min(86400, Math.floor((view.expiresAtMs - Date.now()) / 1000)))), { append: true });
    return { view, csrfToken: walletCsrfToken(token), ...(replayed === undefined ? {} : { replayed }) };
  }
  const assets = { ...options.assets, ...mountAssets(app, base, { 'wallet-recovery.js': options.browserScript, 'wallet-recovery.css': walletRecoveryCss() }) };
  app.get(`${base}/recover`, c => c.html(walletRecoveryPage({ base, assets })));
  app.get(`${base}/recovery/state`, async c => {
    const token = readWalletCookie(c.req.raw, walletRecoveryCookie);
    if (!token) return c.json({ view: null });
    try { return json(c, { view: await recovery.status(token), csrfToken: walletCsrfToken(token) }); }
    catch (error) {
      if (!(error instanceof RestError) || error.code !== 'WALLET_RECOVERY_UNAUTHORIZED') throw error;
      c.header('Set-Cookie', walletCookie(walletRecoveryCookie, null, 0), { append: true });
      return c.json({ view: null });
    }
  });
  app.post(`${base}/recovery/begin`, async c => {
    const input = await body(c, ['walletAddress', 'passkeyName']);
    if (readWalletCookie(c.req.raw, walletRecoveryCookie)) invalid(409);
    const begun = await recovery.begin({ walletAddress: input.walletAddress as Address, passkeyName: input.passkeyName as string });
    return c.json(result(c, begun.flowToken, begun.view), 201);
  });
  app.post(`${base}/recovery/restart`, async c => {
    await body(c, []);
    try { if (readWalletCookie(c.req.raw, walletRecoveryCookie)) await recovery.restart(cookie(c, walletRecoveryCookie)); }
    catch (error) {
      if (!(error instanceof RestError) || error.code !== 'WALLET_RECOVERY_UNAUTHORIZED') throw error;
      // Cleanup can reclaim the expired continuation between state and Restart.
    }
    c.header('Set-Cookie', walletCookie(walletRecoveryCookie, null, 0), { append: true });
    return c.json({ restarted: true, view: null });
  });
  app.post(`${base}/recovery/register`, async c => {
    const input = await body(c, ['type', 'credentialId', 'rawId', 'clientDataJSON', 'attestationObject']), token = cookie(c, walletRecoveryCookie);
    if (input.type !== 'public-key') invalid();
    walletHttpBytes(input.credentialId, 1, 1023);
    return json(c, { view: await recovery.register(token, { type: 'public-key', credentialId: input.credentialId as string,
      rawId: walletHttpBytes(input.rawId, 1, 1023), clientDataJSON: walletHttpBytes(input.clientDataJSON, 1, 2048), attestationObject: walletHttpBytes(input.attestationObject, 1, 2048) }) });
  });
  app.post(`${base}/recovery/prove`, async c => {
    const input = await body(c, ['assertion', 'backupSignature']), token = cookie(c, walletRecoveryCookie);
    return json(c, { view: await recovery.prove(token, { assertion: walletHttpAssertion(input.assertion), backupSignature: input.backupSignature as Hex }) });
  });
  app.post(`${base}/recovery/rotation/review`, async c => {
    await body(c, []); return json(c, await recovery.prepareRotation(cookie(c, walletRecoveryCookie)));
  });
  app.post(`${base}/recovery/rotation/approve`, async c => {
    // After activation only the other chains are approved, so Base's signature is absent.
    const input = await body(c, [], ['backupSignature', 'chainSignatures']), token = cookie(c, walletRecoveryCookie);
    return json(c, { view: await recovery.approveRotation(token, input.backupSignature as Hex | undefined, input.chainSignatures ?? []) });
  });
  app.post(`${base}/recovery/activate`, async c => {
    await body(c, []);
    return json(c, { view: await recovery.activate(cookie(c, walletRecoveryCookie)) });
  });
  app.post(`${base}/recovery/resume/begin`, async c => {
    const input = await body(c, ['recoveryId']);
    const resumed = await recovery.beginResume(input.recoveryId as string);
    c.header('Set-Cookie', walletCookie(walletRecoveryResumeCookie, resumed.resumeToken, 86400), { append: true });
    return json(c, { challenge: resumed.challenge, csrfToken: walletCsrfToken(resumed.resumeToken) });
  });
  app.post(`${base}/recovery/resume/complete`, async c => {
    const input = await body(c, ['resumeId', 'assertion', 'backupSignature']), resumeToken = cookie(c, walletRecoveryResumeCookie);
    const resumed = await recovery.completeResume({ resumeId: input.resumeId as string, resumeToken,
      assertion: walletHttpAssertion(input.assertion), backupSignature: input.backupSignature as Hex });
    return json(c, result(c, resumed.flowToken, await recovery.status(resumed.flowToken), resumed.replayed));
  });
}
