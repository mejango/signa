import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { mountWalletSignup, type WalletSignupSiteOptions } from '../src/rest/wallet/signupSite.js';
import { RestError } from '../src/rest/core.js';
import { walletCookie, walletCsrfToken, walletSignupCookie, walletSignupResumeCookie } from '../src/rest/wallet/http.js';

const origin = 'https://wallet.example.test', token = Buffer.alloc(32, 7).toString('base64url');
const view = { phase: 'awaiting_registration', expiresAtMs: Date.now() + 180000, passkeyName: 'Juicebox test' };
function setup(extra: Partial<WalletSignupSiteOptions> = {}) {
  const signup = { begin: vi.fn(async () => ({ flowToken: token, view })), status: vi.fn(async () => view),
    register: vi.fn(async () => view), proveEnrollment: vi.fn(async () => view),
    prepareDeployment: vi.fn(), approveDeployment: vi.fn(), activate: vi.fn(),
    session: vi.fn(async () => ({ session: { id: '22222222-2222-4222-8222-222222222222', expiresAtMs: Date.now() + 3600000, accountId: 'eip155:8453:0x' + '11'.repeat(20) }, sessionToken: 'A'.repeat(43) })),
    listeners: new Set<() => void>(),
    watch: vi.fn(async (_token: string, listener: () => void) => { signup.listeners.add(listener); return () => signup.listeners.delete(listener); }),
    beginResume: vi.fn(async () => ({ resumeToken: token, challenge: { id: 'resume', challenge: '0x' + '11'.repeat(32) } })),
    completeResume: vi.fn(async () => ({ flowToken: token, flow: { secret: 'internal-only' }, replayed: true })) };
  const app = new Hono();
  app.onError((error, c) => c.json({ error: error instanceof RestError ? error.code : 'unavailable' }, error instanceof RestError ? error.status as 400 : 503));
  mountWalletSignup(app, { origin, signup: signup as unknown as WalletSignupSiteOptions['signup'], browserScript: '/* signup */', ...extra });
  return { app, signup };
}
const headers = { origin, 'content-type': 'application/json', 'x-center-wallet-request': '1',
  cookie: `${walletSignupCookie}=${token}`, 'x-center-wallet-csrf': walletCsrfToken(token) };
function post(path: string, body: unknown, input: Record<string, string> = headers) {
  return new Request(origin + '/wallet/signup/' + path, { method: 'POST', headers: input, body: JSON.stringify(body) });
}
describe('signup HTTP authority boundary', () => {
  it('serves signup with restrictive headers and rejects a substituted host', async () => {
    const { app } = setup(), response = await app.fetch(new Request(origin + '/wallet/create'));
    expect(response.status).toBe(200); expect(await response.text()).toContain('Passkey name');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect((await app.fetch(new Request(origin + '/wallet/create', { headers: { host: 'attacker.test' } }))).status).toBe(403);
  });
  it('creates only with same-origin browser context and keeps the continuation in a distinct HttpOnly cookie', async () => {
    const { app, signup } = setup(), body = { recoveryOwner: '0x' + '12'.repeat(20), passkeyName: 'Juicebox test' };
    const fresh = { ...headers }; delete (fresh as Partial<typeof headers>).cookie;
    const response = await app.fetch(post('begin', body, fresh));
    expect(response.status).toBe(201); expect(response.headers.get('set-cookie')).toContain(walletSignupCookie + '=' + token);
    expect(response.headers.get('set-cookie')).toContain('Secure; HttpOnly; SameSite=Lax');
    const json = await response.json(); expect(json).toEqual({ view, csrfToken: walletCsrfToken(token) });
    expect(JSON.stringify(json)).not.toContain(token);
    expect((await app.fetch(post('begin', body))).status).toBe(409);
    expect((await app.fetch(post('begin', body, { ...fresh, origin: 'https://homerun.test' }))).status).toBe(403);
    expect((await app.fetch(post('begin', { ...body, rpId: 'attacker.test' }, fresh))).status).toBe(400);
    expect((await app.fetch(post('begin', { ...body, mnemonic: 'a secret must not be accepted' }, fresh))).status).toBe(400);
    expect(signup.begin).toHaveBeenCalledTimes(1);
  });
  it('asks the refresh worker for the authority whenever a view is still preparing the login', async () => {
    // Login needs the worker's verified observation (~25 s hosted); the page polls state until then.
    const refresh = { request: vi.fn(async () => undefined), tick: vi.fn(async () => undefined) };
    const { app, signup } = setup({ refresh });
    const wallet = '0x' + 'AB'.repeat(20), preparing = { ...view, phase: 'preparing_sign_in', walletAddress: wallet };
    signup.status.mockResolvedValueOnce(preparing as never);
    expect((await app.fetch(new Request(origin + '/wallet/signup/state', { headers }))).status).toBe(200);
    await vi.waitFor(() => expect(refresh.tick).toHaveBeenCalledTimes(1));
    expect(refresh.request).toHaveBeenCalledWith('eip155:8453:' + wallet.toLowerCase());
    signup.status.mockResolvedValueOnce({ ...preparing, phase: 'ready_to_sign_in' } as never);
    expect((await app.fetch(new Request(origin + '/wallet/signup/state', { headers }))).status).toBe(200);
    expect(refresh.request).toHaveBeenCalledTimes(1);
  });
  it('signs a fresh signup in from its approval: the session cookie is set as a login sets it and the continuation is dropped', async () => {
    const { app, signup } = setup(), response = await app.fetch(post('session', {}));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ signedIn: true });
    const cookies = response.headers.get('set-cookie') ?? '';
    expect(cookies).toContain('__Host-center-wallet=' + 'A'.repeat(43)); expect(cookies).toContain('Secure; HttpOnly; SameSite=Lax');
    expect(cookies).toContain(`${walletSignupCookie}=; `);
    expect(signup.session).toHaveBeenCalledWith(token);
    // Same-origin browser context and CSRF are required, as for every signup action.
    const noCsrf = { ...headers }; delete (noCsrf as Partial<typeof headers>)['x-center-wallet-csrf'];
    expect((await app.fetch(post('session', {}, noCsrf))).status).toBe(403);
  });
  it('streams the view on connect and on every phase change, and ends the stream when the view cannot be read', async () => {
    const { app, signup } = setup(), current = { ...view, phase: 'deploying' as string };
    signup.status.mockImplementation(async () => current);
    const response = await app.fetch(new Request(origin + '/wallet/signup/events', { headers: { cookie: headers.cookie } }));
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader(), decoder = new TextDecoder(); let text = '';
    const until = async (needle: string) => { for (let i = 0; i < 50 && !text.includes(needle); i++) { const chunk = await reader.read(); if (chunk.done) break; text += decoder.decode(chunk.value); } expect(text).toContain(needle); };
    await until('"phase":"deploying"');
    expect(signup.listeners.size).toBe(1);
    current.phase = 'awaiting_activation'; for (const listener of signup.listeners) listener();
    await until('"phase":"awaiting_activation"');
    expect(text).not.toContain(token);
    // The continuation is gone: the view throws, the stream ends and the listener is released.
    signup.status.mockImplementation(async () => { throw new RestError(403, 'WALLET_SIGNUP_UNAUTHORIZED', 'gone'); });
    for (const listener of signup.listeners) listener();
    for (let i = 0; i < 50; i++) { const chunk = await reader.read(); if (chunk.done) break; }
    expect(signup.listeners.size).toBe(0);
    // No cookie, no stream.
    expect((await app.fetch(new Request(origin + '/wallet/signup/events'))).status).toBe(403);
  });
  it('lets a deliberate start-over drop the continuation cookie at any phase without touching the signup', async () => {
    const { app, signup } = setup();
    const response = await app.fetch(post('restart', {}));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ view: null });
    expect(response.headers.get('set-cookie')).toMatch(new RegExp(`${walletSignupCookie}=;.*Max-Age=0`));
    expect(signup.status).toHaveBeenCalledTimes(1);
    for (const fn of [signup.register, signup.proveEnrollment, signup.approveDeployment, signup.activate]) expect(fn).not.toHaveBeenCalled();
  });
  it('rejects missing CSRF, duplicate cookies and client authority fields before mutation', async () => {
    const { app, signup } = setup();
    for (const input of [{ ...headers, 'x-center-wallet-csrf': '' }, { ...headers, cookie: headers.cookie + '; ' + headers.cookie },
      { ...headers, origin: 'https://homerun.test' }, { ...headers, 'sec-fetch-site': 'cross-site' }])
      expect((await app.fetch(post('deployment/review', {}, input))).status).toBeGreaterThanOrEqual(400);
    expect((await app.fetch(post('deployment/review', { accountId: 'attacker' }))).status).toBe(400);
    expect(signup.prepareDeployment).not.toHaveBeenCalled();
  });
  it('decodes bounded registration bytes and never accepts malformed base64 or extra fields', async () => {
    const { app, signup } = setup(), value = { type: 'public-key', credentialId: token, rawId: token,
      clientDataJSON: Buffer.from('{}').toString('base64url'), attestationObject: token };
    expect((await app.fetch(post('register', value))).status).toBe(200);
    expect(signup.register).toHaveBeenCalledWith(token, { ...value, rawId: Buffer.alloc(32, 7), clientDataJSON: Buffer.from('{}'), attestationObject: Buffer.alloc(32, 7) });
    for (const bad of [{ ...value, rawId: token + '=' }, { ...value, attestationObject: 'A'.repeat(3000) }, { ...value, userHandle: token }])
      expect((await app.fetch(post('register', bad))).status).toBe(400);
    expect(signup.register).toHaveBeenCalledTimes(1);
  });
  it('resumption uses its own cookie and strips internal rows from the response', async () => {
    const { app } = setup(), begun = await app.fetch(post('resume/begin', {}));
    expect(begun.headers.get('set-cookie')).toContain(walletSignupResumeCookie + '=');
    const assertion = { credentialId: token, userHandle: token, authenticatorData: Buffer.alloc(37).toString('base64url'),
      clientDataJSON: Buffer.from('{}').toString('base64url'), signature: Buffer.alloc(70).toString('base64url') };
    expect((await app.fetch(post('resume/complete', { resumeId: 'resume', assertion }))).status).toBe(403);
    const response = await app.fetch(post('resume/complete', { resumeId: 'resume', assertion }, { ...headers, cookie: `${walletSignupResumeCookie}=${token}` }));
    expect(await response.json()).toEqual({ view, csrfToken: walletCsrfToken(token), replayed: true });
    expect(response.headers.get('set-cookie')).toContain(walletSignupCookie + '=');
  });
  it('never permits a signup cookie to be used as a session cookie name or indefinite bearer', () => {
    expect(() => walletCookie(walletSignupCookie, token, 86401)).toThrow();
    expect(() => walletCookie('__Host-other' as never, token, 60)).toThrow();
  });
  it('clears a reclaimed continuation during restart but preserves it on outage and rejects invalid CSRF', async () => {
    const { app, signup } = setup();
    signup.status.mockRejectedValueOnce(new RestError(403, 'WALLET_SIGNUP_UNAUTHORIZED', 'Reclaimed'));
    const reset = await app.fetch(post('restart', {}));
    expect(reset.status).toBe(200);
    expect(reset.headers.get('set-cookie')).toContain('Max-Age=0');
    signup.status.mockRejectedValueOnce(new Error('Database unavailable'));
    const outage = await app.fetch(post('restart', {}));
    expect(outage.status).toBe(503); expect(outage.headers.get('set-cookie')).toBeNull();
    const invalid = await app.fetch(post('restart', {}, { ...headers, 'x-center-wallet-csrf': '' }));
    expect(invalid.status).toBe(403); expect(invalid.headers.get('set-cookie')).toBeNull();
    expect(signup.status).toHaveBeenCalledTimes(2); expect(signup.begin).not.toHaveBeenCalled();
  });
  it('clears an unavailable continuation cookie so cleaned pending flows do not trap the browser', async () => {
    const { app, signup } = setup();
    signup.status.mockRejectedValueOnce(new RestError(403, 'WALLET_SIGNUP_UNAUTHORIZED', 'Continuation unavailable'));
    const response = await app.fetch(new Request(origin + '/wallet/signup/state', { headers }));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ view: null });
    expect(response.headers.get('set-cookie')).toContain(walletSignupCookie + '=;');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(signup.begin).not.toHaveBeenCalled();
    signup.status.mockRejectedValueOnce(new Error('Database unavailable'));
    const outage = await app.fetch(new Request(origin + '/wallet/signup/state', { headers }));
    expect(outage.status).toBe(503); expect(outage.headers.get('set-cookie')).toBeNull();
  });

});

describe('signup framed by an admitted app', () => {
  const appOrigin = 'https://beep.example.test', intentId = Buffer.alloc(32, 9).toString('base64url');
  const assertion = { credentialId: token, userHandle: token, authenticatorData: Buffer.alloc(37).toString('base64url'), clientDataJSON: Buffer.from('{}').toString('base64url'), signature: Buffer.alloc(70).toString('base64url') };
  const registration = { type: 'public-key', credentialId: token, rawId: token, clientDataJSON: Buffer.from('{}').toString('base64url'), attestationObject: Buffer.alloc(40).toString('base64url') };
  const plain = { origin, 'content-type': 'application/json', 'x-center-wallet-request': '1' };
  function framedSetup() {
    const framed = {
      frameOrigin: vi.fn(async (id: string) => id === intentId ? appOrigin : undefined),
      framedBy: vi.fn((c: { header(name: string, value: string | undefined): void }, framer: string | undefined) => { if (framer === appOrigin) { c.header('Content-Security-Policy', `frame-ancestors ${framer};`); c.header('X-Frame-Options', undefined); } }),
      intent: vi.fn(async (id: string) => { if (id !== intentId) throw new RestError(403, 'WALLET_HANDOFF_UNCLAIMED', 'private'); return { id, request: { origin: appOrigin } }; }),
      issue: vi.fn(async () => appOrigin + '/center/callback?code=c&state=s&iss=' + encodeURIComponent(origin)),
    };
    return { ...setup({ framed }), framed };
  }
  it('lets exactly the intent\'s app frame the signup page', async () => {
    const { app } = framedSetup();
    const framedPage = await app.fetch(new Request(origin + '/wallet/create?intent=' + intentId, { headers: { 'Sec-Fetch-Dest': 'iframe' } }));
    expect(framedPage.status).toBe(200); expect(framedPage.headers.get('content-security-policy')).toContain(`frame-ancestors ${appOrigin};`); expect(framedPage.headers.get('x-frame-options')).toBeNull();
    expect(await framedPage.text()).toContain('<html lang="en" class="framed">');
    expect(await (await app.fetch(new Request(origin + '/wallet/create?intent=' + intentId))).text()).not.toContain('class="framed"');
    for (const path of ['/wallet/create', '/wallet/create?intent=' + token]) {
      const page = await app.fetch(new Request(origin + path));
      expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'"); expect(page.headers.get('x-frame-options')).toBe('DENY');
    }
    expect((await setup().app.fetch(new Request(origin + '/wallet/create?intent=' + intentId))).headers.get('x-frame-options')).toBe('DENY');
  });
  it('runs every step by intent and flow token in the body, naming the app as the ceremonies\' top origin, with no cookie', async () => {
    const { app, signup, framed } = framedSetup();
    const empty = await app.fetch(post('framed/state', { intentId, flowToken: '' }, plain));
    expect(empty.status).toBe(200); expect(await empty.json()).toEqual({ view: null }); expect(signup.status).not.toHaveBeenCalled();
    const begun = await app.fetch(post('framed/begin', { intentId, recoveryOwner: '0x' + '22'.repeat(20), passkeyName: 'Juicebox test' }, plain));
    expect(begun.status).toBe(201); expect(begun.headers.get('set-cookie')).toBeNull();
    expect(await begun.json()).toEqual({ view, flowToken: token });
    const state = await app.fetch(post('framed/state', { intentId, flowToken: token }, plain));
    expect(state.status).toBe(200); expect((await state.json()).view).toEqual(view); expect(signup.status).toHaveBeenCalledWith(token);
    const registered = await app.fetch(post('framed/register', { intentId, flowToken: token, ...registration }, plain));
    expect(registered.status).toBe(200); expect(signup.register).toHaveBeenCalledWith(token, expect.objectContaining({ credentialId: token }), { topOrigin: appOrigin });
    signup.prepareDeployment.mockResolvedValue({ id: 'approval' }); signup.approveDeployment.mockResolvedValue(view);
    expect((await app.fetch(post('framed/deployment/review', { intentId, flowToken: token }, plain))).status).toBe(200);
    expect(signup.prepareDeployment).toHaveBeenCalledWith(token);
    const approved = await app.fetch(post('framed/deployment/approve', { intentId, flowToken: token, approvalId: 'approval', assertion, backupSignature: '0x' + '11'.repeat(65) }, plain));
    expect(approved.status).toBe(200);
    expect(signup.approveDeployment).toHaveBeenCalledWith(token, expect.objectContaining({ approvalId: 'approval', backupSignature: '0x' + '11'.repeat(65) }), { topOrigin: appOrigin });
    // Activation that reaches the login signs the new account in and answers with the app's return; no cookie is set.
    signup.activate.mockResolvedValue({ ...view, phase: 'ready_to_sign_in' });
    const activated = await app.fetch(post('framed/activate', { intentId, flowToken: token }, plain));
    expect(activated.status).toBe(200); expect(activated.headers.get('set-cookie')).toBeNull();
    expect((await activated.json()).redirectUri).toContain(appOrigin + '/center/callback?code=');
    expect(signup.session).toHaveBeenCalledWith(token, { topOrigin: appOrigin }); expect(framed.issue).toHaveBeenCalledWith(intentId, '22222222-2222-4222-8222-222222222222');
    const session = await app.fetch(post('framed/session', { intentId, flowToken: token }, plain));
    expect(session.status).toBe(200); expect(session.headers.get('set-cookie')).toBeNull(); expect((await session.json()).redirectUri).toContain('code=');
    const resume = await app.fetch(post('framed/resume/begin', { intentId }, plain));
    expect(resume.status).toBe(201); expect(resume.headers.get('set-cookie')).toBeNull(); expect((await resume.json()).resumeToken).toBe(token);
    const resumed = await app.fetch(post('framed/resume/complete', { intentId, resumeToken: token, resumeId: 'resume', assertion }, plain));
    expect(resumed.status).toBe(200); expect(resumed.headers.get('set-cookie')).toBeNull();
    expect(signup.completeResume).toHaveBeenCalledWith(expect.objectContaining({ resumeId: 'resume', resumeToken: token }), { topOrigin: appOrigin });
    expect(await resumed.json()).toEqual({ view, flowToken: token, replayed: true });
  });
  it('refuses a framed step without an admitted framed launch, and a cookie step never names a top origin', async () => {
    const { app, signup } = framedSetup();
    for (const [path, body] of [['framed/begin', { intentId: token, recoveryOwner: '0x' + '22'.repeat(20), passkeyName: 'x' }], ['framed/state', { intentId: token, flowToken: token }],
      ['framed/register', { intentId: token, flowToken: token, ...registration }], ['framed/activate', { intentId: token, flowToken: token }]] as const) {
      expect((await app.fetch(post(path, body, plain))).status).toBe(403);
    }
    expect((await app.fetch(post('framed/state', { flowToken: token }, plain))).status).toBe(400);
    expect((await app.fetch(post('framed/register', { intentId, flowToken: 'short', ...registration }, plain))).status).toBe(403);
    expect(signup.register).not.toHaveBeenCalled();
    expect((await app.fetch(post('register', registration))).status).toBe(200);
    expect(signup.register).toHaveBeenCalledTimes(1); expect((signup.register as ReturnType<typeof vi.fn>).mock.calls[0]).toHaveLength(2);
    expect((await setup().app.fetch(post('framed/begin', { intentId, recoveryOwner: '0x' + '22'.repeat(20), passkeyName: 'x' }, plain))).status).toBe(404);
  });
});
