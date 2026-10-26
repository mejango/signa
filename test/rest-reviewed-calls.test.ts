import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { build } from 'esbuild';
// @ts-expect-error The build script is plain ESM without declarations.
import { webBuildOptions } from '../scripts/rest/build-web.mjs';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeFunctionData, erc20Abi, padHex, parseAbi, toFunctionSelector, type Abi, type Address, type Hex } from 'viem';
import { getJBContractAddress, jbControllerAbi, jbMultiTerminalAbi, jbPermissionsAbi } from '@bananapus/nana-sdk-core';
import { Hono } from 'hono';
import { createRestApp, type RestDependencies } from '../src/rest/app.js';
import type { RestPrincipal } from '../src/rest/auth/store.js';
import type { RestPlanDraft } from '../src/rest/core.js';
import type { StoredReceipt } from '../src/rest/transactions/types.js';
import { encodeSafe7579Execution } from '../src/rest/smartAccounts/accountExecution.js';
import { safe7579PasskeyOwnerSigningPayload } from '../src/rest/smartAccounts/passkeySignatures.js';
import { getUserOperationHash, normalizeUserOperation, userOperationMaximumCost } from '../src/rest/userOperations/codec.js';
import { etherscanAbiSource } from '../src/rest/userOperations/etherscanAbi.js';
import { recognizeReviewedCalls, REVIEWED_CALLS_KIND, REVIEWED_CALLS_OPERATION, reviewCalls, reviewedCallsView, verifyReviewedCallsEffects,
  type CallSource, type EtherscanAbiSource, type SignaCall } from '../src/rest/userOperations/reviewedCalls.js';
import { ETHERSCAN_SOURCE_LINE, LOOKUP_FAILED_LINE, RAW_CALL_WARNING } from '../src/rest/userOperations/reviewedCallRules.js';
import { createWalletPaymentReviewDraft, validateWalletPaymentReviewDraft, verifyWalletPaymentReviewProof,
  walletReviewFromStored, walletReviewToStored, type WalletPaymentReviewContext } from '../src/rest/wallet/paymentReviews.js';
import { publicWalletPaymentAppReview, publicWalletPaymentCentralReview, type WalletReviewedCallsCentralPublic } from '../src/rest/wallet/paymentPublic.js';
import { createWalletPaymentReviewContextFixture, issuer, now, recommit, rpId } from './fixtures/wallet-payment-review-context.js';
import { signGet } from './fixtures/wallet-enrollment-crypto.js';
import { digest } from '../src/rest/userOperations/store.js';

const unknownContract = '0x5555555555555555555555555555555555555555' as Address;
const proxy = '0x6666666666666666666666666666666666666666' as Address;
const implementation = '0x7777777777777777777777777777777777777777' as Address;
const stakeAbi = parseAbi(['function stake(uint256 amount,address to)']);
const depositAbi = parseAbi(['function deposit(uint256 amount)']);
const upgradeAbi = parseAbi(['function upgradeTo(address implementation)']);
const terminal = getJBContractAddress('JBMultiTerminal', 6, 8453) as Address;
const controller = getJBContractAddress('JBController', 6, 8453) as Address;
const permissions = getJBContractAddress('JBPermissions', 6, 8453) as Address;
const usdtLike = '0x8888888888888888888888888888888888888888' as Address;
const nativeToken = '0x000000000000000000000000000000000000EEEe' as Address;
const other = '0x9999999999999999999999999999999999999999' as Address;

/** Etherscan V2 served by a local stub: each address answers with a status, a body or a hang. Never the live API. */
function etherscan(answers: Record<string, { status?: number; body?: unknown } | 'hang'>, slots: Record<string, Hex> = {}) {
  const fetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input)), answer = answers[url.searchParams.get('address')!];
    expect(url.origin + url.pathname).toBe('https://api.etherscan.io/v2/api');
    expect(url.searchParams.get('apikey')).toBe('test-key');
    if (answer === 'hang') return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'TimeoutError'))));
    if (!answer) return new Response(JSON.stringify({ status: '0', message: 'NOTOK', result: 'Contract source code not verified' }));
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200 });
  });
  const client = () => ({ getStorageAt: async ({ address }: { address: Address }) => slots[address.toLowerCase()] ?? padHex('0x0', { size: 32 }) });
  return { fetch, source: etherscanAbiSource({ apiKey: 'test-key', client, fetch: fetch as typeof globalThis.fetch }) };
}
const verified = (abi: Abi) => ({ body: { status: '1', message: 'OK', result: JSON.stringify(abi) } });

let base: WalletPaymentReviewContext, credential: Awaited<ReturnType<typeof createWalletPaymentReviewContextFixture>>['credential'];
let account: Address;
beforeAll(async () => { ({ base, credential } = await createWalletPaymentReviewContextFixture()); account = base.plan.draft.account; });
/** The fixture account's prepared operation, turned into these reviewed calls. */
function reviewedContext(calls: SignaCall[], sources: CallSource[]): WalletPaymentReviewContext {
  const c = structuredClone(base);
  const planCalls = calls.map((call, index) => ({ chainId: 8453, to: call.to, value: call.value.toString(), data: call.data, label: '', decoded: {},
    dependsOn: index ? [index - 1] : [] }));
  c.plan.draft = { operation: REVIEWED_CALLS_OPERATION, account, calls: planCalls, evidence: c.plan.draft.evidence, warnings: [],
    summary: { kind: REVIEWED_CALLS_KIND, sources } };
  c.plan.steps = planCalls.map((_, index) => ({ index, state: 'waiting' }));
  c.operation.stepIndexes = planCalls.map((_, index) => index);
  c.operation.operation.callData = encodeSafe7579Execution(planCalls.map(call => ({ target: call.to, value: call.value, callData: call.data })));
  recommit(c); return c;
}
const options = () => ({ id: randomUUID(), state: randomBytes(32).toString('base64url'), createdAtMs: now });
async function reviewed(calls: SignaCall[], abis: EtherscanAbiSource, expectation?: unknown) {
  return reviewCalls({ chainId: 8453, account, calls, abis, ...(expectation === undefined ? {} : { expectation }) });
}
const noLookups: EtherscanAbiSource = { abiFor: vi.fn(async () => { throw new Error('No lookup expected'); }) };

describe('reviewed calls from a Signa account', () => {
  it('decodes an unknown verified contract from Etherscan and labels the source', async () => {
    const { source, fetch } = etherscan({ [unknownContract.toLowerCase()]: verified([...stakeAbi, ...upgradeAbi]) });
    const data = encodeFunctionData({ abi: stakeAbi, functionName: 'stake', args: [5n, other] });
    const result = await reviewed([{ to: unknownContract, value: 0n, data }], source);
    if (!result.ok) throw new Error(result.refusal);
    // Only the one function used is stored with the review, so the page decodes with the same one.
    expect(result.sources).toEqual([{ source: 'etherscan', abi: [stakeAbi[0]] }]);
    expect(result.model.calls[0]).toMatchObject({ functionName: 'stake', to: unknownContract });
    expect(result.model.calls[0]!.args!.map(arg => [arg.name, arg.type])).toEqual([['amount', 'uint256'], ['to', 'address']]);
    // The verified ABI is cached per chain and address; a second review does not ask again.
    await reviewed([{ to: unknownContract, value: 0n, data }], source);
    expect(fetch).toHaveBeenCalledTimes(1);
    const draft = createWalletPaymentReviewDraft(reviewedContext([{ to: unknownContract, value: 0n, data }], result.sources), options());
    expect(draft.review).toMatchObject({ kind: REVIEWED_CALLS_KIND, sources: result.sources });
    expect(validateWalletPaymentReviewDraft(walletReviewFromStored(JSON.parse(JSON.stringify(walletReviewToStored(draft)))))).toEqual(draft);
  });

  it('follows a proxy to its implementation ABI', async () => {
    const { source, fetch } = etherscan({ [proxy.toLowerCase()]: verified(upgradeAbi), [implementation.toLowerCase()]: verified(depositAbi) },
      { [proxy.toLowerCase()]: padHex(implementation, { size: 32 }) });
    const data = encodeFunctionData({ abi: depositAbi, functionName: 'deposit', args: [9n] });
    const result = await reviewed([{ to: proxy, value: 0n, data }], source);
    if (!result.ok) throw new Error(result.refusal);
    expect(result.sources).toEqual([{ source: 'etherscan', abi: [depositAbi[0]], implementation }]);
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('address'))).toEqual([implementation.toLowerCase()]);
  });

  it('shows raw calldata with a warning when no ABI exists and allows approval', async () => {
    const data = '0xdeadbeef00000000000000000000000000000000000000000000000000000001' as Hex;
    const result = await reviewed([{ to: unknownContract, value: 1n, data }], etherscan({}).source);
    if (!result.ok) throw new Error(result.refusal);
    expect(result.sources).toEqual([{ source: 'raw', lookup: 'no-abi' }]);
    expect(result.model.calls[0]).toMatchObject({ functionName: null, args: null });
    expect(result.model.calls[0]!.warnings.map(warning => warning.code)).toContain('abi-unavailable');
    const draft = createWalletPaymentReviewDraft(reviewedContext([{ to: unknownContract, value: 1n, data }], result.sources), options());
    const proof = verifyWalletPaymentReviewProof(draft, signGet({ ...credential, rpId, origin: issuer, challenge: draft.signing.digest }));
    expect(proof.signature).toMatch(/^0x/);
  });

  it('falls back to raw with a lookup-failed note when Etherscan errors', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const data = encodeFunctionData({ abi: stakeAbi, functionName: 'stake', args: [5n, other] });
    try {
      for (const answer of [{ status: 500 }, { status: 429 }, { body: { status: '0', message: 'NOTOK', result: 'Max rate limit reached' } }, 'hang'] as const) {
        const { source } = etherscan({ [unknownContract.toLowerCase()]: answer });
        const pending = reviewed([{ to: unknownContract, value: 0n, data }], source);
        await vi.advanceTimersByTimeAsync(5_001);
        const result = await pending;
        if (!result.ok) throw new Error(result.refusal);
        expect(result.sources, JSON.stringify(answer)).toEqual([{ source: 'raw', lookup: 'lookup-failed' }]);
      }
    } finally { vi.useRealTimers(); }
    // No key configured is a failed lookup too, and a failed lookup is not cached.
    expect(await etherscanAbiSource({ apiKey: undefined, client: () => { throw new Error('unused'); } }).abiFor({ chainId: 8453, address: unknownContract }))
      .toEqual({ ok: false, reason: 'lookup-failed' });
    const answers: Record<string, { status?: number; body?: unknown }> = { [unknownContract.toLowerCase()]: { status: 500 } };
    const { source } = etherscan(answers);
    expect((await reviewed([{ to: unknownContract, value: 0n, data }], source) as { sources: CallSource[] }).sources[0]!.source).toBe('raw');
    answers[unknownContract.toLowerCase()] = verified(stakeAbi);
    expect((await reviewed([{ to: unknownContract, value: 0n, data }], source) as { sources: CallSource[] }).sources[0]!.source).toBe('etherscan');
     // An oversized body is cut off while streaming, not buffered whole.
    let pulled = 0, cancelled = false;
    const endless = new ReadableStream<Uint8Array>({ pull(controller) { pulled++; controller.enqueue(new Uint8Array(65_536)); }, cancel() { cancelled = true; } });
    const flood = etherscanAbiSource({ apiKey: 'test-key', client: () => ({ getStorageAt: async () => padHex('0x0', { size: 32 }) }), fetch: (async () => new Response(endless)) as typeof globalThis.fetch });
    expect(await flood.abiFor({ chainId: 8453, address: unknownContract })).toEqual({ ok: false, reason: 'lookup-failed' });
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(40);
  });

  it('refuses account self-administration and delegatecall', async () => {
    const safe = parseAbi(['function addOwnerWithThreshold(address owner,uint256 threshold)', 'function swapOwner(address prev,address old,address next)',
      'function removeOwner(address prev,address owner,uint256 threshold)', 'function changeThreshold(uint256 threshold)',
      'function enableModule(address module)', 'function disableModule(address prev,address module)', 'function setFallbackHandler(address handler)',
      'function setGuard(address guard)', 'function installModule(uint256 moduleTypeId,address module,bytes initData)',
      'function uninstallModule(uint256 moduleTypeId,address module,bytes deInitData)']);
    const selfCalls: Hex[] = [
      encodeFunctionData({ abi: safe, functionName: 'addOwnerWithThreshold', args: [other, 1n] }),
      encodeFunctionData({ abi: safe, functionName: 'swapOwner', args: [other, other, other] }),
      encodeFunctionData({ abi: safe, functionName: 'removeOwner', args: [other, other, 1n] }),
      encodeFunctionData({ abi: safe, functionName: 'changeThreshold', args: [2n] }),
      encodeFunctionData({ abi: safe, functionName: 'enableModule', args: [other] }),
      encodeFunctionData({ abi: safe, functionName: 'disableModule', args: [other, other] }),
      encodeFunctionData({ abi: safe, functionName: 'setFallbackHandler', args: [other] }),
      encodeFunctionData({ abi: safe, functionName: 'setGuard', args: [other] }),
      encodeFunctionData({ abi: safe, functionName: 'installModule', args: [1n, other, '0x'] }),
      encodeFunctionData({ abi: safe, functionName: 'uninstallModule', args: [1n, other, '0x'] }),
      '0x12345678',
    ];
    const harmless = { to: other, value: 0n, data: '0x' as Hex };
    for (const data of selfCalls)
      expect(await reviewed([harmless, { to: account.toUpperCase().replace('0X', '0x') as Address, value: 0n, data }], noLookups), data)
        .toEqual({ ok: false, refusal: 'account-self-administration', callIndex: 1 });
    const execute = parseAbi(['function execute(bytes32 mode,bytes executionCalldata)',
      'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures)']);
    const delegated: Hex[] = [
      encodeFunctionData({ abi: execute, functionName: 'execute', args: [`0xff${'00'.repeat(31)}`, encodeAbiParameters([{ type: 'address' }], [other])] }),
      encodeFunctionData({ abi: execute, functionName: 'execTransaction', args: [other, 0n, '0x', 1, 0n, 0n, 0n, other, other, '0x'] }),
    ];
    for (const data of delegated) expect(await reviewed([{ to: other, value: 0n, data }], noLookups)).toEqual({ ok: false, refusal: 'delegatecall', callIndex: 0 });
    expect(noLookups.abiFor).not.toHaveBeenCalled();
    // A stored plan with either is never drafted into a review.
    expect(() => createWalletPaymentReviewDraft(reviewedContext([{ to: account, value: 0n, data: selfCalls[0]! }], [{ source: 'first-party' }]), options())).toThrow();
    expect(() => createWalletPaymentReviewDraft(reviewedContext([{ to: other, value: 0n, data: delegated[1]! }], [{ source: 'raw', lookup: 'no-abi' }]), options())).toThrow();
  });

  it('decodes a first-party call through decodeReviewCall without an Etherscan lookup', async () => {
    const data = encodeFunctionData({ abi: jbMultiTerminalAbi, functionName: 'pay', args: [7n, nativeToken, 10n ** 16n, account, 0n, 'hi', '0x'] });
    const result = await reviewed([{ to: terminal, value: 10n ** 16n, data }], noLookups);
    if (!result.ok) throw new Error(result.refusal);
    expect(result.sources).toEqual([{ source: 'first-party' }]);
    expect(result.model.calls[0]).toMatchObject({ functionName: 'pay', contractName: expect.stringContaining('JBMultiTerminal') });
    expect(noLookups.abiFor).not.toHaveBeenCalled();
  });

  it('the route stores a reviewed-calls plan that verifyReviewedCallsEffects reads', async () => {
    const principal = { kind: 'wallet-app', principalId: 'app:11111111-1111-4111-8111-111111111111:1', scopes: ['read', 'plan', 'relay'],
      idempotencyKey: 'reviewed-calls:attempt', walletApp: { origin: 'https://beep.biz', audience: 'https://juicebox.center', incarnation: '1' }, account: { id: `eip155:8453:${account.toLowerCase()}` } } as unknown as RestPrincipal;
    const head = { chainId: 8453, blockNumber: '100', blockHash: digest('head'), timestamp: String(now / 1000), source: 'onchain' as const };
    let stored: RestPlanDraft | undefined;
    const app = new Hono().route('/api/v1', createRestApp({
      auth: { authenticate: async () => principal }, quota: { consumeRequest: async () => ({ allowed: true, remaining: 100 }) }, operations: { list: () => [] },
      walletPayments: {} as never,
      transactions: { findPlanByIdempotency: async () => undefined,
        createSmartAccountPlan: async (_actor: unknown, bindingId: Hex, draft: RestPlanDraft) => { stored = draft; return { id: 'plan-id', bindingId, draft }; } },
      reviewedCalls: { abis: etherscan({ [unknownContract.toLowerCase()]: verified(stakeAbi) }).source, head: async () => head },
    } as unknown as RestDependencies));
    const calls = [{ to: terminal, value: '10000000000000000',
      data: encodeFunctionData({ abi: jbMultiTerminalAbi, functionName: 'pay', args: [7n, nativeToken, 10n ** 16n, account, 0n, '', '0x'] }) },
    { to: unknownContract, data: encodeFunctionData({ abi: stakeAbi, functionName: 'stake', args: [5n, other] }) }];
    const post = (body: unknown) => app.request('/api/v1/wallet/reviewed-calls', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const bindingId = digest('binding');
    const response = await post({ bindingId, account, calls });
    expect(response.status, await response.clone().text()).toBe(201);
    expect(stored).toMatchObject({ operation: REVIEWED_CALLS_OPERATION, account, evidence: [head],
      summary: { kind: REVIEWED_CALLS_KIND, sources: [{ source: 'first-party' }, { source: 'etherscan', abi: [stakeAbi[0]] }] } });
    expect(stored!.calls.map(call => call.dependsOn)).toEqual([[], [0]]);
    expect(recognizeReviewedCalls({ draft: stored! }, [0, 1])).not.toBeNull();
    const receipt = (status: StoredReceipt['status'], canonical = true): StoredReceipt => ({ transactionHash: digest('tx'), blockHash: digest('block'),
      blockNumber: '101', status, confirmations: 2, canonical, observedAt: now, logs: [] });
    expect(verifyReviewedCallsEffects({ draft: stored! }, receipt('success'))).toMatchObject({ status: 'verified', details: { verifier: 'reviewed-calls-v1', calls: 2 } });
    // A self-call is refused at the route with its index; other chains wait for the all-chains task.
    const refused = await post({ bindingId, account, calls: [calls[0], { to: account, data: '0x12345678' }] });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ code: 'REVIEWED_CALLS_REFUSED', detail: expect.stringMatching(/^Call 2: A call to the account itself is refused/) });
    expect((await post({ bindingId, account, calls, chainId: 1 })).status).toBe(403);
  });

  it("ignores the app's summary and refuses when the app expectation differs from the decoded calls", async () => {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [terminal, 5n] });
    const raw = '0xdeadbeef' as Hex, calls = [{ to: usdtLike, value: 0n, data }, { to: unknownContract, value: 0n, data: raw }];
    const abis = etherscan({}).source;
    const matching = [{ functionName: 'approve', args: [terminal.toLowerCase(), '5'] }, null];
    expect((await reviewed(calls, abis, matching)).ok).toBe(true);
    for (const [expectation, callIndex] of [[[{ functionName: 'approve', args: [terminal, '6'] }, null], 0], [[{ functionName: 'transfer', args: [terminal, '5'] }, null], 0],
      [[matching[0], { functionName: 'deposit', args: [] }], 1], [[matching[0]], 0]] as const)
      expect(await reviewed(calls, abis, expectation)).toEqual({ ok: false, refusal: 'app-expectation-mismatch', callIndex });
    // Nothing the app sends is shown: the model's text is Signa's and the SDK's alone.
    const result = await reviewed(calls, abis, [{ ...matching[0], label: 'Claim your free airdrop' }, null]);
    if (!result.ok) throw new Error(result.refusal);
    expect(JSON.stringify(result.model, (_, value) => typeof value === 'bigint' ? value.toString() : value)).not.toContain('airdrop');
  });
});

describe('verifyReviewedCallsEffects', () => {
  it('needs a canonical successful execution of a reviewed-calls plan', () => {
    const draft: RestPlanDraft = { operation: REVIEWED_CALLS_OPERATION, account: '0x3333333333333333333333333333333333333333', evidence: [], warnings: [],
      calls: [{ chainId: 8453, to: other, value: '1', data: '0x', label: '', decoded: {}, dependsOn: [] }],
      summary: { kind: REVIEWED_CALLS_KIND, sources: [{ source: 'raw', lookup: 'no-abi' }] } };
    const receipt = (status: StoredReceipt['status'], canonical = true): StoredReceipt => ({ transactionHash: digest('tx'), blockHash: digest('block'),
      blockNumber: '101', status, confirmations: 2, canonical, observedAt: now, logs: [] });
    expect(verifyReviewedCallsEffects({ draft }, receipt('success')).status).toBe('verified');
    expect(verifyReviewedCallsEffects({ draft }, receipt('reverted')).status).toBe('failed');
    expect(verifyReviewedCallsEffects({ draft }, receipt('success', false)).status).toBe('unknown');
    expect(verifyReviewedCallsEffects({ draft: { ...draft, operation: 'pay' } }, receipt('success')).status).toBe('unknown');
    expect(verifyReviewedCallsEffects({ draft: { ...draft, calls: [{ ...draft.calls[0]!, to: draft.account }] } }, receipt('success')).status).toBe('unknown');
  });
});

// The production page in Chromium against a synthetic review host. The passkey prompt is counted
// and declined: what matters here is that every source and warning is on the page before the one
// prompt and that nothing else stands between the click and it.
describe('reviewed calls approval page', () => {
  let server: Server, browser: Browser, page: Page, origin: string, html: string, css: string, script: string;
  let review: WalletReviewedCallsCentralPublic;
  const reviewId = '77777777-7777-4777-8777-777777777777';
  const status = (value: string) => expect.poll(() => page.locator('#payment-status').getAttribute('data-state')).toBe(value);
  beforeAll(async () => {
    const built = await build({ entryPoints: [new URL('../src/rest/web/walletPayment.ts', import.meta.url).pathname],
      bundle: true, platform: 'browser', format: 'esm', target: 'es2022', write: false, define: webBuildOptions.define });
    script = built.outputFiles[0]!.text;
    const paymentPage = await import('../src/rest/web/walletPaymentPage.js'), walletPage = await import('../src/rest/web/walletPage.js');
    html = paymentPage.walletPaymentPage(); css = walletPage.walletCss() + paymentPage.walletPaymentCss();
    server = createServer((request, response) => {
      const path = new URL(request.url!, origin).pathname;
      const json = (value: unknown) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (path === '/wallet/payment') { response.writeHead(200, { 'content-type': 'text/html' }); response.end(html); return; }
      if (path.startsWith('/wallet/assets/')) { response.writeHead(200, { 'content-type': path.endsWith('.js') ? 'text/javascript' : 'text/css' }); response.end(path.endsWith('.js') ? script : css); return; }
      if (path === '/wallet/config') return json({ version: 'center-wallet-v1', issuer: origin, audience: origin, rpId: 'localhost' });
      if (path === `/wallet/payment-reviews/${reviewId}`) return json(review);
      response.writeHead(404); response.end();
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('port');
    origin = `http://localhost:${address.port}`; browser = await chromium.launch({ headless: true });
  }, 30_000);
  afterAll(async () => { await browser?.close(); if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve())); });

  /** The review the server would serve for these calls, built with the server's own projection. */
  async function serve(calls: SignaCall[], abis: EtherscanAbiSource = noLookups) {
    const result = await reviewCalls({ chainId: 8453, account, calls, abis });
    if (!result.ok) throw new Error(result.refusal);
    const operation = normalizeUserOperation({ sender: account, nonce: '0x0', signature: '0x', callGasLimit: '0x186a0', verificationGasLimit: '0xf4240',
      preVerificationGas: '0xc350', maxFeePerGas: '0x64', maxPriorityFeePerGas: '0x1',
      callData: encodeSafe7579Execution(calls.map(call => ({ target: call.to, value: call.value.toString(), callData: call.data }))) });
    const entryPoint = '0x0000000071727de22e5e9d8baf0edac6f37da032' as Address, safe7579 = '0x7579f2ad53b01c3d8779fe17928e0d48885b0003' as Address;
    const seconds = Math.floor(Date.now() / 1000), signing = safe7579PasskeyOwnerSigningPayload({ operation, chainId: 8453, entryPoint, safe7579,
      validAfter: String(seconds - 1), validUntil: String(seconds + 300) });
    const draft = { review: { kind: REVIEWED_CALLS_KIND, chainId: 8453, sources: result.sources,
      calls: calls.map(call => ({ to: call.to, value: call.value.toString(), data: call.data.toLowerCase() as Hex })) } } as const;
    review = { version: 'center-wallet-payment-review-v1', id: reviewId, state: Buffer.alloc(32, 12).toString('base64url'), issuer: origin,
      accountId: `eip155:8453:${account.toLowerCase()}`, app: { origin, callbackUri: `${origin}/app/callback`, grantId: randomUUID(), grantIncarnation: '1' },
      planId: randomUUID(), planCommitment: digest('plan'), operationId: randomUUID(), operationCommitment: digest('operation'),
      operationHash: getUserOperationHash(operation, entryPoint, 8453), stepIndexes: calls.map((_, index) => index), operation, chainId: 8453, entryPoint, safe7579,
      review: structuredClone(draft.review) as WalletReviewedCallsCentralPublic['review'], reviewedCalls: JSON.parse(JSON.stringify(reviewedCallsView(draft.review, account))),
      signing: { digest: signing.digest, signedData: signing.signedData, validAfter: signing.validAfter, validUntil: signing.validUntil },
      createdAtMs: Date.now() - 1000, expiresAtMs: Date.now() + 120_000, status: 'pending', approvedAtMs: null, cancelledAtMs: null, operationState: 'prepared',
      notice: null, gas: { payer: 'account', chainId: 8453, maximumWei: userOperationMaximumCost(operation).toString(), reason: 'account-cap',
        balanceWei: (10n ** 18n).toString(), funded: true },
      passkey: { rpId: 'localhost', credentialId: 'AAAA', credentialIds: ['AAAA'], challenge: Buffer.from(signing.digest.slice(2), 'hex').toString('base64url'), userVerification: 'required' } };
  }
  async function open(width = 360) {
    page = await browser.newPage({ viewport: { width, height: 800 } }); page.setDefaultTimeout(5000);
    await page.addInitScript(() => {
      (window as any).passkeyRequests = 0;
      navigator.credentials.get = async () => { (window as any).passkeyRequests++; throw new DOMException('Declined in the test', 'NotAllowedError'); };
    });
    await page.goto(`${origin}/wallet/payment?review=${reviewId}`);
  }
  beforeEach(async () => { await page?.close(); });

  it('describes an ETH pay, an ERC-20 pay with a USDT-style reset, a cash out, queueRulesetsOf, setSplitGroupsOf and setPermissionsFor with admin warnings first', async () => {
    const calls: SignaCall[] = [
      { to: terminal, value: 10n ** 16n, data: encodeFunctionData({ abi: jbMultiTerminalAbi, functionName: 'pay', args: [7n, nativeToken, 10n ** 16n, account, 0n, 'eth pay', '0x'] }) },
      { to: usdtLike, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [terminal, 0n] }) },
      { to: usdtLike, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [terminal, 2_000_000n] }) },
      { to: terminal, value: 0n, data: encodeFunctionData({ abi: jbMultiTerminalAbi, functionName: 'pay', args: [7n, usdtLike, 2_000_000n, account, 0n, '', '0x'] }) },
      { to: terminal, value: 0n, data: encodeFunctionData({ abi: jbMultiTerminalAbi, functionName: 'cashOutTokensOf', args: [account, 7n, 10n ** 18n, nativeToken, 0n, account, '0x'] }) },
      { to: controller, value: 0n, data: encodeFunctionData({ abi: jbControllerAbi, functionName: 'queueRulesetsOf', args: [7n, [], 'next'] }) },
      { to: controller, value: 0n, data: encodeFunctionData({ abi: jbControllerAbi, functionName: 'setSplitGroupsOf', args: [7n, 1n, []] }) },
      { to: permissions, value: 0n, data: encodeFunctionData({ abi: jbPermissionsAbi, functionName: 'setPermissionsFor', args: [account, { operator: other, projectId: 7n, permissionIds: [1, 2] }] }) },
    ];
    await serve(calls); await open(); await status('ready');
    expect(await page.locator('h1').textContent()).toBe('Review transaction');
    expect(await page.locator('#payment-amount').textContent()).toBe('8 calls, sending 0.01 ETH');
    const titles = await page.locator('#payment-calls > li .call-title').allTextContents();
    expect(titles.map(title => title.split(' on ')[0])).toEqual(['pay', 'approve', 'approve', 'pay', 'cashOutTokensOf', 'queueRulesetsOf', 'setSplitGroupsOf', 'setPermissionsFor']);
    expect(await page.locator('#payment-calls > li').nth(2).textContent()).toContain('amount: 2000000');
    expect(new Set(await page.locator('#payment-calls .call-source').allTextContents())).toEqual(new Set(['Decoded with the Juicebox SDK']));
    const warnings = await page.locator('#payment-warnings li').allTextContents();
    expect(warnings[0]).toMatch(/^Call 8: This lets another address act for you/);
    expect(warnings.some(text => text.startsWith('Call 2:'))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  it('every source and warning fits in one confirmation', async () => {
    const stake = encodeFunctionData({ abi: stakeAbi, functionName: 'stake', args: [5n, other] });
    const abis = etherscan({ [unknownContract.toLowerCase()]: verified(stakeAbi), [proxy.toLowerCase()]: { status: 429 } }).source;
    await serve([{ to: terminal, value: 1n, data: encodeFunctionData({ abi: jbMultiTerminalAbi, functionName: 'pay', args: [7n, nativeToken, 1n, account, 0n, '', '0x'] }) },
      { to: unknownContract, value: 0n, data: stake }, { to: proxy, value: 0n, data: '0xdeadbeef' }], abis);
    for (const width of [360, 1280]) {
      await open(width); await status('ready');
      expect(await page.locator('#payment-calls .call-source').allTextContents()).toEqual(['Decoded with the Juicebox SDK', ETHERSCAN_SOURCE_LINE,
        `Raw calldata. ${LOOKUP_FAILED_LINE}`]);
      expect(await page.locator('#payment-warnings').textContent()).toContain(`Call 3: ${LOOKUP_FAILED_LINE} ${RAW_CALL_WARNING}`);
      // Warnings, sources and the approve button are all on the page at once; one click is one prompt.
      for (const id of ['#payment-warnings', '#payment-calls', '#payment-approve']) expect(await page.locator(id).isVisible(), id).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.locator('#payment-approve').click();
      await expect.poll(() => page.evaluate(() => (window as any).passkeyRequests)).toBe(1);
      expect(await page.locator('dialog, [role=dialog]').count()).toBe(0);
      await page.close();
    }
  });

  it('the page refuses an Etherscan ABI whose selector does not match the calldata', async () => {
    const stake = encodeFunctionData({ abi: stakeAbi, functionName: 'stake', args: [5n, other] });
    const abis = etherscan({ [unknownContract.toLowerCase()]: verified(stakeAbi) }).source;
    const refused = async () => { await open(); await status('error'); expect(await page.locator('#payment-approve').isVisible()).toBe(false); };
    await serve([{ to: unknownContract, value: 0n, data: stake }], abis);
    (review.review.sources[0] as { abi: Abi }).abi = parseAbi(['function unstake(uint256 amount,address to)']); await refused();
    // Renaming the function while keeping the selector's signature is a different selector too.
    await serve([{ to: unknownContract, value: 0n, data: stake }], abis);
    (review.review.sources[0] as { abi: Abi }).abi = parseAbi(['function stake(uint128 amount,address to)']); await refused();
    // A call shown as decoded whose bytes differ from the operation's.
    await serve([{ to: unknownContract, value: 0n, data: stake }], abis);
    review.reviewedCalls.model.calls[0]!.data = encodeFunctionData({ abi: stakeAbi, functionName: 'stake', args: [6n, other] }); await refused();
    // A first-party function the server names that the bytes do not encode.
    const pay = encodeFunctionData({ abi: jbMultiTerminalAbi, functionName: 'pay', args: [7n, nativeToken, 1n, account, 0n, '', '0x'] });
    await serve([{ to: terminal, value: 1n, data: pay }]);
    review.reviewedCalls.functions[0] = { ...review.reviewedCalls.functions[0]!, name: 'payFor' }; await refused();
    // A self-call the server slipped past its own check.
    await serve([{ to: other, value: 0n, data: '0x' }]);
    const selfCall = { to: account, value: 0n, data: '0x' as Hex };
    const operation = normalizeUserOperation({ ...review.operation, callData: encodeSafe7579Execution([{ target: selfCall.to, value: '0', callData: '0x' }]) });
    review = { ...review, operation, operationHash: getUserOperationHash(operation, review.entryPoint, 8453) };
    review.review.calls[0] = { to: account, value: '0', data: '0x' };
    review.reviewedCalls.model.calls[0] = { ...review.reviewedCalls.model.calls[0]!, to: account };
    await refused();
    expect(toFunctionSelector(stakeAbi[0])).not.toBe(toFunctionSelector('function stake(uint128 amount,address to)'));
  });

  it('serves the app its calls and sources, and the page alone the model', async () => {
    const data = encodeFunctionData({ abi: stakeAbi, functionName: 'stake', args: [5n, other] });
    const result = await reviewed([{ to: unknownContract, value: 0n, data }], etherscan({ [unknownContract.toLowerCase()]: verified(stakeAbi) }).source);
    if (!result.ok) throw new Error(result.refusal);
    const draft = createWalletPaymentReviewDraft(reviewedContext([{ to: unknownContract, value: 0n, data }], result.sources), options());
    const view = { draft, status: 'pending' as const, approvedAtMs: null, cancelledAtMs: null, operationState: 'prepared' as const, approvers: ['a'] };
    const app = publicWalletPaymentAppReview({ ...view, approval: null });
    expect(app).toMatchObject({ review: draft.review }); expect(app).not.toHaveProperty('payment'); expect(app).not.toHaveProperty('reviewedCalls');
    const central = publicWalletPaymentCentralReview(view) as WalletReviewedCallsCentralPublic;
    expect(central.reviewedCalls.model.calls[0]).toMatchObject({ functionName: 'stake', data });
    expect(central.reviewedCalls.functions).toEqual([stakeAbi[0]]);
    expect(() => JSON.stringify(central)).not.toThrow();
  });
});
