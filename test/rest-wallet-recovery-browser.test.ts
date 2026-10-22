import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright';
import { hashTypedData, recoverTypedDataAddress, type Hex } from 'viem';
import { createWalletRecoverySecret, serializeWalletRecoveryKit } from '../src/rest/web/walletRecoveryKit.js';
import { walletRecoveryCss, walletRecoveryPage } from '../src/rest/web/walletRecoveryPage.js';
import { createWalletAuthorityContextFixture } from './fixtures/wallet-authority-context.js';
import { createRegistration } from './fixtures/wallet-enrollment-crypto.js';
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

  it('shows one review for every chain and signs each chain with the one backup it opened, without a passkey prompt', async () => {
    const context = await browser.newContext(), page = await context.newPage(), secret = createWalletRecoverySecret();
    // The modeled server's reviews; the backup key they name is this test's backup password. The SafeTx itself does not carry it.
    const authority = await createWalletAuthorityContextFixture(Date.now());
    const intent = createWalletRecoveryIntent(authority, { rpId: authority.credential.rpId, origin: authority.enrollment.intent.origin, nowMs: Date.now(), expiresAtMs: Date.now() + 120_000 });
    const key = createRegistration({ rpId: intent.rpId, origin: intent.origin, userHandle: intent.userHandle, challenge: `0x${Buffer.from(intent.registration.challenge, 'base64url').toString('hex')}` });
    const candidate = prepareWalletRecoveryCandidate(intent, key.response), owners = [intent.priorSigner, intent.recoveryOwner];
    const reviews = [prepareWalletRecoveryRotation(candidate, { owners, threshold: 1, safeNonce: '4' }),
      prepareWalletRecoveryRotation(candidate, { owners, threshold: 1, safeNonce: '0' }, 10), prepareWalletRecoveryRotation(candidate, { owners, threshold: 1, safeNonce: '2' }, 42161)];
    const shaped = (review: typeof reviews[number]) => JSON.parse(JSON.stringify({ review: { ...review, recoveryOwner: secret.recoveryOwner }, document: walletRecoveryRotationDocument(review) },
      (_key, value) => typeof value === 'bigint' ? String(value) : value));
    let view: Record<string, unknown> = { id: intent.id, passkeyName: 'Juicebox replacement', rpId: 'localhost', origin, expiresAtMs: Date.now() + 3600000,
      proofExpiresAtMs: intent.expiresAtMs, walletAddress: reviews[0]!.walletAddress, recoveryOwner: secret.recoveryOwner, initializerHash: intent.initializerHash,
      priorSigner: intent.priorSigner, replacementSigner: candidate.signerAddress, candidateDigest: reviews[0]!.candidateDigest,
      rotationContext: { publicKey: candidate.credential.publicKey, signerFactory: intent.manifest.ownerProfile!.signerFactory.address, verifiers: intent.manifest.ownerProfile!.p256Verifier.address },
      phase: 'awaiting_rotation_approval', registration: null, possession: null, transactionHashes: [],
      chains: [{ chainId: 10, name: 'Optimism', state: 'review' }, { chainId: 42161, name: 'Arbitrum', state: 'review' }] };
    const approvals: { backupSignature: Hex; chainSignatures: { chainId: number; signature: Hex }[] }[] = [];
    await page.route(origin + '/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path === '/wallet/recover') return route.fulfill({ contentType: 'text/html', body: walletRecoveryPage() });
      if (path.endsWith('wallet-recovery-kit.js')) return route.fulfill({ contentType: 'text/javascript', body: kitScript });
      if (path.endsWith('.js')) return route.fulfill({ contentType: 'text/javascript', body: script });
      if (path.endsWith('.css')) return route.fulfill({ contentType: 'text/css', body: walletRecoveryCss() });
      if (path.endsWith('/state')) return route.fulfill({ json: { view, csrfToken: Buffer.alloc(32, 3).toString('base64url') } });
      if (path.endsWith('/rotation/review')) return route.fulfill({ json: { ...shaped(reviews[0]!), chains: reviews.slice(1).map(shaped) } });
      if (path.endsWith('/rotation/approve')) {
        approvals.push(JSON.parse(request.postData()!));
        view = { ...view, phase: 'rotating', chains: [{ chainId: 10, name: 'Optimism', state: 'approved' }, { chainId: 42161, name: 'Arbitrum', state: 'approved' }] };
        return route.fulfill({ json: { view } });
      }
      throw new Error('Unexpected browser request: ' + path);
    });
    const contains = async (text: string) => expect.poll(() => page.locator('#wallet-status').textContent()).toContain(text);
    try {
      await page.addInitScript(() => { (window as unknown as { prompts: number }).prompts = 0;
        navigator.credentials.get = async () => { (window as unknown as { prompts: number }).prompts++; throw new DOMException('No prompt expected', 'NotAllowedError'); }; });
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
      expect(await page.locator('#recovery-chains').textContent()).toBe('Optimism: Waiting for Base, Arbitrum: Waiting for Base');
      expect(JSON.stringify(approvals)).not.toContain(secret.mnemonic);
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
