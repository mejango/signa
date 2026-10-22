import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';
import { encodeAbiParameters, hashTypedData, recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { signaChains } from '../src/rest/wallet/chains.js';
import { WALLET_PASSKEY_PROFILE } from '../src/rest/web/walletRecoveryReview.js';
import { createWalletRecoverySecret, serializeWalletRecoveryKit } from '../src/rest/web/walletRecoveryKit.js';
import { walletRecoveryCss, walletRecoveryPage } from '../src/rest/web/walletRecoveryPage.js';
import { createWalletAuthorityContextFixture } from './fixtures/wallet-authority-context.js';
import { createRegistration, enrollmentManifest } from './fixtures/wallet-enrollment-crypto.js';
import { createWalletRecoveryIntent, prepareWalletRecoveryCandidate } from '../src/rest/wallet/recovery.js';
import { prepareWalletRecoveryRotation, walletRecoveryRotationDocument } from '../src/rest/wallet/recoveryRotation.js';

const origin = 'http://localhost:34171', walletAddress = `0x${'33'.repeat(20)}` as const;
const initializerHash = `0x${'44'.repeat(32)}` as const, id = '10000000-0000-4000-8000-000000000001';
let browser: Browser, script: string, kitScript: string;
beforeAll(async () => {
  script = (await build({ entryPoints: ['src/rest/web/walletRecoveryJourney.ts'], bundle: true, platform: 'browser', format: 'esm', write: false })).outputFiles[0]!.text;
  // The page imports the backup kit, its own bundle, from the URL its HTML names.
  kitScript = (await build({ entryPoints: ['src/rest/web/walletRecoveryKit.ts'], bundle: true, platform: 'browser', format: 'esm', write: false })).outputFiles[0]!.text;
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => { await browser?.close(); });

describe('recovery browser continuation and secret handling with modeled HTTP', () => {
  it('explicitly restarts an expired unproved attempt, retries a lost reset reply and never auto-creates a replacement', async () => {
    const context = await browser.newContext(), page = await context.newPage();
    const secret = createWalletRecoverySecret(); let restarts = 0, begins = 0;
    let view: Record<string, unknown> | null = { id, passkeyName: 'Old attempt', rpId: 'localhost', origin,
      expiresAtMs: Date.now() + 3600000, proofExpiresAtMs: Date.now() - 1, walletAddress, recoveryOwner: secret.recoveryOwner,
      initializerHash, priorSigner: `0x${'55'.repeat(20)}`, replacementSigner: null, transactionHashes: [], phase: 'expired' };
    await page.route(origin + '/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/wallet/recover') return route.fulfill({ contentType: 'text/html', body: walletRecoveryPage() });
      if (path.endsWith('wallet-recovery-kit.js')) return route.fulfill({ contentType: 'text/javascript', body: kitScript });
      if (path.endsWith('.js')) return route.fulfill({ contentType: 'text/javascript', body: script });
      if (path.endsWith('.css')) return route.fulfill({ contentType: 'text/css', body: walletRecoveryCss() });
      if (path.endsWith('/state')) return route.fulfill({ json: { view, csrfToken: Buffer.alloc(32, 3).toString('base64url') } });
      if (path.endsWith('/restart')) {
        restarts++; view = null;
        return restarts === 1 ? route.fulfill({ status: 503 }) : route.fulfill({ json: { restarted: true, view: null } });
      }
      if (path.endsWith('/begin')) begins++;
      return route.fulfill({ status: 500 });
    });
    try {
      await page.goto(origin + '/wallet/recover');
      await page.getByRole('button', { name: 'Start again', exact: true }).click();
      await expect.poll(() => page.locator('#wallet-status').textContent()).toContain('could not be confirmed');
      expect(await page.getByRole('button', { name: 'Start again', exact: true }).isHidden()).toBe(true);
      await page.getByRole('button', { name: 'Check again', exact: true }).click();
      await expect.poll(() => page.locator('#wallet-status').textContent()).toContain('Expired recovery closed');
      expect(await page.evaluate(() => sessionStorage.getItem('center:recovery:reference'))).toBeNull();
      expect(await page.getByRole('button', { name: 'Continue', exact: true }).isVisible()).toBe(true);
      expect(restarts).toBe(2); expect(begins).toBe(0);
      view = { id, passkeyName: 'Accepted attempt', rpId: 'localhost', origin, expiresAtMs: Date.now() + 3600000,
        proofExpiresAtMs: Date.now() - 1, walletAddress, recoveryOwner: secret.recoveryOwner, initializerHash,
        priorSigner: `0x${'55'.repeat(20)}`, replacementSigner: null, transactionHashes: [], phase: 'awaiting_rotation_approval' };
      await page.reload(); await expect.poll(() => page.locator('#wallet-status').textContent()).toContain('Review and approve');
      expect(await page.getByRole('button', { name: 'Start again', exact: true }).isHidden()).toBe(true);
    } finally { await context.close(); }
  });
  it('keeps kit words private, checks an unknown begin, cancels the prompt and retries identical registration bytes', async () => {
    const context = await browser.newContext({ viewport: { width: 320, height: 844 } }), page = await context.newPage();
    const secret = createWalletRecoverySecret(), encoded = serializeWalletRecoveryKit(secret, {
      network: 'base', chainId: 8453, walletAddress, initializerHash, recoveryOwner: secret.recoveryOwner });
    let view: Record<string, unknown> | null = null, begins = 0, lostRegistration = false;
    const bodies: string[] = [], registrations: string[] = [], errors: string[] = [];
    page.on('pageerror', error => errors.push(error.name));
    await page.route(origin + '/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
      if (path === '/wallet/recover') return route.fulfill({ contentType: 'text/html', body: walletRecoveryPage() });
      if (path.endsWith('wallet-recovery-kit.js')) return route.fulfill({ contentType: 'text/javascript', body: kitScript });
      if (path.endsWith('wallet-recovery.js')) return route.fulfill({ contentType: 'text/javascript', body: script });
      if (path.endsWith('wallet-recovery.css')) return route.fulfill({ contentType: 'text/css', body: walletRecoveryCss() });
      if (request.postData()) bodies.push(request.postData()!);
      if (path.endsWith('/state')) return json({ view, csrfToken: Buffer.alloc(32, 3).toString('base64url') });
      if (path.endsWith('/begin')) {
        begins++; expect(JSON.parse(request.postData()!)).toEqual({ walletAddress, passkeyName: 'Juicebox replacement' });
        view = { id, passkeyName: 'Juicebox replacement', rpId: 'localhost', origin, expiresAtMs: Date.now() + 3600000,
          proofExpiresAtMs: Date.now() + 300000, walletAddress, recoveryOwner: secret.recoveryOwner, initializerHash,
          priorSigner: `0x${'55'.repeat(20)}`, replacementSigner: null, candidateDigest: null, rotationContext: null,
          phase: 'awaiting_registration', registration: { challenge: Buffer.alloc(32, 6).toString('base64url'), userHandle: Buffer.alloc(32, 7).toString('base64url') },
          possession: null, transactionHashes: [] };
        return json({ error: 'reply unavailable after commit' }, 503);
      }
      if (path.endsWith('/register')) {
        registrations.push(request.postData()!);
        view = { ...view!, phase: 'awaiting_possession', registration: null };
        if (!lostRegistration) { lostRegistration = true; return json({ error: 'reply unavailable after commit' }, 503); }
        return json({ view });
      }
      throw new Error('Unexpected browser request: ' + path);
    });
    const cdp = await context.newCDPSession(page); await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
      protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: false } });
    const contains = async (text: string) => expect.poll(() => page.locator('#wallet-status').textContent()).toContain(text);
    try {
      await page.goto(origin + '/wallet/recover');
      // The file carries the account address, so that field only appears for the other ways in.
      await expect.poll(() => page.locator('#recovery-wallet-box').isHidden()).toBe(true);
      await page.getByLabel('My backup password').check();
      await expect.poll(() => page.locator('#recovery-wallet-box').isVisible()).toBe(true);
      await page.getByRole('button', { name: 'Continue', exact: true }).click(); await contains('Enter your backup password');
      await page.getByLabel('Backup password', { exact: true }).fill(secret.mnemonic);
      await page.getByRole('button', { name: 'Continue', exact: true }).click(); await contains('Enter the account address');
      expect(await page.getByLabel('Backup password', { exact: true }).inputValue()).toBe('');
      await page.getByLabel('My backup file').check();
      await page.getByLabel('Open your backup file').setInputFiles({ name: 'kit.json', mimeType: 'application/json', buffer: Buffer.from(encoded) });
      await page.getByLabel('New passkey name').fill('Juicebox replacement');
      expect(await page.getByLabel('Account address', { exact: true }).inputValue()).toBe(walletAddress);
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await contains('Check the original recovery');
      await page.getByRole('button', { name: 'Check again', exact: true }).click();
      await contains('Create your replacement passkey'); expect(begins).toBe(1);
      // Browser diagnostics can include long URLs and cannot distinguish a dismissed prompt
      // from an unavailable passkey. Keep retries explicit and the current recovery intact.
      for (const [name, text, state] of [
        ['NotAllowedError', 'The device prompt didn’t finish. Try again.', 'ready'],
        ['SecurityError', 'This browser blocked the device request.', 'error'],
        ['NotSupportedError', 'This browser or device cannot complete the request.', 'error'],
      ] as const) {
        await page.evaluate(name => {
          const original = navigator.credentials.create;
          navigator.credentials.create = async () => {
            navigator.credentials.create = original;
            throw new DOMException('Browser diagnostic: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client', name);
          };
        }, name);
        await page.locator('#recovery-next').click(); await contains(text);
        expect(await page.locator('#wallet-status').getAttribute('data-state')).toBe(state);
        expect(await page.locator('#wallet-status').textContent()).not.toMatch(/Browser diagnostic|https:|NotAllowedError|SecurityError|NotSupportedError/);
        expect(await page.locator('#recovery-next').isEnabled()).toBe(true);
        expect(begins).toBe(1); expect(registrations).toHaveLength(0);
      }
      // The OS prompt owns cancellation (NotAllowedError above); the page offers no second cancel.
      expect(await page.getByRole('button', { name: 'Cancel prompt' }).count()).toBe(0);
      expect(registrations).toHaveLength(0);
      await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: true });
      await page.locator('#recovery-next').click();
      await contains('Check the original recovery');
      await page.getByRole('button', { name: 'Check again', exact: true }).click(); await contains('Prove access');
      expect(registrations).toHaveLength(2); expect(registrations[0]).toBe(registrations[1]);
      await page.reload(); await contains('Prove access');
      expect(await page.getByLabel('Backup password', { exact: true }).inputValue()).toBe('');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
      expect(stored.includes(secret.mnemonic)).toBe(false); expect(stored).toContain(id);
      expect(bodies.some(body => body.includes(secret.mnemonic))).toBe(false);
      expect(await page.content()).not.toContain(secret.mnemonic); expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 30000);

  it('clears the backup password from the page even when the backup kit cannot load', async () => {
    const context = await browser.newContext(), page = await context.newPage();
    await page.route(origin + '/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/wallet/recover') return route.fulfill({ contentType: 'text/html', body: walletRecoveryPage() });
      if (path.includes('wallet-recovery-kit')) return route.abort();
      if (path.endsWith('.js')) return route.fulfill({ contentType: 'text/javascript', body: script });
      if (path.endsWith('.css')) return route.fulfill({ contentType: 'text/css', body: walletRecoveryCss() });
      if (path.endsWith('/state')) return route.fulfill({ json: { view: null, csrfToken: Buffer.alloc(32, 3).toString('base64url') } });
      return route.fulfill({ status: 500 });
    });
    try {
      await page.goto(origin + '/wallet/recover');
      await page.getByLabel('My backup password').check();
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await expect.poll(() => page.locator('#wallet-status').textContent()).toContain('Enter your backup password');
      await page.getByLabel('Backup password', { exact: true }).fill('secret words stay private');
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await expect.poll(() => page.locator('#wallet-status').textContent()).not.toContain('Enter your backup password');
      expect(await page.getByLabel('Backup password', { exact: true }).inputValue()).toBe('');
    } finally { await context.close(); }
  });

  /** A modeled recovery for an account on Base, Optimism and Arbitrum. The page derives the replacement signer from the
   * passkey key it kept when it created the passkey, and reads each chain's Safe through that chain's public RPC. */
  async function rotationModel() {
    // The account uses the passkey signer contracts the page has built in.
    const profile = enrollmentManifest.ownerProfile!, secret = createWalletRecoverySecret(), authority = await createWalletAuthorityContextFixture(Date.now(), { ...enrollmentManifest,
      ownerProfile: { ...profile, signerFactory: { ...profile.signerFactory, address: WALLET_PASSKEY_PROFILE.signerFactory },
        signerSingleton: { ...profile.signerSingleton, address: WALLET_PASSKEY_PROFILE.signerSingleton }, p256Verifier: { ...profile.p256Verifier, address: WALLET_PASSKEY_PROFILE.p256Verifier } } });
    const intent = createWalletRecoveryIntent(authority, { rpId: authority.credential.rpId, origin: authority.enrollment.intent.origin, nowMs: Date.now(), expiresAtMs: Date.now() + 120_000 });
    const passkey = () => prepareWalletRecoveryCandidate(intent, createRegistration({ rpId: intent.rpId, origin: intent.origin, userHandle: intent.userHandle,
      challenge: `0x${Buffer.from(intent.registration.challenge, 'base64url').toString('hex')}` }).response);
    const candidate = passkey(), owners = [intent.priorSigner, intent.recoveryOwner];
    const safes: Record<number, { owners: Address[]; nonce: bigint; down?: boolean }> = { 8453: { owners, nonce: 4n }, 10: { owners, nonce: 0n }, 42161: { owners, nonce: 2n } };
    const review = (chainId: number, from = candidate, nonce = safes[chainId]!.nonce) =>
      prepareWalletRecoveryRotation(from, { owners: safes[chainId]!.owners, threshold: 1, safeNonce: String(nonce) }, chainId);
    const shaped = (item: ReturnType<typeof review>) => JSON.parse(JSON.stringify({ review: { ...item, recoveryOwner: secret.recoveryOwner }, document: walletRecoveryRotationDocument(item) },
      (_key, value) => typeof value === 'bigint' ? String(value) : value));
    const home = review(8453);
    const view = (phase: string, chains: { chainId: number; name: string; state: string }[], from = candidate): Record<string, unknown> => ({ id: intent.id, passkeyName: 'Juicebox replacement',
      rpId: 'localhost', origin, expiresAtMs: Date.now() + 3600000, proofExpiresAtMs: intent.expiresAtMs, walletAddress: home.walletAddress, recoveryOwner: secret.recoveryOwner,
      initializerHash: intent.initializerHash, priorSigner: intent.priorSigner, replacementSigner: from.signerAddress, candidateDigest: (from === candidate ? home : review(8453, from)).candidateDigest,
      rotationContext: { publicKey: from.credential.publicKey, signerFactory: WALLET_PASSKEY_PROFILE.signerFactory, verifiers: WALLET_PASSKEY_PROFILE.p256Verifier },
      phase, registration: null, possession: null, transactionHashes: [], chains });
    const reads: { chainId: number; method: string; block?: unknown }[] = [];
    /** Each chain's public RPC as the page reaches it; a chain marked down does not answer. */
    async function open(keep = true) {
      const context = await browser.newContext(), page = await context.newPage();
      if (keep) await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [`center:recovery:passkey:${intent.id}`, JSON.stringify(candidate.credential.publicKey)] as const);
      await page.addInitScript(() => { (window as unknown as { prompts: number }).prompts = 0;
        navigator.credentials.get = async () => { (window as unknown as { prompts: number }).prompts++; throw new DOMException('No prompt expected', 'NotAllowedError'); }; });
      await page.route(url => signaChains.some(chain => url.href.replace(/\/$/, '') === chain.publicRpc), async route => {
        const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' };
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        const chainId = signaChains.find(chain => route.request().url().replace(/\/$/, '') === chain.publicRpc)!.chainId, safe = safes[chainId];
        if (!safe || safe.down) return route.abort();
        const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`;
        const replies = (JSON.parse(route.request().postData()!) as { id: number; method: string; params: any[] }[]).map(({ id, method, params }) => {
          reads.push({ chainId, method, block: method === 'eth_getCode' || method === 'eth_call' ? params[1] : undefined });
          const result = method === 'eth_chainId' ? `0x${chainId.toString(16)}` : method === 'eth_blockNumber' ? '0x10' : method === 'eth_getCode' ? '0x6001'
            : params[0].data === '0xa0e67e2b' ? encodeAbiParameters([{ type: 'address[]' }], [safe.owners]) : params[0].data === '0xe75235b8' ? word(1n) : word(safe.nonce);
          return { jsonrpc: '2.0', id, result };
        });
        return route.fulfill({ headers: cors, json: replies });
      });
      return { context, page };
    }
    return { secret, intent, candidate, passkey, safes, review, shaped, view, reads, open };
  }
  type RotationModel = Awaited<ReturnType<typeof rotationModel>>;
  /** The page's own files and the modeled recovery API. */
  function serve(page: Page, api: (path: string, body: string | null) => unknown) {
    return page.route(origin + '/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path === '/wallet/recover') return route.fulfill({ contentType: 'text/html', body: walletRecoveryPage() });
      if (path.endsWith('wallet-recovery-kit.js')) return route.fulfill({ contentType: 'text/javascript', body: kitScript });
      if (path.endsWith('.js')) return route.fulfill({ contentType: 'text/javascript', body: script });
      if (path.endsWith('.css')) return route.fulfill({ contentType: 'text/css', body: walletRecoveryCss() });
      const reply = api(path, request.postData());
      if (reply === undefined) throw new Error('Unexpected browser request: ' + path);
      return route.fulfill({ json: reply });
    });
  }
  const csrfToken = Buffer.alloc(32, 3).toString('base64url');

  it('shows one review for every chain and signs each chain with the one backup it opened, without a passkey prompt', async () => {
    const model = await rotationModel(), { secret, review, shaped } = model, reviews = [8453, 10, 42161].map(chainId => review(chainId));
    let view = model.view('awaiting_rotation_approval', [{ chainId: 10, name: 'Optimism', state: 'review' }, { chainId: 42161, name: 'Arbitrum', state: 'review' }]);
    const approvals: { backupSignature: Hex; chainSignatures: { chainId: number; signature: Hex }[] }[] = [];
    const { context, page } = await model.open();
    await serve(page, (path, body) => {
      if (path.endsWith('/state')) return { view, csrfToken };
      if (path.endsWith('/rotation/review')) return { ...shaped(reviews[0]!), chains: reviews.slice(1).map(shaped) };
      if (path.endsWith('/rotation/approve')) {
        approvals.push(JSON.parse(body!));
        view = { ...view, phase: 'rotating', chains: [{ chainId: 10, name: 'Optimism', state: 'approved' }, { chainId: 42161, name: 'Arbitrum', state: 'approved' }] };
        return { view };
      }
    });
    const contains = async (text: string) => expect.poll(() => page.locator('#wallet-status').textContent()).toContain(text);
    try {
      await page.goto(origin + '/wallet/recover'); await contains('Review and approve');
      expect(await page.locator('#recovery-chains').textContent()).toBe('Optimism: Waiting for your approval, Arbitrum: Waiting for your approval');
      await page.getByLabel('My backup password').check();
      await page.getByLabel('Backup password', { exact: true }).fill(secret.mnemonic);
      await page.getByRole('button', { name: 'Review passkey replacement' }).click();
      await contains('Review the account and the exact calls');
      expect(await page.locator('#recovery-scope').textContent()).toBe('Base, Optimism and Arbitrum');
      expect(await page.locator('#recovery-review').isVisible()).toBe(true);
      await page.getByRole('button', { name: 'Approve passkey replacement' }).click();
      await contains('Replacing your passkey');
      // One approval, one backup unlock, no passkey prompt: one signature per chain, each for that chain's own swap and nonce.
      expect(approvals).toHaveLength(1); expect(await page.evaluate(() => (window as unknown as { prompts: number }).prompts)).toBe(0);
      expect(await page.getByLabel('Backup password', { exact: true }).inputValue()).toBe('');
      const [approval] = approvals;
      expect(approval!.chainSignatures.map(item => item.chainId)).toEqual([10, 42161]);
      for (const [index, signature] of [approval!.backupSignature, ...approval!.chainSignatures.map(item => item.signature)].entries()) {
        const document = walletRecoveryRotationDocument(reviews[index]!);
        expect(document.domain.chainId).toBe([8453, 10, 42161][index]);
        expect((await recoverTypedDataAddress({ ...document, signature })).toLowerCase()).toBe(secret.recoveryOwner.toLowerCase());
        expect(hashTypedData(document)).not.toBe(hashTypedData(walletRecoveryRotationDocument(reviews[(index + 1) % 3]!)));
      }
      // Each chain was read by the page itself, every read pinned to the one block it first asked for.
      expect(new Set(model.reads.map(read => read.chainId))).toEqual(new Set([8453, 10, 42161]));
      expect(model.reads.filter(read => read.method === 'eth_call' || read.method === 'eth_getCode').every(read => read.block === '0x10')).toBe(true);
      expect(await page.locator('#recovery-chains').textContent()).toBe('Optimism: Waiting for Base, Arbitrum: Waiting for Base');
      expect(JSON.stringify(approvals)).not.toContain(secret.mnemonic);
    } finally { await context.close(); }
  }, 30000);

  it('signs nothing when the server substitutes the replacement signer, a nonce or the old passkey, or a chain cannot be read', async () => {
    type Arranged = { from?: RotationModel['candidate']; keep?: boolean; reviews?: ReturnType<RotationModel['review']>[] };
    const cases: [string, (model: RotationModel) => Arranged, string][] = [
      // The server names its own signer, with reviews and context that are consistent with it.
      ['signer', model => { const from = model.passkey(); return { from, reviews: [8453, 10, 42161].map(chainId => model.review(chainId, from)) }; }, 'The recovery review changed'],
      // Arbitrum's Safe is at nonce 2; the server's swap is for nonce 3, to be held and run later.
      ['nonce', model => ({ reviews: [model.review(8453), model.review(10), model.review(42161, model.candidate, 3n)] }), 'The recovery review changed'],
      // Optimism no longer has the old passkey as an owner.
      ['prior', model => { const reviews = [8453, 10, 42161].map(chainId => model.review(chainId));
        model.safes[10] = { owners: [`0x${'ab'.repeat(20)}`, model.intent.recoveryOwner], nonce: 0n }; return { reviews }; }, 'The recovery review changed'],
      ['unread', model => { model.safes[42161]!.down = true; return {}; }, 'Arbitrum could not be read, so nothing was signed'],
      ['other browser', () => ({ keep: false }), 'Continue this recovery in the browser where you created its replacement passkey'],
    ];
    for (const [name, arrange, text] of cases) {
      const model = await rotationModel(), setup = arrange(model), from = setup.from ?? model.candidate;
      const reviews = setup.reviews ?? [8453, 10, 42161].map(chainId => model.review(chainId));
      const view = model.view('awaiting_rotation_approval', [{ chainId: 10, name: 'Optimism', state: 'review' }, { chainId: 42161, name: 'Arbitrum', state: 'review' }], from);
      const approvals: unknown[] = [], { context, page } = await model.open(setup.keep ?? true);
      await serve(page, (path, body) => {
        if (path.endsWith('/state')) return { view, csrfToken };
        if (path.endsWith('/rotation/review')) return { ...model.shaped(reviews[0]!), chains: reviews.slice(1).map(model.shaped) };
        if (path.endsWith('/rotation/approve')) { approvals.push(JSON.parse(body!)); return { view }; }
      });
      const status = () => page.locator('#wallet-status').textContent();
      try {
        await page.goto(origin + '/wallet/recover'); await expect.poll(status, { message: name }).toContain('Review and approve');
        await page.getByLabel('My backup password').check();
        await page.getByLabel('Backup password', { exact: true }).fill(model.secret.mnemonic);
        await page.getByRole('button', { name: 'Review passkey replacement' }).click();
        const approve = page.getByRole('button', { name: 'Approve passkey replacement' });
        await expect.poll(async () => await approve.isVisible() || (await status())!.includes(text), { message: name }).toBe(true);
        if (await approve.isVisible()) await approve.click();
        await expect.poll(status, { message: name }).toContain(text);
        expect(approvals, name).toEqual([]);
      } finally { await context.close(); }
    }
  }, 60000);

  it('after activation, reviews only the chains still on the old passkey with the backup, across a reload', async () => {
    const model = await rotationModel(), { secret, review, shaped } = model;
    const optimism = review(10);
    // Base and Optimism already show the new passkey; Arbitrum still has the old one, at nonce 5.
    model.safes[8453] = { owners: [model.candidate.signerAddress, model.intent.recoveryOwner], nonce: 5n };
    model.safes[42161]!.nonce = 5n;
    const arbitrum = review(42161);
    let view = model.view('ready_to_sign_in', [{ chainId: 10, name: 'Optimism', state: 'updated' }, { chainId: 42161, name: 'Arbitrum', state: 'failed' }]);
    const approvals: Record<string, unknown>[] = []; let reviews = 0;
    const { context, page } = await model.open();
    await serve(page, (path, body) => {
      if (path.endsWith('/state')) return { view, csrfToken };
      if (path.endsWith('/rotation/review')) {
        view = { ...view, chains: [{ chainId: 10, name: 'Optimism', state: 'updated' }, { chainId: 42161, name: 'Arbitrum', state: 'review' }] };
        // The first answer slips in a chain that is already updated; the page refuses to sign it.
        return { review: null, document: null, chains: reviews++ ? [shaped(arbitrum)] : [shaped(optimism), shaped(arbitrum)] };
      }
      if (path.endsWith('/rotation/approve')) {
        approvals.push(JSON.parse(body!));
        view = { ...view, chains: [{ chainId: 10, name: 'Optimism', state: 'updated' }, { chainId: 42161, name: 'Arbitrum', state: 'approved' }] };
        return { view };
      }
    });
    const contains = async (text: string) => expect.poll(() => page.locator('#wallet-status').textContent()).toContain(text);
    try {
      await page.goto(origin + '/wallet/recover'); await contains('Arbitrum still accepts the old passkey');
      await page.getByLabel('My backup password').check();
      await page.getByLabel('Backup password', { exact: true }).fill(secret.mnemonic);
      await page.getByRole('button', { name: 'Review network updates' }).click();
      await contains('The recovery review changed');
      // The review is kept on the server, so a reload picks it up where it was.
      await page.reload(); await contains('Arbitrum still accepts the old passkey');
      expect(await page.locator('#recovery-chains').textContent()).toBe('Optimism: Updated, Arbitrum: Waiting for your approval');
      await page.getByLabel('My backup password').check();
      await page.getByLabel('Backup password', { exact: true }).fill(secret.mnemonic);
      await page.getByRole('button', { name: 'Review network updates' }).click();
      await contains('Review the account and the exact calls');
      expect(await page.locator('#recovery-scope').textContent()).toBe('Arbitrum');
      await page.getByRole('button', { name: 'Approve network updates' }).click();
      await expect.poll(() => approvals.length).toBe(1);
      const [approval] = approvals as { chainSignatures: { chainId: number; signature: Hex }[] }[];
      expect(Object.keys(approval!)).toEqual(['chainSignatures']);
      expect(approval!.chainSignatures.map(item => item.chainId)).toEqual([42161]);
      expect((await recoverTypedDataAddress({ ...walletRecoveryRotationDocument(arbitrum), signature: approval!.chainSignatures[0]!.signature })).toLowerCase()).toBe(secret.recoveryOwner.toLowerCase());
      await expect.poll(() => page.locator('#recovery-chains').textContent()).toBe('Optimism: Updated, Arbitrum: Waiting to update');
      expect(await page.evaluate(() => (window as unknown as { prompts: number }).prompts)).toBe(0);
    } finally { await context.close(); }
  }, 30000);

  it('refuses recovery secrets or arbitrary return URLs in the page URL before any API call', async () => {
    const context = await browser.newContext(), page = await context.newPage(); let apiCalls = 0;
    await page.route(origin + '/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/wallet/recover') return route.fulfill({ contentType: 'text/html', body: walletRecoveryPage() });
      if (path.endsWith('wallet-recovery-kit.js')) return route.fulfill({ contentType: 'text/javascript', body: kitScript });
      if (path.endsWith('.js')) return route.fulfill({ contentType: 'text/javascript', body: script });
      if (path.endsWith('.css')) return route.fulfill({ contentType: 'text/css', body: walletRecoveryCss() });
      apiCalls++; return route.fulfill({ status: 500 });
    });
    try {
      await page.goto(origin + '/wallet/recover?return=https://other.test');
      await expect.poll(() => page.locator('#wallet-status').textContent()).toContain('original app'); expect(apiCalls).toBe(0);
    } finally { await context.close(); }
  });
});
