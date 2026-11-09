import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createServices } from '../../src/app.js';
import type { Services } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { createTools } from '../../src/mcp/tools.js';
import { NATIVE_TOKEN } from '@bananapus/nana-sdk-core';
import { buildPayTx } from '@bananapus/nana-sdk-core/v6';
import { encodeFunctionData, type PublicClient, type Hex } from 'viem';

describe('real MCP application protocol', () => {
  let server: McpServer;
  let client: Client;
  let services: Services;
  beforeEach(async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('Offline protocol tests must not use the network.');
      }),
    );
    services = createServices(
      loadConfig({
        PLAN_SECRET: 'test-only-secret-'.repeat(4),
        PUBLIC_ORIGIN: 'https://juicebox.diy',
      }),
    );
    server = createMcpServer(services);
    client = new Client({ name: 'juicebox-integration-test', version: '1.0.0' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });
  afterEach(async () => {
    await client?.close();
    await server?.close();
    vi.unstubAllGlobals();
  });

  it('advertises a complete organized catalog with valid MCP input/output schemas', async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(50);
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.outputSchema?.type).toBe('object');
      expect(tool.annotations?.readOnlyHint).toBe(
        ![
          'jb_pin_project_logo',
          'jb_pin_project_metadata',
          'jb_publish_intent',
          'jb_deploy_intent',
        ].includes(tool.name),
      );
    }
    const result = await client.callTool({ name: 'jb_list_capabilities', arguments: {} });
    expect(result.isError).not.toBe(true);
    const data = (
      result.structuredContent as {
        data: { families: { tools: { name: string }[] }[]; serviceOperations: { name: string }[] };
      }
    ).data;
    const catalogNames = [
      ...data.families.flatMap((family) => family.tools.map((tool) => tool.name)),
      ...data.serviceOperations.map((tool) => tool.name),
    ];
    expect(catalogNames.sort()).toEqual(tools.map((tool) => tool.name).sort());
    expect(fetch).not.toHaveBeenCalled();
  });
  it('registers the intent write tools as non-read-only and never as transaction plans', async () => {
    const { tools } = await client.listTools();
    const publish = tools.find((tool) => tool.name === 'jb_publish_intent');
    const deploy = tools.find((tool) => tool.name === 'jb_deploy_intent');
    expect(publish?.annotations?.readOnlyHint).toBe(false);
    expect(deploy?.annotations?.readOnlyHint).toBe(false);
    expect(publish?.annotations?.idempotentHint).toBe(true);
    expect(deploy?.annotations?.idempotentHint).toBe(false);
    expect(publish?.description).toContain('already signed');
    expect(deploy?.description).toContain('sponsor');
    expect(Object.keys(publish?.inputSchema.properties ?? {}).sort()).toEqual(
      [
        'chainIds',
        'deploymentCalls',
        'deploymentVersion',
        'format',
        'jb',
        'publisher',
        'signature',
      ].sort(),
    );
    expect(Object.keys(deploy?.inputSchema.properties ?? {}).sort()).toEqual(['chainIds', 'id']);
  });
  it('resolves identifiers with explicit V6 and no network', async () => {
    const result = await client.callTool({
      name: 'jb_resolve_project',
      arguments: { input: 'https://juicebox.money/base:9007199254740993' },
    });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      data: {
        kind: 'project',
        project: { chainId: 8453, projectId: '9007199254740993', version: 6 },
        existenceVerified: false,
      },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('returns machine-readable domain failures without leaking upstream errors', async () => {
    const result = await client.callTool({
      name: 'jb_get_account',
      arguments: { address: '0x1111111111111111111111111111111111111111' },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'NOT_CONFIGURED' },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects malformed transaction amounts and unknown fields before chain reads', async () => {
    const result = await client.callTool({
      name: 'jb_quote_pay',
      arguments: {
        project: { chainId: 1, projectId: '1' },
        account: '0x1111111111111111111111111111111111111111',
        beneficiary: '0x1111111111111111111111111111111111111111',
        token: '0x1111111111111111111111111111111111111111',
        amount: '1e18',
      },
    });
    expect(result.isError).toBe(true);
    const unknown = await client.callTool({
      name: 'jb_get_contract',
      arguments: { name: 'JBController', rpcUrl: 'https://attacker.example' },
    });
    expect(unknown.isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('serves exact bounded reference pages and categorized source counts', async () => {
    const sources = await client.readResource({ uri: 'juicebox://sources' });
    const sourceText = sources.contents[0];
    expect(sourceText && 'text' in sourceText).toBe(true);
    const data = JSON.parse((sourceText as { text: string }).text) as { total: number };
    expect(data.total).toBeGreaterThan(400);
    const listed = await client.callTool({
      name: 'jb_list_references',
      arguments: { category: 'contracts', limit: 1 },
    });
    const listing = (listed.structuredContent as { data: { documents: { id: string }[] } }).data;
    const id = listing.documents[0]!.id;
    const page = await client.readResource({ uri: `juicebox://reference/${id}/0` });
    const reference = JSON.parse((page.contents[0] as { text: string }).text) as {
      text: string;
      source: { fileSha256: string };
    };
    expect(reference.text.length).toBeLessThanOrEqual(8000);
    expect(reference.source.fileSha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it('exposes all three webclient sources and actionable integration plans', async () => {
    const listed = await client.callTool({
      name: 'jb_list_webclient_references',
      arguments: { limit: 50 },
    });
    expect(listed.isError).not.toBe(true);
    const plan = await client.callTool({
      name: 'jb_plan_integration',
      arguments: {
        framework: 'react',
        features: ['payments'],
        projectType: 'project',
        chainIds: [8453],
      },
    });
    expect(plan.isError).not.toBe(true);
    expect(plan.structuredContent).toMatchObject({
      ok: true,
      data: { referenceOnly: true, publicOrigin: 'https://juicebox.diy' },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('offers task prompts through the actual protocol', async () => {
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((prompt) => prompt.name)).toContain('build-webclient');
    const result = await client.getPrompt({
      name: 'build-webclient',
      arguments: { request: 'Build a project storefront on Base.' },
    });
    expect(result.messages[0]?.content).toMatchObject({ type: 'text' });
  });

  it('round-trips a prepared payment through signed plan inspection without changing reviewed calldata', async () => {
    const account = '0x1111111111111111111111111111111111111111';
    const request = buildPayTx({
      chainId: 8453,
      terminal: '0x2222222222222222222222222222222222222222',
      projectId: 1n,
      token: NATIVE_TOKEN,
      amount: 10n,
      beneficiary: account,
      minReturnedTokens: 99n,
    });
    const data = encodeFunctionData(request);
    const blockHash = `0x${'ab'.repeat(32)}` as Hex;
    const evidence = {
      chainId: 8453 as const,
      blockNumber: '100',
      blockHash,
      timestamp: '123',
      source: 'rpc' as const,
    };
    const rpcClient = {
      getChainId: async () => 8453,
      call: async () => ({ data: '0x' }),
      estimateGas: async () => 21000n,
      getBlock: async () => ({ hash: blockHash }),
    } as unknown as PublicClient;
    vi.spyOn(services.rpc, 'snapshot').mockResolvedValue({ client: rpcClient, evidence });
    vi.spyOn(services.payments, 'preparePay').mockResolvedValue({
      operation: 'pay',
      account,
      project: { chainId: 8453, projectId: '1', version: 6 },
      calls: [
        {
          chainId: 8453,
          to: request.address,
          data,
          value: '10',
          label: 'Pay project 1',
          decoded: { functionName: 'pay', args: request.args },
          dependsOn: [],
        },
      ],
      evidence: [evidence],
      summary: { beneficiaryTokenMinimum: '99' },
      warnings: [],
    });
    const result = await client.callTool({
      name: 'jb_prepare_pay',
      arguments: {
        project: { chainId: 8453, projectId: '1' },
        account,
        beneficiary: account,
        token: NATIVE_TOKEN,
        amount: '10',
      },
    });
    expect(result.isError).not.toBe(true);
    const prepared = (
      result.structuredContent as { data: { token: string; review: unknown; preflight: unknown } }
    ).data;
    expect(prepared.preflight).toMatchObject({ status: 'known', value: { status: 'simulated' } });
    const inspected = await client.callTool({
      name: 'jb_inspect_plan',
      arguments: { token: prepared.token },
    });
    expect(inspected.structuredContent).toMatchObject({
      ok: true,
      data: { draft: { calls: [{ data, value: '10' }] } },
    });
    const tampered = await client.callTool({
      name: 'jb_inspect_plan',
      arguments: { token: `${prepared.token.slice(0, -2)}xx` },
    });
    expect(tampered.isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves ordinary Center commitments and explicitly rejects reserved JSON keys', async () => {
    const input = {
      format: 'juicebox.money/v1',
      deploymentVersion: '6' as const,
      chainIds: [8453 as const],
      deploymentCalls: [
        {
          chainId: 8453,
          to: '0x1111111111111111111111111111111111111111' as const,
          data: '0x12345678' as const,
        },
      ],
      jb: { v: 1, name: 'Example', chains: [8453] },
    };
    const expected = await services.center.prepareIntent(input);
    const actual = await client.callTool({ name: 'jb_prepare_intent', arguments: input });
    expect(actual.structuredContent).toMatchObject({ ok: true, data: expected });
    const rejected = await client.callTool({
      name: 'jb_prepare_intent',
      arguments: { ...input, jb: JSON.parse('{"v":1,"__proto__":{"a":1}}') },
    });
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected)).not.toContain('contentHash');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not inject a mainnet default before testnet chain inference', async () => {
    const getAccount = vi
      .spyOn(services.bendystraw, 'getAccount')
      .mockRejectedValue(new Error('capture only'));
    await client.callTool({
      name: 'jb_get_account',
      arguments: { address: '0x1111111111111111111111111111111111111111', chainId: 84532 },
    });
    expect(getAccount.mock.calls[0]?.[0]).toMatchObject({ chainId: 84532 });
    expect(getAccount.mock.calls[0]?.[0].network).toBeUndefined();
    const search = createTools(services).find((tool) => tool.name === 'jb_search_projects')!;
    expect(search.schema.parse({ chainId: 84532 })).not.toHaveProperty('network');
  });
});
