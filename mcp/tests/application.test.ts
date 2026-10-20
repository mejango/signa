import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NATIVE_TOKEN } from '@bananapus/nana-sdk-core';
import { buildPayTx } from '@bananapus/nana-sdk-core/v6';
import type { JBCenterSearchPage } from '@bananapus/nana-sdk-core/jbcenter';
import { encodeFunctionData, type Hex, type PublicClient } from 'viem';
import type { CenterIntent } from '../src/adapters/jbcenter.js';
import { createServices, type Services } from '../src/app.js';
import { createProtocolOperations } from '../src/application/operations.js';
import { loadConfig } from '../src/config.js';
import { consumeRequest } from '../src/domain/context.js';
import { DomainError } from '../src/domain/errors.js';
import type { PlanDraft } from '../src/domain/types.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const TERMINAL = '0x2222222222222222222222222222222222222222';
const INTENT_ID = 'b0a555ff-4444-4111-aaaa-333333333333';
const BLOCK_HASH = `0x${'ab'.repeat(32)}` as Hex;
const PROJECT = { chainId: 8453 as const, projectId: '9007199254740993', version: 6 as const };
const PAY_INPUT = {
  project: { chainId: PROJECT.chainId, projectId: PROJECT.projectId },
  account: ACCOUNT,
  beneficiary: ACCOUNT,
  token: NATIVE_TOKEN,
  amount: '9007199254740995',
};

function paymentDraft(): PlanDraft {
  const request = buildPayTx({
    chainId: PROJECT.chainId,
    terminal: TERMINAL,
    projectId: BigInt(PROJECT.projectId),
    token: NATIVE_TOKEN,
    amount: BigInt(PAY_INPUT.amount),
    beneficiary: ACCOUNT,
    minReturnedTokens: 99n,
  });
  return {
    operation: 'pay',
    account: ACCOUNT,
    project: { ...PROJECT },
    calls: [
      {
        chainId: PROJECT.chainId,
        to: request.address,
        data: encodeFunctionData(request),
        value: PAY_INPUT.amount,
        label: 'Pay the reviewed project',
        decoded: { functionName: 'pay', args: request.args },
        dependsOn: [],
      },
    ],
    evidence: [
      {
        chainId: PROJECT.chainId,
        blockNumber: '100',
        blockHash: BLOCK_HASH,
        timestamp: '123',
        source: 'rpc',
      },
    ],
    summary: { beneficiaryTokenMinimum: '99' },
    warnings: [],
  };
}

function onchainProject(): Awaited<ReturnType<Services['projects']['getProject']>> {
  const unavailable = {
    status: 'unknown' as const,
    error: { code: 'TEST_UNAVAILABLE', message: 'Read unavailable in fixture.', retryable: false },
  };
  return {
    project: { ...PROJECT },
    evidence: paymentDraft().evidence,
    owner: { status: 'known', value: ACCOUNT },
    controller: unavailable,
    canonicalController: unavailable,
    metadataUri: unavailable,
    rulesets: { current: unavailable, upcoming: unavailable, latestQueued: unavailable },
    token: unavailable,
    supply: {
      totalIncludingPendingReserved: unavailable,
      pendingReserved: unavailable,
      decimals: 18,
      scope: 'localChain',
    },
    reservedTokenSplits: unavailable,
    splitPercentDenominator: '1000000000',
    terminals: unavailable,
    coverage: {
      balances: 'No terminal balances were read in this fixture.',
      valuation: 'No portfolio valuation was inferred.',
      rulesets: 'Rulesets are unavailable.',
      metadata: 'Project metadata was not fetched.',
    },
  };
}

function searchIntent(version: string): JBCenterSearchPage['items'][number] {
  return {
    name: `Version ${version} project`,
    description: 'Publisher-authored untrusted content.',
    tagline: null,
    tags: [],
    logoUri: null,
    owner: null,
    source: 'jbcenter',
    status: 'undeployed',
    intentId: INTENT_ID,
    contentHash: BLOCK_HASH,
    format: 'juicebox.money/v1',
    deploymentVersion: version,
    chainIds: [8453],
    publisher: ACCOUNT,
    createdAt: '2026-09-07T00:00:00Z',
  };
}

function intent(version: string): CenterIntent {
  const {
    intentId,
    source: _source,
    format,
    deploymentVersion,
    chainIds,
    ...metadata
  } = searchIntent(version);
  return {
    ...metadata,
    id: intentId,
    envelope: {
      format,
      deploymentVersion,
      chainIds,
      deploymentCalls: [{ chainId: 8453, to: TERMINAL, data: '0x12345678' }],
      jb: { name: metadata.name, chains: [8453] },
    },
    // The mocked Center service represents its verified read boundary. Signature
    // verification itself is covered against signed fixtures in adapter tests.
    signature: `0x${'01'.repeat(65)}`,
    deployments: [],
    deploys: [],
  };
}

describe('transport-independent protocol operations', () => {
  let services: Services;
  let operations: ReturnType<typeof createProtocolOperations>;

  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('Application operation tests must not use the network.');
      }),
    );
    services = createServices(
      loadConfig({ PLAN_SECRET: 'application-test-only-secret-'.repeat(3) }),
    );
    operations = createProtocolOperations(services);
  });

  afterEach(() => {
    expect(fetch).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('preserves the complete public catalog and input schemas without MCP-prefixed operation IDs', () => {
    const catalog = JSON.parse(
      readFileSync(new URL('../data/mcp-tool-catalog.json', import.meta.url), 'utf8'),
    ) as { tools: { name: string; inputSchema: Record<string, unknown> }[] };
    const descriptors = operations.list();
    expect(descriptors.map(({ id }) => id).sort()).toEqual(
      catalog.tools.map(({ name }) => name.replace(/^jb_/, '')).sort(),
    );
    expect(new Set(descriptors.map(({ id }) => id)).size).toBe(descriptors.length);
    for (const { name, inputSchema } of catalog.tools) {
      const descriptor = operations.get(name.replace(/^jb_/, ''));
      expect(descriptor?.inputJsonSchema).toEqual(inputSchema);
      expect(descriptor?.schema).toBeDefined();
      expect(descriptor?.handler).toBeTypeOf('function');
    }
  });

  it('distinguishes transaction preparation, local preparation, reference reads and public metadata publication', () => {
    expect(operations.get('prepare_pay')).toMatchObject({ kind: 'prepare', transaction: true });
    expect(operations.get('quote_pay')).toMatchObject({ kind: 'read', transaction: false });
    expect(operations.get('prepare_intent')).toMatchObject({ kind: 'prepare', transaction: false });
    expect(operations.get('prepare_project_metadata')).toMatchObject({
      kind: 'prepare',
      transaction: false,
    });
    for (const id of ['publish_intent', 'deploy_intent']) {
      expect(operations.get(id)).toMatchObject({
        kind: 'center-write',
        sources: ['center'],
        transaction: false,
        effects: { externalMutation: true, idempotent: true },
      });
    }
    for (const id of ['pin_project_logo', 'pin_project_metadata']) {
      expect(operations.get(id)).toMatchObject({
        kind: 'metadata-write',
        sources: ['publication'],
        transaction: false,
        effects: { externalMutation: true, idempotent: false },
      });
    }
    for (const id of ['get_reference', 'get_contract', 'plan_integration', 'list_capabilities']) {
      expect(operations.get(id)).toMatchObject({ kind: 'reference', transaction: false });
    }
  });

  it.each(['pin_project_logo', 'pin_project_metadata'])(
    'rejects onchain source selection before invoking %s',
    async (id) => {
      const logo = vi.spyOn(services.metadata, 'pinLogo');
      const metadata = vi.spyOn(services.metadata, 'pin');
      await expect(operations.execute(id, {}, { source: 'onchain' })).rejects.toMatchObject({
        code: 'SOURCE_NOT_SUPPORTED',
      });
      expect(logo).not.toHaveBeenCalled();
      expect(metadata).not.toHaveBeenCalled();
    },
  );

  it('filters Center search to V6 without rewriting the upstream cursor or claiming a V6 count', async () => {
    vi.spyOn(services.bendystraw, 'searchProjects').mockResolvedValue({
      items: [],
      totalCount: 0,
      pageInfo: { endCursor: null, hasNextPage: false },
    });
    const v6 = searchIntent('6');
    const center = vi.spyOn(services.center, 'search').mockResolvedValue({
      items: [searchIntent('4'), v6, searchIntent('v6')],
      totalCount: 200,
      nextCursor: '23',
    });
    const result = await operations.execute('search_projects', {
      query: 'Example',
      limit: 3,
      intentCursor: '20',
    });
    expect(center).toHaveBeenCalledWith({ query: 'Example', limit: 3, cursor: '20' });
    expect(result).toMatchObject({
      undeployed: {
        status: 'known',
        value: {
          items: [v6],
          totalCount: null,
          nextCursor: '23',
          pagination: {
            cursorScope: 'upstream-all-deployment-versions',
            totalCountStatus: 'unknown-after-version-filter',
            upstreamTotalCount: 200,
            upstreamPageItemCount: 3,
            excludedNonV6ItemCount: 2,
            returnedV6ItemCount: 1,
          },
        },
      },
    });
  });

  it('keeps an empty filtered page traversable and an unavailable source explicitly unknown', async () => {
    vi.spyOn(services.bendystraw, 'searchProjects').mockRejectedValue(
      new DomainError('NOT_CONFIGURED', 'No indexer is configured.'),
    );
    vi.spyOn(services.center, 'search').mockResolvedValue({
      items: [searchIntent('4')],
      totalCount: 3,
      nextCursor: '1',
    });
    expect(await operations.execute('search_projects', {})).toMatchObject({
      deployed: { status: 'unknown', error: { code: 'NOT_CONFIGURED' } },
      undeployed: {
        status: 'known',
        value: { items: [], totalCount: null, nextCursor: '1' },
      },
    });
  });

  it('rejects a verified Center intent whose deployment version is not exactly 6', async () => {
    const getIntent = vi.spyOn(services.center, 'getIntent').mockResolvedValue(intent('4'));
    await expect(operations.execute('get_intent', { id: INTENT_ID })).rejects.toMatchObject({
      code: 'UNSUPPORTED_VERSION',
    });
    const v6 = intent('6');
    getIntent.mockResolvedValue(v6);
    expect(await operations.execute('get_intent', { id: INTENT_ID })).toEqual(v6);
  });

  it('maps a Center publish-limit refusal to a fixed sentence and code, and leaves other refusals as the bounded generic', async () => {
    const publishInput = {
      format: 'juicebox.money/v1',
      deploymentVersion: '6' as const,
      chainIds: [8453],
      deploymentCalls: [{ chainId: 8453, to: TERMINAL, data: '0x12345678' }],
      jb: { name: 'Test', chains: [8453] },
      publisher: ACCOUNT,
      signature: `0x${'01'.repeat(65)}`,
    };
    const publishIntent = vi.spyOn(services.center, 'publishIntent');
    publishIntent.mockRejectedValueOnce(
      new DomainError('UPSTREAM_HTTP_ERROR', 'The upstream returned HTTP 429.', {
        retryable: true,
        details: { status: 429, code: 'publish_limit' },
      }),
    );
    await expect(operations.execute('publish_intent', publishInput)).rejects.toMatchObject({
      code: 'PUBLISH_LIMIT',
      message:
        "Center's publish limit is reached for this publisher or for the shared assistant budget. Try again later.",
    });
    publishIntent.mockRejectedValueOnce(
      new DomainError('UPSTREAM_HTTP_ERROR', 'The upstream returned HTTP 500.', {
        retryable: true,
        details: { status: 500 },
      }),
    );
    await expect(operations.execute('publish_intent', publishInput)).rejects.toMatchObject({
      code: 'UPSTREAM_HTTP_ERROR',
    });
    expect(publishIntent).toHaveBeenCalledTimes(2);
  });

  it('rejects unsupported versions and unknown nested or top-level fields before typed service calls', async () => {
    const quote = vi.spyOn(services.payments, 'quotePay');
    const invalidInputs = [
      { ...PAY_INPUT, project: { ...PAY_INPUT.project, version: 4 } },
      { ...PAY_INPUT, project: { ...PAY_INPUT.project, rpcUrl: 'https://invalid.example' } },
      { ...PAY_INPUT, rpcUrl: 'https://invalid.example' },
    ];
    for (const input of invalidInputs) {
      await expect(operations.execute('quote_pay', input)).rejects.toMatchObject({
        name: 'ZodError',
      });
    }
    expect(quote).not.toHaveBeenCalled();
  });

  it.each(['1e18', '0', '-1', 9007199254740992, (1n << 256n).toString()])(
    'rejects malformed or out-of-range transaction amount %s before quoting',
    async (amount) => {
      const quote = vi.spyOn(services.payments, 'quotePay');
      await expect(operations.execute('quote_pay', { ...PAY_INPUT, amount })).rejects.toMatchObject(
        {
          name: 'ZodError',
        },
      );
      expect(quote).not.toHaveBeenCalled();
    },
  );

  it('preserves uint256 identifiers and amounts and applies the same V6 and slippage defaults', async () => {
    const capture = new DomainError('TEST_CAPTURE', 'Only record the validated service input.');
    const quote = vi.spyOn(services.payments, 'quotePay').mockRejectedValue(capture);
    await expect(operations.execute('quote_pay', PAY_INPUT)).rejects.toBe(capture);
    expect(quote).toHaveBeenCalledWith({ ...PAY_INPUT, project: PROJECT, slippageBps: 100 });
    expect(quote.mock.calls[0]?.[0].amount).toBe('9007199254740995');
    expect(quote.mock.calls[0]?.[0].project.projectId).toBe('9007199254740993');
  });

  it('preserves testnet inference instead of injecting an incompatible mainnet default', async () => {
    const capture = new DomainError('TEST_CAPTURE', 'Only record the validated indexer input.');
    const account = vi.spyOn(services.bendystraw, 'getAccount').mockRejectedValue(capture);
    await expect(
      operations.execute('get_account', { address: ACCOUNT, chainId: 84532 }),
    ).rejects.toBe(capture);
    expect(account.mock.calls[0]?.[0]).toMatchObject({ chainId: 84532, limit: 20 });
    expect(account.mock.calls[0]?.[0].network).toBeUndefined();
  });

  it('reads only on-chain project state when explicitly selected and never falls back to the indexer', async () => {
    const state = onchainProject();
    const onchain = vi.spyOn(services.projects, 'getProject').mockResolvedValue(state);
    const indexed = vi.spyOn(services.bendystraw, 'getProject');
    expect(
      await operations.execute(
        'get_project',
        { project: PAY_INPUT.project },
        { source: 'onchain' },
      ),
    ).toEqual({ source: 'onchain', onchain: state });
    expect(onchain).toHaveBeenCalledWith(PROJECT);
    expect(indexed).not.toHaveBeenCalled();

    const unavailable = new DomainError('UPSTREAM_FAILURE', 'The pinned state is unavailable.');
    onchain.mockRejectedValue(unavailable);
    await expect(
      operations.execute('get_project', { project: PROJECT }, { source: 'onchain' }),
    ).rejects.toBe(unavailable);
    expect(indexed).not.toHaveBeenCalled();
  });

  it('reads only indexed project data and keeps missing and unavailable observations distinct', async () => {
    const project = { chainId: 8453 as const, projectId: '1' };
    const indexed = vi.spyOn(services.bendystraw, 'getProject').mockResolvedValue(null);
    const onchain = vi.spyOn(services.projects, 'getProject');
    const result = await operations.execute('get_project', { project }, { source: 'indexer' });
    expect(result).toMatchObject({ source: 'indexer', indexed: { status: 'known', value: null } });
    expect(result).toHaveProperty('indexedSemantics');
    expect(result).not.toHaveProperty('onchain');
    expect(indexed).toHaveBeenCalledWith({ ...project, version: 6 });
    expect(onchain).not.toHaveBeenCalled();

    indexed.mockRejectedValue(new DomainError('NOT_CONFIGURED', 'No indexer is configured.'));
    expect(
      await operations.execute('get_project', { project }, { source: 'indexer' }),
    ).toMatchObject({
      source: 'indexer',
      indexed: { status: 'unknown', error: { code: 'NOT_CONFIGURED' } },
    });
    expect(onchain).not.toHaveBeenCalled();
  });

  it('searches only deployed indexed projects when requested without querying Center intents', async () => {
    const page = { items: [], totalCount: 0, pageInfo: { endCursor: null, hasNextPage: false } };
    const search = vi.spyOn(services.bendystraw, 'searchProjects').mockResolvedValue(page);
    const center = vi.spyOn(services.center, 'search');
    const result = await operations.execute(
      'search_projects',
      { query: 'V6 project', chainId: 84532, projectCursor: 'indexer-cursor', limit: 2 },
      { source: 'indexer' },
    );
    expect(result).toMatchObject({ source: 'indexer', deployed: { status: 'known', value: page } });
    expect(result).toHaveProperty('semantics');
    expect(result).toHaveProperty('coverage');
    expect(result).not.toHaveProperty('undeployed');
    expect(search).toHaveBeenCalledWith({
      query: 'V6 project',
      chainId: 84532,
      network: undefined,
      cursor: 'indexer-cursor',
      limit: 2,
    });
    expect(center).not.toHaveBeenCalled();
  });

  it('accepts an explicit matching source for fixed indexer and live transaction operations', async () => {
    const page = {
      items: [],
      totalCount: 0,
      pageInfo: { endCursor: null, hasNextPage: false },
      coverage: 'No indexed participants in this fixture.',
    };
    const account = vi.spyOn(services.bendystraw, 'getAccount').mockResolvedValue(page);
    expect(
      await operations.execute('get_account', { address: ACCOUNT }, { source: 'indexer' }),
    ).toMatchObject({ indexed: page });
    expect(account).toHaveBeenCalledOnce();

    const draft = paymentDraft();
    const prepare = vi.spyOn(services.payments, 'preparePay').mockResolvedValue(draft);
    expect(await operations.prepare('prepare_pay', PAY_INPUT, { source: 'onchain' })).toMatchObject(
      {
        operation: 'pay',
        calls: [{ data: draft.calls[0]!.data, value: draft.calls[0]!.value }],
      },
    );
    expect(prepare).toHaveBeenCalledOnce();
  });

  it('rejects unsupported sources before invoking any backend or transaction builder', async () => {
    const account = vi.spyOn(services.bendystraw, 'getAccount');
    const quote = vi.spyOn(services.payments, 'quotePay');
    const search = vi.spyOn(services.bendystraw, 'searchProjects');
    const center = vi.spyOn(services.center, 'search');
    const prepare = vi.spyOn(services.payments, 'preparePay');
    await expect(
      operations.execute('get_account', { address: ACCOUNT }, { source: 'onchain' }),
    ).rejects.toMatchObject({ code: 'SOURCE_NOT_SUPPORTED' });
    await expect(
      operations.execute('quote_pay', PAY_INPUT, { source: 'indexer' }),
    ).rejects.toMatchObject({
      code: 'SOURCE_NOT_SUPPORTED',
    });
    await expect(
      operations.execute('search_projects', {}, { source: 'onchain' }),
    ).rejects.toMatchObject({
      code: 'SOURCE_NOT_SUPPORTED',
    });
    await expect(
      operations.prepare('prepare_pay', PAY_INPUT, { source: 'indexer' }),
    ).rejects.toMatchObject({
      code: 'SOURCE_NOT_SUPPORTED',
    });
    for (const backend of [account, quote, search, center, prepare])
      expect(backend).not.toHaveBeenCalled();
  });

  it('rejects invalid runtime source keys before prototype lookup or service work', async () => {
    const onchain = vi.spyOn(services.projects, 'getProject');
    const indexed = vi.spyOn(services.bendystraw, 'getProject');
    const prepare = vi.spyOn(services.payments, 'preparePay');
    for (const source of ['toString', '__proto__', 'constructor']) {
      // Untrusted transports can supply runtime values outside the TypeScript union.
      await expect(
        operations.execute('get_project', { project: PROJECT }, { source: source as never }),
      ).rejects.toMatchObject({ code: 'SOURCE_NOT_SUPPORTED' });
      await expect(
        operations.prepare('prepare_pay', PAY_INPUT, { source: source as never }),
      ).rejects.toMatchObject({ code: 'SOURCE_NOT_SUPPORTED' });
    }
    expect(onchain).not.toHaveBeenCalled();
    expect(indexed).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it('returns a validated transaction draft without sealing it or simulating before the caller chooses execution', async () => {
    const draft = paymentDraft();
    const prepare = vi.spyOn(services.payments, 'preparePay').mockResolvedValue(draft);
    const seal = vi.spyOn(services.plans, 'seal');
    const simulate = vi.spyOn(services.plans, 'simulate');
    const result = await operations.prepare('prepare_pay', PAY_INPUT);
    expect(prepare).toHaveBeenCalledWith({ ...PAY_INPUT, project: PROJECT, slippageBps: 100 });
    expect(result).toMatchObject({
      operation: 'pay',
      account: ACCOUNT,
      project: PROJECT,
      calls: [{ data: draft.calls[0]!.data, value: PAY_INPUT.amount, dependsOn: [] }],
    });
    expect(result).not.toHaveProperty('token');
    expect(result).not.toHaveProperty('preflight');
    expect(seal).not.toHaveBeenCalled();
    expect(simulate).not.toHaveBeenCalled();
  });

  it.each(['negative value', 'forward dependency', 'missing chain evidence'])(
    'validates service-produced drafts before returning them: %s',
    async (problem) => {
      const draft = paymentDraft();
      if (problem === 'negative value') draft.calls[0]!.value = '-1';
      if (problem === 'forward dependency') draft.calls[0]!.dependsOn = [0];
      if (problem === 'missing chain evidence') draft.evidence[0]!.chainId = 1;
      vi.spyOn(services.payments, 'preparePay').mockResolvedValue(draft);
      const simulate = vi.spyOn(services.plans, 'simulate');
      await expect(operations.prepare('prepare_pay', PAY_INPUT)).rejects.toMatchObject({
        code: 'INVALID_PLAN',
      });
      expect(simulate).not.toHaveBeenCalled();
    },
  );

  it('keeps execute preparation compatible with authentic plan inspection and exact preflight calldata', async () => {
    const draft = paymentDraft();
    vi.spyOn(services.payments, 'preparePay').mockResolvedValue(draft);
    const call = vi.fn(async () => ({ data: '0x' as Hex }));
    const estimateGas = vi.fn(async () => 21000n);
    const client = {
      getChainId: async () => PROJECT.chainId,
      call,
      estimateGas,
      getBlock: async () => ({ hash: BLOCK_HASH }),
    } as unknown as PublicClient;
    vi.spyOn(services.rpc, 'snapshot').mockResolvedValue({
      client,
      evidence: draft.evidence[0]!,
    });
    const prepared = (await operations.execute('prepare_pay', PAY_INPUT)) as {
      token: string;
      preflight: unknown;
    };
    expect(prepared).toMatchObject({
      preflight: { status: 'known', value: { status: 'simulated' } },
      execution: { mode: 'external-wallet', broadcastByServer: false, steps: 1 },
    });
    const expectedCall = {
      account: ACCOUNT,
      to: TERMINAL,
      data: draft.calls[0]!.data,
      value: BigInt(PAY_INPUT.amount),
      blockNumber: 100n,
    };
    expect(call).toHaveBeenCalledWith(expect.objectContaining(expectedCall));
    expect(estimateGas).toHaveBeenCalledWith(expect.objectContaining(expectedCall));
    expect(await operations.execute('inspect_plan', { token: prepared.token })).toMatchObject({
      draft: { calls: [{ data: draft.calls[0]!.data, value: PAY_INPUT.amount }] },
    });
    await expect(
      operations.execute('inspect_plan', { token: `${prepared.token.slice(0, -2)}xx` }),
    ).rejects.toMatchObject({ code: 'INVALID_PLAN_TOKEN' });
  });

  it('rejects an already cancelled request before any service or adapter work', async () => {
    const adapter = vi.fn();
    const account = vi.spyOn(services.bendystraw, 'getAccount').mockImplementation(async () => {
      consumeRequest();
      adapter();
      throw new Error('Cancelled work must not reach the adapter.');
    });
    await expect(
      operations.execute('get_account', { address: ACCOUNT }, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(account).not.toHaveBeenCalled();
    expect(adapter).not.toHaveBeenCalled();
  });

  it('propagates cancellation during service work before the next upstream request', async () => {
    const controller = new AbortController();
    const adapter = vi.fn();
    vi.spyOn(services.bendystraw, 'getAccount').mockImplementation(async () => {
      expect(consumeRequest()).toBe(controller.signal);
      adapter();
      controller.abort();
      consumeRequest();
      adapter();
      throw new Error('The second adapter call must be prevented.');
    });
    await expect(
      operations.execute('get_account', { address: ACCOUNT }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it('bounds all upstream requests in one operation and gives the next operation a fresh budget', async () => {
    const adapter = vi.fn();
    vi.spyOn(services.bendystraw, 'getAccount').mockImplementation(async () => {
      for (let index = 0; index < 129; index += 1) {
        consumeRequest();
        adapter();
      }
      throw new Error('An operation must not make its 129th upstream request.');
    });
    for (let operation = 0; operation < 2; operation += 1) {
      await expect(operations.execute('get_account', { address: ACCOUNT })).rejects.toMatchObject({
        code: 'REQUEST_BUDGET_EXCEEDED',
      });
      expect(adapter).toHaveBeenCalledTimes(128 * (operation + 1));
    }
  });

  it('applies cancellation and strict input validation to raw transaction preparation too', async () => {
    const prepare = vi.spyOn(services.payments, 'preparePay').mockResolvedValue(paymentDraft());
    await expect(
      operations.prepare('prepare_pay', PAY_INPUT, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(
      operations.prepare('prepare_pay', { ...PAY_INPUT, extra: true }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('rejects unknown IDs and non-transaction preparation without publishing metadata or signing anything', async () => {
    const pin = vi.spyOn(services.metadata, 'pin');
    for (const id of ['missing_operation', 'jb_prepare_pay', '__proto__', 'constructor']) {
      await expect(operations.execute(id, {})).rejects.toMatchObject({
        code: 'OPERATION_NOT_FOUND',
      });
      await expect(operations.prepare(id, {})).rejects.toMatchObject({
        code: 'OPERATION_NOT_FOUND',
      });
    }
    for (const id of [
      'quote_pay',
      'prepare_intent',
      'prepare_project_metadata',
      'pin_project_metadata',
    ]) {
      await expect(operations.prepare(id, {})).rejects.toMatchObject({
        code: 'NOT_TRANSACTION_OPERATION',
      });
    }
    expect(pin).not.toHaveBeenCalled();
  });
});
