import { describe, expect, it, vi } from 'vitest';
import {
  NATIVE_TOKEN,
  createHookMetadata,
  hookMetadataId,
  jbMultiTerminalAbi,
} from '@bananapus/nana-sdk-core';
import {
  build721PayMetadata,
  buildBuybackCashOutMetadata,
  buildUserPayMetadata,
  prepareUserPay,
  v6Address,
  PAY_MAX_SLIPPAGE_BPS,
  PAY_QUOTE_FAILED_MESSAGE,
} from '@bananapus/nana-sdk-core/v6';
import {
  decodeFunctionData,
  encodeAbiParameters,
  erc20Abi,
  getAddress,
  keccak256,
  parseAbiParameters,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import {
  PaymentService,
  type CashOutInput,
  type PayInput,
  type PayoutInput,
} from '../../src/services/payments.js';
import { deploymentAddress } from '../../src/services/rollout.js';
import { paySlippageSchema, slippageSchema } from '../../src/domain/schemas.js';
import type { BlockEvidence, RpcProvider } from '../../src/domain/types.js';

const project = { chainId: 8453, projectId: '12', version: 6 } as const;
const account = '0x1111111111111111111111111111111111111111' as const;
const beneficiary = '0x2222222222222222222222222222222222222222' as const;
const token = '0x3333333333333333333333333333333333333333' as const;
const feeless = '0x4444444444444444444444444444444444444444' as const;
const custom = '0x5555555555555555555555555555555555555555' as const;
const controller = v6Address('JBController', project.chainId);
const terminal = v6Address('JBMultiTerminal', project.chainId);
const buybackHook = deploymentAddress('JBBuybackHook', project.chainId)!;
const registry = v6Address('JBBuybackHookRegistry', project.chainId);
const omni = v6Address('JBOmnichainDeployer', project.chainId);
const nftImplementation = v6Address('JB721TiersHook', project.chainId);
const nftCloneCode =
  `0x3d3d3d3d363d3d37363d73${nftImplementation.slice(2)}5af43d3d93803e602a57fd5bf3` as Hex;
const hash = `0x${'ab'.repeat(32)}` as Hex;
const ruleset = {
  id: 3,
  cycleNumber: 1,
  basedOnId: 0,
  start: 10,
  duration: 0,
  weight: 1_000n,
  weightCutPercent: 0,
  approvalHook: zeroAddress,
  metadata: 0n,
};
const evidence: BlockEvidence = {
  chainId: 8453,
  blockNumber: '123',
  blockHash: hash,
  timestamp: '1000',
  source: 'rpc',
};
// Caller metadata keeps the terminal-preview quote; without it the SDK's prepareUserPay sets the minimum.
const payInput: PayInput = {
  project,
  account,
  token: NATIVE_TOKEN,
  amount: '100',
  beneficiary,
  metadata: '0x',
};
const { metadata: _callerMetadata, ...sdkPayInput } = payInput;
const cashInput: CashOutInput & { account: Address } = {
  project,
  account,
  holder: account,
  tokenToReclaim: NATIVE_TOKEN,
  cashOutCount: '100',
  beneficiary,
};
const payoutInput: PayoutInput = {
  project,
  account,
  token: NATIVE_TOKEN,
  amount: '100',
  currency: 61166,
};
type Request = {
  functionName: string;
  args?: readonly unknown[];
  account?: Address;
  address?: Address;
  blockNumber?: bigint;
  gas?: bigint;
};
type HookSpec = { hook: Address; noop: boolean; amount: bigint; metadata: Hex };

function fixture(
  options: {
    beneficiaryCount?: bigint;
    allowance?: bigint;
    payHooks?: HookSpec[];
    dataHook?: Address;
    cashGross?: bigint;
    cashTax?: bigint;
    feeFreeSurplus?: bigint;
    beneficiaryIsFeeless?: boolean;
    cashPreview?: (metadata: Hex) => readonly unknown[];
    grossPayout?: bigint;
    resolvedBuyback?: Address;
    customController?: Address;
    errorOn?: string;
    primaryTerminal?: Address;
    routerTarget?: Address;
    gatewayRouter?: Address;
    registered?: boolean;
    tieredHook?: Address;
    nftClone?: Address;
    nftProjectId?: bigint;
    extraDataHook?: Address;
    extraPayEnabled?: boolean;
  } = {},
) {
  const metadata = {
    useDataHookForPay: Boolean(options.dataHook),
    useDataHookForCashOut: Boolean(options.dataHook),
    dataHook: options.dataHook ?? zeroAddress,
  };
  const readContract = vi.fn(async (request: Request): Promise<unknown> => {
    if (options.errorOn === request.functionName) throw new Error('RPC read unavailable');
    switch (request.functionName) {
      case 'controllerOf':
        return options.customController ?? controller;
      case 'currentRulesetOf':
        return [ruleset, metadata];
      case 'primaryTerminalOf':
        return options.primaryTerminal ?? terminal;
      case 'ROUTER':
        return options.gatewayRouter;
      case 'terminalOf':
        return options.routerTarget ?? v6Address('JBRouterTerminal', project.chainId);
      case 'terminalsOf':
        return [terminal, v6Address('JBRouterTerminalRegistry', project.chainId)];
      case 'isTerminalOf':
        return options.registered ?? true;
      case 'accountingContextForTokenOf':
        return { token: request.args?.[1], decimals: 18, currency: 61166 };
      case 'previewPayFor':
        return [ruleset, options.beneficiaryCount ?? 101n, 10n, options.payHooks ?? []];
      case 'allowance':
        return options.allowance ?? 0n;
      case 'BUYBACK_HOOK':
        return registry;
      case 'tiered721HookOf':
        return request.address === omni
          ? [options.tieredHook ?? zeroAddress, false]
          : (options.tieredHook ?? zeroAddress);
      case 'extraDataHookOf':
        return {
          dataHook: options.extraDataHook ?? zeroAddress,
          useDataHookForPay: options.extraPayEnabled ?? true,
          useDataHookForCashOut: true,
        };
      case 'STORE':
        return v6Address('JB721TiersHookStore', project.chainId);
      case 'DIRECTORY':
        return v6Address('JBDirectory', project.chainId);
      case 'projectId':
        return options.nftProjectId ?? BigInt(project.projectId);
      case 'METADATA_ID_TARGET':
        return nftImplementation;
      case 'pricingContext':
        return [61166, 18];
      case 'hookOf':
        return options.resolvedBuyback ?? buybackHook;
      case 'FEELESS_ADDRESSES':
        return feeless;
      case 'isFeelessFor':
        return options.beneficiaryIsFeeless ?? false;
      case 'previewCashOutFrom':
        return (
          options.cashPreview?.(request.args?.[5] as Hex) ?? [
            ruleset,
            options.cashGross ?? 101n,
            options.cashTax ?? 1n,
            [],
          ]
        );
      case 'feeFreeSurplusOf':
        return options.feeFreeSurplus ?? 0n;
      default:
        throw new Error(`Unexpected read ${request.functionName}`);
    }
  });
  const simulateContract = vi.fn(async (_request: Request) => ({
    result: options.grossPayout ?? 101n,
  }));
  const getBytecode = vi.fn(async ({ address }: { address: Address }) => {
    if (address === nftImplementation) return '0x6000';
    return address === options.nftClone || address === options.tieredHook ? nftCloneCode : '0x';
  });
  const client = { readContract, simulateContract, getBytecode } as unknown as PublicClient;
  const snapshot = vi.fn(async () => ({ client, evidence }));
  const rpc: RpcProvider = { snapshot, client: () => client };
  return {
    service: new PaymentService(rpc),
    readContract,
    simulateContract,
    getBytecode,
    snapshot,
  };
}

const poolKey = {
  currency0: zeroAddress,
  currency1: '0x7777777777777777777777777777777777777777' as Address,
  fee: 3000,
  tickSpacing: 60,
  hooks: zeroAddress,
};
const poolId = keccak256(
  encodeAbiParameters(parseAbiParameters('address,address,uint24,int24,address'), [
    poolKey.currency0,
    poolKey.currency1,
    poolKey.fee,
    poolKey.tickSpacing,
    poolKey.hooks,
  ]),
);

/** Serves the buyback pool the SDK quotes against; `readable` returns false while its reads fail. */
async function servePool(f: ReturnType<typeof fixture>, readable: () => boolean = () => true) {
  const original = f.readContract.getMockImplementation()!;
  f.readContract.mockImplementation(async (request) => {
    if (request.functionName !== 'poolKeyOf') return original(request);
    if (!readable()) throw new Error('RPC read unavailable');
    return poolKey;
  });
  Object.assign((await f.snapshot()).client, {
    call: vi.fn(async () => ({
      data: encodeAbiParameters(parseAbiParameters('uint256,uint256'), [1000n, 1n]),
    })),
  });
}

function payHookMetadata(
  overrides: {
    beneficiaryCount?: bigint;
    skipSplits?: boolean;
    partialMint?: bigint;
    explicit?: boolean;
    poolId?: Hex;
  } = {},
): Hex {
  return encodeAbiParameters(
    parseAbiParameters(
      'bool,uint256,uint256,bool,address,uint256,uint256,uint256,int24,uint128,bytes32,uint256,uint256,uint256,bool,bool,uint256',
    ),
    [
      false,
      overrides.partialMint ?? 0n,
      300n,
      overrides.explicit ?? false,
      controller,
      200n,
      1n,
      100n,
      0,
      1n,
      overrides.poolId ?? hash,
      overrides.beneficiaryCount ?? 250n,
      50n,
      999n,
      false,
      overrides.skipSplits ?? false,
      1667n,
    ],
  );
}

function cashHookMetadata(minimum: bigint, explicit: boolean, direct = 100n): Hex {
  return encodeAbiParameters(
    parseAbiParameters('uint256,uint256,uint256,int24,uint128,bytes32,uint256,bool'),
    [minimum, 100n, direct, 0, 1n, hash, explicit ? 0n : 250n, explicit],
  );
}

describe('payment quotes and approval plans', () => {
  it('preserves the caller-supplied canonical snapshot through ordinary payment preparation', async () => {
    const f = fixture();
    const { client } = await f.snapshot();
    f.snapshot.mockClear();
    const at: BlockEvidence = {
      ...evidence,
      blockNumber: '456',
      blockHash: `0x${'cd'.repeat(32)}`,
    };
    const snapshotAt = vi.fn(() => ({ client, evidence: at }));
    const service = new PaymentService({ snapshot: f.snapshot, snapshotAt, client: () => client });
    const plan = await service.preparePay(payInput, at);
    expect(snapshotAt).toHaveBeenCalledWith(project.chainId, at);
    expect(f.snapshot).not.toHaveBeenCalled();
    expect(plan.evidence).toEqual([at]);
  });
  it('reads the project context and terminal together, keeps them for minutes, and drops them when the live preview disagrees', async () => {
    const f = fixture();
    const names = () => f.readContract.mock.calls.map(([request]) => request.functionName);
    await f.service.preparePay(payInput);
    const first = names();
    expect(first).toContain('controllerOf');
    expect(first).toContain('primaryTerminalOf');
    // The controller, the ruleset and the terminal go out together, ahead of any dependent read.
    expect(first.slice(0, 3).sort()).toEqual([
      'controllerOf',
      'currentRulesetOf',
      'primaryTerminalOf',
    ]);
    {
      const held = fixture();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = held.readContract.getMockImplementation()!;
      held.readContract.mockImplementation(async (request) => {
        if (request.functionName === 'controllerOf') await gate;
        return original(request);
      });
      const quoting = held.service.preparePay(payInput);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const issued = held.readContract.mock.calls.map(([request]) => request.functionName);
      expect(issued).toContain('currentRulesetOf');
      expect(issued).toContain('primaryTerminalOf');
      release();
      await quoting;
    }
    f.readContract.mockClear();
    const { client: snapshotClient } = await f.snapshot();
    f.snapshot.mockResolvedValueOnce({
      client: snapshotClient,
      evidence: { ...evidence, blockNumber: '101', blockHash: `0x${'22'.repeat(32)}` },
    } as never);
    const hit = await f.service.preparePay(payInput);
    // A second payment for the same project within the window only previews; the plan still
    // carries one evidence entry (the quote's block) and names the route's block beside it.
    expect(names()).toEqual(['previewPayFor']);
    expect(hit.evidence).toHaveLength(1);
    expect(
      (hit.summary as { routeEvidence: { blockHash: string } }).routeEvidence.blockHash,
    ).not.toBe(hit.evidence[0]!.blockHash);
    // A ruleset change on chain shows in the live preview; the context is read again.
    f.readContract.mockClear();
    const original = f.readContract.getMockImplementation()!;
    let flips = 1;
    f.readContract.mockImplementation(async (request) => {
      const value = await original(request);
      if (request.functionName === 'previewPayFor' && flips-- > 0)
        return [
          { ...((value as unknown[])[0] as object), id: 999n },
          ...(value as unknown[]).slice(1),
        ];
      return value;
    });
    await f.service.preparePay(payInput);
    expect(names().filter((name) => name === 'controllerOf')).toHaveLength(1);
    expect(names().filter((name) => name === 'previewPayFor')).toHaveLength(2);
    // A fresh read that still disagrees with the live preview is a real mismatch, not a retry.
    const g = fixture();
    g.readContract.mockImplementation(async (request) => {
      const value = await original(request);
      return request.functionName === 'previewPayFor'
        ? [{ ...((value as unknown[])[0] as object), id: 999n }, ...(value as unknown[]).slice(1)]
        : value;
    });
    await expect(g.service.preparePay(payInput)).rejects.toMatchObject({ code: 'INVALID_PREVIEW' });
    expect(
      g.readContract.mock.calls.filter(([request]) => request.functionName === 'previewPayFor'),
    ).toHaveLength(1);
    // Expired entries leave the map as new ones arrive.
    const h = fixture();
    await h.service.preparePay(payInput);
    (
      h.service as unknown as { recentProjects: Map<string, { at: number }> }
    ).recentProjects.forEach((entry) => {
      entry.at -= 1_801_000;
    });
    await h.service.preparePay({
      ...payInput,
      token: '0x000000000000000000000000000000000000dEaD',
    });
    expect(
      (h.service as unknown as { recentProjects: Map<string, unknown> }).recentProjects.size,
    ).toBe(1);
  });
  it('warms a route that is missing or past half its life, and leaves a young one alone', async () => {
    const f = fixture();
    const names = () => f.readContract.mock.calls.map(([request]) => request.functionName);
    expect(await f.service.warm(payInput.project, payInput.token)).toBe(true);
    expect(names()).toContain('controllerOf');
    expect(names()).not.toContain('previewPayFor');
    f.readContract.mockClear();
    expect(await f.service.warm(payInput.project, payInput.token)).toBe(false);
    expect(names()).toEqual([]);
    (
      f.service as unknown as { recentProjects: Map<string, { at: number }> }
    ).recentProjects.forEach((entry) => {
      entry.at -= 900_000;
    });
    expect(await f.service.warm(payInput.project, payInput.token)).toBe(true);
    expect(names()).toContain('controllerOf');
    // The next quote finds the route warm.
    f.readContract.mockClear();
    await f.service.preparePay(payInput);
    expect(names()).toEqual(['previewPayFor']);
  });
  it('answers from a route past half its life and reads it again behind the quote', async () => {
    const f = fixture();
    const names = () => f.readContract.mock.calls.map(([request]) => request.functionName);
    await f.service.preparePay(payInput);
    const routes = (f.service as unknown as { recentProjects: Map<string, { at: number }> })
      .recentProjects;
    routes.forEach((entry) => {
      entry.at -= 900_000;
    });
    f.readContract.mockClear();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = f.readContract.getMockImplementation()!;
    f.readContract.mockImplementation(async (request) => {
      if (request.functionName === 'controllerOf') await held;
      return original(request);
    });
    // The quote does not wait on the re-read; a second quote meanwhile does not start another.
    await f.service.preparePay(payInput);
    await f.service.preparePay(payInput);
    expect(names().filter((name) => name === 'previewPayFor')).toHaveLength(2);
    expect(names().filter((name) => name === 'controllerOf')).toHaveLength(1);
    const before = [...routes.values()][0]!.at;
    release();
    await vi.waitFor(() => expect([...routes.values()][0]!.at).toBeGreaterThan(before));
    f.readContract.mockClear();
    await f.service.preparePay(payInput);
    expect(names()).toEqual(['previewPayFor']);
  });
  it('preserves an invoice memo in exact payment bytes and rejects oversized UTF-8 text', async () => {
    const plan = await fixture().service.preparePay({ ...payInput, memo: 'beep:invoice-123' });
    const decoded = decodeFunctionData({ abi: jbMultiTerminalAbi, data: plan.calls[0]!.data });
    expect(decoded.args?.[5]).toBe('beep:invoice-123');
    await expect(
      fixture().service.preparePay({ ...payInput, memo: '🌈'.repeat(65) }),
    ).rejects.toThrow('256 UTF-8 bytes');
  });
  it('binds SDK previews to the caller and block evidence and encodes the exact floor', async () => {
    const { service, readContract, snapshot } = fixture();
    const plan = await service.preparePay(payInput);
    expect(snapshot).toHaveBeenCalledOnce();
    expect(plan.evidence).toEqual([evidence]);
    const preview = readContract.mock.calls.find(
      ([request]) => request.functionName === 'previewPayFor',
    )?.[0];
    expect(preview).toMatchObject({ account, args: [12n, NATIVE_TOKEN, 100n, beneficiary, '0x'] });
    expect(plan.calls).toHaveLength(1);
    expect(plan.calls[0]?.value).toBe('100');
    expect(
      decodeFunctionData({ abi: jbMultiTerminalAbi, data: plan.calls[0]!.data }),
    ).toMatchObject({
      functionName: 'pay',
      args: [12n, NATIVE_TOKEN, 100n, beneficiary, 99n, '', '0x'],
    });
    expect(plan.calls[0]?.decoded.args).toEqual([
      '12',
      NATIVE_TOKEN,
      '100',
      beneficiary,
      '99',
      '',
      '0x',
    ]);
  });

  it('requires positive ordinary payments even when a verified NFT hook is configured', async () => {
    const { service, snapshot } = fixture({ dataHook: custom, nftClone: custom });
    await expect(service.quotePay({ ...payInput, amount: '0' })).rejects.toMatchObject({
      code: 'INVALID_AMOUNT',
    });
    await expect(service.preparePay({ ...payInput, amount: '0' })).rejects.toMatchObject({
      code: 'INVALID_AMOUNT',
    });
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('prepares zero-value NFT calls only for the matching active verified hook without token approval', async () => {
    const { service, readContract } = fixture({
      dataHook: custom,
      nftClone: custom,
      beneficiaryCount: 0n,
      payHooks: [{ hook: custom, noop: false, amount: 0n, metadata: '0x' }],
      errorOn: 'allowance',
    });
    const input = { ...payInput, token, amount: '0' };
    const plan = await service.prepareNftPay(input, custom);
    expect(plan.calls).toHaveLength(1);
    expect(plan.calls[0]?.value).toBe('0');
    expect(
      decodeFunctionData({ abi: jbMultiTerminalAbi, data: plan.calls[0]!.data }),
    ).toMatchObject({
      functionName: 'pay',
      args: [12n, token, 0n, beneficiary, 0n, '', '0x'],
    });
    expect(readContract.mock.calls.some(([request]) => request.functionName === 'allowance')).toBe(
      false,
    );
    await expect(service.prepareNftPay(input, beneficiary)).rejects.toMatchObject({
      code: 'NFT_HOOK_NOT_INVOKED',
    });
    for (const payHooks of [
      [],
      [{ hook: custom, noop: true, amount: 0n, metadata: '0x' as const }],
    ])
      await expect(
        fixture({ dataHook: custom, nftClone: custom, payHooks }).service.prepareNftPay(
          input,
          custom,
        ),
      ).rejects.toMatchObject({ code: 'NFT_HOOK_NOT_INVOKED' });
    await expect(fixture().service.prepareNftPay(input, custom)).rejects.toMatchObject({
      code: 'NFT_HOOK_NOT_INVOKED',
    });
  });

  it('keeps verified zero issuance explicit, and never converts a failed preview to zero', async () => {
    const zero = await fixture({ beneficiaryCount: 0n }).service.preparePay(payInput);
    expect(zero.summary).toMatchObject({
      beneficiaryTokenCount: '0',
      minimumBeneficiaryTokenCount: '0',
    });
    expect(zero.warnings.join(' ')).toContain('zero fungible');
    await expect(
      fixture({ errorOn: 'previewPayFor' }).service.preparePay(payInput),
    ).rejects.toThrow('RPC read unavailable');
  });

  it('uses integer arithmetic for huge values and retains a one-unit floor for dust', async () => {
    const huge = (1n << 240n) + 913n;
    const quote = await fixture({ beneficiaryCount: huge }).service.quotePay({
      ...payInput,
      slippageBps: 17,
    });
    expect(quote.minimumBeneficiaryTokenCount).toBe(((huge * 9983n) / 10000n).toString());
    expect(
      (await fixture({ beneficiaryCount: 1n }).service.quotePay(payInput))
        .minimumBeneficiaryTokenCount,
    ).toBe('1');
  });

  it('makes reset, exact approval, and payment dependencies explicit without fictitious simulation state', async () => {
    const { service, simulateContract, readContract } = fixture({ allowance: 9n });
    const plan = await service.preparePay({ ...payInput, token });
    // The allowance goes out beside the preview rather than after it.
    {
      const held = fixture({ allowance: 9n });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = held.readContract.getMockImplementation()!;
      held.readContract.mockImplementation(async (request) => {
        if (request.functionName === 'previewPayFor') await gate;
        return original(request);
      });
      const preparing = held.service.preparePay({ ...payInput, token });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(held.readContract.mock.calls.map(([request]) => request.functionName)).toContain(
        'allowance',
      );
      release();
      await preparing;
    }
    expect(plan.calls.map((item) => item.dependsOn)).toEqual([[], [0], [1]]);
    expect(plan.calls.map((item) => item.value)).toEqual(['0', '0', '0']);
    expect(decodeFunctionData({ abi: erc20Abi, data: plan.calls[0]!.data }).args).toEqual([
      getAddress(terminal),
      0n,
    ]);
    expect(decodeFunctionData({ abi: erc20Abi, data: plan.calls[1]!.data }).args).toEqual([
      getAddress(terminal),
      100n,
    ]);
    expect(simulateContract).not.toHaveBeenCalled();
    const sufficient = await fixture({ allowance: 100n }).service.preparePay({
      ...payInput,
      token,
    });
    expect(sufficient.calls).toHaveLength(1);
    const noAllowance = await fixture().service.preparePay({ ...payInput, token });
    expect(noAllowance.calls.map((item) => item.dependsOn)).toEqual([[], [0]]);
    await expect(
      fixture({ errorOn: 'allowance' }).service.preparePay({ ...payInput, token }),
    ).rejects.toThrow();
  });

  it('approves the directly called router registry and preserves exact caller metadata', async () => {
    const registryTerminal = v6Address('JBRouterTerminalRegistry', project.chainId);
    const { service, readContract } = fixture({ primaryTerminal: registryTerminal });
    const metadata = '0x1234' as const;
    const plan = await service.preparePay({ ...payInput, token, metadata });
    expect(plan.calls[1]?.to).toBe(registryTerminal);
    expect(decodeFunctionData({ abi: erc20Abi, data: plan.calls[0]!.data }).args).toEqual([
      getAddress(registryTerminal),
      100n,
    ]);
    expect(
      decodeFunctionData({ abi: jbMultiTerminalAbi, data: plan.calls[1]!.data }).args?.[6],
    ).toBe(metadata);
    expect(
      readContract.mock.calls.find(([request]) => request.functionName === 'previewPayFor')?.[0]
        .args?.[4],
    ).toBe(metadata);
  });

  it('warns when the router conversion quote fails, and keeps the warning on its metadata sent back', async () => {
    const registryTerminal = v6Address('JBRouterTerminalRegistry', project.chainId);
    const warned = (warnings: string[]) =>
      warnings.some((warning) => warning.startsWith(PAY_QUOTE_FAILED_MESSAGE));
    // No buyback hook: the SDK quotes the router's conversion, and its reads fail twice.
    // This fixture does not answer accountingContextsOf, one of those reads.
    const failing = fixture({ primaryTerminal: registryTerminal });
    const quoted = await failing.service.quotePay({ ...sdkPayInput, token });
    expect(warned(quoted.warnings)).toBe(true);
    const sentBack = await failing.service.preparePay({
      ...sdkPayInput,
      token,
      metadata: quoted.metadata,
    });
    expect(sentBack.summary).toMatchObject({ metadata: quoted.metadata });
    expect(warned(sentBack.warnings)).toBe(true);
    // Reads that answer carry no notice, quoted or sent back.
    const reading = fixture({ primaryTerminal: registryTerminal });
    const original = reading.readContract.getMockImplementation()!;
    // Two accepted tokens: the SDK keeps the router's own floor, with every read answered.
    reading.readContract.mockImplementation(async (request) =>
      request.functionName === 'accountingContextsOf'
        ? [
            { token: NATIVE_TOKEN, decimals: 18, currency: 61166 },
            { token, decimals: 18, currency: 1 },
          ]
        : original(request),
    );
    expect(warned((await reading.service.quotePay({ ...sdkPayInput, token })).warnings)).toBe(
      false,
    );
    expect(
      warned(
        (await reading.service.preparePay({ ...sdkPayInput, token, metadata: quoted.metadata }))
          .warnings,
      ),
    ).toBe(false);
  });

  it('resolves registry -> gateway -> router on an executed chain and approves the outer terminal', async () => {
    const chainId = 84532;
    const registryTerminal = v6Address('JBRouterTerminalRegistry', chainId);
    const gateway = deploymentAddress('JBRouterTerminalGateway', chainId)!;
    const router = deploymentAddress('JBRouterTerminal', chainId)!;
    const input: PayInput = { ...payInput, project: { ...project, chainId }, token };
    const { service, readContract } = fixture({
      primaryTerminal: registryTerminal,
      routerTarget: gateway,
      gatewayRouter: router,
    });
    const plan = await service.preparePay(input);
    expect(plan.summary).toMatchObject({
      terminalPath: [registryTerminal, gateway, router],
      routerGateway: gateway,
    });
    expect(plan.calls.at(-1)?.to).toBe(registryTerminal);
    expect(decodeFunctionData({ abi: erc20Abi, data: plan.calls[0]!.data }).args).toEqual([
      getAddress(registryTerminal),
      100n,
    ]);
    expect(
      readContract.mock.calls.some(
        ([request]) => request.address === gateway && request.functionName === 'ROUTER',
      ),
    ).toBe(true);
    expect(plan.warnings.join(' ')).toContain('pending, not paid or forgiven');
    await expect(
      fixture({
        primaryTerminal: registryTerminal,
        routerTarget: gateway,
        gatewayRouter: custom,
      }).service.preparePay(input),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_ROUTER_GATEWAY' });
    await expect(
      fixture({
        primaryTerminal: registryTerminal,
        routerTarget: gateway,
        gatewayRouter: router,
        errorOn: 'ROUTER',
      }).service.preparePay(input),
    ).rejects.toThrow('RPC read unavailable');
  });

  it('reads buyback beneficiary output rather than treating zero terminal issuance or raw diagnostics as settlement', async () => {
    const { service } = fixture({
      dataHook: registry,
      beneficiaryCount: 0n,
      payHooks: [{ hook: buybackHook, noop: false, amount: 100n, metadata: payHookMetadata() }],
    });
    const plan = await service.preparePay(payInput);
    expect(plan.summary).toMatchObject({
      quoteBasis: 'buyback-hook-indicative-output',
      beneficiaryTokenCount: '250',
      minimumBeneficiaryTokenCount: '247',
      rawTerminalPreview: { semantics: 'issuance', beneficiaryTokenCount: '0' },
    });
    expect(
      decodeFunctionData({ abi: jbMultiTerminalAbi, data: plan.calls[0]!.data }).args?.[4],
    ).toBe(247n);
    expect(plan.warnings.join(' ')).toContain('falls back');
  });

  it('without caller metadata pays with the SDK prepareUserPay metadata and minimum', async () => {
    for (const skipSplits of [undefined, true, false]) {
      for (const options of [
        {},
        {
          dataHook: registry,
          beneficiaryCount: 0n,
          payHooks: [
            {
              hook: buybackHook,
              noop: false,
              amount: 100n,
              metadata: payHookMetadata({ skipSplits: skipSplits ?? true, poolId }),
            },
          ],
        },
      ]) {
        const f = fixture(options);
        await servePool(f);
        const input = skipSplits === undefined ? sdkPayInput : { ...sdkPayInput, skipSplits };
        const plan = await f.service.preparePay(input);
        const servicePreviews = f.readContract.mock.calls.filter(
          ([request]) => request.functionName === 'previewPayFor',
        );
        const { client } = await f.snapshot();
        const sdk = await prepareUserPay(client, {
          chainId: project.chainId,
          terminal,
          projectId: BigInt(project.projectId),
          token: NATIVE_TOKEN,
          amount: 100n,
          beneficiary,
          slippageBps: 100n,
          skipSplits: skipSplits ?? true,
        });
        // The pool pays 1000 for the 100 swapped: the minimum is that quote less the 1% tolerance.
        expect(sdk.metadata).toBe(
          buildUserPayMetadata({
            chainId: project.chainId,
            skipSplits: skipSplits ?? true,
            ...('dataHook' in options ? { minimumSwapAmountOut: 990n } : {}),
          }),
        );
        const args = decodeFunctionData({
          abi: jbMultiTerminalAbi,
          data: plan.calls[0]!.data,
        }).args!;
        expect([args[4], args[6]]).toEqual([sdk.minReturnedTokens, sdk.metadata]);
        expect(plan.summary).toMatchObject({
          minimumBeneficiaryTokenCount: String(sdk.minReturnedTokens),
          beneficiaryTokenCount: String(sdk.preview.beneficiaryTokenCount),
          reservedTokenCount: String(sdk.preview.reservedTokenCount),
          metadata: sdk.metadata,
        });
        // The hook specs checked are the terminal's answer for that exact metadata.
        expect(servicePreviews.at(-1)?.[0].args?.[4]).toBe(sdk.metadata);
      }
    }
    await expect(
      fixture().service.preparePay({ ...payInput, skipSplits: false }),
    ).rejects.toMatchObject({ code: 'INVALID_SKIP_SPLITS' });
  });

  it('caps a payment tolerance at the SDK payer maximum, and other tolerances at 1000', async () => {
    const { service } = fixture();
    await expect(
      service.preparePay({ ...payInput, slippageBps: Number(PAY_MAX_SLIPPAGE_BPS) }),
    ).resolves.toBeDefined();
    await expect(
      service.preparePay({ ...payInput, slippageBps: Number(PAY_MAX_SLIPPAGE_BPS) + 1 }),
    ).rejects.toMatchObject({ code: 'INVALID_SLIPPAGE' });
    await expect(service.prepareCashOut({ ...cashInput, slippageBps: 1001 })).rejects.toMatchObject(
      {
        code: 'INVALID_SLIPPAGE',
      },
    );
    expect(paySlippageSchema.safeParse(Number(PAY_MAX_SLIPPAGE_BPS)).success).toBe(true);
    expect(paySlippageSchema.safeParse(Number(PAY_MAX_SLIPPAGE_BPS) + 1).success).toBe(false);
    expect(slippageSchema.safeParse(1001).success).toBe(false);
  });

  it('validates the hook specs of the metadata it sends, quoted or fallen back after a tentative quote', async () => {
    const base = buildUserPayMetadata({ chainId: project.chainId, skipSplits: true });
    // The pool pays 1000 for the 100 swapped against a 200-token mint: worth quoting.
    const quoting = (swapsWhenQuoted: boolean) => {
      const f = fixture({ dataHook: registry, beneficiaryCount: 0n });
      const original = f.readContract.getMockImplementation()!;
      f.readContract.mockImplementation(async (request) => {
        if (request.functionName === 'poolKeyOf') return poolKey;
        if (request.functionName !== 'previewPayFor') return original(request);
        const quoted = request.args?.[4] !== base;
        return [
          ruleset,
          0n,
          10n,
          [
            {
              hook: buybackHook,
              noop: quoted && !swapsWhenQuoted,
              amount: 100n,
              metadata: payHookMetadata({ skipSplits: true, explicit: quoted, poolId }),
            },
          ],
        ];
      });
      return f;
    };
    for (const swapsWhenQuoted of [true, false]) {
      const f = quoting(swapsWhenQuoted);
      const { client } = await f.snapshot();
      Object.assign(client, {
        call: vi.fn(async () => ({
          data: encodeAbiParameters(parseAbiParameters('uint256,uint256'), [1000n, 1n]),
        })),
      });
      const plan = await f.service.preparePay(sdkPayInput);
      const servicePreviews = f.readContract.mock.calls.filter(
        ([request]) => request.functionName === 'previewPayFor',
      );
      const reference = quoting(swapsWhenQuoted);
      const { client: referenceClient } = await reference.snapshot();
      Object.assign(referenceClient, {
        call: vi.fn(async () => ({
          data: encodeAbiParameters(parseAbiParameters('uint256,uint256'), [1000n, 1n]),
        })),
      });
      const sdk = await prepareUserPay(referenceClient, {
        chainId: project.chainId,
        terminal,
        projectId: BigInt(project.projectId),
        token: NATIVE_TOKEN,
        amount: 100n,
        beneficiary,
        slippageBps: 100n,
      });
      expect(sdk.metadata === base).toBe(!swapsWhenQuoted);
      const args = decodeFunctionData({ abi: jbMultiTerminalAbi, data: plan.calls[0]!.data }).args!;
      expect([args[4], args[6]]).toEqual([sdk.minReturnedTokens, sdk.metadata]);
      // The SDK previewed the tentative quote too; the specs the service checked are for what it sends.
      expect(servicePreviews.some(([request]) => request.args?.[4] !== sdk.metadata)).toBe(true);
      expect(servicePreviews.at(-1)?.[0].args?.[4]).toBe(sdk.metadata);
    }
  });

  it("refuses a swap quote while prepareUserPay cannot read the pool's price, and quotes once it can", async () => {
    let readable = false;
    const swapping = (metadata: Hex) =>
      fixture({
        dataHook: registry,
        beneficiaryCount: 0n,
        payHooks: [{ hook: buybackHook, noop: false, amount: 100n, metadata }],
      });
    const f = swapping(payHookMetadata({ skipSplits: true, poolId }));
    await servePool(f, () => readable);
    const refused = { code: 'PAY_SWAP_QUOTE_FAILED', retryable: true };
    await expect(f.service.quotePay(sdkPayInput)).rejects.toMatchObject(refused);
    await expect(f.service.preparePay(sdkPayInput)).rejects.toMatchObject(refused);
    const warned = (warnings: string[]) =>
      warnings.some((warning) => warning.startsWith(PAY_QUOTE_FAILED_MESSAGE));
    // Caller metadata whose buyback entry carries its own minimum is protected by it.
    const withMinimum = swapping(payHookMetadata({ skipSplits: true, explicit: true, poolId }));
    expect(warned((await withMinimum.service.preparePay(payInput)).warnings)).toBe(false);
    // Once the pool reads, the same service quotes and plans with no notice, and the quote's metadata can be sent back.
    readable = true;
    const quoted = await f.service.quotePay(sdkPayInput);
    expect(warned(quoted.warnings)).toBe(false);
    expect(warned((await f.service.preparePay(sdkPayInput)).warnings)).toBe(false);
    expect(
      warned((await f.service.preparePay({ ...sdkPayInput, metadata: quoted.metadata })).warnings),
    ).toBe(false);
  });

  it('supports the recorded 1.1.1 hook without accepting another generation or a partial buyback', async () => {
    const legacy = '0x77bee1ad2ac0ace98a9b5b58d75685c8b4d94948' as Address;
    const metadata = payHookMetadata().slice(0, 2 + 15 * 64) as Hex;
    const legacyFixture = (hookMetadata = metadata, hook = legacy) =>
      fixture({
        dataHook: registry,
        resolvedBuyback: hook,
        beneficiaryCount: 0n,
        payHooks: [{ hook, noop: false, amount: 100n, metadata: hookMetadata }],
      });
    const plan = await legacyFixture().service.preparePay({ ...payInput, memo: 'beep:demo' });
    expect(plan.summary).toMatchObject({
      beneficiaryTokenCount: '250',
      minimumBeneficiaryTokenCount: '247',
    });
    expect(
      decodeFunctionData({ abi: jbMultiTerminalAbi, data: plan.calls[0]!.data }).args?.slice(4),
    ).toEqual([247n, 'beep:demo', '0x']);
    expect(plan.warnings.join(' ')).toContain('1.1.1');
    await expect(
      legacyFixture(metadata, buybackHook).service.preparePay(payInput),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CONFIGURATION' });
    await expect(
      legacyFixture(payHookMetadata()).service.preparePay(payInput),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CONFIGURATION' });
    await expect(
      legacyFixture(
        payHookMetadata({ partialMint: 1n }).slice(0, 2 + 15 * 64) as Hex,
      ).service.preparePay(payInput),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CONFIGURATION' });
  });

  it('does not add buyback output twice when router previews have already normalized it', async () => {
    const { service } = fixture({
      dataHook: registry,
      beneficiaryCount: 832n,
      primaryTerminal: v6Address('JBRouterTerminalRegistry', project.chainId),
      payHooks: [{ hook: buybackHook, noop: false, amount: 100n, metadata: payHookMetadata() }],
    });
    const quote = await service.quotePay(payInput);
    expect(quote).toMatchObject({
      beneficiaryTokenCount: '250',
      reservedTokenCount: '50',
      minimumBeneficiaryTokenCount: '247',
      rawTerminalPreview: { semantics: 'router-normalized', beneficiaryTokenCount: '832' },
    });
  });

  it('refuses custom controllers, unknown active hooks, historical buyback formats, and unmodeled opt-outs', async () => {
    await expect(
      fixture({ customController: custom }).service.preparePay(payInput),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CONFIGURATION' });
    await expect(fixture({ dataHook: custom }).service.preparePay(payInput)).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONFIGURATION',
    });
    await expect(
      fixture({ dataHook: registry, resolvedBuyback: custom }).service.preparePay(payInput),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CONFIGURATION' });
    await expect(
      fixture({
        dataHook: registry,
        payHooks: [
          {
            hook: buybackHook,
            noop: false,
            amount: 100n,
            metadata: payHookMetadata({ skipSplits: true, partialMint: 1n }),
          },
        ],
      }).service.preparePay(payInput),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CONFIGURATION' });
  });

  it('plans a skipSplits payment at the payer metadata minimum, or the beneficiary mint share without one', async () => {
    // The pay card's request (SDK buildUserPayMetadata): the registry's (0, minimum, skipSplits).
    const request = (minimum: bigint) =>
      createHookMetadata(
        [hookMetadataId(registry, 'pay')],
        [encodeAbiParameters(parseAbiParameters('uint256,uint256,bool'), [0n, minimum, true])],
      ) as Hex;
    const skipping = (explicit: boolean, slippageBps = 100, noop = false) =>
      fixture({
        dataHook: registry,
        beneficiaryCount: noop ? 400n : 0n,
        payHooks: [
          {
            hook: buybackHook,
            noop,
            amount: noop ? 0n : 100n,
            metadata: payHookMetadata({ skipSplits: true, explicit }),
          },
        ],
      }).service.preparePay({ ...payInput, slippageBps, metadata: request(explicit ? 300n : 0n) });
    const explicit = await skipping(true);
    expect(
      decodeFunctionData({ abi: jbMultiTerminalAbi, data: explicit.calls[0]!.data }).args?.[6],
    ).toBe(request(300n));
    expect(explicit.summary).toMatchObject({
      beneficiaryTokenCount: '300',
      reservedTokenCount: '0',
      minimumBeneficiaryTokenCount: '300',
    });
    expect(
      decodeFunctionData({ abi: jbMultiTerminalAbi, data: explicit.calls[0]!.data }).args?.[4],
    ).toBe(300n);
    expect(explicit.warnings.join(' ')).toContain('skips the reserved split');
    const derived = await skipping(false);
    expect(derived.summary).toMatchObject({
      beneficiaryTokenCount: '198',
      minimumBeneficiaryTokenCount: '196',
    });
    // The swap and the leftover mint each round down once, so even zero slippage keeps two units.
    expect((await skipping(false, 0)).summary).toMatchObject({
      minimumBeneficiaryTokenCount: '198',
    });
    expect((await skipping(true, 0)).summary).toMatchObject({
      minimumBeneficiaryTokenCount: '300',
    });
    // A noop spec leaves the payment on the mint path: the terminal's own preview counts.
    expect((await skipping(false, 100, true)).summary).toMatchObject({
      beneficiaryTokenCount: '400',
      minimumBeneficiaryTokenCount: '396',
    });
  });

  it('checks registry forwarding targets even when the outer call goes directly to the canonical router', async () => {
    const { service } = fixture({
      primaryTerminal: v6Address('JBRouterTerminal', project.chainId),
      routerTarget: custom,
    });
    await expect(service.preparePay(payInput)).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONFIGURATION',
    });
  });

  it('allows a known NFT callback but refuses nested tier split money flows without an adapter', async () => {
    const options = { dataHook: v6Address('REVOwner', project.chainId), tieredHook: custom };
    const quote = await fixture({
      ...options,
      payHooks: [{ hook: custom, noop: false, amount: 0n, metadata: '0x' }],
    }).service.quotePay(payInput);
    expect(quote.warnings.join(' ')).toContain('NFT allocation');
    await expect(
      fixture({
        ...options,
        payHooks: [{ hook: custom, noop: false, amount: 1n, metadata: '0x' }],
      }).service.preparePay(payInput),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CONFIGURATION' });
  });

  it('recognizes a verified direct NFT clone and preserves its implementation-keyed mint metadata', async () => {
    const metadata = build721PayMetadata({
      metadataIdTarget: nftImplementation,
      tierIdsToMint: [1n],
      allowOverspending: false,
    });
    const { service, getBytecode, readContract } = fixture({
      dataHook: custom,
      nftClone: custom,
      payHooks: [{ hook: custom, noop: false, amount: 0n, metadata: '0x' }],
    });
    const plan = await service.preparePay({ ...payInput, metadata });
    expect(getBytecode).toHaveBeenCalledWith({ address: custom });
    expect(
      readContract.mock.calls.find(
        ([request]) => request.functionName === 'METADATA_ID_TARGET',
      )?.[0].address,
    ).toBe(custom);
    expect(
      decodeFunctionData({ abi: jbMultiTerminalAbi, data: plan.calls[0]!.data }).args?.[6],
    ).toBe(metadata);
    await expect(fixture({ dataHook: custom }).service.preparePay(payInput)).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONFIGURATION',
    });
    await expect(
      fixture({ dataHook: custom, nftClone: custom, nftProjectId: 99n }).service.preparePay(
        payInput,
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CONFIGURATION' });
  });

  it('checks the current omnichain wrapper NFT and extra hook instead of inferring base economics', async () => {
    const { service, readContract } = fixture({
      dataHook: omni,
      tieredHook: custom,
      extraDataHook: registry,
      beneficiaryCount: 0n,
      payHooks: [
        { hook: custom, noop: false, amount: 0n, metadata: '0x' },
        { hook: buybackHook, noop: false, amount: 100n, metadata: payHookMetadata() },
      ],
    });
    const quote = await service.quotePay(payInput);
    expect(quote).toMatchObject({
      beneficiaryTokenCount: '250',
      minimumBeneficiaryTokenCount: '247',
    });
    expect(
      readContract.mock.calls.find(([request]) => request.functionName === 'extraDataHookOf')?.[0],
    ).toMatchObject({ address: omni, args: [12n, 3n] });
    await expect(
      fixture({ dataHook: omni, tieredHook: custom, extraDataHook: token }).service.preparePay(
        payInput,
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CONFIGURATION' });
    const inactive = await fixture({
      dataHook: omni,
      tieredHook: custom,
      extraDataHook: token,
      extraPayEnabled: false,
    }).service.quotePay(payInput);
    expect(inactive.beneficiaryTokenCount).toBe('101');
  });
});

describe('cash-out quotes', () => {
  it('floors final net using the preview tax, with caller-aware fee evidence', async () => {
    const { service, readContract } = fixture({ cashGross: 101n, cashTax: 1n });
    const plan = await service.prepareCashOut(cashInput);
    expect(plan.summary).toMatchObject({
      treasuryGross: '101',
      treasuryProtocolFee: '2',
      expectedReturn: '99',
      minimumReturn: '98',
    });
    expect(
      decodeFunctionData({ abi: jbMultiTerminalAbi, data: plan.calls[0]!.data }).args?.[4],
    ).toBe(98n);
    expect(
      readContract.mock.calls.find(([request]) => request.functionName === 'isFeelessFor')?.[0],
    ).toMatchObject({
      address: feeless,
      args: [beneficiary, 12n, account],
    });
    expect(
      readContract.mock.calls.find(
        ([request]) => request.functionName === 'previewCashOutFrom',
      )?.[0].account,
    ).toBe(account);
  });

  it('charges zero-tax round-trip fees only on tracked fee-free surplus and preserves feeless grants', async () => {
    const ordinary = await fixture({ cashTax: 0n, feeFreeSurplus: 40n }).service.quoteCashOut(
      cashInput,
    );
    expect(ordinary).toMatchObject({
      treasuryProtocolFee: '1',
      treasuryNet: '100',
      minimumReturn: '99',
    });
    const exempt = await fixture({ beneficiaryIsFeeless: true, cashTax: 1n }).service.quoteCashOut(
      cashInput,
    );
    expect(exempt).toMatchObject({ treasuryProtocolFee: '0', treasuryNet: '101' });
    await expect(
      fixture({ errorOn: 'isFeelessFor' }).service.quoteCashOut(cashInput),
    ).rejects.toThrow();
    await expect(
      fixture({ cashTax: 0n, errorOn: 'feeFreeSurplusOf' }).service.quoteCashOut(cashInput),
    ).rejects.toThrow();
  });

  it('locks AMM minima in metadata and submits exactly the re-previewed bytes', async () => {
    const minimum = 198n;
    const locked = buildBuybackCashOutMetadata({
      hook: buybackHook,
      minimumSwapAmountOut: minimum,
    });
    const { service, readContract } = fixture({
      dataHook: registry,
      cashPreview: (metadata) => [
        ruleset,
        0n,
        10000n,
        [
          {
            hook: buybackHook,
            noop: false,
            amount: 0n,
            metadata: cashHookMetadata(metadata === '0x' ? 200n : minimum, metadata !== '0x'),
          },
        ],
      ],
    });
    const plan = await service.prepareCashOut(cashInput);
    expect(plan.summary).toMatchObject({
      route: 'amm',
      terminalMinimum: '0',
      minimumReturn: '198',
      metadata: locked,
    });
    expect(
      readContract.mock.calls
        .filter(([request]) => request.functionName === 'previewCashOutFrom')
        .map(([request]) => request.args?.[5]),
    ).toEqual(['0x', locked]);
    expect(decodeFunctionData({ abi: jbMultiTerminalAbi, data: plan.calls[0]!.data }).args).toEqual(
      [account, 12n, 100n, NATIVE_TOKEN, 0n, beneficiary, locked],
    );
  });

  it('rejects SDK zero-floor fallback when a slippage-protected pool quote no longer beats direct cash-out', async () => {
    const { service } = fixture({
      dataHook: registry,
      cashPreview: () => [
        ruleset,
        0n,
        10000n,
        [
          {
            hook: buybackHook,
            noop: false,
            amount: 0n,
            metadata: cashHookMetadata(101n, false, 100n),
          },
        ],
      ],
    });
    await expect(service.prepareCashOut(cashInput)).rejects.toMatchObject({
      code: 'CASH_OUT_ROUTE_REQUIRES_REQUOTE',
    });
  });

  it('never prepares a zero-output burn and requires a registered treasury terminal', async () => {
    expect((await fixture({ cashGross: 0n }).service.quoteCashOut(cashInput)).expectedReturn).toBe(
      '0',
    );
    await expect(
      fixture({ cashGross: 0n }).service.prepareCashOut(cashInput),
    ).rejects.toMatchObject({ code: 'NOTHING_TO_RECLAIM' });
    await expect(
      fixture({ registered: false }).service.prepareCashOut(cashInput),
    ).rejects.toMatchObject({ code: 'TERMINAL_NOT_REGISTERED' });
  });
});

describe('payout quotes', () => {
  it('quotes with minimum zero at the evidence block then protects exact same-currency gross', async () => {
    const { service, simulateContract } = fixture();
    const plan = await service.preparePayout(payoutInput);
    expect(simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({
        account,
        blockNumber: 123n,
        functionName: 'sendPayoutsOf',
        args: [12n, NATIVE_TOKEN, 100n, 61166n, 0n],
      }),
    );
    expect(
      decodeFunctionData({ abi: jbMultiTerminalAbi, data: plan.calls[0]!.data }).args?.[4],
    ).toBe(101n);
    expect(plan.summary).toMatchObject({
      grossAmountRecorded: '101',
      minimumGrossAmountRecorded: '101',
      slippageBps: 0,
    });
    expect(plan.warnings.join(' ')).toContain('do not guarantee delivery');
  });

  it('applies slippage only to converted currency, and does not prepare zero-payout calls', async () => {
    const plan = await fixture().service.preparePayout({ ...payoutInput, currency: 2 });
    expect(
      decodeFunctionData({ abi: jbMultiTerminalAbi, data: plan.calls[0]!.data }).args?.[4],
    ).toBe(99n);
    expect(plan.summary).toMatchObject({
      isCurrencyConversion: true,
      minimumGrossAmountRecorded: '99',
    });
    expect(
      (await fixture({ grossPayout: 0n }).service.quotePayout(payoutInput)).grossAmountRecorded,
    ).toBe('0');
    await expect(
      fixture({ grossPayout: 0n }).service.preparePayout(payoutInput),
    ).rejects.toMatchObject({ code: 'NOTHING_TO_PAY_OUT' });
  });
});
