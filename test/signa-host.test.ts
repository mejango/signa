import { Hono } from 'hono';
import type { HttpBindings } from '@hono/node-server';
import { request as nodeRequest } from 'node:http';
import { connect, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createSignaApp, type SignaAppOptions, type SignaHttpRuntime } from '../src/signaApp.js';
import { createSignaServer, type SignaServer } from '../src/signaServer.js';
import { assertWalletHttpRequest } from '../src/rest/wallet/http.js';
import { accountIdFor, buildRequestTypedData, createRestAuth, MemoryAccountStore,
  newRequestNonce, readSignedRequest, REST_AUTH_HEADERS as H, RestAuthError, type RequestClaims } from '../src/rest/auth/index.js';

const audience = 'https://api.signa.center';
const origin = 'https://signa.center';
const servers: SignaServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(overrides: Partial<SignaAppOptions> = {}) {
  const api = new Hono().all('*', c => c.text('api'));
  const wallet = new Hono().all('*', c => c.text('wallet'));
  const ready = vi.fn(async () => {});
  const runtime = { api, wallet, ready };
  const app = createSignaApp({ apiAudience: audience, walletOrigin: origin,
    currentRuntime: () => runtime, ...overrides });
  return { app, runtime, ready };
}

async function start(app: ReturnType<typeof createSignaApp>, shutdownGraceMs = 1_000) {
  const server = createSignaServer(app.fetch, { port: 0, hostname: '127.0.0.1', shutdownGraceMs });
  servers.push(server);
  return { server, port: (await server.listen()).port };
}

function send(port: number, path: string, headers: Record<string, string>, body?: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = nodeRequest({ hostname: '127.0.0.1', port, path, method: body === undefined ? 'GET' : 'POST', headers }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }));
    });
    request.once('error', reject);
    request.end(body);
  });
}

describe('Signa HTTP boundary', () => {
  it('keeps dormant liveness independent of runtime and readiness dependent on a healthy runtime', async () => {
    let runtime: SignaHttpRuntime | undefined;
    const { app, runtime: available, ready } = fixture({ currentRuntime: () => runtime });
    for (const host of ['private.railway.internal', 'api.signa.center'])
      expect((await app.request(`http://${host}/healthz`)).status).toBe(200);
    expect((await app.request('https://signa.center/healthz')).status).toBe(503);
    expect((await app.request('http://private.railway.internal/readyz')).status).toBe(503);
    expect((await app.request(origin + '/session')).status).toBe(503);
    expect((await app.request(audience + '/api/v1/accounts/me')).status).toBe(503);
    expect(ready).not.toHaveBeenCalled();
    runtime = available;
    expect((await app.request('http://private.railway.internal/readyz')).status).toBe(200);
    ready.mockRejectedValueOnce(new Error('private database detail'));
    const unavailable = await app.request('http://private.railway.internal/readyz');
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain('private database detail');
  });

  it('contains every credential-host path in the wallet app and exposes only the API site on its own host', async () => {
    const { app, ready } = fixture();
    for (const path of ['/', '/healthz', '/readyz', '/api/v1/accounts/me', '/accounts', '/mcp', '/ipfs/anything'])
      expect(await (await app.request(origin + path)).text()).toBe('wallet');
    expect(ready).not.toHaveBeenCalled();
    for (const host of ['juicebox.center', 'wallet.juicebox.center', 'my.juicebox.center', 'unconfigured.center', 'signa.center:9443'])
      for (const path of ['/', '/accounts', '/api/v1/accounts/me', '/mcp', '/ipfs/anything'])
        expect((await app.request(`https://${host}${path}`)).status).toBe(404);
    for (const path of ['/', '/apiary', '/assets/wallet.js', '/assets/other.js', '/api/v1/../../mcp', '/mcp', '/ipfs/anything'])
      expect((await app.request(audience + path)).status).toBe(404);
    for (const path of ['/api', '/api/docs/authentication', '/api/client/juicebox-center-client-0.1.0.tgz', '/api/v1/accounts/me',
      '/accounts', '/assets/accounts.css', '/assets/accounts.js', '/assets/accounts-icon.svg', '/assets/docs.js', '/assets/api.css'])
      expect(await (await app.request(audience + path)).text()).toBe('api');
  });

  it('ignores forwarding headers and browser Origin when choosing the host boundary', async () => {
    const { app } = fixture();
    for (const headers of [
      { 'x-forwarded-host': 'api.signa.center' },
      { 'x-signa-original-host': 'api.signa.center', 'x-signa-internal-token': 'not-an-authentication-mechanism' },
      { forwarded: 'host=api.signa.center;proto=https' }, { origin: audience },
    ]) {
      expect((await app.request('http://private.internal/api/v1/accounts/me', { headers })).status).toBe(404);
      expect(await (await app.request('https://signa.center/api/v1/accounts/me', { headers })).text()).toBe('wallet');
    }
    expect((await app.request('http://private.internal/session', { headers: { 'x-forwarded-host': 'signa.center', origin } })).status).toBe(404);
  });

  it('validates exact distinct credential and API origins', () => {
    for (const walletOrigin of ['https://signa.center/path', 'https://signa.center/', audience])
      expect(() => fixture({ walletOrigin })).toThrow();
    expect(() => fixture({ apiAudience: 'https://api.signa.center/path' })).toThrow();
  });

  it.each([origin, 'https://signa.center:8443'])('preserves wallet CSRF checks, exact Host and headers over HTTP for %s', async walletOrigin => {
    const wallet = new Hono();
    wallet.onError((_error, c) => c.text('rejected', 403));
    wallet.post('/session', async c => {
      assertWalletHttpRequest(c.req.raw, walletOrigin, 'central');
      return c.json({ origin: c.req.header('origin'), cookie: c.req.header('cookie'), authorization: c.req.header('authorization'),
        host: c.req.header('host'), url: c.req.url, body: await c.req.text() });
    });
    const { app, runtime } = fixture({ walletOrigin });
    runtime.wallet = wallet;
    const { port } = await start(app);
    const host = new URL(walletOrigin).host;
    const headers = { host, origin: walletOrigin, cookie: '__Host-center-wallet=unchanged', authorization: 'Bearer unchanged',
      'x-center-wallet-request': '1', 'content-type': 'application/json' };
    const response = await send(port, '/session?space=%20&slash=%2f', headers, '{"unchanged":true}');
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ origin: walletOrigin, cookie: headers.cookie, authorization: headers.authorization,
      host, url: 'http://' + host + '/session?space=%20&slash=%2f', body: '{"unchanged":true}' });
    expect((await send(port, '/session', { ...headers, origin: audience }, '{}')).status).toBe(403);
    expect((await send(port, '/session', { host: walletOrigin === origin ? 'signa.center:8443' : 'signa.center' }, '{}')).status).toBe(404);
    for (const [host, status] of [['unconfigured.center', 404], ['signa.center:9443', 404], ['SIGNA.CENTER:8443', 400], ['signa.center:443', 404]] as const)
      expect((await send(port, '/session', { host }, '{}')).status).toBe(status);
    for (const path of ['/api/v1/accounts/me', '/healthz', '/accounts', '/api'])
      expect((await send(port, path, { 'x-forwarded-host': 'api.signa.center', host })).status).toBe(404);
  });

  it('routes the mounted API while binding signatures to the original target and body bytes', async () => {
    const owner = privateKeyToAccount(`0x${'04'.padStart(64, '0')}`);
    const accountId = accountIdFor(owner.address, 1), now = 1_900_000_000;
    const auth = createRestAuth({ store: new MemoryAccountStore(), audience, now: () => now });
    const signed = async (target: string, body: string) => {
      const claims: RequestClaims = { accountId, signer: owner.address, grantId: '', method: 'POST', requestTarget: target,
        contentType: 'application/json', bodyHash: keccak256(new TextEncoder().encode(body)), issuedAt: now, expiresAt: now + 60, nonce: newRequestNonce(), idempotencyKey: '' };
      return { [H.account]: accountId, [H.signer]: owner.address, [H.issuedAt]: String(now), [H.expiresAt]: String(now + 60),
        [H.nonce]: claims.nonce, [H.signature]: await owner.signTypedData(buildRequestTypedData(audience, claims)), 'content-type': 'application/json' };
    };
    await auth.enroll({ method: 'POST', requestTarget: '/api/v1/accounts/enroll', contentType: 'application/json', body: new TextEncoder().encode('{}'),
      headers: new Headers(await signed('/api/v1/accounts/enroll', '{}')) });
    const api = new Hono<{ Bindings: HttpBindings }>();
    api.onError((error, c) => c.json({ code: error instanceof RestAuthError ? error.code : 'INTERNAL' }, error instanceof RestAuthError ? error.status as 400 : 500));
    api.post('/protected', async c => {
      const input = await readSignedRequest(c.req.raw, c.env.incoming.url!);
      const principal = await auth.authenticate(input);
      return c.json({ accountId: principal.account.id, target: input.requestTarget, body: new TextDecoder().decode(input.body), host: c.req.header('host') });
    });
    const { app, runtime } = fixture();
    runtime.api = new Hono().route('/api/v1', api);
    const { port } = await start(app);
    const target = '/api/v1/protected?value=%2f&value=+&space=%20', body = '{\n"amount": "12.00"\n}';
    const response = await send(port, target, { host: 'api.signa.center', ...await signed(target, body) }, body);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ accountId, target, body, host: 'api.signa.center' });
    for (const [sentTarget, sentBody] of [[target.replace('%2f', '%2F'), body], [target, body + ' '], [target.replace('/protected', '/ignored/../protected'), body]]) {
      const changed = await send(port, sentTarget!, { host: 'api.signa.center', ...await signed(target, body) }, sentBody!);
      expect(changed.status).toBe(401);
      expect(JSON.parse(changed.body)).toEqual({ code: 'INVALID_SIGNATURE' });
    }
  });

  it('passes streaming uploads immediately and propagates client disconnects to the handler signal', async () => {
    const first = deferred(), cancelled = deferred();
    const wallet = new Hono().post('/stream', async c => {
      const reader = c.req.raw.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('first');
      c.req.raw.signal.addEventListener('abort', () => cancelled.resolve(), { once: true });
      first.resolve();
      await cancelled.promise;
      reader.releaseLock();
      return c.text('cancelled');
    });
    const { app, runtime } = fixture();
    runtime.wallet = wallet;
    const { port } = await start(app);
    const request = nodeRequest({ hostname: '127.0.0.1', port, path: '/stream', method: 'POST', headers: { host: 'signa.center' } });
    const disconnected = new Promise<Error>(resolve => request.once('error', resolve));
    request.write('first');
    await first.promise;
    request.destroy();
    await cancelled.promise;
    expect(await disconnected).toHaveProperty('code', 'ECONNRESET');
  });

  it('drains active work and refuses later requests on the same connection', async () => {
    const entered = deferred(), finish = deferred();
    const wallet = new Hono().get('/work', async c => { entered.resolve(); await finish.promise; return c.text('completed'); });
    const { app, runtime, ready } = fixture();
    runtime.wallet = wallet;
    const { port, server } = await start(app);
    const accepted = new Promise<Socket>(resolve => server.server.once('connection', resolve));
    const socket = connect(port, '127.0.0.1');
    const completed = new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      socket.on('data', chunk => chunks.push(Buffer.from(chunk)));
      socket.once('error', reject);
      socket.once('end', () => resolve(Buffer.concat(chunks).toString()));
    });
    const peer = await accepted;
    const pipelined = new Promise<void>(resolve => peer.on('data', chunk => {
      if (chunk.toString().includes('GET /readyz')) resolve();
    }));
    socket.write('GET /work HTTP/1.1\r\nHost: signa.center\r\n\r\n');
    await entered.promise;
    const closing = server.close();
    expect(server.close()).toBe(closing);
    // The existing active connection may pipeline more work while close() drains it.
    socket.write('GET /readyz HTTP/1.1\r\nHost: private.internal\r\nConnection: close\r\n\r\n');
    await pipelined;
    expect(ready).not.toHaveBeenCalled();
    finish.resolve();
    const response = await completed;
    expect(response).toContain('HTTP/1.1 200 OK');
    expect(response).toContain('completed');
    expect(response).toContain('HTTP/1.1 503 Service Unavailable');
    expect(response).toContain('"code":"draining"');
    await closing;
    await expect(server.listen()).rejects.toThrow('cannot be restarted');
  });

  it('closes stalled connections at the shutdown deadline and aborts their handler', async () => {
    const entered = deferred(), cancelled = deferred();
    const wallet = new Hono().get('/stall', async c => {
      c.req.raw.signal.addEventListener('abort', () => cancelled.resolve(), { once: true });
      entered.resolve();
      await cancelled.promise;
      return c.text('cancelled');
    });
    const { app, runtime } = fixture();
    runtime.wallet = wallet;
    const { port, server } = await start(app, 25);
    const response = send(port, '/stall', { host: 'signa.center' });
    const disconnected = expect(response).rejects.toThrow();
    await entered.promise;
    await server.close();
    await Promise.all([cancelled.promise, disconnected]);
  });
});
