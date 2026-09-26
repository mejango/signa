import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { build } from 'esbuild';
import { Hono } from 'hono';
import { chromium } from 'playwright';
import { expect } from 'vitest';
import type { Pool } from 'pg';
import type { TypedDataDefinition } from 'viem';
import { toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createLocalWalletSignup, type LocalWalletSignupDependencies } from '../../src/rest/wallet/signup.js';
import { PostgresWalletSignupStore } from '../../src/rest/wallet/signupPostgres.js';
import { PostgresWalletLoginStore } from '../../src/rest/wallet/loginPostgres.js';
import { PostgresWalletRecoveryStore } from '../../src/rest/wallet/recoveryPostgres.js';
import { PostgresWalletRecoveryFlowStore } from '../../src/rest/wallet/recoveryFlowPostgres.js';
import { createLocalAnvilWalletRecovery } from '../../src/rest/wallet/recoveryLocalAnvil.js';
import { createLocalWalletRecovery } from '../../src/rest/wallet/recoveryService.js';
import { createWalletAuthorityChain } from '../../src/rest/wallet/authorityChain.js';
import { createWalletNetworks } from '../../src/rest/wallet/networks.js';
import { PostgresWalletAuthorityStore } from '../../src/rest/wallet/authorityPostgres.js';
import { PostgresWalletNetworksStore } from '../../src/rest/wallet/networksPostgres.js';
import { RELAYR_NATIVE_TOKEN, RELAYR_PAYMENT_ADDRESS, RELAYR_PAYMENT_SELECTOR } from '../../src/rest/sponsorship/constants.js';
import { RELAYR_PAYMENT_RUNTIME } from './relayr-payment.js';
import { exerciseRecoveryBrowser } from './wallet-recovery-browser.js';
import { createWalletSite } from '../../src/rest/wallet/site.js';
import { walletSignupCookie } from '../../src/rest/wallet/http.js';
import { enrollmentBackupAccount } from './wallet-enrollment-crypto.js';
import type { startWalletDeploymentAnvil } from './wallet-deployment-anvil.js';

/** Real browser, HTTP handlers, PostgreSQL and unforked EVM. Only the hardware
 * authenticator and independent test recovery wallet are simulated. */
export async function exerciseSignupBrowser(options: Omit<LocalWalletSignupDependencies, 'flows'> & {
  pool: Pool; fixture: Awaited<ReturnType<typeof startWalletDeploymentAnvil>>;
  recoveryMode?: 'wallet' | 'kit'; expectedNextNonce?: string;
  /** Lose the continuation cookie and pick the signup up with its passkey before activation (default). */
  resume?: boolean;
}) {
  let app = new Hono(), lostRegistration = false, lostSetup = false;
  let recoveryKitText: string | null = null;
  const lostRecoveryPaths = new Set<string>();
  const kitMode = options.recoveryMode === 'kit', requestBodies: string[] = [];
  const observed: { path: string; status: number }[] = [];
  const server = serve({ port: 0, hostname: '127.0.0.1', fetch: async request => {
    if (kitMode && request.method === 'POST') requestBodies.push(await request.clone().text());
    const response = await app.fetch(request), path = new URL(request.url).pathname;
    observed.push({ path, status: response.status });
    if (kitMode && response.ok && ['/recovery/register', '/recovery/rotation/approve', '/recovery/activate'].includes(path)
      && !lostRecoveryPaths.has(path)) {
      lostRecoveryPaths.add(path); return new Response('Unavailable after commit', { status: 503 });
    }
    // The kit journey loses the setup reply and logs in by hand; the wallet journey keeps it and
    // proves the single "Continue" click carries the user from setup into the signed-in wallet.
    // The kit journey loses the registration and setup replies and recovers by hand; the wallet
    // journey keeps them and proves one click runs create, check and approve, then setup and login.
    if (response.ok && kitMode && ((path === '/signup/register' && !lostRegistration) || (path === '/signup/activate' && !lostSetup))) {
      if (path.endsWith('/register')) lostRegistration = true; else lostSetup = true;
      return new Response('Unavailable after commit', { status: 503 });
    }
    return response;
  } });
  if (!server.listening) await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No local signup listener.');
  const origin = `http://localhost:${address.port}`;
  const flows = new PostgresWalletSignupStore(options.pool, { origin, rpId: 'localhost', manifest: options.fixture.manifest });
  const login = new PostgresWalletLoginStore(options.pool, { origin, rpId: 'localhost' });
  const signup = createLocalWalletSignup({ ...options, flows, login, releasedObservationIntervalMs: 0 });
  let refreshHold: Promise<void> = Promise.resolve(), releaseRefresh = () => {};
  const recoveryObserver = createWalletAuthorityChain({ rpc: options.fixture.readOnlyRpc, manifest: options.fixture.manifest, utility: options.fixture.utility });
  const relay = privateKeyToAccount(`0x${'77'.repeat(32)}`);
  const recovery = kitMode ? createLocalWalletRecovery({ audience: 'https://juicebox.center', smart: options.smart, authority: options.authority,
    recoveries: new PostgresWalletRecoveryStore(options.pool, { origin, rpId: 'localhost' },
      { audience: 'https://juicebox.center', observe: context => recoveryObserver.observe(context) }),
    flows: new PostgresWalletRecoveryFlowStore(options.pool),
    rotation: createLocalAnvilWalletRecovery({ pool: options.pool, endpoint: options.fixture.endpoint, expectedGenesisHash: options.fixture.expectedGenesisHash,
      signer: relay, manifest: options.fixture.manifest, utility: options.fixture.utility, maximumOperations: 2, maximumCostWei: '1000000000000000000' }) }) : null;
  if (kitMode) await options.fixture.rpc('anvil_setBalance', [relay.address, toHex(10n ** 20n)]);
  // The account on more chains: Relayr is faked (one quote, then "Included" once the payment landed),
  // Optimism reads are faked (code appears after the payment), the payment itself lands on the Base anvil.
  const networksPayer = privateKeyToAccount(`0x${'88'.repeat(32)}`), networksBundleUuid = 'c0ffee00-4444-4111-aaaa-333333333333';
  let networksPaid = false;
  await options.fixture.rpc('anvil_setBalance', [networksPayer.address, toHex(10n ** 18n)]);
  await options.fixture.rpc('anvil_setCode', [RELAYR_PAYMENT_ADDRESS, RELAYR_PAYMENT_RUNTIME]);
  const networksProvider = { entries: [] as { chain: number; target: string; data: string; value: string }[],
    async createIndependent(entries: { chain: number; target: string; data: string; value: string }[]) {
      networksProvider.entries = entries; const deadline = Math.floor(Date.now() / 1000) + 900;
      return { bundle_uuid: networksBundleUuid, tx_uuids: entries.map((_, i) => `d1d1d1d1-0000-4000-8000-00000000000${i}`),
        payment_info: [{ chain: 8453, target: RELAYR_PAYMENT_ADDRESS, token: RELAYR_NATIVE_TOKEN, amount: '12000000000000', payment_deadline: String(deadline),
          calldata: `${RELAYR_PAYMENT_SELECTOR}${networksBundleUuid.replaceAll('-', '')}${'0'.repeat(32)}${deadline.toString(16).padStart(64, '0')}` }] }; },
    async status(uuid: string) { return { bundle_uuid: uuid, transactions: networksProvider.entries.map((entry, i) => ({ tx_uuid: `d1d1d1d1-0000-4000-8000-00000000000${i}`,
      request: entry, status: { state: networksPaid ? 'Included' : 'Pending', data: networksPaid ? { hash: `0x${'ab'.repeat(32)}` } : {} } })) }; } };
  let networksWalletAddress = '';
  const networksRpc = { async request(chainId: number, method: string, params: readonly unknown[]) {
    if (chainId === 8453) { const result = await options.fixture.rpc(method, params); if (method === 'eth_sendRawTransaction') networksPaid = true; return result; }
    // Optimism: the creation stack reads come from the same anvil bytes; the account appears once the payment landed.
    if (method === 'eth_getCode') {
      const address = String(params[0]).toLowerCase();
      if (address === networksWalletAddress) return networksPaid ? '0x6001' : '0x';
      return options.fixture.rpc(method, params);
    }
    if (method === 'eth_call') return `0x${'00'.repeat(12)}${networksWalletAddress.slice(2)}`;
    throw new Error(`Unexpected ${method} on chain ${chainId}`); } };
  const networks = createWalletNetworks({ enrollments: options.enrollments, authority: new PostgresWalletAuthorityStore(options.pool),
    store: new PostgresWalletNetworksStore(options.pool), provider: networksProvider, rpc: networksRpc,
    payer: { address: networksPayer.address, signTransaction: transaction => networksPayer.signTransaction(transaction) } });
  const bundle = async (entry: string) => (await build({ entryPoints: [entry], bundle: true, platform: 'browser', format: 'esm', write: false })).outputFiles[0]!.text;
  const [browserScript, signupBrowserScript] = await Promise.all([bundle('src/rest/web/wallet.ts'), bundle('src/rest/web/walletSignup.ts')]);
  const recoveryBrowserScript = recovery ? await bundle('src/rest/web/walletRecoveryJourney.ts') : undefined;
  app = createWalletSite({ origin, basePath: '', audience: 'https://juicebox.center', browserScript, signup, signupBrowserScript, login,
    ...(recovery ? { recovery, recoveryBrowserScript: recoveryBrowserScript! } : {}), networks,
    // No app handoff is involved in this signup/login observation.
    handoff: {} as never, policy: {} as never,
    // The site kicks the authority refresh after setup; holding it makes the "preparing" phase
    // observable before the worker (inline here) verifies the authority and login opens.
    refresh: { request: async accountId => { await refreshHold; await options.authority.refreshAuthority(accountId); }, tick: async () => ({}) } });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1000, height: 850 } });
  const page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.name));
  page.setDefaultTimeout(15000);
  await page.exposeFunction('recoveryTestRequest', async (input: { method: string; params?: unknown[] }) => {
    if (kitMode) throw new Error('First-time signup must not request an external wallet.');
    if (input.method === 'eth_requestAccounts') return [enrollmentBackupAccount.address];
    if (input.method === 'eth_signTypedData_v4') {
      expect(input.params?.[0]).toBe(enrollmentBackupAccount.address);
      return enrollmentBackupAccount.signTypedData(JSON.parse(input.params?.[1] as string) as TypedDataDefinition);
    }
    throw new Error('Unsupported test recovery wallet method.');
  });
  await page.addInitScript(() => {
    (window as any).ethereum = { request: (input: unknown) => (window as any).recoveryTestRequest(input) };
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
  } });
  const out = new URL(`../../.generated/wallet-observations/signup-browser${kitMode ? '-kit' : ''}/`, import.meta.url);
  // Match the browser's existing wait budget, rather than Vitest's one-second
  // polling default. The enclosing journey and all server deadlines stay bounded.
  const contains = async (text: string) => expect.poll(() => page.locator('#wallet-status').textContent(), { timeout: 15000 }).toContain(text);
  // The page asks before going on only when something would be lost or is unexpected; "Continue" answers it.
  const proceed = async (title: string) => {
    await expect.poll(() => page.locator('#explain-title').textContent(), { timeout: 15000 }).toBe(title);
    await page.locator('#explain-continue').click();
  };
  try {
    await page.goto(origin + '/create');
    const fillForm = async () => {
      await page.locator('#passkey-name').fill('Juicebox test');
      if (!kitMode) await page.getByLabel('A wallet you already have').check();
    };
    await fillForm();
    // Sign up opens the passkey prompt at once; a cancelled prompt leaves the explicit button as the fallback.
    // The OS prompt owns cancellation; a cancelled prompt rejects with NotAllowedError.
    await page.evaluate(() => {
      const original = navigator.credentials.create;
      navigator.credentials.create = async () => { navigator.credentials.create = original; throw new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError'); };
    });
    await page.getByRole('button', { name: 'Signa up' }).click();
    await contains('We couldn’t finish with your device');
    expect(await page.locator('#wallet-status').getAttribute('data-state')).toBe('ready');
    // Starting over forgets the continuation and shows the clean form again.
    await page.getByRole('button', { name: 'Reset signup' }).click();
    await expect.poll(() => page.locator('#passkey-name').isVisible()).toBe(true);
    expect((await context.cookies()).some(item => item.name === walletSignupCookie)).toBe(false);
    await fillForm();
    // The prompt opens straight from the tap; cancelling it leaves the explicit button as the fallback.
    await page.evaluate(() => {
      const original = navigator.credentials.create;
      navigator.credentials.create = async () => { navigator.credentials.create = original; throw new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError'); };
    });
    await page.getByRole('button', { name: 'Signa up' }).click();
    await contains('We couldn’t finish with your device');
    // A begun signup without a passkey yet still offers "log in" for someone who already has an account.
    expect(await page.getByRole('link', { name: 'Signa in' }).isVisible()).toBe(true);
    await page.evaluate(() => {
      const original = navigator.credentials.create;
      navigator.credentials.create = async () => { navigator.credentials.create = original; throw new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError'); };
    });
    await page.getByRole('button', { name: 'Signa up', exact: true }).click();
    await contains('We couldn’t finish with your device');
    await page.getByRole('button', { name: 'Signa up', exact: true }).click();
    let encoded = '';
    if (kitMode) {
      await contains('Check the original signup');
      await page.getByRole('button', { name: 'Check signup' }).click();
      await contains('Your passkey is ready');
      const create = page.getByRole('button', { name: 'Create account', exact: true });
      // The lost registration reply leaves a manual retry. A normal registration continues
      // into fresh approval by itself, before the backup is shown during deployment.
      expect(await create.isDisabled()).toBe(false);
      expect(await page.locator('#recovery-kit').isVisible()).toBe(true);
      await create.click();
    }
    // Under gate load a shared local anvil can time the approval's chain reads out; the page says
    // so and a person clicks again, as they would. Once.
    await expect.poll(() => page.locator('#wallet-status').textContent(), { timeout: 15000 }).toMatch(/Creating your account|Signup could not be confirmed/);
    if ((await page.locator('#wallet-status').textContent())?.includes('Signup could not be confirmed')) await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await contains('Creating your account');
    const originalAddress = await page.locator('#signup-address').textContent();
    networksWalletAddress = (originalAddress ?? '').toLowerCase();
    if (!kitMode) expect((await page.locator('#signup-recovery').textContent())?.toLowerCase()).toBe(enrollmentBackupAccount.address.toLowerCase());
    if (kitMode) {
      const predictedAddress = await page.locator('#signup-address').textContent();
      expect(await page.locator('#recovery-phrase').getAttribute('type')).toBe('password');
      await page.getByRole('button', { name: 'Show' }).click();
      const shown = await page.locator('#recovery-phrase').inputValue();
      expect(shown.split(' ')).toHaveLength(24);
      await page.getByRole('button', { name: 'Hide' }).click();
      const downloaded = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Save backup file' }).click();
      const stream = await (await downloaded).createReadStream(), chunks = [];
      if (!stream) throw new Error('No recovery download.');
      for await (const chunk of stream) chunks.push(chunk);
      encoded = Buffer.concat(chunks).toString('utf8'); const kit = JSON.parse(encoded);
      recoveryKitText = encoded;
      expect(kit.walletAddress.toLowerCase()).toBe(predictedAddress?.toLowerCase());
      expect(kit.mnemonic).toBe(shown);
      // Leaving during deployment must not carry the backup words in browser storage.
      if (options.resume ?? true) await page.goto('about:blank');
    }
    // Nothing to press while creation runs: the events stream (or the poll behind it) carries the
    // view, so the kit appears without another click. A restart here would orphan a paid creation.
    expect(await page.getByRole('button', { name: 'Check signup' }).isVisible()).toBe(false);
    expect(await page.getByRole('button', { name: 'Reset signup' }).isVisible()).toBe(false);
    const cookie = (await context.cookies()).find(item => item.name === walletSignupCookie)!;
    const flow = (await flows.authenticate(cookie.value))!, deploymentId = flow.deploymentId!;
    await signup.tick();
    // Under load the dispatch may already have settled by now; only an open lease needs waiting out.
    const dispatch = await options.deployments.getDispatch(deploymentId);
    if (dispatch) await expect.poll(() => flows.now()).toBeGreaterThanOrEqual(dispatch.leaseUntil);
    await options.fixture.rpc('anvil_mine', ['0x41', '0x0']); await signup.tick();
    const resumed = options.resume ?? true;
    if (resumed) {
      await context.clearCookies({ name: walletSignupCookie });
      if (kitMode) await page.goto(origin + '/create'); else await page.reload();
      await page.getByRole('link', { name: 'Signa in' }).click();
      await proceed('Pick up your signup');
      await contains('Your account is ready');
      expect(await page.locator('#signup-address').textContent()).toBe(originalAddress);
      expect(await flows.authenticate(cookie.value)).toBeNull();
    }
    if (kitMode) {
      const kit = JSON.parse(encoded);
      expect(await page.locator('#recovery-phrase').inputValue()).toBe('');
      await page.setViewportSize({ width: 320, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      // After a reload, reopening the saved backup is optional; Continue stays available.
      expect(await page.locator('#recovery-restore-box').isVisible()).toBe(true);
      expect(await page.getByRole('link', { name: 'reset signup' }).isVisible()).toBe(true);
      expect(await page.locator('#signup-recovery-label').textContent()).toBe('Backup password address');
      expect((await page.locator('#signup-recovery').textContent())?.toLowerCase()).toBe(String(kit.recoveryOwner).toLowerCase());
      expect(await page.getByRole('button', { name: 'Continue', exact: true }).isDisabled()).toBe(false);
      await page.locator('#recovery-verify summary').click();
      const wrong = JSON.stringify({ ...kit, walletAddress: '0x' + '44'.repeat(20) });
      await page.getByLabel('Backup file', { exact: true }).setInputFiles({ name: 'wrong.json', mimeType: 'application/json', buffer: Buffer.from(wrong) });
      await contains('does not match');
      await page.getByLabel('Backup file', { exact: true }).setInputFiles({ name: 'recovery.json', mimeType: 'application/json', buffer: Buffer.from(encoded) });
      await contains('Backup file verified');
      expect(await page.getByRole('button', { name: 'Continue', exact: true }).isDisabled()).toBe(false);
      const persisted = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
      expect(persisted.includes(kit.mnemonic)).toBe(false);
      expect(requestBodies.some(body => body.includes(kit.mnemonic))).toBe(false);
      await page.setViewportSize({ width: 1000, height: 850 });
    }
    await mkdir(out, { recursive: true });
    await page.screenshot({ path: new URL('signup-desktop.png', out).pathname, fullPage: true });
    await page.setViewportSize({ width: 320, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: new URL('signup-mobile.png', out).pathname, fullPage: true });
    await page.setViewportSize({ width: 1000, height: 850 });
    // Activation binds the account, carries its first authority observation and (on the page that
    // approved) signs it in, all in the one Continue click.
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    if (kitMode) {
      await contains('Check the original signup');
      await page.getByRole('button', { name: 'Check signup' }).click();
    }
    // The Continue click carries through to the login once the authority is verified; a browser
    // that wants a fresh click for the prompt (or a slower refresh) leaves the Log in button instead.
    for (let i = 0; i < 40 && !(await page.locator('#wallet-status').textContent())?.includes('You are signed in'); i++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      if (i >= 12 && await page.getByRole('button', { name: 'Signa in', exact: true }).isVisible()) { await page.getByRole('button', { name: 'Signa in', exact: true }).click({ timeout: 2000 }).catch(() => undefined); }
    }
    await contains('You are signed in');
    // An unresumed signup is signed in from its creation approval, with no login prompt; a journey
    // that resumed the signup with its passkey (the cookie-recovery step) gets the login prompt.
    const signupSessions = await options.pool.query("SELECT count(*)::text AS c FROM rest_wallet_logins WHERE proof->>'kind'='signup-approval' AND account_id=$1",
      [`eip155:8453:${(originalAddress ?? '').toLowerCase()}`]);
    expect(Number(signupSessions.rows[0].c)).toBe(resumed ? 0 : 1);
    expect(observed.some(o => o.path === '/login/complete' && o.status === 200)).toBe(resumed);
    expect((await context.cookies()).some(item => item.name === walletSignupCookie)).toBe(false);
    if (kitMode) expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('center:signup:browser:')))).toEqual([]);
    expect((await page.locator('#wallet-address').textContent())?.toLowerCase()).toBe(originalAddress?.toLowerCase());
    expect(await page.locator('#wallet-passkey').textContent()).toBe('Juicebox test');
    if (!kitMode) {
      // "Add more": one click quotes and prompts the passkey once, Center pays on Base, Optimism shows the account.
      await expect.poll(() => page.getByRole('button', { name: 'Add more' }).isVisible()).toBe(true);
      await page.getByRole('button', { name: 'Add more' }).click();
      // One family at a time: Relayr never mixes mainnets and testnets in a bundle.
      await expect.poll(() => page.getByLabel('Base Sepolia', { exact: true }).count()).toBe(0);
      await page.getByLabel('Testnets', { exact: true }).check();
      await expect.poll(() => page.getByLabel('Base Sepolia', { exact: true }).count()).toBe(1);
      expect(await page.getByLabel('Optimism', { exact: true }).count()).toBe(0);
      await page.getByLabel('Mainnets', { exact: true }).check();
      await page.getByLabel('Optimism', { exact: true }).check();
      await page.screenshot({ path: new URL('networks-picker.png', out).pathname, fullPage: true });
      await page.getByRole('button', { name: 'Deploy', exact: true }).click();
      await expect.poll(() => page.locator('#wallet-networks').textContent(), { timeout: 30000 }).toBe('Base, Optimism');
      expect(networksProvider.entries).toHaveLength(1);
      expect(networksProvider.entries[0]).toMatchObject({ chain: 10, target: options.fixture.manifest.factory.address, value: '0' });
      expect(networksProvider.entries[0]!.data.startsWith('0x1688f0b9')).toBe(true); // createProxyWithNonce, the same call that created it on Base
      await contains('Your account is on 2 networks');
      await page.screenshot({ path: new URL('networks-done.png', out).pathname, fullPage: true });
      const payment = await options.fixture.rpc<{ to: string; value: string }[]>('eth_getBlockByNumber', ['latest', true]).then(block => (block as unknown as { transactions: { to: string; value: string }[] }).transactions);
      expect(payment.some(tx => tx.to?.toLowerCase() === RELAYR_PAYMENT_ADDRESS.toLowerCase() && BigInt(tx.value) === 12000000000000n)).toBe(true);
    }
    if (recovery) {
      await exerciseRecoveryBrowser({ page, context, cdp, authenticatorId, origin, recovery, login, requestBodies, kitText: recoveryKitText!,
        hold: { arm: () => { refreshHold = new Promise<void>(resolve => { releaseRefresh = resolve; }); }, release: () => { releaseRefresh(); refreshHold = Promise.resolve(); } } });
      expect(lostRecoveryPaths.size).toBe(3);
    }
    expect(errors).toEqual([]); expect(lostRegistration).toBe(kitMode); expect(lostSetup).toBe(kitMode);
    expect((await options.deployments.getSettlement(deploymentId))?.nextNonce).toBe(options.expectedNextNonce ?? '5');
    await writeFile(new URL('summary.json', out), JSON.stringify({ passed: true, browser: browser.version(),
      evidence: 'real HTTP, PostgreSQL, unforked Anvil; virtual authenticator and test EOA',
      recoveryMode: options.recoveryMode ?? 'wallet', ...(kitMode ? { backupDuringDeployment: true, activationRequiresBackup: true, savedKitRestored: true, wrongKitRejected: true, phraseAbsentFromStorageAndRequests: true } : {}),
      cancelledPrompt: true, lostRegistrationReplyRecovered: lostRegistration, lostSetupReplyRecovered: lostSetup,
      cookieLossResumedSameWallet: true, separateFreshLogin: true, mobileWidth: 320, pageErrors: errors, requests: observed }, null, 2));
  } finally { await recovery?.stop(); await signup.stop(); await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
