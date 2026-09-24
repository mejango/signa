// Local acceptance harness. All wallet execution is on a freshly spawned,
// unforked Anvil; the real client uses its installed SDK and the real Center HTTP
// handlers/stores. Browser routing bridges the fixture HTTPS name to loopback;
// this does not qualify a production TLS/proxy deployment or real Base funding.
import { randomUUID, createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { build } from 'esbuild';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Pool } from 'pg';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { hashTypedData, toHex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { PostgresWalletEnrollmentStore } from '@center/src/rest/wallet/enrollmentPostgres.js';
import { walletEnrollmentDocument } from '@center/src/rest/wallet/enrollment.js';
import { PostgresWalletDeploymentStore } from '@center/src/rest/wallet/deploymentPostgres.js';
import { createWalletDeploymentExecution } from '@center/src/rest/wallet/deploymentExecution.js';
import { createLocalAnvilWalletDeploymentTransport } from '@center/src/rest/wallet/deploymentLocalAnvil.js';
import { createLocalAnvilWalletDeploymentSettlement } from '@center/src/rest/wallet/deploymentSettlementLocalAnvil.js';
import { createSmartAccountService } from '@center/src/rest/smartAccounts/service.js';
import { PostgresSmartAccountRegistry } from '@center/src/rest/smartAccounts/postgres.js';
import { PostgresOnboardingStore } from '@center/src/rest/smartAccounts/onboardingPostgres.js';
import { createSafe7579Inspector } from '@center/src/rest/smartAccounts/inspector.js';
import { createInstalledSessionVerifier } from '@center/src/rest/smartAccounts/installed.js';
import { PostgresWalletAuthorityStore } from '@center/src/rest/wallet/authorityPostgres.js';
import { createWalletAuthorityChain } from '@center/src/rest/wallet/authorityChain.js';
import { createWalletAuthorityService } from '@center/src/rest/wallet/authorityService.js';
import { PostgresWalletLoginStore } from '@center/src/rest/wallet/loginPostgres.js';
import { PostgresWalletSignupStore } from '@center/src/rest/wallet/signupPostgres.js';
import { createLocalWalletSignup } from '@center/src/rest/wallet/signup.js';
import { createWalletSite } from '@center/src/rest/wallet/site.js';
import { PostgresWalletPolicyStore } from '@center/src/rest/wallet/policyPostgres.js';
import { PostgresWalletHandoffStore } from '@center/src/rest/wallet/handoffPostgres.js';
import { walletDeploymentDocument } from '@center/src/rest/wallet/deployment.js';
import { createRegistration, enrollmentBackupAccount, signBackupProof, signGet } from '@center/test/fixtures/wallet-enrollment-crypto.js';
import { migrate } from '@center/src/db/migrate.js';
import { startWalletDeploymentAnvil } from '@center/test/fixtures/wallet-deployment-anvil.js';
import { createRestAuth } from '@center/src/rest/auth/service.js';
import { createRestAuthRouter } from '@center/src/rest/auth/router.js';
import { PostgresAccountStore } from '@center/src/rest/auth/postgres.js';
import { REST_AUTH_HEADERS } from '@center/src/rest/auth/signatures.js';
import { createApp as createBeepApp } from '@beep/dist/app.js';
import { Store as BeepStore } from '@beep/dist/store.js';
import { Protocol as BeepProtocol, BASE } from '@beep/dist/protocol.js';

const base = process.env.HOMERUN_PILOT_ORIGIN!, issuer = 'https://signa.center', audience = 'https://api.signa.center';
const rpId = new URL(issuer).hostname, root = fileURLToPath(new URL('../../', import.meta.url));
const beepDirectory = process.env.BEEP_PILOT_ROOT!;
const output = root + '/.generated/wallet-observations/shared-clients';
const encode = (value: string) => Buffer.from(value, 'base64url').toString('base64');

it('shares one deployed Signa account across actual Homerun and Beep', async () => {
  const schema = 'client_pilot_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL, connectionTimeoutMillis: 3000, query_timeout: 10000 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema} -c statement_timeout=10000`,
    connectionTimeoutMillis: 3000, query_timeout: 10000, max: 5 });
  let fixture: Awaited<ReturnType<typeof startWalletDeploymentAnvil>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let server: ReturnType<typeof serve> | undefined;
  let beepServer: ReturnType<typeof serve> | undefined, beepStore: BeepStore | undefined;
  try {
    await migrate(pool);
    fixture = await startWalletDeploymentAnvil();
    const enrollments = new PostgresWalletEnrollmentStore(pool), deployments = new PostgresWalletDeploymentStore(pool);
    const settlement = createLocalAnvilWalletDeploymentSettlement(fixture);
    await fixture.rpc('anvil_setBalance', [fixture.sender, toHex(BigInt(fixture.configuration.allocationWei))]);
    await deployments.configurePool(fixture.configuration);
    const funding = await deployments.loadFundingContext(fixture.configuration.id);
    await deployments.initializeAccounting(funding, await settlement.observeFunding(funding), '2');
    const execution = createWalletDeploymentExecution({ store: deployments, chain: fixture.chain(), dispatchLeaseMs: 500,
      signer: mnemonicToAccount('test test test test test test test test test test test junk'),
      experimentalTransport: createLocalAnvilWalletDeploymentTransport(fixture) });
    const smart = createSmartAccountService({ rpc: fixture.readOnlyRpc, manifests: [fixture.manifest], audience,
      registry: new PostgresSmartAccountRegistry(pool), onboarding: new PostgresOnboardingStore(pool),
      moduleInspectors: [createSafe7579Inspector({ rpc: fixture.readOnlyRpc, utility: fixture.utility,
        inspectSessions: createInstalledSessionVerifier({ rpc: fixture.readOnlyRpc }).inspectAllAt })] });
    const authority = createWalletAuthorityService({ store: new PostgresWalletAuthorityStore(pool),
      chain: createWalletAuthorityChain({ rpc: fixture.readOnlyRpc, manifest: fixture.manifest, utility: fixture.utility }) });
    const flows = new PostgresWalletSignupStore(pool, { origin: issuer, rpId, manifest: fixture.manifest });
    const signup = createLocalWalletSignup({ flows, enrollments, deployments, settlement, execution, smart, authority,
      registry: new PostgresSmartAccountRegistry(pool), chain: fixture.chain(), poolId: fixture.configuration.id,
      releasedObservationIntervalMs: 0 });
    const begun = await signup.begin({ recoveryOwner: enrollmentBackupAccount.address, passkeyName: 'Signa Homerun pilot' });
    const token = begun.flowToken, initial = (await enrollments.get(begun.view.enrollmentId))!;
    const credential = createRegistration({ challenge: `0x${Buffer.from(initial.intent.registration.challenge, 'base64url').toString('hex')}`,
      rpId, origin: issuer, userHandle: initial.intent.userHandle });
    await signup.register(token, credential.response);
    const document = walletEnrollmentDocument((await enrollments.get(initial.intent.id))!);
    await signup.proveEnrollment(token, { assertion: signGet({ ...credential, challenge: hashTypedData(document), rpId, origin: issuer }),
      backupSignature: await signBackupProof(document) });
    const enrollment = (await enrollments.get(initial.intent.id))!, accountId = enrollment.receipt!.accountId;
    const creation = await signup.prepareDeployment(token);
    await signup.approveDeployment(token, { approvalId: creation.id,
      assertion: signGet({ ...credential, challenge: hashTypedData(walletDeploymentDocument((await enrollments.get(initial.intent.id))!, (await deployments.get(creation.id))!.approval)), rpId, origin: issuer }) });
    for (let attempt = 0; attempt < 5 && !(await deployments.getDispatch(creation.id)); attempt++) await signup.tick();
    const dispatch = (await deployments.getDispatch(creation.id))!;
    await new Promise(resolve => setTimeout(resolve, Math.max(1, dispatch.leaseUntil - Date.now() + 20)));
    await fixture.rpc('anvil_mine', ['0x41', '0x0']);
    for (let attempt = 0; attempt < 12 && (await signup.status(token)).phase !== 'awaiting_activation'; attempt++) {
      await signup.tick(); await new Promise(resolve => setTimeout(resolve, 500));
    }
    expect((await signup.status(token)).phase).toBe('awaiting_activation');
    expect((await signup.activate(token)).phase).toBe('ready_to_sign_in');
    expect((await authority.refreshAuthority(accountId)).snapshot.readiness).toBe('verified');
    let beepApp = new Hono();
    beepServer = serve({ port: 0, hostname: '127.0.0.1', fetch: request => beepApp.fetch(request) });
    if (!beepServer.listening) await once(beepServer, 'listening');
    const beepOrigin = `http://127.0.0.1:${(beepServer.address() as { port: number }).port}`;
    beepStore = new BeepStore(':memory:');
    const terminal = beepStore.createTerminal('Local shared wallet pilot', { chainId: 8453, projectId: '6', chainName: 'Local test chain',
      name: 'Juicebox local pilot', symbol: 'TEST', projectToken: BASE.tokens, owner: BASE.projects,
      terminal: BASE.terminal, usdc: BASE.usdc, checkedBlock: '1' });
    const sale = beepStore.createSale(terminal.id, '1', 'local-pilot-invoice');
    const beepPath = '/i/' + sale.id;
    beepApp = createBeepApp({ store: beepStore, protocol: new BeepProtocol(fixture.endpoint),
      adminKey: 'local-acceptance-only-no-production-authority', origin: beepOrigin, paymentsEnabled: false,
      centerWallet: { enabled: true, issuer, audience, callbackUri: beepOrigin + '/center/callback',
        manifest: { id: fixture.manifest.id, revision: fixture.manifest.revision }, maximumNetworkFee: '100000000000000' } });
    const beepRoot = beepDirectory + '/web-dist';
    beepApp.get('/assets/*', serveStatic({ root: beepRoot }));
    beepApp.get('*', async c => {
      if (c.req.path.startsWith('/api/')) return c.json({ error: 'Not found' }, 404);
      return c.html(await readFile(beepRoot + '/index.html', 'utf8'));
    });
    const policy = new PostgresWalletPolicyStore(pool);
    await policy.activate({ expectedRevision: 0, nextRevision: 1, configuration: { version: 'center-wallet-policy-v1',
      applications: [{ origin: base, walletCallbacks: [base + '/center/callback'] },
        { origin: beepOrigin, walletCallbacks: [beepOrigin + '/center/callback'] }] } });
    const login = new PostgresWalletLoginStore(pool, { origin: issuer, rpId });
    const script = (await build({ entryPoints: [root + '/src/rest/web/wallet.ts'], platform: 'browser', bundle: true, format: 'esm', write: false })).outputFiles[0]!.text;
    const app = createWalletSite({ origin: issuer, audience, basePath: '', browserScript: script, policy, login,
      frameableAppOrigins: [base, beepOrigin],
      handoff: new PostgresWalletHandoffStore(pool, { issuer, audience, frameableAppOrigins: [base, beepOrigin] }),
      refresh: { request: id => authority.refreshAuthority(id), tick: async () => ({}) } });
    const api = new Hono();
    api.use('*', cors({ origin: [base, beepOrigin], credentials: false, allowMethods: ['GET', 'OPTIONS'],
      allowHeaders: [...Object.values(REST_AUTH_HEADERS), 'Content-Type'] }));
    api.route('/api/v1', createRestAuthRouter(createRestAuth({ audience, store: new PostgresAccountStore(pool,
      { walletRefresh: { request: id => authority.refreshAuthority(id), tick: async () => ({}) } }) }),
      { requestTarget: context => new URL(context.req.url).pathname }));
    // Observation-only browser module: it restores the actual packaged SDK
    // connection and asks the real server to authorize a signed account read.
    // No key or signature is exported into the test report.
    const readScript = (await build({ stdin: { contents: `import { createCenterWalletClient } from '@bananapus/nana-sdk-connect/core';
      export async function read() {
        const connection = createCenterWalletClient({ issuer: ${JSON.stringify(issuer)}, audience: ${JSON.stringify(audience)},
          callbackUri: location.origin + '/center/callback', storage: location.origin === ${JSON.stringify(beepOrigin)} ? localStorage : sessionStorage }).restoreConnection();
        if (!connection) throw new Error('No client connection');
        return (await connection.client.account()).account.id;
      }`, resolveDir: beepDirectory }, platform: 'browser', bundle: true, format: 'esm', write: false })).outputFiles[0]!.text;
    const transport: { path: string; method: string; status: number; cookie: boolean }[] = [], exchanges: string[] = [];
    server = serve({ port: 0, hostname: '127.0.0.1', fetch: async incoming => {
      const path = new URL(incoming.url).pathname;
      const headers = new Headers(incoming.headers);
      for (const name of ['mode', 'dest']) { const value = headers.get(`x-pilot-fetch-${name}`); if (value) headers.set(`sec-fetch-${name}`, value); headers.delete(`x-pilot-fetch-${name}`); }
      const request = new Request((path.startsWith('/api/') ? audience : issuer) + path + new URL(incoming.url).search,
        { method: incoming.method, headers, body: incoming.method === 'GET' || incoming.method === 'HEAD' ? undefined : incoming.body, duplex: 'half' });
      if (path === '/wallet/handoff/exchange' && request.method === 'POST')
        exchanges.push(createHash('sha256').update(await request.clone().text()).digest('hex'));
      const result = await (path.startsWith('/api/') ? api : app).fetch(request);
      const loggedPath = /^\/wallet\/authorize\/[A-Za-z0-9_-]{43}$/.test(path) ? '/wallet/authorize/:intent' : path;
      transport.push({ path: loggedPath, method: request.method, status: result.status, cookie: request.headers.has('cookie') });
      if (path === '/wallet/handoff/exchange' && request.method === 'POST' && exchanges.length === 1 && result.ok)
        return new Response('Lost response after the real grant committed', { status: 503, headers: result.headers });
      return result;
    } });
    if (!server.listening) await once(server, 'listening');
    const local = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    // The fixture models public Signa on loopback; production app callbacks are HTTPS.
    browser = await chromium.launch({ headless: true, args: ['--disable-features=LocalNetworkAccessChecks'] });
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, reducedMotion: 'reduce' });
    await context.route(/^https:\/\/(?:api\.)?signa\.center\//, async route => {
      const request = route.request(), url = new URL(request.url());
      const origin = url.origin;
      const response = await route.fetch({ url: local + url.pathname + url.search, maxRedirects: 0, maxRetries: 0,
        headers: { ...await request.allHeaders(), host: new URL(origin).host,
          ...(request.isNavigationRequest() ? { 'x-pilot-fetch-mode': 'navigate', 'x-pilot-fetch-dest': request.frame().parentFrame() ? 'iframe' : 'document' } : {}) } });
      if (url.pathname === '/wallet/launch' && response.status() === 303) {
        // Playwright follows a fulfilled 303 outside route interception. A meta refresh
        // makes the browser start a new navigation that stays inside this local fixture.
        const destination = response.headers()['location'];
        expect(destination?.startsWith(issuer + '/?intent=')).toBe(true);
        await route.fulfill({ status: 200, contentType: 'text/html',
          headers: { 'content-security-policy': response.headers()['content-security-policy']! },
          body: `<!doctype html><meta http-equiv="refresh" content="0;url=${destination}">` });
        return;
      }
      await route.fulfill({ response });
    });
    for (const origin of [base, beepOrigin]) await context.route(origin + '/__center_pilot_read.js', route =>
      route.fulfill({ contentType: 'text/javascript', body: readScript }));
    const page = await context.newPage(), errors: string[] = [];
    page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.name));
    const cdp = await context.newCDPSession(page); await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
      protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: { credentialId: encode(credential.credentialId),
      privateKey: credential.key.export({ format: 'der', type: 'pkcs8' }).toString('base64'), userHandle: encode(credential.userHandle),
      rpId, isResidentCredential: true, signCount: 0, backupEligibility: enrollment.candidate!.backupEligible, backupState: enrollment.candidate!.backedUp } });
    await page.goto(base + '/founderhaus', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    for (let attempt = 0; attempt < 5 && !(await page.locator('.jb-connect-primary').isVisible()); attempt++) {
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.waitForTimeout(1_000);
    }
    expect(await page.locator('.jb-connect-primary').isVisible(), JSON.stringify(await page.getByRole('button').allTextContents())).toBe(true);
    await page.locator('.jb-connect-primary').click();
    await page.frameLocator('iframe[name="juicebox-center-frame"]').getByRole('button', { name: 'Signa in' }).click();
    await expect.poll(() => page.locator('.jb-connect-error').textContent()).toContain('Retry');
    await page.locator('.jb-connect-primary').click();
    await expect.poll(() => page.url()).toBe(base + '/founderhaus');
    await page.getByRole('button', { name: /^Signed in as/ }).waitFor();
    expect(exchanges).toHaveLength(2); expect(exchanges[0]).toBe(exchanges[1]);
    const grants = await pool.query('SELECT grant_document FROM rest_wallet_handoffs WHERE state = $1', ['consumed']);
    expect(grants.rowCount).toBe(1); expect(grants.rows[0].grant_document.accountId).toBe(accountId);
    expect(grants.rows[0].grant_document.scopes).toEqual(['read', 'plan', 'relay']);
    await page.reload(); await page.getByRole('button', { name: /^Signed in as/ }).waitFor();
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: output + '/homerun-connected.png', fullPage: true });
    const beep = await context.newPage(); beep.setDefaultTimeout(15000);
    beep.on('pageerror', error => errors.push(error.name));
    const beepCdp = await context.newCDPSession(beep); await beepCdp.send('WebAuthn.enable');
    const { authenticatorId: beepAuthenticatorId } = await beepCdp.send('WebAuthn.addVirtualAuthenticator', { options: {
      protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await beepCdp.send('WebAuthn.addCredential', { authenticatorId: beepAuthenticatorId, credential: { credentialId: encode(credential.credentialId),
      privateKey: credential.key.export({ format: 'der', type: 'pkcs8' }).toString('base64'), userHandle: encode(credential.userHandle),
      rpId, isResidentCredential: true, signCount: 0, backupEligibility: enrollment.candidate!.backupEligible, backupState: enrollment.candidate!.backedUp } });
    await beep.goto(beepOrigin + beepPath);
    await beep.getByRole('button', { name: 'Sign in', exact: true }).click();
    await beep.getByRole('button', { name: 'Signa in', exact: true }).click();
    await beep.frameLocator('iframe[name="juicebox-center-frame"]').getByRole('button', { name: 'Signa in' }).click();
    await beep.locator('details.quiet summary').click();
    const beepAddress = `${enrollment.creation!.address.slice(0, 6)}…${enrollment.creation!.address.slice(-4)}`;
    await beep.locator('details.quiet dd').filter({ hasText: beepAddress }).waitFor({ state: 'visible' });
    await expect.poll(() => beep.url()).toBe(beepOrigin + beepPath);
    await expect.poll(() => beep.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('center.wallet.connection.v1:')).length)).toBe(1);
    const beepAccount = await beep.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find(key => key.startsWith('center.wallet.connection.v1:'))!)!).grant.accountId);
    expect(beepAccount).toBe(accountId);
    const shared = await pool.query('SELECT grant_document FROM rest_wallet_handoffs WHERE state = $1 ORDER BY origin', ['consumed']);
    expect(shared.rowCount).toBe(2);
    expect(shared.rows.every(row => row.grant_document.accountId === accountId)).toBe(true);
    expect(new Set(shared.rows.map(row => row.grant_document.signerAddress)).size).toBe(2);
    expect(new Set(shared.rows.map(row => row.grant_document.origin))).toEqual(new Set([base, beepOrigin]));
    // Each framed app performs a fresh passkey sign-in; both resolve to the same account.
    expect((await pool.query('SELECT count(*)::int AS n FROM rest_wallet_logins WHERE completed_at_ms IS NOT NULL')).rows[0].n).toBe(2);
    expect(transport.filter(item => item.path === '/wallet/handoff/exchange' && item.method === 'POST')).toHaveLength(3);
    expect(transport.filter(item => item.path.startsWith('/wallet/handoff/') && item.method === 'POST').every(item => !item.cookie)).toBe(true);
    await beep.reload();
    await beep.locator('details.quiet summary').click();
    await beep.locator('details.quiet dd').filter({ hasText: beepAddress }).waitFor({ state: 'visible' });
    await beep.screenshot({ path: output + '/beep-connected.png', fullPage: true });
    // A browser expression keeps Vitest's server import transform out of the
    // native browser module import. Only public account/status values return.
    const readAccount = (target: typeof page) => target.evaluate(`import('/__center_pilot_read.js')
      .then(module => module.read()).then(accountId => ({ accepted: true, accountId }))
      .catch(error => ({ accepted: false, errorName: error.name, message: String(error.message).slice(0, 160) }))`);
    const homerunRead = await readAccount(page);
    expect(homerunRead, JSON.stringify(transport.slice(-8))).toEqual({ accepted: true, accountId });
    expect(await readAccount(beep)).toEqual({ accepted: true, accountId });
    expect(transport.filter(item => item.path === '/api/v1/accounts/me' && item.method === 'GET').map(item => item.status)).toEqual([200, 200]);
    await page.getByRole('button', { name: /^Signed in as/ }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('center.wallet.connection.v1:')))).toEqual([]);
    expect(errors).toEqual([]);
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: output + '/homerun.png', fullPage: true });
    await writeFile(output + '/summary.json', JSON.stringify({ passed: true,
      observedAt: new Date().toISOString(), client: 'actual Homerun Next app and Beep checkout, pinned SDKs', browser: browser.version(),
      realSignaHttp: true, realPostgres: true, realUnforkedAnvil: true, nativeVirtualPasskeyAssertion: true,
      walletDeployedAndCanonicallyVerified: true, sameExchangeRecoveredAfterLostReply: true,
      grants: 2, centralSessions: 2, sameWalletAcrossClients: true, separateAppKeys: true, credentiallessExchanges: true,
      callbackSecretsScrubbed: true, signedAccountReads: 2,
      reloadRestored: true, localDisconnectCleared: true, pageErrors: errors,
      beepPaymentsEnabled: false, beepProjectQuoteQualified: false,
      productionTlsProxyObserved: false, productionBaseObserved: false, paymentsObserved: false, transport }, null, 2));
  } finally {
    await browser?.close();
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    if (beepServer) { beepServer.closeAllConnections(); await new Promise<void>(resolve => beepServer!.close(() => resolve())); }
    beepStore?.close();
    await fixture?.close(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});
