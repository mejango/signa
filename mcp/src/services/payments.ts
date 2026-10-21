import {
  NATIVE_TOKEN,
  jbBuybackHookRegistryAbi,
  jbDirectoryAbi,
  jbMultiTerminalAbi,
  jbOmnichainDeployerAbi,
  revOwnerAbi,
} from '@bananapus/nana-sdk-core';
import {
  buildPayTx,
  getCurrentRuleset,
  PAY_MAX_SLIPPAGE_BPS,
  PAY_QUOTE_FAILED_MESSAGE,
  prepareHookAwareCashOut,
  prepareUserPay,
  previewPay,
  resolvePaymentTerminal,
  slippageFloor,
  v6Address,
} from '@bananapus/nana-sdk-core/v6';
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  parseAbi,
  parseAbiParameters,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { DomainError } from '../domain/errors.js';
import { jsonSafe } from '../domain/json.js';
import { verify721Hook } from '../domain/products.js';
import { resolveRouterTerminal } from '../domain/routing.js';
import { deploymentAddresses } from './rollout.js';
import type {
  ChainId,
  PlanDraft,
  PreparedCall,
  ProjectRef,
  RpcProvider,
  RpcSnapshot,
  BlockEvidence,
} from '../domain/types.js';

export interface PayInput {
  /** Optional receipt correlation text, bounded to 256 UTF-8 bytes. */
  memo?: string;
  project: ProjectRef;
  /** Required even for previews: data hooks may depend on the payer. */
  account: Address;
  token: Address;
  amount: string;
  beneficiary: Address;
  slippageBps?: number;
  metadata?: Hex;
  /** Without metadata: whether swapped tokens skip the reserved split. Defaults to true. */
  skipSplits?: boolean;
}

export interface CashOutInput {
  project: ProjectRef;
  holder: Address;
  cashOutCount: string;
  tokenToReclaim: Address;
  beneficiary: Address;
  /** Quotes default to holder; operators must provide their actual account. */
  account?: Address;
  slippageBps?: number;
  terminal?: Address;
}

export interface PayoutInput {
  project: ProjectRef;
  account: Address;
  token: Address;
  /** Integer in accounting-token decimals, denominated in `currency`. */
  amount: string;
  currency: number;
  slippageBps?: number;
  terminal?: Address;
}

type HookSpec = { hook: Address; noop: boolean; amount: bigint; metadata: Hex };
type PaymentTerminal = Awaited<ReturnType<PaymentService['paymentTerminal']>>;
type RulesetContext = Awaited<ReturnType<typeof getCurrentRuleset>> & {
  controller: Address;
  buybackHook: Address;
  revOwner: Address | undefined;
  tieredHook: Address | undefined;
};

const feelessAbi = parseAbi([
  'function isFeelessFor(address addr, uint256 projectId, address caller) view returns (bool)',
]);
// This exact V6 tuple is emitted by canonical JBBuybackHook.beforePayRecordedWith.
// Its rawSwapQuote is diagnostic. Only beneficiary/reserved amounts are used here.
const buybackPaySpecParameters = parseAbiParameters(
  'bool projectTokenIs0, uint256 amountToMintWith, uint256 minimumSwapAmountOut, bool hasUserSpecifiedQuote, address controller, uint256 tokenCountWithoutHook, uint256 weightRatio, uint256 amountToSwapWith, int24 twapTick, uint128 twapLiquidity, bytes32 poolId, uint256 minimumBeneficiaryTokenCount, uint256 minimumReservedTokenCount, uint256 rawSwapQuote, bool oracleUnseeded, bool skipSplits, uint256 reservedPercent',
);

// Executed 1.1.1 deployment, retained by the rollout catalog for existing projects.
// Source 7bf3c6bad283c39e714d6edd7418ee041ef384e8, JBBuybackHook.sol:
// keccak256 0x228c41a61a032067c67e79cba946dd21f9fe5e039307456376318a0a464b485e
// matches the deployment's compiler metadata. This generation has no skipSplits word.
const buyback111 = '0x77bee1ad2ac0ace98a9b5b58d75685c8b4d94948' as Address;
const buyback111PaySpecParameters = parseAbiParameters(
  'bool projectTokenIs0, uint256 amountToMintWith, uint256 minimumSwapAmountOut, bool hasUserSpecifiedQuote, address controller, uint256 tokenCountWithoutHook, uint256 weightRatio, uint256 amountToSwapWith, int24 twapTick, uint128 twapLiquidity, bytes32 poolId, uint256 minimumBeneficiaryTokenCount, uint256 minimumReservedTokenCount, uint256 rawSwapQuote, bool oracleUnseeded',
);

function same(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
function isNative(token: Address): boolean {
  return same(token, NATIVE_TOKEN);
}
function unsupported(message: string): never {
  throw new DomainError('UNSUPPORTED_CONFIGURATION', message);
}
function uint(value: string, name: string, positive = true): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || value.length > 78) {
    throw new DomainError('INVALID_AMOUNT', `${name} must be a base-10 integer string.`);
  }
  const result = BigInt(value);
  if (result >= 1n << 256n || (positive && result === 0n)) {
    throw new DomainError('INVALID_AMOUNT', `${name} is outside the supported uint256 range.`);
  }
  return result;
}
function bps(value = 100, maximum = 1000n): bigint {
  if (!Number.isInteger(value) || value < 0 || BigInt(value) > maximum) {
    throw new DomainError(
      'INVALID_SLIPPAGE',
      `Slippage must be between 0 and ${maximum} basis points.`,
    );
  }
  return BigInt(value);
}

/** Preserve RpcProvider's block pin while supplying the real msg.sender to SDK views. */
function asAccount(
  client: PublicClient,
  account: Address,
  observed?: (request: Record<string, unknown>, result: unknown) => void,
): PublicClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property !== 'readContract') return Reflect.get(target, property, receiver);
      return async (request: Record<string, unknown>) => {
        const result = await target.readContract({ ...request, account } as Parameters<
          PublicClient['readContract']
        >[0]);
        observed?.(request, result);
        return result;
      };
    },
  });
}

function call(
  chainId: ChainId,
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
  label: string,
  value = 0n,
  dependsOn: number[] = [],
): PreparedCall {
  const data = encodeFunctionData({ abi, functionName, args });
  const decoded = decodeFunctionData({ abi, data });
  return {
    chainId,
    to: address,
    data,
    value: value.toString(),
    label,
    dependsOn,
    decoded: { functionName: decoded.functionName, args: jsonSafe(decoded.args) },
  };
}

/**
 * Financial quote and calldata boundary. RPC failures propagate as unavailable;
 * no price, allowance, fee flag, or failed preview is replaced by a zero.
 */
/** A project's payment route (controller, ruleset, hooks, terminal) is kept this long. Payments to
 * one project arrive minutes apart, every quote is still previewed live and the route is re-read on a
 * ruleset change; a terminal or hook swap inside this window only makes the plan's own simulation fail. */
const routeLifetimeMs = 1_800_000;
type RouteEntry = {
  at: number;
  evidence: BlockEvidence;
  context: RulesetContext;
  terminal: PaymentTerminal;
};
export class PaymentService {
  constructor(private readonly rpc: RpcProvider) {}
  /** A project's controller, ruleset, hooks and payment terminal change rarely; one read serves
   * the payments of the next minutes. The live preview still binds every quote to the current
   * ruleset, and a disagreement drops the entry and reads again. */
  private readonly recentProjects = new Map<string, RouteEntry>();
  private readonly routeReads = new Map<string, Promise<RouteEntry>>();
  private async payRoute(
    client: PublicClient,
    evidence: BlockEvidence,
    project: ProjectRef,
    token: Address,
  ) {
    const key = `${project.chainId}:${uint(project.projectId, 'projectId')}:${token.toLowerCase()}`;
    const now = Date.now();
    const kept = this.recentProjects.get(key);
    if (kept && now - kept.at < routeLifetimeMs) {
      // Past half its life a kept route is read again behind the quote, so a project paid at least
      // every quarter hour never waits on a cold read. A failed re-read keeps the entry to its end.
      if (now - kept.at >= routeLifetimeMs / 2)
        this.readRoute(key, client, evidence, project, token).catch(() => undefined);
      return { key, fresh: false, ...kept };
    }
    return { key, fresh: true, ...(await this.readRoute(key, client, evidence, project, token)) };
  }
  /** Reads a route ahead of its next quote when it is missing or past half its life. */
  async warm(project: ProjectRef, token: Address) {
    const key = `${project.chainId}:${uint(project.projectId, 'projectId')}:${token.toLowerCase()}`;
    const kept = this.recentProjects.get(key);
    if (kept && Date.now() - kept.at < routeLifetimeMs / 2) return false;
    const snapshot = await this.rpc.snapshot(project.chainId);
    await this.readRoute(key, snapshot.client, snapshot.evidence, project, token);
    return true;
  }
  /** One read per route at a time; whoever asks meanwhile joins it. */
  private readRoute(
    key: string,
    client: PublicClient,
    evidence: BlockEvidence,
    project: ProjectRef,
    token: Address,
  ) {
    let reading = this.routeReads.get(key);
    if (!reading) {
      reading = Promise.all([
        this.context(client, project, 'pay'),
        this.paymentTerminal(client, project, token),
      ])
        .then(([context, terminal]) => {
          const now = Date.now();
          // Any caller can name any token; expired entries go on every write so the map stays small.
          for (const [other, entry] of this.recentProjects)
            if (now - entry.at >= routeLifetimeMs) this.recentProjects.delete(other);
          const entry = { at: now, evidence, context, terminal };
          this.recentProjects.set(key, entry);
          return entry;
        })
        .finally(() => this.routeReads.delete(key));
      this.routeReads.set(key, reading);
    }
    return reading;
  }

  async quotePay(input: PayInput) {
    return (await this.pay(input)).quote;
  }

  async preparePay(input: PayInput, at?: BlockEvidence): Promise<PlanDraft> {
    return this.preparePayment(input, undefined, at);
  }

  /** Internal NFT composition: a zero payment still requires the verified active tiers hook.
   * The product service additionally checks tier minting, credits and overspending. */
  async prepareNftPay(input: PayInput, verifiedHook: Address): Promise<PlanDraft> {
    return this.preparePayment(input, verifiedHook);
  }

  private async preparePayment(
    input: PayInput,
    verifiedNftHook?: Address,
    at?: BlockEvidence,
  ): Promise<PlanDraft> {
    // The allowance depends only on the terminal: read beside the preview, not after it.
    const {
      quote,
      transaction,
      beside: allowance = 0n,
    } = await this.pay(
      input,
      (client, terminal) =>
        isNative(input.token) || input.amount === '0'
          ? Promise.resolve(0n)
          : client.readContract({
              address: input.token,
              abi: erc20Abi,
              functionName: 'allowance',
              args: [input.account, terminal],
            }),
      at,
      verifiedNftHook,
    );
    const calls: PreparedCall[] = [];
    if (!isNative(input.token) && quote.payment.amount !== '0') {
      const amount = BigInt(quote.payment.amount);
      if (allowance < amount) {
        if (allowance > 0n) {
          calls.push(
            call(
              input.project.chainId,
              input.token,
              erc20Abi,
              'approve',
              [transaction.address, 0n],
              'Reset the existing insufficient token allowance',
            ),
          );
        }
        calls.push(
          call(
            input.project.chainId,
            input.token,
            erc20Abi,
            'approve',
            [transaction.address, amount],
            'Approve exactly this payment amount',
            0n,
            calls.length ? [calls.length - 1] : [],
          ),
        );
      }
    }
    calls.push(
      call(
        input.project.chainId,
        transaction.address,
        transaction.abi,
        transaction.functionName,
        transaction.args,
        'Pay the project through its resolved terminal',
        transaction.value,
        calls.length ? [calls.length - 1] : [],
      ),
    );
    return {
      operation: 'pay',
      account: input.account,
      project: input.project,
      calls,
      evidence: quote.evidence,
      summary: quote,
      warnings: [
        ...quote.warnings,
        ...(calls.length > 1
          ? [
              'Confirm each approval and verify its resulting allowance before simulating the dependent step. The payment has not been simulated with artificial balances or allowances.',
            ]
          : []),
      ],
    };
  }

  async quoteCashOut(input: CashOutInput) {
    return (await this.cashOut(input)).quote;
  }

  async prepareCashOut(input: CashOutInput & { account: Address }): Promise<PlanDraft> {
    const { quote, prepared } = await this.cashOut(input);
    if (prepared.route.expectedReturn === 0n || prepared.route.minimumReturn === 0n) {
      throw new DomainError(
        'NOTHING_TO_RECLAIM',
        'The verified cash-out quote returns zero; no token-burning transaction was prepared.',
      );
    }
    const tx = prepared.transaction;
    return {
      operation: 'cash_out',
      account: input.account,
      project: input.project,
      calls: [
        call(
          input.project.chainId,
          tx.address,
          tx.abi,
          tx.functionName,
          tx.args,
          'Cash out project tokens',
        ),
      ],
      evidence: quote.evidence,
      summary: quote,
      warnings: quote.warnings,
    };
  }

  async quotePayout(input: PayoutInput) {
    return (await this.payout(input)).quote;
  }

  async preparePayout(input: PayoutInput): Promise<PlanDraft> {
    const { quote, transaction } = await this.payout(input);
    if (quote.grossAmountRecorded === '0') {
      throw new DomainError(
        'NOTHING_TO_PAY_OUT',
        'The verified payout simulation records zero; no payout transaction was prepared.',
      );
    }
    return {
      operation: 'payout',
      account: input.account,
      project: input.project,
      calls: [transaction],
      evidence: quote.evidence,
      summary: quote,
      warnings: quote.warnings,
    };
  }

  private async context(
    client: PublicClient,
    project: ProjectRef,
    operation: 'pay' | 'cashOut' | 'payout',
  ): Promise<RulesetContext> {
    const projectId = uint(project.projectId, 'projectId');
    // The controller and the ruleset depend only on the project: one round trip for both.
    const [controller, current] = await Promise.all([
      client.readContract({
        address: v6Address('JBDirectory', project.chainId),
        abi: jbDirectoryAbi,
        functionName: 'controllerOf',
        args: [projectId],
      }),
      getCurrentRuleset(client, { chainId: project.chainId, projectId }),
    ]);
    if (same(controller, zeroAddress))
      throw new DomainError('PROJECT_NOT_FOUND', 'The project has no current controller.');
    if (!same(controller, v6Address('JBController', project.chainId))) {
      unsupported(
        'The current directory controller is custom. Its economic semantics need an audited adapter before preparing transactions.',
      );
    }
    if (BigInt(current.ruleset.id) === 0n)
      throw new DomainError(
        'NO_ACTIVE_RULESET',
        'The project has no active ruleset at the quoted block.',
      );
    let buybackHook: Address = zeroAddress;
    let revOwner: Address | undefined;
    let tieredHook: Address | undefined;
    const enabled =
      operation === 'pay'
        ? current.metadata.useDataHookForPay
        : operation === 'cashOut'
          ? current.metadata.useDataHookForCashOut
          : false;
    const verifyTiered = async (hook: Address) => {
      await verify721Hook(client, project, hook);
      if (tieredHook && !same(tieredHook, hook))
        unsupported(
          'Multiple NFT tiers hooks in one payment require a dedicated composition adapter.',
        );
      tieredHook = hook;
    };
    const inspectHook = async (hook: Address, depth = 0): Promise<void> => {
      if (same(hook, zeroAddress)) return;
      const knownBuybacks = deploymentAddresses('JBBuybackHook', project.chainId);
      const canonicalRegistry = v6Address('JBBuybackHookRegistry', project.chainId);
      if (knownBuybacks.some((address) => same(hook, address))) buybackHook = hook;
      else if (
        same(hook, canonicalRegistry) ||
        same(hook, v6Address('REVOwner', project.chainId))
      ) {
        // The revnet's registry, its NFT hook and the registry's hook depend only on the
        // project: one round trip for all of them.
        const [registry, tiered, resolved] = await Promise.all([
          same(hook, v6Address('REVOwner', project.chainId))
            ? client.readContract({ address: hook, abi: revOwnerAbi, functionName: 'BUYBACK_HOOK' })
            : undefined,
          same(hook, v6Address('REVOwner', project.chainId)) && operation === 'pay'
            ? client.readContract({
                address: hook,
                abi: revOwnerAbi,
                functionName: 'tiered721HookOf',
                args: [projectId],
              })
            : undefined,
          client.readContract({
            address: canonicalRegistry,
            abi: jbBuybackHookRegistryAbi,
            functionName: 'hookOf',
            args: [projectId],
          }),
        ]);
        if (same(hook, v6Address('REVOwner', project.chainId))) {
          revOwner = hook;
          if (!same(registry!, canonicalRegistry))
            unsupported('This revnet uses a custom buyback registry.');
          if (tiered !== undefined && !same(tiered, zeroAddress)) await verifyTiered(tiered);
        }
        buybackHook = resolved;
        if (
          !same(buybackHook, zeroAddress) &&
          !knownBuybacks.some((address) => same(buybackHook, address))
        ) {
          unsupported(
            'The project resolves to a custom or historical buyback hook whose settlement format is not supported.',
          );
        }
      } else if (same(hook, v6Address('JBOmnichainDeployer', project.chainId))) {
        if (depth !== 0)
          unsupported(
            'Nested omnichain data-hook wrappers require a dedicated composition adapter.',
          );
        const rulesetId = BigInt(current.ruleset.id);
        const [[tiered, usesTieredCashOut], extra] = await Promise.all([
          client.readContract({
            address: hook,
            abi: jbOmnichainDeployerAbi,
            functionName: 'tiered721HookOf',
            args: [projectId, rulesetId],
          }),
          client.readContract({
            address: hook,
            abi: jbOmnichainDeployerAbi,
            functionName: 'extraDataHookOf',
            args: [projectId, rulesetId],
          }),
        ]);
        const hasTiered = !same(tiered, zeroAddress) && (operation === 'pay' || usesTieredCashOut);
        if (hasTiered) await verifyTiered(tiered);
        // The canonical wrapper deliberately skips extra cash-out hooks when
        // the NFT hook supplies the cash-out weight. Mirror that composition;
        // do not treat an inactive custom extra hook as part of this route.
        const usesExtra =
          operation === 'pay'
            ? extra.useDataHookForPay
            : operation === 'cashOut' && !hasTiered
              ? extra.useDataHookForCashOut
              : false;
        if (usesExtra) await inspectHook(extra.dataHook, depth + 1);
      } else {
        // Direct NFT data hooks are clone addresses. Match their actual runtime
        // to the canonical implementation and verify all immutable links; a
        // familiar ABI or a claimed STORE address alone cannot establish trust.
        try {
          await verifyTiered(hook);
        } catch (error) {
          if (
            error instanceof DomainError &&
            ['UNSUPPORTED_721_HOOK', 'INVALID_721_IDENTITY'].includes(error.code)
          ) {
            unsupported(
              'The active data hook is neither a supported canonical hook nor a verified canonical NFT tiers clone.',
            );
          }
          throw error;
        }
      }
    };
    if (enabled) await inspectHook(current.metadata.dataHook);
    return { ...current, controller, buybackHook, revOwner, tieredHook };
  }

  private async paymentTerminal(client: PublicClient, project: ProjectRef, token: Address) {
    const resolved = await resolvePaymentTerminal(client, {
      chainId: project.chainId,
      projectId: BigInt(project.projectId),
      token,
    });
    const multi = v6Address('JBMultiTerminal', project.chainId);
    const registry = v6Address('JBRouterTerminalRegistry', project.chainId);
    if (same(resolved.address, multi))
      return {
        address: resolved.address,
        isRouter: false,
        previewSemantics: 'issuance' as const,
        path: [resolved.address],
        gateway: null,
      };
    // The route and the project's terminal list depend only on what is known here: one round
    // trip for both, and the candidate destinations are resolved together.
    const [route, terminals] = await Promise.all([
      resolveRouterTerminal(client, project, resolved.address),
      client.readContract({
        address: v6Address('JBDirectory', project.chainId),
        abi: jbDirectoryAbi,
        functionName: 'terminalsOf',
        args: [BigInt(project.projectId)],
      }),
    ]);
    if (same(route.terminal, zeroAddress))
      throw new DomainError(
        'NO_PAYMENT_ROUTE',
        'The router registry has no effective terminal for this project.',
      );
    const routers = deploymentAddresses('JBRouterTerminal', project.chainId);
    if (!same(route.router, multi) && !routers.some((address) => same(address, route.router)))
      unsupported('The resolved payment terminal is custom and has no supported quote adapter.');
    if (!same(route.router, multi)) {
      // A known outer forwarder does not establish the identity of its candidate destinations.
      const candidates = terminals.filter((terminal) => !same(terminal, multi));
      const resolvedCandidates = await Promise.all(
        candidates.map((terminal) =>
          same(terminal, resolved.address)
            ? route
            : resolveRouterTerminal(client, project, terminal),
        ),
      );
      for (const [index, terminal] of candidates.entries()) {
        const candidate = resolvedCandidates[index]!;
        if (
          !same(candidate.router, zeroAddress) &&
          !same(candidate.router, multi) &&
          !routers.some((address) => same(address, candidate.router))
        )
          unsupported(
            same(terminal, registry)
              ? 'A candidate destination registry forwards to a custom terminal whose settlement is unsupported.'
              : 'The router can select a custom destination terminal; its settlement requires a dedicated adapter.',
          );
      }
    }
    return {
      address: resolved.address,
      isRouter: true,
      previewSemantics: same(route.router, multi)
        ? ('issuance' as const)
        : ('router-normalized' as const),
      path: route.path,
      gateway: route.gateway,
    };
  }

  private async balanceTerminal(
    client: PublicClient,
    project: ProjectRef,
    token: Address,
    requested?: Address,
  ) {
    const canonical = v6Address('JBMultiTerminal', project.chainId);
    const terminal = requested ?? canonical;
    if (!same(terminal, canonical))
      unsupported(
        'Cash-out and payout preparation currently require the canonical V6 multi-terminal.',
      );
    const registered = await client.readContract({
      address: v6Address('JBDirectory', project.chainId),
      abi: jbDirectoryAbi,
      functionName: 'isTerminalOf',
      args: [BigInt(project.projectId), terminal],
    });
    if (!registered)
      throw new DomainError(
        'TERMINAL_NOT_REGISTERED',
        'The requested treasury terminal is not registered for this project at the quoted block.',
      );
    const accounting = await client.readContract({
      address: terminal,
      abi: jbMultiTerminalAbi,
      functionName: 'accountingContextForTokenOf',
      args: [BigInt(project.projectId), token],
    });
    if (!same(accounting.token, token) || same(accounting.token, zeroAddress)) {
      throw new DomainError(
        'TOKEN_NOT_ACCEPTED',
        'The selected treasury terminal has no accounting context for this token.',
      );
    }
    return { terminal, accounting };
  }

  private previewFor(
    client: PublicClient,
    input: PayInput,
    terminal: Address,
    amount: bigint,
    metadata: Hex,
  ) {
    return previewPay(client, {
      chainId: input.project.chainId,
      terminal,
      projectId: BigInt(input.project.projectId),
      token: input.token,
      amount,
      beneficiary: input.beneficiary,
      metadata,
    });
  }
  /** `beside` reads alongside the preview whatever else the plan needs from the resolved terminal. */
  private async pay<T = undefined>(
    input: PayInput,
    beside?: (client: PublicClient, terminal: Address) => Promise<T>,
    at?: BlockEvidence,
    verifiedNftHook?: Address,
  ) {
    if (
      input.memo !== undefined &&
      (typeof input.memo !== 'string' || new TextEncoder().encode(input.memo).length > 256)
    ) {
      throw new DomainError('INVALID_MEMO', 'Payment memo must be at most 256 UTF-8 bytes.');
    }
    const amount = uint(input.amount, 'amount', verifiedNftHook === undefined);
    const slippage = bps(input.slippageBps, PAY_MAX_SLIPPAGE_BPS);
    const requested = Date.now();
    // A head the caller read moments ago pins the quote without another read of it.
    const snapshot =
      at && at.chainId === input.project.chainId && this.rpc.snapshotAt
        ? this.rpc.snapshotAt(input.project.chainId, at)
        : await this.rpc.snapshot(input.project.chainId);
    let fullPreview: readonly unknown[] | undefined;
    const client = asAccount(snapshot.client, input.account, (request, result) => {
      if (request.functionName === 'previewPayFor' && Array.isArray(result)) fullPreview = result;
    });
    if (input.metadata !== undefined && input.skipSplits !== undefined)
      throw new DomainError(
        'INVALID_SKIP_SPLITS',
        'skipSplits applies only when no metadata is supplied.',
      );
    const started = Date.now();
    let route = await this.payRoute(client, snapshot.evidence, input.project, input.token);
    const routed = Date.now();
    // Without caller metadata the SDK sets the metadata and minimum that get the payer the most
    // tokens; the terminal is previewed again with that metadata so its hook specs match it.
    const alongside = (terminal: Address) =>
      Promise.all([
        (input.metadata === undefined
          ? prepareUserPay(client, {
              chainId: input.project.chainId,
              terminal,
              projectId: BigInt(input.project.projectId),
              token: input.token,
              amount,
              beneficiary: input.beneficiary,
              slippageBps: slippage,
              skipSplits: input.skipSplits ?? true,
            })
          : Promise.resolve(undefined)
        ).then(async (prepared) => ({
          prepared,
          preview: await this.previewFor(
            client,
            input,
            terminal,
            amount,
            prepared?.metadata ?? input.metadata ?? '0x',
          ),
        })),
        beside?.(client, terminal),
      ]);
    let [{ prepared, preview }, extra] = await alongside(route.terminal.address);
    // Where a quote's time goes, for the production log; the request line only has the total.
    console.info(
      JSON.stringify({
        service: 'payments',
        action: 'pay_quote',
        route: route.fresh ? 'read' : 'kept',
        snapshotMs: started - requested,
        routeMs: routed - started,
        previewMs: Date.now() - routed,
      }),
    );
    const rulesetOf = () => {
      const previewRuleset = fullPreview?.[0];
      return previewRuleset && typeof previewRuleset === 'object' && 'id' in previewRuleset
        ? String((previewRuleset as { id: unknown }).id)
        : null;
    };
    if (!route.fresh && rulesetOf() !== String(route.context.ruleset.id)) {
      // The kept context is behind the chain (a new ruleset): read it again, once.
      this.recentProjects.delete(route.key);
      route = await this.payRoute(client, snapshot.evidence, input.project, input.token);
      [{ prepared, preview }, extra] = await alongside(route.terminal.address);
    }
    const { context, terminal } = route;
    if (!fullPreview || !Array.isArray(fullPreview[3]))
      throw new DomainError(
        'INVALID_PREVIEW',
        'The terminal did not provide a complete V6 payment preview.',
      );
    if (rulesetOf() !== String(context.ruleset.id)) {
      throw new DomainError(
        'INVALID_PREVIEW',
        'The payment preview ruleset does not match the verified current ruleset.',
      );
    }
    const hooks = fullPreview[3] as HookSpec[];
    if (
      verifiedNftHook !== undefined &&
      (!context.tieredHook ||
        !same(context.tieredHook, verifiedNftHook) ||
        !hooks.some((spec) => same(spec.hook, verifiedNftHook) && !spec.noop))
    )
      throw new DomainError(
        'NFT_HOOK_NOT_INVOKED',
        'The terminal preview will not invoke the verified NFT hook.',
      );
    let beneficiaryTokenCount = preview.beneficiaryTokenCount;
    let reservedTokenCount = preview.reservedTokenCount;
    let quoteBasis: 'terminal-issuance-preview' | 'buyback-hook-indicative-output' =
      'terminal-issuance-preview';
    const warnings = [
      'This quote follows the project terminal route. Direct market acquisition has not been compared, so this is not a best-price claim.',
      'A terminal payment can route funds into a buyback pool or hooks. The full payment is not necessarily retained in the treasury.',
    ];
    if (terminal.gateway)
      warnings.push(
        'The registry-selected gateway takes custody before forwarding to its immutable router. Only failed zero-minimum calls with a valid source-project opt-in can be retained; ordinary failed payments revert. A queued fee is pending, not paid or forgiven.',
      );
    let explicitMinimum: bigint | undefined;
    // The skip word of an active buyback entry that carries no minimum of its own.
    let unquotedSkipSplits: boolean | undefined;
    for (const spec of hooks) {
      if (spec.noop) continue;
      if (context.tieredHook && same(spec.hook, context.tieredHook)) {
        if (spec.amount > 0n)
          unsupported(
            'This NFT tiers hook forwards funds to tier splits, which can invoke nested project payments and arbitrary split hooks. Their economic effects require a dedicated quote adapter.',
          );
        warnings.push(
          'The revnet also invokes its registered NFT tiers hook without forwarding funds to tier splits. This quote describes fungible tokens; NFT allocation needs a separate review.',
        );
        continue;
      }
      if (same(context.buybackHook, zeroAddress) || !same(spec.hook, context.buybackHook))
        unsupported(
          'The pay preview includes an unrecognized active hook. Its final beneficiary output is unknown.',
        );
      const legacy111 = same(context.buybackHook, buyback111);
      if (spec.metadata.length !== 2 + (legacy111 ? 15 : 17) * 64)
        unsupported(
          'The selected historical buyback hook uses an unsupported settlement format; its address remains available in the contract catalog.',
        );
      const decoded = legacy111
        ? decodeAbiParameters(buyback111PaySpecParameters, spec.metadata)
        : decodeAbiParameters(buybackPaySpecParameters, spec.metadata);
      const amountToMintWith = decoded[1];
      const previewController = decoded[4];
      const skipSplits = legacy111 ? false : decoded[15];
      if (!same(previewController, context.controller))
        unsupported('The buyback preview names a different controller.');
      if (amountToMintWith !== 0n)
        unsupported('Partial buyback payments need a dedicated quote adapter.');
      if (quoteBasis === 'buyback-hook-indicative-output')
        unsupported('Multiple active buyback pay specifications are not supported.');
      if (!decoded[3]) unquotedSkipSplits = skipSplits;
      // An active canonical buyback hook returns weight=0: all fungible output
      // comes through this hook. The router may already have normalized its
      // returned counts (even using raw TWAP diagnostics). Replace those counts
      // with this indicative executable quote basis; never add it a second time.
      if (skipSplits) {
        // 1.4 hands swapped tokens to the beneficiary with no reserved split and checks an
        // explicit minimum against the swap plus the beneficiary share of any leftover mint.
        // Without one, it swaps only above the beneficiary's share of a mint
        // (tokenCountWithoutHook) and mints the rest; the swap and that mint each round down
        // once, as the SDK's prepareUserPay allows for.
        const hasUserSpecifiedQuote = decoded[3];
        beneficiaryTokenCount = hasUserSpecifiedQuote
          ? decoded[2]
          : decoded[5] > 2n
            ? decoded[5] - 2n
            : 0n;
        reservedTokenCount = 0n;
        if (hasUserSpecifiedQuote) explicitMinimum = decoded[2];
        warnings.push(
          hasUserSpecifiedQuote
            ? 'The payer skips the reserved split on pool buys. The hook reverts unless the beneficiary receives at least the metadata minimum (swap plus any leftover mint), so that minimum is the payment minimum. A leftover mint still goes through the reserved split, so the reserved count shown is a lower bound.'
            : 'The payer skips the reserved split on pool buys. Without a metadata minimum the hook routes by its TWAP floor; this quote counts only the beneficiary share of a mint, and a leftover mint still goes through the reserved split.',
        );
      } else {
        beneficiaryTokenCount = decoded[11];
        reservedTokenCount = decoded[12];
      }
      quoteBasis = 'buyback-hook-indicative-output';
      warnings.push(
        legacy111
          ? 'Buyback 1.1.1 output is indicative. A total swap failure can fall back to issuance; a successful swap below its oracle minimum reverts. The terminal also enforces the reviewed beneficiary minimum.'
          : 'Buyback output is indicative. Buyback 1.4.0 pay quotes encode three words (amountToSwapWith, minimumSwapAmountOut, skipSplits); two-word quotes revert. A pool failure or swap below the TWAP floor falls back to issuance; the transaction reverts if the final beneficiary balance increase is below its reviewed minimum.',
      );
    }
    if (prepared) {
      beneficiaryTokenCount = prepared.preview.beneficiaryTokenCount;
      reservedTokenCount = prepared.preview.reservedTokenCount;
    }
    // Caller metadata (such as a failed quote's, sent back) skips the SDK. Where the SDK would quote the
    // route, a buyback entry with no minimum of its own or a router conversion with no buyback hook,
    // ask it again only to learn whether the market price reads now. A read that fails here is the
    // same unknown, so the payer is told.
    let quoteFailed = prepared?.quoteFailed === true;
    const requote =
      unquotedSkipSplits !== undefined ||
      (terminal.isRouter && quoteBasis !== 'buyback-hook-indicative-output');
    if (!prepared && requote)
      quoteFailed = await prepareUserPay(client, {
        chainId: input.project.chainId,
        terminal: terminal.address,
        projectId: BigInt(input.project.projectId),
        token: input.token,
        amount,
        beneficiary: input.beneficiary,
        slippageBps: slippage,
        skipSplits: unquotedSkipSplits ?? true,
      }).then(
        (requoted) => requoted.quoteFailed === true,
        () => true,
      );
    if (quoteFailed) warnings.push(`${PAY_QUOTE_FAILED_MESSAGE} Quote again for the pool price.`);
    const metadata = prepared?.metadata ?? input.metadata ?? '0x';
    const minimum =
      prepared?.minReturnedTokens ??
      explicitMinimum ??
      slippageFloor(beneficiaryTokenCount, slippage);
    if (beneficiaryTokenCount === 0n)
      warnings.push(
        'The verified preview returns zero fungible project tokens for the beneficiary. The payment has a zero minimum and may still transfer funds.',
      );
    const transaction = buildPayTx({
      chainId: input.project.chainId,
      terminal: terminal.address,
      projectId: BigInt(input.project.projectId),
      token: input.token,
      amount,
      beneficiary: input.beneficiary,
      minReturnedTokens: minimum,
      ...(input.memo === undefined ? {} : { memo: input.memo }),
      metadata,
    });
    const quote = {
      operation: 'pay' as const,
      project: input.project,
      account: input.account,
      terminal: terminal.address,
      terminalPath: terminal.path,
      routerGateway: terminal.gateway,
      route: terminal.isRouter ? 'router-terminal' : 'multi-terminal',
      quoteBasis,
      payment: { token: input.token, amount: amount.toString(), unit: 'token-base-units' },
      beneficiary: input.beneficiary,
      projectTokenDecimals: 18,
      beneficiaryTokenCount: beneficiaryTokenCount.toString(),
      reservedTokenCount: reservedTokenCount.toString(),
      rawTerminalPreview: {
        semantics: terminal.previewSemantics,
        beneficiaryTokenCount: preview.beneficiaryTokenCount.toString(),
        reservedTokenCount: preview.reservedTokenCount.toString(),
      },
      minimumBeneficiaryTokenCount: minimum.toString(),
      slippageBps: Number(slippage),
      metadata,
      hooks: jsonSafe(hooks),
      rulesetId: context.ruleset.id.toString(),
      routeEvidence: route.evidence,
      // One evidence entry per chain: the quote's block. The route's own block is in the summary.
      evidence: [snapshot.evidence],
      warnings,
    };
    return { quote, transaction, snapshot, beside: extra };
  }

  private async cashOut(input: CashOutInput) {
    const cashOutCount = uint(input.cashOutCount, 'cashOutCount');
    const slippage = bps(input.slippageBps);
    const account = input.account ?? input.holder;
    const snapshot = await this.rpc.snapshot(input.project.chainId);
    const client = asAccount(snapshot.client, account);
    const context = await this.context(client, input.project, 'cashOut');
    const { terminal, accounting } = await this.balanceTerminal(
      client,
      input.project,
      input.tokenToReclaim,
      input.terminal,
    );
    const feelessRegistry = await client.readContract({
      address: terminal,
      abi: jbMultiTerminalAbi,
      functionName: 'FEELESS_ADDRESSES',
    });
    const beneficiaryIsFeeless = await client.readContract({
      address: feelessRegistry,
      abi: feelessAbi,
      functionName: 'isFeelessFor',
      args: [input.beneficiary, BigInt(input.project.projectId), account],
    });
    const prepared = await prepareHookAwareCashOut(client, {
      chainId: input.project.chainId,
      projectId: BigInt(input.project.projectId),
      holder: input.holder,
      cashOutCount,
      tokenToReclaim: input.tokenToReclaim,
      beneficiary: input.beneficiary,
      terminal,
      buybackHookAddress: context.buybackHook,
      beneficiaryIsFeeless,
      slippageBps: slippage,
    });
    for (const preview of [prepared.preview, prepared.lockedPreview]) {
      if (!preview) continue;
      if (preview.rulesetId !== BigInt(context.ruleset.id))
        throw new DomainError(
          'INVALID_PREVIEW',
          'The cash-out preview ruleset does not match the verified current ruleset.',
        );
      for (const spec of preview.hookSpecifications) {
        if (spec.noop) continue;
        const buyback =
          !same(context.buybackHook, zeroAddress) && same(spec.hook, context.buybackHook);
        const revFee = context.revOwner !== undefined && same(spec.hook, context.revOwner);
        if (!buyback && !revFee)
          unsupported(
            'The cash-out preview includes an unrecognized active hook; its return cannot safely be inferred.',
          );
      }
    }
    const activeBuyback = prepared.preview.hookSpecifications.some(
      (spec) => !spec.noop && same(spec.hook, context.buybackHook),
    );
    // SDK resolution may choose its zero treasury fallback when applying user
    // slippage to an active pool preview no longer beats the direct route.
    // That pool preview does not contain a fresh treasury quote. Never emit its
    // zero terminal minimum with empty metadata as if it protected a cash-out.
    if (activeBuyback && prepared.route.route !== 'amm') {
      throw new DomainError(
        'CASH_OUT_ROUTE_REQUIRES_REQUOTE',
        'The protected buyback quote no longer selects the pool. A new explicit treasury-route quote is required; no floorless cash-out was prepared.',
        { retryable: true },
      );
    }
    const route = prepared.route;
    const warnings = [
      'The quote uses the terminal cash-out path and recognized hooks. Direct market sales have not been compared.',
      'Cash-out preview does not prove the caller has burn permission or the holder has sufficient tokens. The exact transaction must be simulated as the stated account.',
    ];
    if (context.revOwner)
      warnings.push(
        'Revnet fee-hook outflow is already reflected in the hook-aware preview. It is not subtracted again as a flat fee from the beneficiary quote.',
      );
    if (route.route === 'amm')
      warnings.push(
        'The protected minimum is enforced by buyback cash-out metadata; the terminal minimum is zero for this route. Re-quote if the route changes.',
      );
    if (!isNative(input.tokenToReclaim))
      warnings.push(
        'ERC-20 transfer taxes and rebases are not modeled. The treasury minimum protects the terminal net transfer amount, which can differ from the recipient balance increase for such tokens.',
      );
    const quote = {
      operation: 'cash_out' as const,
      project: input.project,
      account,
      holder: input.holder,
      cashOutCount: cashOutCount.toString(),
      projectTokenDecimals: 18,
      terminal,
      tokenToReclaim: input.tokenToReclaim,
      tokenDecimals: accounting.decimals,
      accountingCurrency: accounting.currency,
      beneficiary: input.beneficiary,
      beneficiaryIsFeeless,
      route: route.route,
      quoteBasis:
        route.route === 'amm'
          ? 'buyback-hook-indicative-output'
          : 'terminal-preview-after-protocol-fee',
      expectedReturn: route.expectedReturn.toString(),
      ...(route.buyback
        ? { buybackExecutableQuote: route.buyback.minimumSwapAmountOut.toString() }
        : {}),
      minimumReturn: route.minimumReturn.toString(),
      terminalMinimum: route.terminalMinimum.toString(),
      metadata: route.metadata,
      slippageBps: Number(slippage),
      treasuryGross: route.treasuryGross.toString(),
      treasuryProtocolFee: route.treasuryProtocolFee.toString(),
      treasuryNet: route.treasuryNet.toString(),
      cashOutTaxRate: prepared.preview.cashOutTaxRate.toString(),
      hooks: jsonSafe(prepared.preview.hookSpecifications),
      rulesetId: context.ruleset.id.toString(),
      evidence: [snapshot.evidence],
      warnings,
    };
    return { quote, prepared };
  }

  private async payout(input: PayoutInput) {
    const amount = uint(input.amount, 'amount');
    const slippage = bps(input.slippageBps);
    if (
      !Number.isSafeInteger(input.currency) ||
      input.currency < 0 ||
      input.currency > 0xffff_ffff
    ) {
      throw new DomainError('INVALID_CURRENCY', 'Payout currency must fit uint32.');
    }
    const snapshot: RpcSnapshot = await this.rpc.snapshot(input.project.chainId);
    const client = asAccount(snapshot.client, input.account);
    const context = await this.context(client, input.project, 'payout');
    const { terminal, accounting } = await this.balanceTerminal(
      client,
      input.project,
      input.token,
      input.terminal,
    );
    const args = [
      BigInt(input.project.projectId),
      input.token,
      amount,
      BigInt(input.currency),
      0n,
    ] as const;
    const simulated = await client.simulateContract({
      address: terminal,
      abi: jbMultiTerminalAbi,
      functionName: 'sendPayoutsOf',
      args,
      account: input.account,
      blockNumber: BigInt(snapshot.evidence.blockNumber),
      gas: 10_000_000n,
    });
    const gross = simulated.result;
    const isCurrencyConversion = input.currency !== accounting.currency;
    const minimum = isCurrencyConversion ? slippageFloor(gross, slippage) : gross;
    const transaction = call(
      input.project.chainId,
      terminal,
      jbMultiTerminalAbi,
      'sendPayoutsOf',
      [args[0], args[1], args[2], args[3], minimum],
      'Send the current ruleset payout splits',
    );
    const quote = {
      operation: 'payout' as const,
      project: input.project,
      account: input.account,
      terminal,
      token: input.token,
      tokenDecimals: accounting.decimals,
      amount: amount.toString(),
      currency: input.currency,
      accountingCurrency: accounting.currency,
      isCurrencyConversion,
      grossAmountRecorded: gross.toString(),
      minimumGrossAmountRecorded: minimum.toString(),
      slippageBps: isCurrencyConversion ? Number(slippage) : 0,
      quoteBasis: 'sendPayoutsOf-simulation-return' as const,
      rulesetId: context.ruleset.id.toString(),
      evidence: [snapshot.evidence],
      warnings: [
        'The return and minimum are the gross payout amount recorded against the limit, before recipient fees. They do not guarantee delivery to every split recipient.',
        'Failed split or owner transfers can be caught and returned to the project balance while consuming the payout limit. Verify payout-transfer events and recipient outcomes after execution.',
        'Recipient amounts, hook effects, wildcard caller shares, held fees, and actual protocol fees require receipt evidence; they cannot be inferred from the gross return.',
      ],
    };
    return { quote, transaction };
  }
}
