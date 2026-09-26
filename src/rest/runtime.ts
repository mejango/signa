import type { Pool } from "pg";
import type { createPool } from "../db/postgres.js";
import type { SmartAccountState } from "./smartAccounts/types.js";
import {
  createProtocolOperations,
  type Config,
  type ProjectRef,
  type Services,
} from "@juicebox/mcp/host";
import type { Store } from "../store.js";
import type { RpcUpstreams } from "../rpc.js";
import { Metrics } from "../observability.js";
import { createRestApp } from "./app.js";
import { createRestAuth, PostgresAccountStore } from "./auth/index.js";
import { createContractOwnerVerifier } from "./contractOwner.js";
import { getContractCatalog, type ContractCatalog } from "./contracts/catalog.js";
import { RestError, type RestRpc } from "./core.js";
import { restRequest } from "./context.js";
import { apiDocsCss, apiDocsPage, buildRestOpenApi } from "./docs/index.js";
import {
  createTransactionDispatchAuthorizer,
  createSponsorshipDispatchAuthorizer,
  createSessionPlanAuthorizer,
  createUserOperationRequestAuthorizer,
} from "./dispatchAuthority.js";
import { createIndexerReadService } from "./indexer/index.js";
import { createOmnichainService } from "./omnichain/index.js";
import { createProtocolReadService } from "./protocol/index.js";
import { createProtocolSemanticVerifier } from "./protocol/semantics.js";
import { createRestRpc } from "./rpc.js";
import { readRestAssets, type RestSite } from "./site.js";
import {
  RelayrSponsorshipService,
  PostgresSponsorshipStore,
} from "./sponsorship/index.js";
import {
  createSmartAccountService,
  createSessionPolicyReviewer,
  PostgresSmartAccountRegistry,
  CHECKED_SMART_ACCOUNT_BINDING_MANIFESTS,
  type SmartAccountManifest,
  type ContractPin,
  type SmartModuleInspector,
  type ReviewedSessionTarget,
  type ReviewedSessionAsset,
  type ReviewedSessionPaymaster,
  createInstalledSessionVerifier,
} from "./smartAccounts/index.js";
import { createSessionTargetResolver } from "./smartAccounts/targets.js";
import { createSafe7579Inspector } from "./smartAccounts/inspector.js";
import { stable } from "./smartAccounts/service.js";
import { FactoryHistoryIndex, loadFactoryHistorySeed } from "./smartAccounts/factoryHistory.js";
import { PostgresSafe7579CheckpointStore } from "./smartAccounts/checkpoints.js";
import { PostgresOnboardingStore } from "./smartAccounts/onboardingPostgres.js";
import {
  readRestExecutionConfiguration,
  type RestExecutionConfiguration,
} from "./executionConfig.js";
import { PostgresSessionStore } from "./sessions/postgres.js";
import { SessionService } from "./sessions/service.js";
import { UserOperationProvider } from "./userOperations/provider.js";
import { UserOperationService } from "./userOperations/service.js";
import { PostgresUserOperationStore } from "./userOperations/postgres.js";
import { PostgresTransactionStore } from "./transactions/postgres.js";
import { TransactionService } from "./transactions/service.js";

import { PostgresWalletAppGrantStore } from "./wallet/appGrantsPostgres.js";
import { PostgresWalletLoginStore } from "./wallet/loginPostgres.js";
import { PostgresWalletPolicyStore } from "./wallet/policyPostgres.js";
import { PostgresWalletHandoffStore } from "./wallet/handoffPostgres.js";
import { PostgresWalletAuthorityStore } from "./wallet/authorityPostgres.js";
import { createWalletAuthorityChain } from "./wallet/authorityChain.js";
import { createWalletAuthorityService } from "./wallet/authorityService.js";
import { createWalletAuthorityRefresh } from "./wallet/authorityRefresh.js";
import { PostgresWalletAuthorityRefreshQueue } from "./wallet/authorityRefreshPostgres.js";
import { validateWalletPolicyOrigin } from "./wallet/policy.js";
import { createWalletSite } from "./wallet/site.js";
import { PostgresWalletPaymentReviewStore } from './wallet/paymentReviewsPostgres.js';
import type { WalletV6UsdcPaymentConfig } from './userOperations/semantics.js';
import type { createLocalWalletSignup } from './wallet/signup.js';
import type { createLocalWalletRecovery } from './wallet/recoveryService.js';
import { createLocalWalletDevices } from "./wallet/deviceService.js";
import { createWalletNetworks } from "./wallet/networks.js";
import { PostgresWalletNetworksStore } from "./wallet/networksPostgres.js";
import { PostgresWalletEnrollmentStore } from "./wallet/enrollmentPostgres.js";
import { RelayrProvider } from "./sponsorship/provider.js";
import { createWalletOnramp, type WalletOnrampConfig } from "./wallet/onramp.js";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

export interface RestWalletConfiguration {
  origin: string;
  /** Former wallet origins whose hosts redirect to `origin`. */
  legacyOrigins?: string[];
  /** App origins admitted to frame their own payment reviews (each an exact https origin). */
  frameableAppOrigins?: string[];
  /** Mount path of the wallet pages: '' on a dedicated host. Defaults to '/wallet'. */
  basePath?: string;
  manifest: SmartAccountManifest;
  utility: ContractPin;
  payments?: Omit<WalletV6UsdcPaymentConfig, 'chainId'>;
  /** Private key of the account that funds Relayr bundles for the account-on-more-chains feature. */
  networksPayerKey?: Hex;
  /** Coinbase Onramp to the account's own address (plain settings; the runtime builds the client). */
  onramp?: Omit<WalletOnrampConfig, 'origin' | 'fetch'>;
  applePayDomainFile?: string;
}
export interface RestWalletRuntime {
  origin: string;
  networks?: ReturnType<typeof createWalletNetworks>;
  login: PostgresWalletLoginStore;
  appGrants: PostgresWalletAppGrantStore;
  policy: PostgresWalletPolicyStore;
  handoff: PostgresWalletHandoffStore;
  authority: PostgresWalletAuthorityStore;
  refresh: ReturnType<typeof createWalletAuthorityRefresh>;
  refreshQueue: PostgresWalletAuthorityRefreshQueue;
  manifestId: string;
  payments?: PostgresWalletPaymentReviewStore;
  signup?: ReturnType<typeof createLocalWalletSignup>;
  recovery?: ReturnType<typeof createLocalWalletRecovery>;
  devices?: ReturnType<typeof createLocalWalletDevices>;
  /** Internal operator transition; startup never activates policy. */
  activatePolicy: PostgresWalletPolicyStore["activate"];
}

export async function createRestRuntime(options: {
  surface?: "wallet";
  pool: Pool;
  store: Store;
  services: Services;
  config: Config;
  upstreams: RpcUpstreams;
  audience?: string;
  wallet?: RestWalletConfiguration;
  /** Explicit host capabilities: the unforked local pilot or the hosted Base host. No HTTP field
   * can construct a treasury signer; the host process supplies the factory and its configuration. */
  walletSignup?: (context: { pool: Pool; rpc: RestRpc; wallet: RestWalletRuntime; audience: string;
    smart: ReturnType<typeof createSmartAccountService> }) => ReturnType<typeof createLocalWalletSignup> | Promise<ReturnType<typeof createLocalWalletSignup>>;
  walletRecovery?: (context: { pool: Pool; rpc: RestRpc; wallet: RestWalletRuntime; audience: string;
    smart: ReturnType<typeof createSmartAccountService> }) => ReturnType<typeof createLocalWalletRecovery> | Promise<ReturnType<typeof createLocalWalletRecovery>>;
  walletDevices?: (context: { pool: Pool; rpc: RestRpc; wallet: RestWalletRuntime; audience: string;
    smart: ReturnType<typeof createSmartAccountService> }) => ReturnType<typeof createLocalWalletDevices> | Promise<ReturnType<typeof createLocalWalletDevices>>;
  rpcSiteLimitPerMinute?: number;
  smartAccountManifests?: readonly SmartAccountManifest[];
  smartAccountModuleInspectors?: readonly SmartModuleInspector[];
  smartAccountSessionTargets?: readonly ReviewedSessionTarget[];
  smartAccountAssets?: readonly ReviewedSessionAsset[];
  smartAccountPaymasters?: readonly ReviewedSessionPaymaster[];
  executionConfiguration?: RestExecutionConfiguration;
  rpc?: RestRpc;
  startMaintenance?: boolean;
  metrics?: Metrics;
}): Promise<{
  site: RestSite;
  transactions: TransactionService;
  wallet?: RestWalletRuntime;
  rpc: RestRpc;
  catalog: ContractCatalog;
  stop(): Promise<void>;
}> {
  const contracts = await getContractCatalog();
  const execution =
    options.executionConfiguration ??
    (await readRestExecutionConfiguration({}));
  const shutdownSignal = new AbortController();
  const backendRpc =
    options.rpc ??
    createRestRpc({
      upstreams: options.upstreams,
      consume: async () => {
        // Two counters, one round trip's worth of waiting.
        const [quota, site] = await Promise.all([
          options.store.consumeRequest("rpc:rest", 20_000, 60),
          options.store.consumeRequest("rpc:site", options.rpcSiteLimitPerMinute ?? 20_000, 60),
        ]);
        if (!quota.allowed)
          throw new RestError(
            429,
            "RATE_LIMITED",
            "The REST chain request budget is spent; retry later",
          );
        if (!site.allowed)
          throw new RestError(
            429,
            "RATE_LIMITED",
            "The shared chain request budget is spent; retry later",
          );
      },
    });
  const rpc: RestRpc = {
    request: (chainId, method, params, signal) =>
      backendRpc.request(
        chainId,
        method,
        params,
        AbortSignal.any([
          shutdownSignal.signal,
          ...(signal ? [signal] : []),
          ...(restRequest() ? [restRequest()!.signal] : []),
        ]),
      ),
  };
  // Explicit pilot configuration owns private source pins. A caller changing its object after
  // startup cannot silently change the profile used by either readiness or operation checks.
  const walletConfiguration = options.wallet ? structuredClone(options.wallet) : undefined;
  let rememberVerifiedState: ((state: SmartAccountState) => void) | undefined;
  let rememberedVerifiedState: ((manifestId: string, address: Address) => SmartAccountState | undefined) | undefined;
  const wallet: RestWalletRuntime | undefined = walletConfiguration ? (() => {
    const origin = validateWalletPolicyOrigin(walletConfiguration.origin);
    const chain = createWalletAuthorityChain({ rpc, manifest: walletConfiguration.manifest,
      utility: walletConfiguration.utility, limits: { totalTimeoutMs: 90_000 },
      checkpointStore: new PostgresSafe7579CheckpointStore(options.pool),
      onError: code => console.info(JSON.stringify({ service: "wallet", action: "authority_observe", outcome: "failed", code })),
      // The refresh verifies each tracked account about once a minute; the API's smart-account
      // service (created below) serves a payment's binding read from that state.
      onState: state => rememberVerifiedState?.(state),
      // The first observation after a signup's binding carries the creation worker's verification.
      carried: (manifestId, address) => rememberedVerifiedState?.(manifestId, address) });
    const login = new PostgresWalletLoginStore(options.pool, { origin, rpId: new URL(origin).hostname });
    const policy = new PostgresWalletPolicyStore(options.pool);
    const appGrants = new PostgresWalletAppGrantStore(options.pool);
    const handoff = new PostgresWalletHandoffStore(options.pool, {
      grantStore: appGrants, issuer: origin, audience: options.audience ?? options.config.publicOrigin,
      ...(options.wallet?.frameableAppOrigins ? { frameableAppOrigins: options.wallet.frameableAppOrigins } : {}),
    });
    const authority = new PostgresWalletAuthorityStore(options.pool);
    // One refresh is one hosted inspection (~25 s measured, 90 s budget); the lease outlives the attempt.
    const refreshQueue = new PostgresWalletAuthorityRefreshQueue(options.pool);
    const refresh = createWalletAuthorityRefresh({
      queue: refreshQueue,
      service: createWalletAuthorityService({ store: authority, chain }), attemptTimeoutMs: 100_000,
      onEvent: event => console.info(JSON.stringify({ service: "wallet", action: "authority_refresh", outcome: event })),
    });
    const networks = walletConfiguration.networksPayerKey ? (() => {
      const account = privateKeyToAccount(walletConfiguration.networksPayerKey);
      return createWalletNetworks({ enrollments: new PostgresWalletEnrollmentStore(options.pool), authority, store: new PostgresWalletNetworksStore(options.pool),
        provider: new RelayrProvider(), rpc, payer: { address: account.address, signTransaction: transaction => account.signTransaction(transaction) } });
    })() : undefined;
    return { origin, login, policy, handoff, appGrants, authority, refresh, refreshQueue, manifestId: walletConfiguration.manifest.id,
      activatePolicy: policy.activate.bind(policy), ...(networks ? { networks } : {}) };
  })() : undefined;
  const accountStore = new PostgresAccountStore(options.pool, wallet ? { walletRefresh: wallet.refresh } : {});
  const verifyContractOwner = createContractOwnerVerifier(
    rpc,
    contracts.data.chains.map((chain) => chain.id),
  );
  const auth = createRestAuth({
    store: accountStore,
    audience: options.audience ?? options.config.publicOrigin,
    verifyContractOwner,
  });
  const operations = createProtocolOperations(options.services);
  const protocol = createProtocolReadService({ rpc, catalog: contracts });
  const indexer = createIndexerReadService({
    ...(options.config.bendystrawMainnetUrl
      ? { mainnetUrl: options.config.bendystrawMainnetUrl }
      : {}),
    ...(options.config.bendystrawTestnetUrl
      ? { testnetUrl: options.config.bendystrawTestnetUrl }
      : {}),
  });
  const omnichain = createOmnichainService({ operations, indexer });
  const transactionStore = new PostgresTransactionStore(options.pool);
  const semanticVerifier = createProtocolSemanticVerifier({
    plans: options.services.plans,
  });
  const authority = { audience: auth.audience, verifyContractOwner };
  const sponsorship = new RelayrSponsorshipService({
    rpc,
    catalog: contracts,
    transactionStore,
    store: new PostgresSponsorshipStore(options.pool),
    semanticVerifier,
    authorizeDispatch: createSponsorshipDispatchAuthorizer(authority),
    policy: { enabled: true },
  });
  let userOperations: UserOperationService | undefined;
  const transactions = new TransactionService({
    store: transactionStore,
    rpc,
    semanticVerifier,
    authorizeDispatch: createTransactionDispatchAuthorizer(authority),
    resolveSmartAccount: (actor, id) =>
      smartAccounts.current(actor.accountId, id),
    smartAccountExecution: {
      chainIds: execution.providers.map((provider) => provider.chainId),
      sessionChainIds: execution.stacks
        .filter(
          (stack) =>
            stack.compilerStack &&
            execution.providers.some(
              (provider) => provider.chainId === stack.manifest.chainId,
            ),
        )
        .map((stack) => stack.manifest.chainId),
    },
    externalObservers: [
      {
        kind: "relayr",
        observePlanStep: (plan, index, bindingId, request) =>
          sponsorship.observePlanStep(plan, index, bindingId, request),
      },
      {
        kind: "erc4337",
        observePlanStep: (plan, index, bindingId, request) => {
          if (!userOperations)
            throw new RestError(
              503,
              "USER_OPERATIONS_UNAVAILABLE",
              "The operation verifier is unavailable.",
            );
          return userOperations.observePlanStep(
            plan,
            index,
            bindingId,
            request,
          );
        },
      },
    ],
  });
  const sessionStore = new PostgresSessionStore(options.pool);
  const installedVerifier = createInstalledSessionVerifier({
    rpc,
    findCompiled: (chainId, wallet, permissionId) =>
      sessionStore.findCompiled(chainId, wallet, permissionId),
  });
  const activeManifests = [...(options.smartAccountManifests ??
    execution.stacks.map((stack) => stack.manifest))];
  if (walletConfiguration) {
    const configured = activeManifests.findIndex(manifest => manifest.id === walletConfiguration.manifest.id);
    if (configured !== -1 && stable(activeManifests[configured]) !== stable(walletConfiguration.manifest))
      throw new RestError(500, "WALLET_MANIFEST_CONFLICT", "The wallet profile conflicts with a configured account manifest.");
    if (configured === -1) activeManifests.push(walletConfiguration.manifest);
    else activeManifests[configured] = walletConfiguration.manifest;
  }
  // Adding a guard must not invalidate an existing owner-only binding or hide an
  // already-submitted operation. Retain exact source pins without advertising
  // older manifests as the default wallet-creation choices.
  const retainedManifests = options.smartAccountManifests
    ? []
    : [
        ...(await readRestExecutionConfiguration({})).stacks.map(
          (stack) => stack.manifest,
        ),
        ...CHECKED_SMART_ACCOUNT_BINDING_MANIFESTS,
      ].filter(
        (manifest) =>
          !activeManifests.some((active) => active.id === manifest.id),
      );
  const manifests = [...activeManifests, ...retainedManifests];
  const factoryHistory = options.upstreams.has(8453) && execution.stacks.length && !options.smartAccountModuleInspectors && !options.smartAccountManifests
    ? new FactoryHistoryIndex(options.pool, rpc, await loadFactoryHistorySeed()) : undefined;
  // Shared by the legacy and the wallet inspector: creation is proven from the indexed factory
  // history (the hosted provider caps eth_getLogs at 500 blocks), and a complete inspection
  // measured ~85 serial reads, so the deadline leaves room for latency.
  const inspection = () => ({
    rpc, inspectSessions: installedVerifier.inspectAllAt,
    ...(factoryHistory ? {creationLogs: factoryHistory.creationLogs.bind(factoryHistory), maxLogRangeBlocks: 500} : {}),
    timeoutMs: 90_000,
    checkpointStore: new PostgresSafe7579CheckpointStore(options.pool),
  });
  let moduleInspectors =
    options.smartAccountModuleInspectors ??
    (options.smartAccountManifests
      ? []
      : execution.stacks.length
        ? [createSafe7579Inspector({ ...inspection(), utility: execution.stacks[0]!.utility })]
        : []);
  if (walletConfiguration) {
    const walletInspector = createSafe7579Inspector({ ...inspection(), utility: walletConfiguration.utility });
    const existing = moduleInspectors.find(inspector => inspector.id === walletInspector.id);
    // The same reviewed inspector supports both profiles, but each deployment retains its own
    // exact utility pin. Custom or legacy inspectors still handle their configured manifests.
    moduleInspectors = [...moduleInspectors.filter(inspector => inspector.id !== walletInspector.id), {
      id: walletInspector.id,
      inspect: input => {
        if (input.manifest.id === walletConfiguration.manifest.id
          && input.manifest.revision === walletConfiguration.manifest.revision) return walletInspector.inspect(input);
        if (existing) return existing.inspect(input);
        throw new RestError(503, "SMART_MODULE_INSPECTOR_UNAVAILABLE", "The account manifest has no configured module inspector.");
      },
    }];
  }
  const smartAccounts = createSmartAccountService({
    rpc,
    audience: auth.audience,
    registry: new PostgresSmartAccountRegistry(options.pool),
    onboarding: new PostgresOnboardingStore(options.pool),
    manifests: activeManifests,
    retainedManifests,
    moduleInspectors,
    // The switch that makes every pinned account read a full inspection again.
    advance: process.env.CENTER_ACCOUNT_STATE_ADVANCE !== "off",
  });
  rememberVerifiedState = state => smartAccounts.remember(state);
  rememberedVerifiedState = (manifestId, address) => smartAccounts.remembered(manifestId, address);
  const sessionTargets = createSessionTargetResolver({
    catalog: contracts,
    protocol,
    rpc,
    ...(options.smartAccountSessionTargets
      ? { targets: options.smartAccountSessionTargets }
      : {}),
    ...(options.smartAccountAssets
      ? { assets: options.smartAccountAssets }
      : {}),
  });
  const sessionReviewer = createSessionPolicyReviewer({
    currentBinding: (accountId, id, signal) =>
      smartAccounts.current(accountId, id, signal),
    getGrant: async (accountId, grantId) =>
      (await accountStore.listBots(accountId)).find(
        (grant) => grant.id === grantId,
      ) ?? null,
    targets: [],
    resolveTargets: (binding, input, signal) =>
      sessionTargets.resolve(binding, input, signal),
    assets: sessionTargets.assets,
    paymasters: options.smartAccountPaymasters ?? execution.paymasters,
  });
  const sessions = new SessionService({
    store: sessionStore,
    rpc,
    reviewer: sessionReviewer,
    verifier: installedVerifier,
    transactions,
    currentBinding: (accountId, id, signal) =>
      smartAccounts.current(accountId, id, signal),
    currentBindingAt: (accountId, id, evidence, signal) =>
      smartAccounts.currentAt(accountId, id, evidence, signal),
    compilerFor: (binding) => {
      const stack = execution.stacks.find(
        (s) =>
          s.manifest.id === binding.manifestId &&
          s.manifest.revision === binding.state.manifestRevision,
      );
      if (!stack)
        throw new RestError(
          503,
          "SESSION_STACK_UNAVAILABLE",
          "The binding has no configured source-verified session compiler.",
        );
      return stack.createCompiler();
    },
    authorizeOwnerPlan: createSessionPlanAuthorizer(authority),
    configuredChainIds: execution.stacks
      .filter(
        (stack) =>
          stack.compilerStack &&
          execution.providers.some(
            (provider) => provider.chainId === stack.manifest.chainId,
          ),
      )
      .map((stack) => stack.manifest.chainId),
  });
  const manifestFor = (id: string, revision: string) => {
    const manifest = manifests.find(
      (m) => m.id === id && m.revision === revision,
    );
    if (!manifest)
      throw new RestError(
        503,
        "SMART_MANIFEST_UNAVAILABLE",
        "The exact reviewed deployment manifest is unavailable.",
      );
    return manifest;
  };
  const walletPayments = wallet && walletConfiguration?.payments
    ? new PostgresWalletPaymentReviewStore(options.pool, { issuer: wallet.origin, audience: auth.audience,
      ...(options.wallet?.frameableAppOrigins ? { frameableAppOrigins: options.wallet.frameableAppOrigins } : {}),
      token: walletConfiguration.payments.token, directV6Terminal: walletConfiguration.payments.directV6Terminal,
      manifestFor: binding => manifestFor(binding.manifestId, binding.state.manifestRevision) })
    : undefined;
  if (wallet && walletPayments) wallet.payments = walletPayments;
  const operationProvider = new UserOperationProvider(execution.providers);
  userOperations = new UserOperationService({
    rpc,
    ...(walletConfiguration?.payments ? { v6UsdcPayment: { chainId: 8453 as const,
      token: walletConfiguration.payments.token, directV6Terminal: walletConfiguration.payments.directV6Terminal } } : {}),
    provider: operationProvider,
    ...(execution.sponsorRoutes ? {sponsorRoutes: execution.sponsorRoutes} : {}),
    policies: execution.policies,
    store: new PostgresUserOperationStore(options.pool),
    transactionStore,
    transactions,
    sessions,
    currentBinding: (accountId, id, signal) =>
      smartAccounts.current(accountId, id, signal),
    currentBindingAt: (accountId, id, evidence, signal) =>
      smartAccounts.currentAt(accountId, id, evidence, signal),
    manifestFor: (binding) =>
      manifestFor(binding.manifestId, binding.state.manifestRevision),
    manifestForPlan: (plan) => {
      const manifest = manifests.find(
        (m) =>
          m.chainId === plan.smartAccount?.chainId &&
          m.revision === plan.smartAccount.manifestRevision,
      );
      if (!manifest)
        throw new RestError(
          503,
          "SMART_MANIFEST_UNAVAILABLE",
          "The plan's exact reviewed account manifest is unavailable.",
        );
      return manifest;
    },
    verifyHistoricalAccount: async (plan, evidence, signal) => {
      const manifest = manifests.find(
        (m) =>
          m.chainId === plan.smartAccount?.chainId &&
          m.revision === plan.smartAccount.manifestRevision,
      );
      if (!manifest)
        throw new RestError(
          503,
          "SMART_MANIFEST_UNAVAILABLE",
          "The historical account manifest is unavailable.",
        );
      // Opted in: the state at the receipt block may be carried from the last verification.
      const state = await smartAccounts.inspect(
        { manifestId: manifest.id, address: plan.draft.account },
        signal,
        evidence,
        true,
      );
      if (state.stateHash !== plan.smartAccount!.stateHash)
        throw new RestError(
          409,
          "SMART_ACCOUNT_CHANGED",
          "The historical owner/module layout differs from the approved plan.",
        );
    },
    // A send the bundler refuses after a carried admission: the next read inspects in full.
    forgetAccountState: (plan) => {
      const manifest = manifests.find((m) => m.chainId === plan.smartAccount?.chainId && m.revision === plan.smartAccount.manifestRevision);
      if (manifest) smartAccounts.forget(manifest.id, plan.draft.account);
    },
    authorizeRequest: createUserOperationRequestAuthorizer(authority),
    semanticVerifier,
  });
  // The passkey approval sends the operation itself; the app's hand-back then observes it.
  walletPayments?.attachSubmission((submission) => userOperations!.submitApproved(submission));
  walletPayments?.attachSpeculation((actor, operationId) => userOperations!.speculate(actor, operationId));
  const openapi = buildRestOpenApi({
    ...(options.surface ? { surface: options.surface } : {}),
    contracts,
    indexer,
    operations,
    publicOrigin: auth.audience,
  });
  const app = createRestApp({
    ...(options.surface ? { surface: options.surface } : {}),
    auth,
    quota: options.store,
    contracts,
    protocol,
    indexer,
    operations,
    transactions,
    sponsorship,
    smartAccounts,
    sessionReviewer,
    sessions,
    userOperations,
    ...(walletPayments ? { walletPayments } : {}),
    omnichain,
    openapi,
  });
  const assets = await readRestAssets();
  if (options.walletSignup && !wallet) throw new RestError(503, 'WALLET_SIGNUP_UNAVAILABLE', 'Signup requires the dedicated wallet host.');
  if (wallet && options.walletSignup) wallet.signup = await options.walletSignup({ pool: options.pool, rpc: backendRpc, wallet, audience: auth.audience, smart: smartAccounts });
  if (options.walletRecovery && !wallet) throw new RestError(503, 'WALLET_RECOVERY_UNAVAILABLE', 'Recovery requires the dedicated wallet host.');
  if (wallet && options.walletRecovery) wallet.recovery = await options.walletRecovery({ pool: options.pool, rpc: backendRpc, wallet, audience: auth.audience, smart: smartAccounts });
  if (options.walletDevices && !wallet) throw new RestError(503, 'WALLET_DEVICE_UNAVAILABLE', 'Adding devices requires the dedicated wallet host.');
  if (wallet && options.walletDevices) wallet.devices = await options.walletDevices({ pool: options.pool, rpc: backendRpc, wallet, audience: auth.audience, smart: smartAccounts });
  const walletSite = wallet ? createWalletSite({ origin: wallet.origin, audience: auth.audience, ...(options.wallet?.legacyOrigins ? { legacyOrigins: options.wallet.legacyOrigins } : {}),
    ...(options.wallet?.frameableAppOrigins ? { frameableAppOrigins: options.wallet.frameableAppOrigins } : {}),
    ...(options.wallet?.basePath !== undefined ? { basePath: options.wallet.basePath } : {}),
    browserScript: assets.walletScript, login: wallet.login, policy: wallet.policy,
    handoff: wallet.handoff, refresh: wallet.refresh,
    ...(walletPayments ? { payments: walletPayments, paymentBrowserScript: assets.walletPaymentScript } : {}),
    ...(wallet.signup ? { signup: wallet.signup, signupBrowserScript: assets.walletSignupScript } : {}),
    ...(wallet.recovery ? { recovery: wallet.recovery, recoveryBrowserScript: assets.walletRecoveryScript } : {}),
    ...(wallet.devices ? { devices: wallet.devices, deviceBrowserScript: assets.walletDeviceScript } : {}),
    ...(wallet.networks ? { networks: wallet.networks } : {}),
    ...(walletConfiguration?.onramp ? { onramp: createWalletOnramp({ ...walletConfiguration.onramp, origin: wallet.origin }) } : {}),
    ...(options.wallet?.applePayDomainFile ? { applePayDomainFile: options.wallet.applePayDomainFile } : {}),
    onEvent: event => console.info(JSON.stringify({ service: "wallet", ...event })),
  }) : undefined;
  if (options.startMaintenance !== false) wallet?.signup?.start();
  if (options.startMaintenance !== false) wallet?.recovery?.start();
  if (options.startMaintenance !== false) wallet?.devices?.start();
  const metrics = options.metrics ?? new Metrics();
  if (options.startMaintenance !== false) metrics.startRestRecovery();
  let stopped = false;
  let maintenance: Promise<void> | undefined;
  // Every pay route of the last day's plans is read ahead of its next quote, at boot and then every
  // ten minutes once past half its life, so a project paid daily never waits on a cold read.
  let routesWarmedAt = 0;
  const warmRoutes = async () => {
    routesWarmedAt = Date.now();
    let warmed = 0, failed = 0;
    try {
      for (const target of await transactions.recentPayTargets(Date.now() - 86_400_000, 64)) {
        if (stopped) break;
        try { if (await options.services.payments.warm(target.project as ProjectRef, target.token)) warmed++; } catch { failed++; }
      }
    } catch {
      // A warm-up that cannot list its targets is not a fault of the request path; the next tick tries again.
      console.info(JSON.stringify({ service: "payments", action: "routes_warm", outcome: "unavailable" }));
      return;
    }
    if (warmed || failed) console.info(JSON.stringify({ service: "payments", action: "routes_warm", warmed, failed }));
  };
  // A fresh process serves its first binding reads from nothing: the accounts the refresh queue
  // still tracks (the recently active ones) are inspected once at boot, two at a time, so a
  // customer arriving after a deploy is served from a kept state like everyone else.
  const warmAccounts = async () => {
    if (!wallet) return;
    let accounts: string[];
    try { accounts = await wallet.refreshQueue.interested(16); } catch { return; }
    let warmed = 0, failed = 0;
    const next = async () => {
      for (let account = accounts.shift(); account && !stopped; account = accounts.shift()) {
        try { await smartAccounts.inspect({ manifestId: wallet.manifestId, address: account.slice("eip155:8453:".length) as Address }); warmed++; }
        catch { failed++; }
      }
    };
    await Promise.all([next(), next()]);
    if (warmed || failed) console.info(JSON.stringify({ service: "smart-accounts", action: "accounts_warm", warmed, failed }));
  };
  // A connection idle longer than the keep-alive is a new handshake for the next payment: a small
  // read to the chain RPC and the bundler every maintenance tick keeps one open to each.
  const keepUpstreamsWarm = async () => {
    const signal = AbortSignal.timeout(10_000);
    await Promise.allSettled([rpc.request(8453, "eth_chainId", [], signal), operationProvider.gasPrice(8453, signal)]);
  };
  const run = () => {
    if (stopped || maintenance) return;
    maintenance = (async () => {
      await keepUpstreamsWarm();
      if (Date.now() - routesWarmedAt >= 600_000) await warmRoutes();
      await metrics.observeRestRecovery("nonce_cleanup", async () => {
        await accountStore.cleanupExpiredNonces(Math.floor(Date.now() / 1000), 1000);
        return { failures: 0 };
      });
      await metrics.observeRestRecovery("rate_limit_cleanup", async () => {
        await options.store.cleanupRateLimits();
        return { failures: 0 };
      });
      if (!stopped) await metrics.observeRestRecovery("transactions", async () => {
        const result = await transactions.recoverPending({ limit: 5 });
        return { oldestPendingAt: result.oldestPendingAt, failures: result.reconciled.filter((item) =>
          item !== null && typeof item === "object" && "status" in item &&
          item.status === "reconciliation-unavailable").length };
      });
      if (!stopped) await metrics.observeRestRecovery("user_operations", async () => {
        const result = await userOperations!.recoverPending(5);
        return { oldestPendingAt: result.oldestPendingAt,
          failures: result.items.filter((item) => item.state === "verification-unavailable").length };
      });
      if (!stopped && wallet) {
        await wallet.login.cleanup(250);
        if (!stopped) await wallet.handoff.cleanup(250);
        if (!stopped) await wallet.appGrants.cleanup(250);
        if (!stopped && walletPayments) await walletPayments.cleanup(250);
        if (!stopped) console.info(JSON.stringify({ service: "wallet", action: "authority_refresh_queue", ...await wallet.refresh.stats() }));
        if (!stopped) console.info(JSON.stringify({ service: "db", action: "db_pool", total: options.pool.totalCount, idle: options.pool.idleCount,
          waiting: options.pool.waitingCount, connects: (options.pool as Partial<ReturnType<typeof createPool>>).connectsSinceLast?.() ?? null }));
      }
    })()
      .catch(() => {
        // Do not log signed bytes, profile contents, or provider credentials.
        console.error(
          JSON.stringify({
            level: "error",
            service: "rest",
            code: "MAINTENANCE_UNAVAILABLE",
          }),
        );
      })
      .finally(() => {
        maintenance = undefined;
      });
  };
  const factoryTimer = options.startMaintenance === false || !factoryHistory ? undefined : setInterval(() => {
    void factoryHistory.sync().catch(() => console.error(JSON.stringify({level:"error",service:"rest",code:"FACTORY_HISTORY_RETRY"})));
  }, 30000);
  factoryTimer?.unref();
  const timer =
    options.startMaintenance === false ? undefined : setInterval(run, 30_000);
  timer?.unref();
  if (options.startMaintenance !== false) void warmRoutes();
  if (options.startMaintenance !== false) void warmAccounts();
  if (options.startMaintenance !== false) wallet?.refresh.start();
  return {
    site: {
      ...(options.surface ? { surface: options.surface } : {}),
      ...(walletSite ? { wallet: walletSite, walletOrigins: [wallet!.origin, ...(options.wallet?.legacyOrigins ?? [])] } : {}),
      app,
      audience: auth.audience,
      docsHtml: apiDocsPage(openapi, options.surface),
      docsCss: apiDocsCss,
      ...assets,
    },
    transactions,
    rpc,
    catalog: contracts,
    ...(wallet ? { wallet } : {}),
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      if (factoryTimer) clearInterval(factoryTimer);
      shutdownSignal.abort();
      await wallet?.refresh.stop();
      await wallet?.signup?.stop();
      await wallet?.recovery?.stop();
      await wallet?.devices?.stop();
      await factoryHistory?.stop();
      if (maintenance) await maintenance;
    },
  };
}
