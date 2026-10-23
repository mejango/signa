import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
// @ts-expect-error The build script is plain ESM without declarations.
import { webBuildOptions } from '../scripts/rest/build-web.mjs';
import { chromium, type Browser, type Page, type CDPSession } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createWalletPaymentClientFixture } from './fixtures/wallet-payment-client.js';
import { buildUserPayMetadata, PAY_QUOTE_FAILED_MESSAGE } from '@bananapus/nana-sdk-core/v6';
import { passkeyPayMetadataSteps } from '../src/rest/userOperations/userPayMetadata.js';
import type { Hex } from 'viem';
import { getUserOperationHash } from '../src/rest/userOperations/codec.js';
import { safe7579PasskeyOwnerSigningPayload } from '../src/rest/smartAccounts/passkeySignatures.js';
import type { WalletPaymentCentralPublic } from '../src/rest/wallet/paymentPublic.js';
import { parseWalletRegistration, type WalletRegistrationCandidate } from '../src/rest/wallet/registration.js';
import { verifyWalletAssertion } from '../src/rest/wallet/webauthn.js';

const encode = (value: Uint8Array) => Buffer.from(value).toString('base64url');
const decode = (value: string) => Buffer.from(value, 'base64url');
const reviewId = '77777777-7777-4777-8777-777777777777';
const csrf = encode(Buffer.alloc(32, 11)), state = encode(Buffer.alloc(32, 12)), handle = encode(Buffer.alloc(32, 13));
const registrationChallenge = encode(Buffer.alloc(32, 14));

// Actual production page and Chromium WebAuthn, with a virtual authenticator and a
// synthetic HTTP review store. Domain/PG/EVM suites cover authority and execution.
describe('central payment review browser, virtual authenticator', () => {
  let server: Server, browser: Browser, page: Page, cdp: CDPSession, authenticatorId: string, origin: string;
  let html: string, css: string, script: string, candidate: WalletRegistrationCandidate;
  let review: WalletPaymentCentralPublic, dropApproval: boolean, unavailableReads: boolean;
  let redirectOverride: string | undefined;
  const requests: { path: string; body: any; headers: Record<string, string | string[] | undefined> }[] = [];
  const errors: string[] = [];
  const callback = () => `${origin}/app/callback?${new URLSearchParams({ review: reviewId, state, iss: origin })}`;
  const status = async (value: string) => expect.poll(() => page.locator('#payment-status').getAttribute('data-state')).toBe(value);
  // A fresh approval returns to the app on its own; coming back shows the approved review.
  const approved = async () => { await status('approved'); await expect.poll(() => page.url()).toBe(callback()); await page.goBack(); await status('approved'); };

  beforeAll(async () => {
    const built = await build({ entryPoints: [new URL('../src/rest/web/walletPayment.ts', import.meta.url).pathname],
      bundle: true, platform: 'browser', format: 'esm', target: 'es2022', write: false, define: webBuildOptions.define });
    script = built.outputFiles[0]!.text;
    const paymentPage = await import('../src/rest/web/walletPaymentPage.js');
    const walletPage = await import('../src/rest/web/walletPage.js');
    html = paymentPage.walletPaymentPage(); css = walletPage.walletCss() + paymentPage.walletPaymentCss();
    server = createServer(async (request, response) => {
      const path = new URL(request.url!, origin).pathname;
      const json = (value: unknown, code = 200) => { response.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); };
      if (path === '/wallet/payment' || path === '/fixture') {
        response.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
        response.end(path === '/fixture' ? '<html><title>Virtual fixture enrollment</title></html>' : html); return;
      }
      if (path.startsWith('/wallet/assets/')) {
        response.writeHead(200, { 'content-type': path.endsWith('.js') ? 'text/javascript' : 'text/css' });
        response.end(path.endsWith('.js') ? script : css); return;
      }
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      requests.push({ path, body, headers: request.headers });
      if (path === '/wallet/config') return json({ version: 'center-wallet-v1', issuer: origin, audience: origin, rpId: 'localhost' });
      if (path === `/wallet/payment-reviews/${reviewId}`) return unavailableReads ? json({ error: 'private provider detail' }, 503) : json(review);
      if (path === `/wallet/payment-reviews/${reviewId}/approve`) {
        try {
          const assertion = body.assertion;
          verifyWalletAssertion({ ...assertion, authenticatorData: decode(assertion.authenticatorData), clientDataJSON: decode(assertion.clientDataJSON), signature: decode(assertion.signature) },
            { purpose: 'payment', challenge: review.signing.digest, rpId: 'localhost', origin,
              credential: { id: candidate.credentialId, publicKey: candidate.publicKey, userHandle: handle, backupEligible: candidate.backupEligible }, requireUserHandle: false });
        } catch { return json({}, 403); }
        review = { ...review, status: 'approved', approvedAtMs: Date.now() };
        if (dropApproval) { dropApproval = false; response.writeHead(200, { 'content-type': 'application/json', 'content-length': '4096' }); response.write('{"review":', () => response.destroy()); return; }
        return json({ review, replayed: false, redirectUri: redirectOverride ?? callback() });
      }
      if (path === `/wallet/payment-reviews/${reviewId}/cancel`) { review = { ...review, status: 'cancelled', cancelledAtMs: Date.now() }; return json(review); }
      if (path === '/app/callback' || path === '/wallet') { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<p>App callback or sign in</p>'); return; }
      return json({}, 404);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port');
    origin = `http://localhost:${address.port}`; browser = await chromium.launch({ headless: true });
  }, 30000);

  beforeEach(async () => {
    requests.length = 0; errors.length = 0; dropApproval = false; unavailableReads = false; redirectOverride = undefined;
    const f = createWalletPaymentClientFixture(Date.now());
    if (!('signedData' in f.prepared.signing)) throw new Error('Fixture must use a passkey owner');
    review = { version: 'center-wallet-payment-review-v1', id: reviewId, state, issuer: origin, accountId: f.accountId,
      app: { origin, callbackUri: `${origin}/app/callback`, grantId: f.grant.id, grantIncarnation: f.grant.incarnation },
      planId: f.plan.id, planCommitment: f.plan.commitment, operationId: f.prepared.id, operationCommitment: f.prepared.commitment,
      operationHash: f.prepared.operationHash, stepIndexes: [0, 1], operation: f.prepared.operation, chainId: 8453, entryPoint: f.entryPoint,
      safe7579: f.safe7579, payment: f.payment,
      gas: { payer: 'account', chainId: 8453, maximumWei: '115000000', reason: 'account-cap', balanceWei: '1000000000000000000', funded: true },
      signing: { digest: f.prepared.signing.digest, signedData: f.prepared.signing.signedData, validAfter: f.prepared.signing.validAfter, validUntil: f.prepared.signing.validUntil },
      createdAtMs: f.prepared.createdAt, expiresAtMs: f.prepared.expiresAt, status: 'pending', approvedAtMs: null, cancelledAtMs: null,
      operationState: 'prepared', notice: null, passkey: { rpId: 'localhost', credentialId: 'pending', credentialIds: ['pending'], challenge: encode(decode('AA')), userVerification: 'required' },
      metadataSteps: [] };
    // The HTTP fixture supplies trusted derived review fields; executable-byte checks live in domain tests.
    const context = await browser.newContext({ viewport: { width: 360, height: 780 } });
    page = await context.newPage(); page.setDefaultTimeout(5000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'log') errors.push(message.text()); });
    await page.addInitScript(() => {
      const original = navigator.credentials.get.bind(navigator.credentials); (window as any).passkeyRequests = [];
      navigator.credentials.get = options => { (window as any).passkeyRequests.push({ rpId: options?.publicKey?.rpId,
        userVerification: options?.publicKey?.userVerification, allowCredentials: options?.publicKey?.allowCredentials?.length }); return original(options); };
    });
    cdp = await context.newCDPSession(page); await cdp.send('WebAuthn.enable');
    ({ authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal',
      hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } }));
    await page.goto(`${origin}/fixture`);
    const registration = await page.evaluate(async ({ handle, registrationChallenge }) => {
      const bytes = (value: string) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
      const encode = (value: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
      const credential = await navigator.credentials.create({ publicKey: { rp: { id: 'localhost', name: 'Virtual payment fixture' },
        user: { id: bytes(handle), name: 'Juicebox test', displayName: 'Juicebox test' }, challenge: bytes(registrationChallenge),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }], authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, attestation: 'none' } }) as PublicKeyCredential;
      const response = credential.response as AuthenticatorAttestationResponse;
      return { credentialId: credential.id, rawId: encode(credential.rawId), clientDataJSON: encode(response.clientDataJSON), attestationObject: encode(response.attestationObject) };
    }, { handle, registrationChallenge });
    candidate = parseWalletRegistration({ ...registration, type: 'public-key', rawId: decode(registration.rawId), clientDataJSON: decode(registration.clientDataJSON), attestationObject: decode(registration.attestationObject) },
      { challenge: `0x${decode(registrationChallenge).toString('hex')}`, rpId: 'localhost', origin, userHandle: handle });
    review.passkey.credentialId = candidate.credentialId; review.passkey.credentialIds = [candidate.credentialId, 'added-device']; review.passkey.challenge = encode(Buffer.from(review.signing.digest.slice(2), 'hex'));
  });
  afterEach(async () => { await page?.context().close(); });
  afterAll(async () => { await browser?.close(); if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve())); });
  async function load() { await page.goto(`${origin}/wallet/payment?review=${reviewId}`); await status('ready'); }
  const approvals = () => requests.filter(request => request.path.endsWith('/approve'));

  it('shows the quote notice beside approval only when the review carries one', async () => {
    await load(); expect(await page.locator('#payment-notice').isVisible()).toBe(false);
    review = { ...review, notice: PAY_QUOTE_FAILED_MESSAGE }; await load();
    expect(await page.locator('#payment-notice').textContent()).toBe(PAY_QUOTE_FAILED_MESSAGE);
    expect(await page.locator('#payment-notice').isVisible()).toBe(true);
    expect(await page.locator('#payment-approve').isVisible()).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  it('shows exact payment terms and approves only on a click with selected UV credential and CSRF', async () => {
    await load(); expect(await page.evaluate(() => (window as any).passkeyRequests)).toEqual([]);
    expect(await page.locator('#payment-amount').textContent()).toBe('1 USDC');
    expect(await page.locator('#payment-project').textContent()).toBe('7');
    expect(await page.locator('#payment-minimum').textContent()).toContain('5');
    expect(await page.locator('#payment-memo').textContent()).toBe('hello');
    expect(await page.locator('#payment-gas').textContent()).toBe('Gas: up to 0.000000000115 ETH from your account');
    expect(await page.locator('#payment-status').evaluate(e => getComputedStyle(e).borderTopWidth)).toBe('0px');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // A fresh approval returns to the app on its own; the page keeps the approved state for a return visit.
    await page.locator('#payment-approve').click(); await status('approved');
    expect(approvals()).toHaveLength(1); expect(approvals()[0]!.headers['cookie']).toBeUndefined();
    expect(approvals()[0]!.headers['x-center-wallet-request']).toBe('1');
    expect(approvals()[0]!.body.assertion.credentialId).toBe(candidate.credentialId);
    expect(await page.evaluate(() => (window as any).passkeyRequests)).toEqual([{ rpId: 'localhost', userVerification: 'required', allowCredentials: undefined }]);
    expect(await page.locator('#payment-status').textContent()).toContain('Sending on Base');
    await approved();
    expect(await page.locator('#payment-status').textContent()).toContain('Check the result in the app');
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
    const output = new URL('../.generated/wallet-observations/payment-browser/', import.meta.url); await mkdir(output, { recursive: true });
    await page.screenshot({ path: new URL('approved-mobile.png', output).pathname, fullPage: true });
    await writeFile(new URL('summary.json', output), JSON.stringify({ tier: 'virtual-authenticator', browserVersion: browser.version(),
      nativeAssertionVerified: true, explicitClick: true, exactCredential: true, userVerification: true, chainExecutionObserved: false, physicalDeviceObserved: false }, null, 2));
    await page.locator('#payment-return').click(); await expect.poll(() => page.url()).toBe(callback()); expect(errors).toEqual([]);
  });

  it('shows the server-described hook metadata as text and refuses steps that do not fit the metadata', async () => {
    const withMetadata = (metadata: Hex, metadataSteps: unknown = passkeyPayMetadataSteps(metadata)) => {
      const f = createWalletPaymentClientFixture(Date.now(), metadata);
      if (!('signedData' in f.prepared.signing)) throw new Error('Fixture must use a passkey owner');
      review = { ...review, operation: f.prepared.operation, operationHash: f.prepared.operationHash, payment: f.payment, metadataSteps,
        signing: { digest: f.prepared.signing.digest, signedData: f.prepared.signing.signedData, validAfter: f.prepared.signing.validAfter, validUntil: f.prepared.signing.validUntil },
        passkey: { ...review.passkey, challenge: encode(Buffer.from(f.prepared.signing.digest.slice(2), 'hex')) } } as typeof review;
    };
    const lines = () => page.locator('#payment-hooks div').allTextContents();
    const refused = async () => {
      await page.goto(`${origin}/wallet/payment?review=${reviewId}`); await status('error');
      expect(await page.locator('#payment-approve').isVisible()).toBe(false);
    };
    await load(); expect(await lines()).toEqual(['None supplied']);
    const tiered = buildUserPayMetadata({ chainId: 8453, minimumSwapAmountOut: 5n, tiers: { metadataIdTarget: review.payment.terminal, tierIdsToMint: [2n] } });
    withMetadata(tiered); await load();
    const shown = await lines();
    expect(shown).toHaveLength(3);
    expect(shown[0]).toBe('Hooks may ignore these or act differently by version; the minimum above is enforced');
    expect(shown[1]).toMatch(/^Buyback hook swap instructions\. Hook lookup id: 0x[0-9a-f]{8}\. Amount to swap: 0\. Minimum swap output: 5 .*Skip splits on swapped tokens: yes$/);
    expect(shown[2]).toMatch(/^721 shop mint instructions\. .*Tier IDs to mint: /);
    withMetadata(tiered, [{ title: '<img src=x onerror=alert(1)>', rows: [['Label', '<b>value</b>']] }]); await load();
    expect((await lines()).slice(1)).toEqual(['<img src=x onerror=alert(1)>. Label: <b>value</b>']);
    expect(await page.locator('#payment-hooks img, #payment-hooks b').count()).toBe(0);
    withMetadata(tiered, []); await refused();
    withMetadata('0x', [{ title: 'Buyback', rows: [] }]); await refused();
    withMetadata(tiered, [{ title: 'Buyback', rows: [['only label']] }]); await refused();
    withMetadata(tiered, null); await refused();
  });
  it('cancels the native prompt without approving and permits another explicit click', async () => {
    await load(); await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: false });
    await page.locator('#payment-approve').click(); await status('authenticating');
    await page.locator('#payment-prompt-cancel').click(); await status('ready'); expect(approvals()).toHaveLength(0);
    await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: true });
    await page.locator('#payment-approve').click(); await approved(); expect(approvals()).toHaveLength(1);
  });

  it('offers a read-only retry after a browser blocks the native prompt, then requires explicit approval', async () => {
    await load();
    await page.evaluate(() => {
      const original = navigator.credentials.get;
      navigator.credentials.get = async () => {
        navigator.credentials.get = original;
        throw new DOMException('Browser diagnostic: https://www.w3.org/TR/webauthn-2/', 'SecurityError');
      };
    });
    await page.locator('#payment-approve').click(); await status('error');
    expect(await page.locator('#payment-status').textContent()).toBe('This browser blocked the device request. Open the original secure account page and try again.');
    expect(await page.locator('#payment-retry').isVisible()).toBe(true);
    expect(approvals()).toHaveLength(0); expect(review.status).toBe('pending');
    const reads = requests.filter(request => request.path === `/wallet/payment-reviews/${reviewId}`).length;
    await page.locator('#payment-retry').click(); await status('ready');
    expect(requests.filter(request => request.path === `/wallet/payment-reviews/${reviewId}`)).toHaveLength(reads + 1);
    expect(approvals()).toHaveLength(0); expect(review.status).toBe('pending');
    expect(await page.evaluate(() => (window as any).passkeyRequests)).toEqual([]);
    expect(await page.locator('#payment-approve').isVisible()).toBe(true);
    await page.locator('#payment-approve').click(); await approved();
    expect(approvals()).toHaveLength(1); expect(errors).toEqual([]);
  });

  it('recovers a committed approval after a truncated response without a second prompt or mutation', async () => {
    await load(); dropApproval = true; await page.locator('#payment-approve').click(); await status('unknown');
    expect(await page.locator('#payment-approve').isVisible()).toBe(false);
    await page.locator('#payment-retry').click(); await status('approved'); expect(approvals()).toHaveLength(1);
    expect(await page.evaluate(() => (window as any).passkeyRequests.length)).toBe(1);
    await approved();
  });

  it('retries the same native proof when the first approval never reached the server', async () => {
    await load(); let firstBody = '', secondBody = '';
    await page.route('**/wallet/payment-reviews/*/approve', async route => {
      if (!firstBody) { firstBody = route.request().postData()!; await route.abort('failed'); }
      else { secondBody = route.request().postData()!; await route.continue(); }
    });
    await page.locator('#payment-approve').click(); await status('unknown'); expect(approvals()).toHaveLength(0);
    await page.locator('#payment-retry').click(); await status('approved');
    expect(secondBody).toBe(firstBody); expect(approvals()).toHaveLength(1);
    expect(await page.evaluate(() => (window as any).passkeyRequests.length)).toBe(1);
    await approved();
  });

  it('accepts a selected-credential assertion with a nullable user handle', async () => {
    await load();
    // Exercise the standards-permitted nullable response with a genuine native
    // assertion; only the optional returned handle is omitted by this producer.
    await page.evaluate(() => Object.defineProperty(AuthenticatorAssertionResponse.prototype, 'userHandle', { configurable: true, get: () => null }));
    await page.locator('#payment-approve').click(); await approved();
    expect(approvals()[0]!.body.assertion.userHandle).toBeNull(); expect(approvals()).toHaveLength(1);
  });

  it('bounds a payment response before rendering or asking for approval', async () => {
    await page.route('**/wallet/payment-reviews/*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ padding: 'x'.repeat(1_048_576) }) }));
    await page.goto(`${origin}/wallet/payment?review=${reviewId}`); await status('error');
    expect(approvals()).toHaveLength(0); expect(await page.locator('#payment-approve').isVisible()).toBe(false);
  });

  it('an added device approves with its own passkey', async () => {
    // The review names the primary; this device's passkey is one of the account's approvers.
    review.passkey.credentialIds = ['cHJpbWFyeQ', candidate.credentialId]; review.passkey.credentialId = 'cHJpbWFyeQ';
    await load();
    await page.locator('#payment-approve').click(); await status('approved');
    expect(approvals()).toHaveLength(1); expect(approvals()[0]!.body.assertion.credentialId).toBe(candidate.credentialId);
  });
  it('lets a different passkey be tried again, and returns to the app from a blocked page', async () => {
    await load();
    // The device offered another passkey than the one the review pins: no approval is sent, the page asks again.
    const pinned = review.passkey.credentialId; review.passkey.credentialId = 'someone-else'; review.passkey.credentialIds = ['someone-else', 'added-device'];
    await page.reload(); await status('ready');
    await page.locator('#payment-approve').click();
    await expect.poll(() => page.locator('#payment-status').textContent()).toContain('different passkey');
    await status('ready'); expect(approvals()).toHaveLength(0);
    expect(await page.locator('#payment-approve').isVisible()).toBe(true);
    review.passkey.credentialId = pinned; review.passkey.credentialIds = [pinned, 'added-device'];
    // A page that cannot go on still offers the way back to the app it came from.
    dropApproval = true; await page.reload(); await status('ready'); await page.locator('#payment-approve').click(); await status('unknown');
    review.payment = { ...review.payment, amount: '2000000' };
    await page.locator('#payment-retry').click(); await status('error');
    expect(await page.locator('#payment-return').isVisible()).toBe(true);
    await page.locator('#payment-return').click(); await expect.poll(() => page.url()).toBe(callback());
  });

  it('keeps unknown approval honest while its status is unavailable', async () => {
    await load(); dropApproval = true; await page.locator('#payment-approve').click(); await status('unknown');
    unavailableReads = true; await page.locator('#payment-retry').click(); await status('unknown');
    expect(await page.locator('#payment-return').isVisible()).toBe(false); expect(await page.locator('#payment-cancel').isVisible()).toBe(false);
    expect(await page.locator('body').textContent()).not.toContain('private provider detail'); expect(approvals()).toHaveLength(1);
  });

  it.each(['foreign-origin', 'wrong-state', 'duplicate-review', 'fragment'])('rejects a %s response redirect', async kind => {
    await load(); const redirect = new URL(callback());
    if (kind === 'foreign-origin') redirect.hostname = 'outside.invalid';
    if (kind === 'wrong-state') redirect.searchParams.set('state', csrf);
    if (kind === 'duplicate-review') redirect.searchParams.append('review', reviewId);
    if (kind === 'fragment') redirect.hash = 'proof';
    redirectOverride = redirect.href; await page.locator('#payment-approve').click(); await status('error');
    // The page never follows the bad redirect; its own way back is the callback it verified at load.
    expect(new URL(page.url()).pathname).toBe('/wallet/payment');
    expect(await page.locator('#payment-return').getAttribute('href')).toBe(callback());
  });

  it('refuses recovery if immutable payment terms change under the same review ID', async () => {
    await load(); dropApproval = true; await page.locator('#payment-approve').click(); await status('unknown');
    review.payment = { ...review.payment, amount: '2000000' };
    await page.locator('#payment-retry').click(); await status('error'); expect(await page.locator('#payment-return').getAttribute('href')).toBe(callback());
  });

  it.each([
    ['amount', '2000000'], ['beneficiary', '0x1111111111111111111111111111111111111111'], ['projectId', '8'],
    ['memo', '<script>private marker</script>'], ['metadata', '0x1234'], ['minimumReturnedTokens', '0'],
    ['token', '0x1111111111111111111111111111111111111111'], ['terminal', '0x1111111111111111111111111111111111111111'],
  ])('rejects altered first-response %s even when operation and SafeOp digest remain correct', async (field, value) => {
    Object.assign(review.payment, { [field]: value });
    await page.goto(`${origin}/wallet/payment?review=${reviewId}`); await status('error');
    expect(approvals()).toHaveLength(0); expect(await page.locator('#payment-approve').isVisible()).toBe(false);
    expect(await page.evaluate(() => (window as any).passkeyRequests.length)).toBe(0);
  });

  it("refuses a review whose token or terminal differs from the bundle's pin", async () => {
    const pin = { token: review.payment.token, directV6Terminal: review.payment.terminal }, other = '0x1111111111111111111111111111111111111111' as const;
    for (const served of [{ ...pin, token: other }, { ...pin, directV6Terminal: other }]) {
      // Internally consistent: the calls, SafeOp digest, passkey challenge and summary all name the served pair.
      const f = createWalletPaymentClientFixture(Date.now(), '0x', served);
      if (!('signedData' in f.prepared.signing)) throw new Error('Fixture must use a passkey owner');
      review = { ...review, operation: f.prepared.operation, operationHash: f.prepared.operationHash, payment: f.payment,
        signing: { digest: f.prepared.signing.digest, signedData: f.prepared.signing.signedData, validAfter: f.prepared.signing.validAfter, validUntil: f.prepared.signing.validUntil },
        passkey: { ...review.passkey, challenge: encode(Buffer.from(f.prepared.signing.digest.slice(2), 'hex')) } };
      await page.goto(`${origin}/wallet/payment?review=${reviewId}`); await status('error');
      expect(await page.locator('#payment-approve').isVisible()).toBe(false);
      expect(await page.evaluate(() => (window as any).passkeyRequests.length)).toBe(0); expect(approvals()).toHaveLength(0);
    }
  });

  it('the gas row matches the signed paymaster fields', async () => {
    // Sponsored: the operation's own paymaster fields, inside the signed bytes, name the payer.
    const paymaster = '0x00000000000000fb866daaa79352cc568a005d96' as const;
    const operation = { ...review.operation, paymaster, paymasterVerificationGasLimit: '0x64' as Hex, paymasterPostOpGasLimit: '0x0' as Hex, paymasterData: '0x1234' as Hex };
    const signing = safe7579PasskeyOwnerSigningPayload({ operation, chainId: 8453, entryPoint: review.entryPoint, safe7579: review.safe7579,
      validAfter: review.signing.validAfter, validUntil: review.signing.validUntil });
    const sponsored = { ...review, operation, operationHash: getUserOperationHash(operation, review.entryPoint, 8453),
      signing: { digest: signing.digest, signedData: signing.signedData, validAfter: signing.validAfter, validUntil: signing.validUntil },
      passkey: { ...review.passkey, challenge: encode(Buffer.from(signing.digest.slice(2), 'hex')) }, gas: { payer: 'pimlico' as const, chainId: 8453, paymaster } };
    const unsponsored = review;
    review = sponsored; await load();
    expect(await page.locator('#payment-gas').textContent()).toBe('Gas: sponsored');
    expect(await page.locator('#payment-approve').isVisible()).toBe(true);
    // A response whose gas row disagrees with the signed fields is refused before any approval.
    for (const claimed of [{ ...sponsored, gas: unsponsored.gas }, { ...unsponsored, gas: sponsored.gas },
      { ...unsponsored, gas: { ...unsponsored.gas, maximumWei: '1' } }, { ...unsponsored, gas: { ...unsponsored.gas, balanceWei: '1' } }]) {
      review = claimed as typeof review;
      await page.goto(`${origin}/wallet/payment?review=${reviewId}`); await status('error');
      expect(await page.locator('#payment-approve').isVisible()).toBe(false);
    }
    expect(await page.evaluate(() => (window as any).passkeyRequests.length)).toBe(0); expect(approvals()).toHaveLength(0);
  });

  it('a Safe-paid review without enough ETH shows needs ETH for gas in the same confirmation and cannot be signed', async () => {
    review.gas = { payer: 'account', chainId: 8453, maximumWei: '115000000', reason: 'sponsor-refused', balanceWei: '114999999', funded: false };
    for (const viewport of [{ width: 360, height: 780 }, { width: 1280, height: 800 }]) {
      await page.setViewportSize(viewport); await load();
      expect(await page.locator('#payment-gas').textContent()).toBe('Needs ETH for gas on Base.');
      expect(await page.locator('#payment-gas').isVisible()).toBe(true);
      expect(await page.locator('#payment-approve').isVisible()).toBe(false);
      // Not a dead end: the customer can decline here or go back to the app.
      expect(await page.locator('#payment-cancel').isVisible()).toBe(true);
      expect(await page.locator('#payment-return').isVisible()).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    expect(await page.evaluate(() => (window as any).passkeyRequests.length)).toBe(0); expect(approvals()).toHaveLength(0);
  });

  it('does not prompt for an already expired or approved review', async () => {
    review.expiresAtMs = Date.now() - 1; await page.goto(`${origin}/wallet/payment?review=${reviewId}`); await status('expired');
    expect(await page.locator('#payment-approve').isVisible()).toBe(false);
    review.status = 'approved'; review.approvedAtMs = Date.now() - 2;
    await page.reload(); await status('approved'); expect(await page.evaluate(() => (window as any).passkeyRequests.length)).toBe(0);
  });

  it('cancels the pending review without requesting a passkey', async () => {
    await load(); await page.locator('#payment-cancel').click(); await status('cancelled'); expect(approvals()).toHaveLength(0);
    expect(await page.locator('#payment-return').getAttribute('href')).toBe(callback());
  });

  it('reads the configuration and the review together, and never asks for a Center session', async () => {
    await load();
    expect(requests.slice(0, 2).map(request => request.path).sort()).toEqual(['/wallet/config', `/wallet/payment-reviews/${reviewId}`]);
    expect(requests.some(request => request.path === '/wallet/session')).toBe(false);
  });

  it.each([`review=${reviewId}&review=${reviewId}`, `review=${reviewId}&return=https://outside.invalid`, 'review=bad'])('rejects ambiguous review navigation %s', async query => {
    await page.goto(`${origin}/wallet/payment?${query}`); await status('error'); expect(approvals()).toHaveLength(0);
    expect(await page.locator('#payment-approve').isVisible()).toBe(false);
  });
});
