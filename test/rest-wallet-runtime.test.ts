import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import type { Store } from '../src/store.js';
import { createCenterMcp } from '../src/mcp.js';
import { createRestRuntime, type RestWalletConfiguration } from '../src/rest/runtime.js';
import { PostgresWalletPaymentReviewStore } from '../src/rest/wallet/paymentReviewsPostgres.js';
import * as operationService from '../src/rest/userOperations/service.js';
import { readRestExecutionConfiguration } from '../src/rest/executionConfig.js';
import type { SmartAccountManifest, SmartSnapshot } from '../src/rest/smartAccounts/types.js';
import { PostgresWalletAppGrantStore } from '../src/rest/wallet/appGrantsPostgres.js';
import { PostgresWalletLoginStore } from '../src/rest/wallet/loginPostgres.js';
import { PostgresWalletHandoffStore } from '../src/rest/wallet/handoffPostgres.js';
import { PostgresWalletPolicyStore } from '../src/rest/wallet/policyPostgres.js';
import { PostgresWalletAuthorityStore } from '../src/rest/wallet/authorityPostgres.js';
import { PostgresWalletAuthorityRefreshQueue } from '../src/rest/wallet/authorityRefreshPostgres.js';
import * as authorityChain from '../src/rest/wallet/authorityChain.js';
import * as authorityRefresh from '../src/rest/wallet/authorityRefresh.js';
import * as walletSite from '../src/rest/wallet/site.js';
import * as smartAccountService from '../src/rest/smartAccounts/service.js';
import * as smartAccountInspector from '../src/rest/smartAccounts/inspector.js';
import * as postgresAuth from '../src/rest/auth/postgres.js';
import { PostgresAccountStore } from '../src/rest/auth/index.js';
import { TransactionService } from '../src/rest/transactions/service.js';
import { UserOperationService } from '../src/rest/userOperations/service.js';
import { SAFE7579_INSPECTOR_ID } from '../src/rest/smartAccounts/inspector.js';
import type { WalletPolicyActivation } from '../src/rest/wallet/policyPostgres.js';
import { enrollmentManifest } from './fixtures/wallet-enrollment-crypto.js';

// Real runtime composition with inert assets and closed transports. Storage and browser proof
// semantics have independent PostgreSQL, browser and EVM suites; no live service is contacted here.
vi.mock('../src/rest/site.js', async original => ({
  ...(await original<typeof import('../src/rest/site.js')>()),
  readRestAssets: async () => ({ accountsScript: '', walletScript: '/* bounded wallet browser fixture */', walletPaymentScript: '/* payment fixture */', walletSignupScript: '/* signup fixture */', walletRecoveryScript: '/* recovery fixture */', documents: new Map() }),
}));
const origin = 'https://wallet.pilot.example', audience = 'https://juicebox.center';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.useRealTimers(); vi.restoreAllMocks();
});
async function fixture(wallet?: RestWalletConfiguration, startMaintenance = false, smartAccountManifests?: readonly SmartAccountManifest[], walletSignup?: Parameters<typeof createRestRuntime>[0]['walletSignup'], walletRecovery?: Parameters<typeof createRestRuntime>[0]['walletRecovery'], upstreams: Parameters<typeof createRestRuntime>[0]['upstreams'] = new Map()) {
  const pool = new Pool({ connectionString: 'postgresql://fixture@127.0.0.1:1/unused' });
  cleanup.push(() => pool.end());
  const query = vi.spyOn(pool, 'query').mockImplementation(() => { throw new Error('Unexpected database request during startup'); });
  const request = vi.fn(async (): Promise<never> => { throw new Error('Unexpected upstream request during startup'); });
  const store = { consumeRequest: async () => ({ allowed: true, remaining: 100 }), cleanupRateLimits: async () => 0 } as unknown as Store;
  const mcp = createCenterMcp(store, { rpc: { request, supports: () => true }, env: {
    MCP_PLAN_SECRET: 'PUBLIC_WALLET_RUNTIME_FIXTURE_SECRET_ONLY', MCP_PUBLIC_ORIGIN: audience,
  } });
  const runtime = await createRestRuntime({ pool, store, services: mcp.services, config: mcp.config,
    upstreams, rpc: { request }, executionConfiguration: await readRestExecutionConfiguration({}),
    startMaintenance, ...(wallet ? { wallet } : {}), ...(smartAccountManifests ? { smartAccountManifests } : {}), ...(walletSignup ? { walletSignup } : {}), ...(walletRecovery ? { walletRecovery } : {}) });
  cleanup.unshift(() => runtime.stop());
  return { runtime, pool, query, request };
}
async function walletConfiguration() {
  const execution = await readRestExecutionConfiguration({});
  const stack = execution.stacks.find(stack => stack.manifest.chainId === 8453)!;
  return { origin, manifest: { ...structuredClone(enrollmentManifest), moduleInspectorId: SAFE7579_INSPECTOR_ID, entryPoint: stack.manifest.entryPoint! }, utility: stack.utility };
}

describe('explicit wallet runtime composition', () => {
  it('mounts recovery only from a host-created local capability without enabling it at normal startup', async () => {
    const site = vi.spyOn(walletSite, 'createWalletSite'), start = vi.fn(), stop = vi.fn(async () => {});
    const factory = vi.fn(() => ({ start, stop }) as never);
    const f = await fixture(await walletConfiguration(), false, undefined, undefined, factory);
    expect(factory).toHaveBeenCalledOnce();
    expect(site).toHaveBeenCalledWith(expect.objectContaining({ recovery: f.runtime.wallet!.recovery, recoveryBrowserScript: '/* recovery fixture */' }));
    expect(start).not.toHaveBeenCalled(); expect(f.query).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
    await f.runtime.stop(); expect(stop).toHaveBeenCalledOnce();
    const absent = await fixture(await walletConfiguration());
    expect(absent.runtime.wallet).not.toHaveProperty('recovery');
    await expect(fixture(undefined, false, undefined, undefined, factory)).rejects.toMatchObject({ code: 'WALLET_RECOVERY_UNAVAILABLE' });
    expect(factory).toHaveBeenCalledOnce();
  });
  it('builds the onramp from plain settings on the wallet origin, so the configuration still clones', async () => {
    const site = vi.spyOn(walletSite, 'createWalletSite');
    const { privateKey } = generateKeyPairSync('ed25519'), jwk = privateKey.export({ format: 'jwk' });
    const secret = Buffer.concat([Buffer.from(jwk.d!, 'base64url'), Buffer.from(jwk.x!, 'base64url')]).toString('base64');
    const f = await fixture({ ...await walletConfiguration(), onramp: { keyId: 'fixture-key', secret, applePay: true } });
    const onramp = site.mock.calls[0]![0].onramp!;
    expect(onramp.applePay).toBe(true); expect(typeof onramp.session).toBe('function');
    expect(f.query).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
    site.mockClear(); await fixture(await walletConfiguration());
    expect(site.mock.calls[0]![0]).not.toHaveProperty('onramp');
  });
  it('installs signup only from an explicit local capability and stops its worker with the runtime', async () => {
    const site = vi.spyOn(walletSite, 'createWalletSite');
    const start = vi.fn(), stop = vi.fn(async () => true);
    const local = vi.fn(() => ({ start, stop }) as never);
    const f = await fixture(await walletConfiguration(), false, undefined, local);
    expect(local).toHaveBeenCalledOnce(); expect(local.mock.calls[0]).toHaveLength(1);
    expect(site).toHaveBeenCalledWith(expect.objectContaining({ signup: f.runtime.wallet!.signup, signupBrowserScript: '/* signup fixture */' }));
    expect(start).not.toHaveBeenCalled(); expect(f.query).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
    await f.runtime.stop(); expect(stop).toHaveBeenCalledOnce();
  });
  it('composes payment reviews and strict V6 effects from the same optional host configuration', async () => {
    const site = vi.spyOn(walletSite, 'createWalletSite');
    const Original = operationService.UserOperationService;
    const operations = vi.spyOn(operationService, 'UserOperationService').mockImplementation(function(options) { return new Original(options); });
    const paymentConfig = { token: '0x1111111111111111111111111111111111111111' as const, directV6Terminal: '0x2222222222222222222222222222222222222222' as const };
    const configuration = { ...await walletConfiguration(), payments: { ...paymentConfig } }, f = await fixture(configuration);
    expect(f.runtime.wallet!.payments).toBeInstanceOf(PostgresWalletPaymentReviewStore);
    expect(site).toHaveBeenCalledWith(expect.objectContaining({ payments: f.runtime.wallet!.payments, paymentBrowserScript: '/* payment fixture */' }));
    expect(operations).toHaveBeenCalledWith(expect.objectContaining({ v6UsdcPayment: {chainId:8453,...paymentConfig} }));
    configuration.payments.token = '0x3333333333333333333333333333333333333333' as never;
    expect(operations.mock.calls[0]![0].v6UsdcPayment?.token).toBe(paymentConfig.token);
    expect(f.query).not.toHaveBeenCalled();expect(f.request).not.toHaveBeenCalled();
    site.mockClear(); operations.mockClear();
    const disabled = await fixture(await walletConfiguration());
    expect(disabled.runtime.wallet).not.toHaveProperty('payments');
    expect(site.mock.calls[0]![0].payments).toBeUndefined();expect(operations.mock.calls[0]![0].v6UsdcPayment).toBeUndefined();
  });
  it('keeps wallet routes, operator handles and policy activation absent by default', async () => {
    const activate = vi.spyOn(PostgresWalletPolicyStore.prototype, 'activate');
    const claim = vi.spyOn(PostgresWalletAuthorityRefreshQueue.prototype, 'claim');
    const f = await fixture();
    expect(f.runtime).not.toHaveProperty('wallet');
    expect(f.runtime.site).not.toHaveProperty('wallet');
    expect(activate).not.toHaveBeenCalled(); expect(claim).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
  });

  it('composes the exact explicit passkey profile and site without activating policy or making startup RPC', async () => {
    const site = vi.spyOn(walletSite, 'createWalletSite'), chain = vi.spyOn(authorityChain, 'createWalletAuthorityChain');
    const activate = vi.spyOn(PostgresWalletPolicyStore.prototype, 'activate');
    const configuration = await walletConfiguration(), f = await fixture(configuration);
    expect(f.runtime).toHaveProperty('wallet.origin', origin);
    expect(f.runtime.site).toHaveProperty('wallet');
    const internal = f.runtime.wallet!;
    expect(internal.login).toBeInstanceOf(PostgresWalletLoginStore);
    expect(internal.handoff).toBeInstanceOf(PostgresWalletHandoffStore);
    expect(internal.policy).toBeInstanceOf(PostgresWalletPolicyStore);
    expect(internal.authority).toBeInstanceOf(PostgresWalletAuthorityStore);
    expect(site).toHaveBeenCalledWith(expect.objectContaining({ origin, audience,
      browserScript: '/* bounded wallet browser fixture */', login: internal.login, handoff: internal.handoff,
      policy: internal.policy, refresh: internal.refresh }));
    expect(chain).toHaveBeenCalledWith(expect.objectContaining({ manifest: configuration.manifest,
      utility: configuration.utility, limits: { totalTimeoutMs: 90_000 } }));
    expect(activate).not.toHaveBeenCalled(); expect(f.query).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
  });

  it('gives signed app admission the same bounded refresh worker only when wallet is configured', async () => {
    const Original = postgresAuth.PostgresAccountStore;
    const constructed = vi.spyOn(postgresAuth, 'PostgresAccountStore').mockImplementation(function(pool, options) {
      return new Original(pool, options);
    });
    const f = await fixture(await walletConfiguration());
    expect(constructed).toHaveBeenCalledWith(f.pool, { walletRefresh: f.runtime.wallet!.refresh });
    constructed.mockClear();
    const disabled = await fixture();
    expect(constructed).toHaveBeenCalledWith(disabled.pool, {});
  });

  it('isolates the configured passkey manifest and its utility from legacy operation inspection', async () => {
    const service = vi.spyOn(smartAccountService, 'createSmartAccountService');
    const inspect = vi.spyOn(smartAccountInspector, 'createSafe7579Inspector').mockImplementation(({ utility }) => ({
      id: SAFE7579_INSPECTOR_ID, inspect: async () => { throw new Error(`Fixture utility ${utility.address}`); },
    }));
    const configuration = await walletConfiguration(), original = structuredClone(configuration.manifest);
    configuration.utility = { ...configuration.utility, address: '0x8888888888888888888888888888888888888888' };
    await fixture(configuration);
    const composed = service.mock.calls[0]![0], configured = composed.manifests.find(m => m.id === original.id)!;
    expect(configured).toEqual(original);
    const legacy = composed.manifests.find(m => m.id !== original.id)!;
    expect(legacy).toBeDefined();
    const inspector = composed.moduleInspectors!.find(item => item.id === SAFE7579_INSPECTOR_ID)!;
    configuration.manifest.revision = '0x' + '77'.repeat(32) as `0x${string}`;
    expect(configured).toEqual(original);
    const input = { account: '0x9999999999999999999999999999999999999999' as const, snapshot: {} as SmartSnapshot };
    await expect(inspector.inspect({ ...input, manifest: configured })).rejects.toThrow(`Fixture utility ${configuration.utility.address}`);
    const legacyUtility = inspect.mock.calls[0]![0].utility.address;
    expect(legacyUtility).not.toBe(configuration.utility.address);
    await expect(inspector.inspect({ ...input, manifest: legacy })).rejects.toThrow(`Fixture utility ${legacyUtility}`);
  });

  it('inspects the passkey wallet profile with the same hosted-provider limits as legacy operations', async () => {
    // Setup review inspects the wallet manifest through the wallet-specific inspector. Over Dwellir a
    // genesis log scan exceeds the 500-block limit and the default 30 s deadline (SMART_HISTORY_TIMEOUT),
    // so it must prove creation from the indexed factory history under the same 90 s budget.
    const inspect = vi.spyOn(smartAccountInspector, 'createSafe7579Inspector');
    const configuration = await walletConfiguration();
    await fixture(configuration, false, undefined, undefined, undefined, new Map([[8453, { url: 'https://base.invalid' }]]) as never);
    const calls = inspect.mock.calls.map(([options]) => options);
    expect(calls.map(options => options.utility.address)).toContain(configuration.utility.address);
    for (const options of calls) {
      expect(typeof options.creationLogs).toBe('function');
      expect(options.maxLogRangeBlocks).toBe(500);
      expect(options.timeoutMs).toBe(90_000);
    }
  });

  it('gives the authority refresh the hosted-provider inspection budget', async () => {
    // A complete wallet inspection over the hosted provider takes ~25 s. A 10 s observation
    // budget made every refresh a partial read and every login WALLET_LOGIN_INACTIVE.
    const chain = vi.spyOn(authorityChain, 'createWalletAuthorityChain'), refresh = vi.spyOn(authorityRefresh, 'createWalletAuthorityRefresh');
    await fixture(await walletConfiguration());
    expect(chain.mock.calls[0]![0].limits).toEqual({ totalTimeoutMs: 90_000 });
    const options = refresh.mock.calls[0]![0];
    expect(options.attemptTimeoutMs).toBe(100_000);
    expect((options.queue as unknown as { settings: { leaseMs: number } }).settings.leaseMs).toBe(120_000);
  });

  it('owns its profile bytes even when the identical manifest is supplied in the custom account list', async () => {
    const service = vi.spyOn(smartAccountService, 'createSmartAccountService');
    const configuration = await walletConfiguration(), original = structuredClone(configuration.manifest);
    await fixture(configuration, false, [configuration.manifest]);
    configuration.manifest.revision = `0x${'99'.repeat(32)}`;
    expect(service.mock.calls[0]![0].manifests).toEqual([original]);
  });

  it('rejects ambiguous profile identity before starting maintenance', async () => {
    const configuration = await walletConfiguration();
    const claim = vi.spyOn(PostgresWalletAuthorityRefreshQueue.prototype, 'claim');
    await expect(fixture(configuration, true, [{ ...configuration.manifest, revision: '0x' + '88'.repeat(32) as `0x${string}` }]))
      .rejects.toMatchObject({ code: 'WALLET_MANIFEST_CONFLICT' });
    expect(claim).not.toHaveBeenCalled();
  });

  it.each(['http://wallet.pilot.example', 'https://wallet.pilot.example/', 'https://wallet.pilot.example?redirect=elsewhere'])
    ('rejects noncanonical wallet origin %s before startup work', async badOrigin => {
      const configuration = await walletConfiguration();
      const claim = vi.spyOn(PostgresWalletAuthorityRefreshQueue.prototype, 'claim');
      await expect(fixture({ ...configuration, origin: badOrigin }, true)).rejects.toMatchObject({ status: 400 });
      expect(claim).not.toHaveBeenCalled();
    });

  it('requires an explicit operator policy transition and preserves its expected revision', async () => {
    const activate = vi.spyOn(PostgresWalletPolicyStore.prototype, 'activate').mockResolvedValue({ revision: 1,
      configurationHash: '11'.repeat(32), configuration: { version: 'center-wallet-policy-v1', applications: [] }, activatedAt: 1, apps: [] });
    const f = await fixture(await walletConfiguration()), internal = f.runtime.wallet!;
    expect(internal).toBeDefined(); expect(activate).not.toHaveBeenCalled();
    const input: WalletPolicyActivation = { expectedRevision: 0, nextRevision: 1, configuration: { version: 'center-wallet-policy-v1', applications: [] } };
    expect(await internal.activatePolicy(input)).toMatchObject({ revision: 1 });
    expect(activate).toHaveBeenCalledExactlyOnceWith(input);
    expect(f.query).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
  });

  it('reclaims bounded expired login and handoff state and publishes only aggregate queue observations', async () => {
    vi.useFakeTimers();
    vi.spyOn(PostgresWalletAuthorityRefreshQueue.prototype, 'claim').mockResolvedValue(null);
    const stats = { tracked: 2, interested: 1, due: 0, inFlight: 1, oldestDueAtMs: null, startsInWindow: 1, maxStartsPerMinute: 30 };
    vi.spyOn(PostgresWalletAuthorityRefreshQueue.prototype, 'stats').mockResolvedValue(stats);
    vi.spyOn(PostgresAccountStore.prototype, 'cleanupExpiredNonces').mockResolvedValue(0);
    vi.spyOn(TransactionService.prototype, 'recoverPending').mockResolvedValue({ oldestPendingAt: null, reconciled: [] } as never);
    vi.spyOn(UserOperationService.prototype, 'recoverPending').mockResolvedValue({ oldestPendingAt: null, items: [] } as never);
    const login = vi.spyOn(PostgresWalletLoginStore.prototype, 'cleanup').mockResolvedValue(2);
    const handoff = vi.spyOn(PostgresWalletHandoffStore.prototype, 'cleanup').mockResolvedValue(3);
    const grants = vi.spyOn(PostgresWalletAppGrantStore.prototype, 'cleanup').mockResolvedValue(4);
    const payments = vi.spyOn(PostgresWalletPaymentReviewStore.prototype, 'cleanup').mockResolvedValue(5);
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const f = await fixture({ ...await walletConfiguration(), payments: { token: '0x1111111111111111111111111111111111111111', directV6Terminal: '0x2222222222222222222222222222222222222222' } }, true);
    expect(login).not.toHaveBeenCalled(); expect(handoff).not.toHaveBeenCalled(); expect(grants).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(login).toHaveBeenCalledExactlyOnceWith(250);
    expect(handoff).toHaveBeenCalledExactlyOnceWith(250);
    expect(grants).toHaveBeenCalledExactlyOnceWith(250);
    expect(payments).toHaveBeenCalledExactlyOnceWith(250);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ service: 'wallet', action: 'authority_refresh_queue', ...stats }));
    await f.runtime.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(login).toHaveBeenCalledTimes(1); expect(handoff).toHaveBeenCalledTimes(1); expect(grants).toHaveBeenCalledTimes(1);
    expect(payments).toHaveBeenCalledTimes(1);
  });

  it('starts and stops the refresh worker only with explicitly enabled maintenance', async () => {
    vi.useFakeTimers();
    const claim = vi.spyOn(PostgresWalletAuthorityRefreshQueue.prototype, 'claim').mockResolvedValue(null);
    const inactive = await fixture(await walletConfiguration());
    await vi.advanceTimersByTimeAsync(4_000); expect(claim).not.toHaveBeenCalled();
    await inactive.runtime.stop();
    // One claim at start, then one per 2 s idle tick (a request kicks the worker itself).
    const active = await fixture(await walletConfiguration(), true);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(claim).toHaveBeenCalledTimes(3);
    await active.runtime.stop();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(claim).toHaveBeenCalledTimes(3);
    expect(active.request).not.toHaveBeenCalled();
  });
});
