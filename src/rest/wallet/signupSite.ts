import type { Hono, Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Address, Hex } from 'viem';
import { RestError } from '../core.js';
import { walletAppFields } from './appGrants.js';
import type { createLocalWalletSignup } from './signup.js';
import type { WalletCeremonyOptions } from './webauthn.js';
import { walletSignupPage, walletSignupCss } from '../web/walletSignupPage.js';
import { assertWalletHttpHost, assertWalletHttpRequest, assertWalletCsrf, readWalletCookie, readWalletJson,
  walletCookie, walletCsrfToken, walletSessionCookie, walletSignupCookie, walletSignupResumeCookie, walletHttpBytes, walletHttpAssertion, walletPageHeaders,
  type WalletCookieName } from './http.js';

export interface WalletSignupSiteOptions {
  origin: string; browserScript: string;
  /** Mount path of the wallet pages on this host ('' on the dedicated host). */
  basePath?: string;
  /** The authority refresh worker hooks; a "preparing" view asks it to verify the new wallet. */
  refresh?: { request(accountId: string): Promise<unknown>; tick(): Promise<unknown> };
  signup: Pick<ReturnType<typeof createLocalWalletSignup>, 'begin' | 'status' | 'register' | 'proveEnrollment' |
    'prepareDeployment' | 'approveDeployment' | 'activate' | 'session' | 'beginResume' | 'completeResume' | 'watch'>;
  /** Signing up inside an admitted app's frame: the app that may frame an intent's pages, the CSP swap that admits
   * it, the intent behind a framed launch, and the code issued to the app once the new account has a session. */
  framed?: {
    frameOrigin(intentId: string): Promise<string | undefined>;
    framedBy(c: Context, framer: string | undefined): void;
    intent(intentId: string): Promise<{ id: string; request: { origin: string } }>;
    issue(intentId: string, sessionId: string): Promise<string>;
  };
}
function invalid(status = 400): never { throw new RestError(status, 'WALLET_SIGNUP_HTTP_INVALID', 'Reload the original signup and retry its current step.'); }
/** Installed only by the dedicated wallet host. No trusted-app CORS grants signup access. */
export function mountWalletSignup(app: Hono, options: WalletSignupSiteOptions) {
  const base = options.basePath ?? '/wallet';
  const { signup, origin } = options;
  for (const path of [`${base}/create`, `${base}/signup/*`, `${base}/assets/wallet-signup.*`]) app.use(path, async (c, next) => {
    assertWalletHttpHost(c.req.raw, origin);
    for (const [name, value] of Object.entries(walletPageHeaders)) c.header(name, value);
    await next();
  });
  function cookie(c: Context, name: WalletCookieName) {
    const token = readWalletCookie(c.req.raw, name);
    if (!token) invalid(403);
    assertWalletCsrf(c.req.raw, token); return token;
  }
  async function body(c: Context, fields: string[], optional: string[] = []) {
    assertWalletHttpRequest(c.req.raw, origin, 'central');
    const value = await readWalletJson(c.req.raw);
    try { return walletAppFields(value, fields, optional); } catch { return invalid(); }
  }
  function result(c: Context, token: string, view: Awaited<ReturnType<typeof signup.status>>, replayed?: boolean) {
    c.header('Set-Cookie', walletCookie(walletSignupCookie, token, Math.max(1, Math.min(86400, Math.floor((view.expiresAtMs - Date.now()) / 1000)))), { append: true });
    return { view, csrfToken: walletCsrfToken(token), ...(replayed === undefined ? {} : { replayed }) };
  }
  // All typed-data uints are decimal JSON strings; no credential-bearing rows are serialized.
  // Every view that is still preparing the login asks the worker for the authority observation
  // the login needs. The queue dedupes by account; the page keeps reading state meanwhile.
  const kick = (view: { phase?: string; walletAddress?: string | null } | null | undefined) => {
    if (options.refresh && view?.phase === 'preparing_sign_in' && view.walletAddress) {
      const refresh = options.refresh, accountId = `eip155:8453:${view.walletAddress.toLowerCase()}`;
      void refresh.request(accountId).then(() => refresh.tick()).catch(() => { /* The page polls; the worker retries. */ });
    }
  };
  const serialize = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item);
  const json = (c: Context, value: unknown) => {
    kick((value as { view?: { phase?: string; walletAddress?: string | null } } | null)?.view);
    return c.body(serialize(value), 200, { 'Content-Type': 'application/json' });
  };
  app.get(`${base}/create`, async c => {
    // The signup for an app's intent may be framed by that app, when it is admitted to (see the wallet landing).
    const intentId = c.req.query('intent');
    const framer = intentId && options.framed ? await options.framed.frameOrigin(intentId).catch(() => undefined) : undefined;
    if (intentId && options.framed) options.framed.framedBy(c, framer);
    return c.html(walletSignupPage({ base, framed: c.req.header('Sec-Fetch-Dest') === 'iframe' && !!framer }));
  });
  app.get(`${base}/assets/wallet-signup.js`, c => c.body(options.browserScript, 200, { 'Content-Type': 'application/javascript; charset=utf-8' }));
  app.get(`${base}/assets/wallet-signup.css`, c => c.body(walletSignupCss(), 200, { 'Content-Type': 'text/css; charset=utf-8' }));
  // The view, pushed: on connect, on every phase change this process's worker or an action reports,
  // and re-read on a timer while creation or login preparation is under way (the worker may run in
  // another replica; the authority refresh always does). A 15 s ping keeps the socket known-live.
  // Bounded: 200 streams, at most 300 timed re-reads per stream (then the stream ends and the page
  // polls), the refresh worker asked at most every 15 s per stream. Nothing durable is written here.
  let streams = 0;
  app.get(`${base}/signup/events`, async c => {
    // Read-only, like `state`: the continuation cookie alone (EventSource cannot send the CSRF header).
    const token = readWalletCookie(c.req.raw, walletSignupCookie);
    if (!token) invalid(403);
    let lastKick = 0;
    const read = async () => {
      const view = await signup.status(token), now = Date.now();
      if (now - lastKick >= 15_000) { lastKick = now; kick(view); }
      return view;
    };
    await read();
    if (streams >= 200) throw new RestError(503, 'WALLET_SIGNUP_BUSY', 'Too many open signup streams. Polling continues.');
    return streamSSE(c, async stream => {
      let closed = false, finish!: () => void, sending = Promise.resolve(), timer: ReturnType<typeof setTimeout> | undefined, timed = 0;
      const done = new Promise<void>(resolve => { finish = () => { closed = true; resolve(); }; stream.onAbort(finish); });
      const send = () => { sending = sending.then(async () => {
        if (closed) return;
        const view = await read();
        await stream.writeSSE({ data: serialize({ view }) });
        clearTimeout(timer);
        if (view.phase === 'preparing_sign_in' || view.phase === 'deploying') {
          if (++timed > 300) finish();
          else timer = setTimeout(() => void send(), view.phase === 'preparing_sign_in' ? 1000 : 2000);
        }
      }).catch(finish); return sending; };
      let unwatch = () => {};
      try { unwatch = await signup.watch(token, () => void send()); } catch { return; }
      streams++;
      const heartbeat = setInterval(() => { sending = sending.then(() => closed ? undefined : stream.writeSSE({ event: 'ping', data: '' })).catch(finish); }, 15_000);
      try { await send(); await done; }
      finally { clearTimeout(timer); clearInterval(heartbeat); unwatch(); streams--; }
    });
  });
  app.get(`${base}/signup/state`, async c => {
    const token = readWalletCookie(c.req.raw, walletSignupCookie);
    if (!token) return c.json({ view: null });
    try { return json(c, { view: await signup.status(token), csrfToken: walletCsrfToken(token) }); }
    catch (error) {
      if (!(error instanceof RestError) || error.code !== 'WALLET_SIGNUP_UNAUTHORIZED') throw error;
      // Expired unproved flows may be reclaimed. Clear only the unusable continuation,
      // preserving all accepted deployment/setup records and requiring an explicit next action.
      c.header('Set-Cookie', walletCookie(walletSignupCookie, null, 0), { append: true });
      return c.json({ view: null });
    }
  });
  app.post(`${base}/signup/begin`, async c => {
    const input = await body(c, ['recoveryOwner', 'passkeyName']);
    if (readWalletCookie(c.req.raw, walletSignupCookie)) invalid(409);
    const started = await signup.begin({ recoveryOwner: input.recoveryOwner as Address, passkeyName: input.passkeyName as string });
    return c.json(result(c, started.flowToken, started.view), 201);
  });
  app.post(`${base}/signup/restart`, async c => {
    // A deliberate start-over only forgets this browser's continuation. The signup itself keeps
    // its state server-side and its passkey can log in or resume later.
    await body(c, []); const token = cookie(c, walletSignupCookie);
    try { await signup.status(token); }
    catch (error) {
      if (!(error instanceof RestError) || error.code !== 'WALLET_SIGNUP_UNAUTHORIZED') throw error;
      // Cleanup can reclaim an expired continuation between state and Restart.
    }
    c.header('Set-Cookie', walletCookie(walletSignupCookie, null, 0), { append: true });
    return c.json({ view: null });
  });
  app.post(`${base}/signup/register`, async c => {
    const input = await body(c, ['type', 'credentialId', 'rawId', 'clientDataJSON', 'attestationObject']), token = cookie(c, walletSignupCookie);
    if (input.type !== 'public-key') invalid();
    walletHttpBytes(input.credentialId, 1, 1023);
    return json(c, { view: await signup.register(token, { type: 'public-key', credentialId: input.credentialId as string,
      rawId: walletHttpBytes(input.rawId, 1, 1023), clientDataJSON: walletHttpBytes(input.clientDataJSON, 1, 2048), attestationObject: walletHttpBytes(input.attestationObject, 1, 2048) }) });
  });
  app.post(`${base}/signup/prove`, async c => {
    const input = await body(c, ['assertion', 'backupSignature']), token = cookie(c, walletSignupCookie);
    return json(c, { view: await signup.proveEnrollment(token, { assertion: walletHttpAssertion(input.assertion), backupSignature: input.backupSignature as Hex }) });
  });
  app.post(`${base}/signup/deployment/review`, async c => {
    await body(c, []); return json(c, await signup.prepareDeployment(cookie(c, walletSignupCookie)));
  });
  app.post(`${base}/signup/deployment/approve`, async c => {
    const input = await body(c, ['approvalId', 'assertion'], ['backupSignature']), token = cookie(c, walletSignupCookie);
    if (input.backupSignature !== undefined && (typeof input.backupSignature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(input.backupSignature))) invalid();
    return json(c, { view: await signup.approveDeployment(token, { approvalId: input.approvalId as string, assertion: walletHttpAssertion(input.assertion),
      ...(input.backupSignature === undefined ? {} : { backupSignature: input.backupSignature as Hex }) }) });
  });
  // The fresh signup's session, from its creation approval (see `signup.session`): the session
  // cookie is set as a login sets it and the signup continuation is done with.
  const signIn = async (c: Context, token: string) => {
    const result = await signup.session(token), session = result.session as { expiresAtMs: number };
    c.header('Set-Cookie', walletCookie(walletSessionCookie, result.sessionToken,
      Math.max(1, Math.min(3600, Math.floor((session.expiresAtMs - Date.now()) / 1000)))), { append: true });
    c.header('Set-Cookie', walletCookie(walletSignupCookie, null, 0), { append: true });
  };
  app.post(`${base}/signup/activate`, async c => {
    await body(c, []); const token = cookie(c, walletSignupCookie);
    const view = await signup.activate(token);
    // Activation carries through to the session in the same request when the approval's
    // signature is on offer; otherwise the page asks for it, or shows the login.
    let signedIn = false;
    if (view.phase === 'ready_to_sign_in') {
      try { await signIn(c, token); signedIn = true; }
      catch (error) { if (!(error instanceof RestError) || error.status >= 500) throw error; /* a refused hold: the page's own attempt, then the login */ }
    }
    return json(c, { view, signedIn });
  });
  app.post(`${base}/signup/session`, async c => {
    await body(c, []);
    await signIn(c, cookie(c, walletSignupCookie));
    return c.json({ signedIn: true });
  });
  app.post(`${base}/signup/resume/begin`, async c => {
    await body(c, []);
    const resumed = await signup.beginResume();
    c.header('Set-Cookie', walletCookie(walletSignupResumeCookie, resumed.resumeToken, 86400), { append: true });
    return c.json({ challenge: resumed.challenge, csrfToken: walletCsrfToken(resumed.resumeToken) }, 201);
  });
  app.post(`${base}/signup/resume/complete`, async c => {
    const input = await body(c, ['resumeId', 'assertion']), resumeToken = cookie(c, walletSignupResumeCookie);
    const resumed = await signup.completeResume({ resumeId: input.resumeId as string, resumeToken, assertion: walletHttpAssertion(input.assertion) });
    return json(c, result(c, resumed.flowToken, await signup.status(resumed.flowToken), resumed.replayed));
  });
  // The same signup inside an admitted app's frame, with no cookie: Center's cookies never reach a
  // cross-site frame, so the flow token rides in every request body instead (readable only by this
  // page; the app is cross-origin to it), the intent behind the framed launch admits each request,
  // and every passkey ceremony must name the app as its top origin. The routes mirror the cookie
  // ones step for step; the account made here is the same account.
  const framed = options.framed;
  if (framed) {
    const admitted = async (c: Context, fields: string[], optional: string[] = []) => {
      const input = await body(c, ['intentId', ...fields], optional);
      if (typeof input.intentId !== 'string') invalid();
      const intent = await framed.intent(input.intentId);
      return { input, intent, ceremony: { topOrigin: intent.request.origin } };
    };
    const flowToken = (input: Record<string, unknown>) => {
      if (typeof input.flowToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.flowToken)) invalid(403);
      return input.flowToken;
    };
    app.post(`${base}/signup/framed/state`, async c => {
      const { input } = await admitted(c, ['flowToken']);
      // Before a signup begins the frame holds no continuation: the empty state, not a refusal.
      if (input.flowToken === '') return c.json({ view: null });
      try { return json(c, { view: await signup.status(flowToken(input)) }); }
      catch (error) {
        if (!(error instanceof RestError) || error.code !== 'WALLET_SIGNUP_UNAUTHORIZED') throw error;
        return c.json({ view: null });
      }
    });
    app.post(`${base}/signup/framed/begin`, async c => {
      const { input } = await admitted(c, ['recoveryOwner', 'passkeyName']);
      const started = await signup.begin({ recoveryOwner: input.recoveryOwner as Address, passkeyName: input.passkeyName as string });
      return c.json({ view: started.view, flowToken: started.flowToken }, 201);
    });
    app.post(`${base}/signup/framed/register`, async c => {
      const { input, ceremony } = await admitted(c, ['flowToken', 'type', 'credentialId', 'rawId', 'clientDataJSON', 'attestationObject']);
      if (input.type !== 'public-key') invalid();
      walletHttpBytes(input.credentialId, 1, 1023);
      return json(c, { view: await signup.register(flowToken(input), { type: 'public-key', credentialId: input.credentialId as string,
        rawId: walletHttpBytes(input.rawId, 1, 1023), clientDataJSON: walletHttpBytes(input.clientDataJSON, 1, 2048),
        attestationObject: walletHttpBytes(input.attestationObject, 1, 2048) }, ceremony) });
    });
    app.post(`${base}/signup/framed/deployment/review`, async c => {
      const { input } = await admitted(c, ['flowToken']);
      return json(c, await signup.prepareDeployment(flowToken(input)));
    });
    app.post(`${base}/signup/framed/deployment/approve`, async c => {
      const { input, ceremony } = await admitted(c, ['flowToken', 'approvalId', 'assertion'], ['backupSignature']);
      if (input.backupSignature !== undefined && (typeof input.backupSignature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(input.backupSignature))) invalid();
      return json(c, { view: await signup.approveDeployment(flowToken(input), { approvalId: input.approvalId as string, assertion: walletHttpAssertion(input.assertion),
        ...(input.backupSignature === undefined ? {} : { backupSignature: input.backupSignature as Hex }) }, ceremony) });
    });
    // The new account's session anchors the code the app exchanges; the session itself is never handed to the browser.
    const signedIn = async (intentId: string, token: string, ceremony: WalletCeremonyOptions) => {
      const session = (await signup.session(token, ceremony)).session as { id: string };
      return framed.issue(intentId, session.id);
    };
    app.post(`${base}/signup/framed/activate`, async c => {
      const { input, intent, ceremony } = await admitted(c, ['flowToken']);
      const token = flowToken(input), view = await signup.activate(token);
      let redirectUri: string | undefined;
      if (view.phase === 'ready_to_sign_in') {
        try { redirectUri = await signedIn(intent.id, token, ceremony); }
        catch (error) { if (!(error instanceof RestError) || error.status >= 500) throw error; /* a refused hold: the page's own attempt, then the sign-in */ }
      }
      return json(c, { view, ...(redirectUri ? { redirectUri } : {}) });
    });
    app.post(`${base}/signup/framed/session`, async c => {
      const { input, intent, ceremony } = await admitted(c, ['flowToken']);
      return c.json({ redirectUri: await signedIn(intent.id, flowToken(input), ceremony) });
    });
    app.post(`${base}/signup/framed/resume/begin`, async c => {
      await admitted(c, []);
      const resumed = await signup.beginResume();
      return c.json({ challenge: resumed.challenge, resumeToken: resumed.resumeToken }, 201);
    });
    app.post(`${base}/signup/framed/resume/complete`, async c => {
      const { input, ceremony } = await admitted(c, ['resumeToken', 'resumeId', 'assertion']);
      if (typeof input.resumeToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.resumeToken)) invalid(403);
      const resumed = await signup.completeResume({ resumeId: input.resumeId as string, resumeToken: input.resumeToken, assertion: walletHttpAssertion(input.assertion) }, ceremony);
      return json(c, { view: await signup.status(resumed.flowToken), flowToken: resumed.flowToken, replayed: resumed.replayed });
    });
  }
}
