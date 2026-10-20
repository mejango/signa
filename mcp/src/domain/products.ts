import { z } from 'zod';
import { jb721TiersHookAbi } from '@bananapus/nana-sdk-core';
import {
  v6Address,
  type REVConfig,
  type REVDeploy721TiersHookConfig,
  type REVSuckerDeploymentConfig,
} from '@bananapus/nana-sdk-core/v6';
import { zeroAddress, zeroHash, type Address, type PublicClient } from 'viem';
import {
  addressSchema,
  chainIdSchema,
  hashSchema,
  positiveUintSchema,
  projectSchema,
  paySlippageSchema,
  uintSchema,
} from './schemas.js';
import {
  accountingContextSchema,
  rulesetConfigSchema,
  rulesetMetadataSchema,
  splitSchema,
  terminalConfigurationsSchema,
  toRulesetConfig,
} from './rulesets.js';
import { DomainError } from './errors.js';
import type { ProjectRef } from './types.js';

const uint = (bits: number, max = (1n << BigInt(bits)) - 1n) =>
  uintSchema.refine((value) => BigInt(value) <= max, `Must fit uint${bits} and be at most ${max}.`);
const nonzero = addressSchema.refine(
  (value) => value !== zeroAddress,
  'A nonzero address is required.',
);
const splits = z
  .array(splitSchema)
  .max(32)
  .refine(
    (items) => items.reduce((sum, item) => sum + BigInt(item.percent), 0n) <= 1_000_000_000n,
    'Split total exceeds 1,000,000,000.',
  );
export const tierConfigSchema = z
  .object({
    price: uint(104),
    initialSupply: uint(32, 999_999_999n).refine((v) => BigInt(v) > 0n),
    votingUnits: uint(32),
    reserveFrequency: uint(16),
    reserveBeneficiary: addressSchema,
    encodedIpfsUri: hashSchema,
    category: uint(24),
    discountPercent: uint(8, 200n),
    flags: z
      .object({
        allowOwnerMint: z.boolean(),
        useReserveBeneficiaryAsDefault: z.boolean(),
        transfersPausable: z.boolean(),
        useVotingUnits: z.boolean(),
        cantBeRemoved: z.boolean(),
        cantIncreaseDiscountPercent: z.boolean(),
        cantBuyWithCredits: z.boolean(),
      })
      .strict(),
    splitPercent: uint(32, 1_000_000_000n),
    splits,
  })
  .strict()
  .superRefine((tier, ctx) => {
    if (tier.initialSupply === '1' && tier.reserveFrequency !== '0')
      ctx.addIssue({
        code: 'custom',
        path: ['reserveFrequency'],
        message: 'Supply 1 with reserves deadlocks paid minting and is rejected by the store.',
      });
  });
export const tiersConfigArraySchema = z
  .array(tierConfigSchema)
  .max(32)
  .superRefine((tiers, ctx) => {
    tiers.forEach((tier, index) => {
      if (index && BigInt(tier.category) < BigInt(tiers[index - 1]!.category))
        ctx.addIssue({
          code: 'custom',
          path: [index, 'category'],
          message:
            'Tiers must be sorted by category ascending. Input order determines assigned tier IDs.',
        });
    });
  });
export const get721ShopSchema = z
  .object({
    project: projectSchema,
    startingId: uintSchema.default('0'),
    size: z.number().int().min(1).max(32).default(20),
    categories: z
      .array(uint(24))
      .max(16)
      .refine(
        (values) => values.every((v, i) => !i || BigInt(v) > BigInt(values[i - 1]!)),
        'Categories must be unique and ascending.',
      )
      .default([]),
    includeResolvedUri: z.boolean().default(false),
  })
  .strict();
export const pay721Schema = z
  .object({
    project: projectSchema,
    account: nonzero,
    token: nonzero,
    amount: uintSchema.describe(
      'Fresh payment amount in the token’s smallest units. Use 0 for free tiers or eligible NFT-credit purchases.',
    ),
    beneficiary: nonzero,
    tierIds: z
      .array(uint(16).refine((v) => BigInt(v) > 0n))
      .min(1)
      .max(32),
    slippageBps: paySlippageSchema,
    allowOverspending: z.boolean().default(false),
  })
  .strict();
export const getRevnetSchema = z
  .object({
    project: projectSchema,
    startingId: uintSchema.default('0'),
    size: z.number().int().min(1).max(32).default(16),
    operator: nonzero.optional(),
  })
  .strict();
export const prepareAutoIssueSchema = z
  .object({
    project: projectSchema,
    account: nonzero,
    stageId: positiveUintSchema,
    beneficiary: nonzero,
  })
  .strict();
export const prepareAdjustTiersSchema = z
  .object({
    project: projectSchema,
    account: nonzero,
    tiersToAdd: tiersConfigArraySchema,
    tierIdsToRemove: z
      .array(uint(16).refine((v) => BigInt(v) > 0n))
      .max(32)
      .refine((v) => new Set(v).size === v.length, 'Removal IDs must be unique.'),
  })
  .strict()
  .refine(
    (v) => v.tiersToAdd.length + v.tierIdsToRemove.length > 0,
    'Specify at least one addition or removal.',
  );

export const revStageSchema = z
  .object({
    startsAtOrAfter: uint(48).refine(
      (v) => BigInt(v) > 0n,
      'Use one explicit absolute timestamp across chains.',
    ),
    autoIssuances: z
      .array(
        z
          .object({
            chainId: uint(32).refine((v) => BigInt(v) > 0n),
            count: uint(104),
            beneficiary: nonzero,
          })
          .strict(),
      )
      .max(32),
    splitPercent: uint(16, 10_000n),
    splits,
    initialIssuance: uint(112),
    issuanceCutFrequency: uint(32),
    issuanceCutPercent: uint(32, 1_000_000_000n),
    cashOutTaxRate: uint(16, 9_999n),
    extraMetadata: uint(16, 16_383n),
  })
  .strict()
  .refine(
    (v) => v.splitPercent === '0' || v.splits.length > 0,
    'A positive splitPercent requires recipients.',
  );
export const revConfigSchema = z
  .object({
    description: z
      .object({
        name: z.string().min(1).max(256),
        ticker: z.string().min(1).max(32),
        uri: z.string().max(4096),
        salt: hashSchema,
      })
      .strict(),
    baseCurrency: uint(32).refine((v) => BigInt(v) > 0n),
    operator: addressSchema,
    scopeCashOutsToLocalBalances: z.boolean(),
    stageConfigurations: z.array(revStageSchema).min(1).max(16),
  })
  .strict()
  .superRefine((config, ctx) => {
    config.stageConfigurations.forEach((stage, i) => {
      if (
        i &&
        BigInt(stage.startsAtOrAfter) <= BigInt(config.stageConfigurations[i - 1]!.startsAtOrAfter)
      )
        ctx.addIssue({
          code: 'custom',
          path: ['stageConfigurations', i, 'startsAtOrAfter'],
          message: 'Absolute stage starts must strictly increase.',
        });
    });
  });
export const revSuckerConfigSchema = z
  .object({
    salt: hashSchema,
    deployerConfigurations: z
      .array(
        z
          .object({
            deployer: nonzero,
            peer: hashSchema,
            mappings: z
              .array(
                z
                  .object({ localToken: nonzero, minGas: uint(32), remoteToken: hashSchema })
                  .strict(),
              )
              .min(1)
              .max(16),
          })
          .strict(),
      )
      .max(16),
  })
  .strict();
export const revTieredConfigSchema = z
  .object({
    baseline721HookConfiguration: z
      .object({
        name: z.string().min(1).max(256),
        symbol: z.string().min(1).max(32),
        baseUri: z.string().max(4096),
        tokenUriResolver: addressSchema,
        contractUri: z.string().max(4096),
        tiersConfig: z
          .object({
            tiers: tiersConfigArraySchema,
            currency: uint(32).refine((v) => BigInt(v) > 0n),
            decimals: uint(8, 18n),
          })
          .strict(),
        flags: z
          .object({
            noNewTiersWithReserves: z.boolean(),
            noNewTiersWithVotes: z.boolean(),
            noNewTiersWithOwnerMinting: z.boolean(),
            preventOverspending: z.boolean(),
          })
          .strict(),
      })
      .strict(),
    salt: hashSchema,
    preventOperatorAdjustingTiers: z.boolean(),
    preventOperatorUpdatingMetadata: z.boolean(),
    preventOperatorMinting: z.boolean(),
    preventOperatorIncreasingDiscountPercent: z.boolean(),
  })
  .strict();
export const revAllowedPostSchema = z
  .object({
    category: uint(24),
    minimumPrice: uint(104),
    minimumTotalSupply: uint(32, 999_999_999n).refine(
      (v) => BigInt(v) > 0n,
      'Minimum posting supply must be positive.',
    ),
    maximumTotalSupply: uint(32).describe(
      '0 means unlimited; actual minted NFT tiers remain subject to the store supply cap.',
    ),
    maximumSplitPercent: uint(32, 1_000_000_000n),
    allowedAddresses: z.array(nonzero).max(32),
  })
  .strict()
  .refine(
    (v) =>
      v.maximumTotalSupply === '0' || BigInt(v.minimumTotalSupply) <= BigInt(v.maximumTotalSupply),
    'Minimum supply exceeds the nonzero maximum supply.',
  );
export const prepareRevnetDeploySchema = z
  .object({
    chainId: chainIdSchema,
    account: nonzero,
    config: revConfigSchema,
    accountingContexts: z.array(accountingContextSchema).min(1).max(16),
    suckerConfig: revSuckerConfigSchema,
    tiered721Config: revTieredConfigSchema.optional(),
    allowedPosts: z.array(revAllowedPostSchema).max(16).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.tiered721Config && value.allowedPosts.length)
      ctx.addIssue({
        code: 'custom',
        path: ['allowedPosts'],
        message: 'Allowed posts require the explicit tiered 721 configuration.',
      });
    if (value.suckerConfig.deployerConfigurations.length && value.suckerConfig.salt === zeroHash)
      ctx.addIssue({
        code: 'custom',
        path: ['suckerConfig', 'salt'],
        message:
          'A nonzero sucker salt is required: the deployer skips sucker creation when it is zero.',
      });
    if (
      new Set(value.accountingContexts.map((c) => c.token.toLowerCase())).size !==
      value.accountingContexts.length
    )
      ctx.addIssue({
        code: 'custom',
        path: ['accountingContexts'],
        message: 'Accounting tokens must be unique.',
      });
    if (value.suckerConfig.deployerConfigurations.length)
      value.config.stageConfigurations.forEach((stage, i) => {
        if ((BigInt(stage.extraMetadata) & 4n) === 0n)
          ctx.addIssue({
            code: 'custom',
            path: ['config', 'stageConfigurations', i, 'extraMetadata'],
            message: 'Every cross-chain stage must permit sucker deployment with metadata bit 2.',
          });
      });
  });

/** The project deployer attaches its new hook. Its ABI has no user-supplied dataHook or pay-hook flag. */
const {
  dataHook: _dataHook,
  useDataHookForPay: _useDataHookForPay,
  ...payHookMetadataFields
} = rulesetMetadataSchema.shape;
export const payHookRulesetSchema = z
  .object({ ...rulesetConfigSchema.shape, metadata: z.object(payHookMetadataFields).strict() })
  .strict()
  .superRefine((value, ctx) => {
    // Reuse all core duration, split, limit and scalar invariants using inert fields absent from this ABI.
    const result = rulesetConfigSchema.safeParse({
      ...value,
      metadata: {
        ...value.metadata,
        dataHook: zeroAddress,
        useDataHookForPay: false,
        useDataHookForCashOut: false,
      },
    });
    if (!result.success)
      result.error.issues.forEach((issue) =>
        ctx.addIssue({ ...issue, code: 'custom', message: issue.message }),
      );
  });
export const deploy721HookSchema = z
  .object({
    ...revTieredConfigSchema.shape.baseline721HookConfiguration.shape,
    flags: revTieredConfigSchema.shape.baseline721HookConfiguration.shape.flags.extend({
      issueTokensForSplits: z.boolean(),
    }),
  })
  .strict();
export const prepare721LaunchSchema = z
  .object({
    chainId: chainIdSchema,
    account: nonzero,
    owner: nonzero,
    deployTiersHookConfig: deploy721HookSchema,
    projectUri: z.string().max(4096),
    rulesetConfigurations: z.array(payHookRulesetSchema).min(1).max(16),
    terminalConfigurations: terminalConfigurationsSchema,
    memo: z.string().max(4096).default(''),
    salt: hashSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const accepted = new Set(
      value.terminalConfigurations.flatMap((terminal) =>
        terminal.accountingContextsToAccept.map((context) =>
          `${terminal.terminal}:${context.token}`.toLowerCase(),
        ),
      ),
    );
    value.rulesetConfigurations.forEach((config, i) =>
      config.fundAccessLimitGroups.forEach((group, j) => {
        if (!accepted.has(`${group.terminal}:${group.token}`.toLowerCase()))
          ctx.addIssue({
            code: 'custom',
            path: ['rulesetConfigurations', i, 'fundAccessLimitGroups', j],
            message: 'Launch limits must reference an explicit accepted terminal/token context.',
          });
      }),
    );
  });
export function toPayHookRuleset(value: z.output<typeof payHookRulesetSchema>) {
  const converted = toRulesetConfig({
    ...value,
    metadata: { ...value.metadata, dataHook: zeroAddress, useDataHookForPay: false },
  });
  const { dataHook: _hook, useDataHookForPay: _pay, ...metadata } = converted.metadata;
  return { ...converted, metadata };
}
export function toDeploy721Hook(value: z.output<typeof deploy721HookSchema>) {
  return {
    ...value,
    tiersConfig: {
      tiers: value.tiersConfig.tiers.map(toTier),
      currency: Number(value.tiersConfig.currency),
      decimals: Number(value.tiersConfig.decimals),
    },
  };
}

const toSplit = (s: z.output<typeof splitSchema>) => ({
  ...s,
  percent: Number(s.percent),
  projectId: BigInt(s.projectId),
  lockedUntil: Number(s.lockedUntil),
});
export function toTier(t: z.output<typeof tierConfigSchema>) {
  return {
    ...t,
    price: BigInt(t.price),
    initialSupply: Number(t.initialSupply),
    votingUnits: Number(t.votingUnits),
    reserveFrequency: Number(t.reserveFrequency),
    category: Number(t.category),
    discountPercent: Number(t.discountPercent),
    splitPercent: Number(t.splitPercent),
    splits: t.splits.map(toSplit),
  };
}
export function toRevConfig(c: z.output<typeof revConfigSchema>): REVConfig {
  return {
    ...c,
    baseCurrency: Number(c.baseCurrency),
    stageConfigurations: c.stageConfigurations.map((s) => ({
      ...s,
      startsAtOrAfter: Number(s.startsAtOrAfter),
      autoIssuances: s.autoIssuances.map((a) => ({
        ...a,
        chainId: Number(a.chainId),
        count: BigInt(a.count),
      })),
      splitPercent: Number(s.splitPercent),
      splits: s.splits.map(toSplit),
      initialIssuance: BigInt(s.initialIssuance),
      issuanceCutFrequency: Number(s.issuanceCutFrequency),
      issuanceCutPercent: Number(s.issuanceCutPercent),
      cashOutTaxRate: Number(s.cashOutTaxRate),
      extraMetadata: Number(s.extraMetadata),
    })),
  };
}
export function toRevSucker(c: z.output<typeof revSuckerConfigSchema>): REVSuckerDeploymentConfig {
  return {
    ...c,
    deployerConfigurations: c.deployerConfigurations.map((d) => ({
      ...d,
      mappings: d.mappings.map((m) => ({ ...m, minGas: Number(m.minGas) })),
    })),
  };
}
export function toRevTiered(
  c: z.output<typeof revTieredConfigSchema>,
): REVDeploy721TiersHookConfig {
  const b = c.baseline721HookConfiguration;
  return {
    ...c,
    baseline721HookConfiguration: {
      ...b,
      tiersConfig: {
        tiers: b.tiersConfig.tiers.map(toTier),
        currency: Number(b.tiersConfig.currency),
        decimals: Number(b.tiersConfig.decimals),
      },
    },
  };
}

/** Validate the exact factory clone runtime, then immutable links and project association. A STORE getter alone proves nothing. */
export async function verify721Hook(client: PublicClient, project: ProjectRef, hook: Address) {
  const implementation = v6Address('JB721TiersHook', project.chainId);
  const code = await client.getBytecode({ address: hook });
  const expected =
    `0x3d3d3d3d363d3d37363d73${implementation.slice(2)}5af43d3d93803e602a57fd5bf3`.toLowerCase();
  if (!code || code.toLowerCase() !== expected)
    throw new DomainError(
      'UNSUPPORTED_721_HOOK',
      'The project hook is not an exact canonical V6 tiers implementation clone.',
    );
  const implementationCode = await client.getBytecode({ address: implementation });
  if (!implementationCode || implementationCode === '0x')
    throw new DomainError(
      'DEPLOYMENT_UNAVAILABLE',
      'The canonical NFT implementation has no bytecode at this block.',
    );
  const [store, directory, actualProjectId, metadataIdTarget, pricing] = await Promise.all([
    client.readContract({ address: hook, abi: jb721TiersHookAbi, functionName: 'STORE' }),
    client.readContract({ address: hook, abi: jb721TiersHookAbi, functionName: 'DIRECTORY' }),
    client.readContract({ address: hook, abi: jb721TiersHookAbi, functionName: 'projectId' }),
    client.readContract({
      address: hook,
      abi: jb721TiersHookAbi,
      functionName: 'METADATA_ID_TARGET',
    }),
    client.readContract({ address: hook, abi: jb721TiersHookAbi, functionName: 'pricingContext' }),
  ]);
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (
    !eq(store, v6Address('JB721TiersHookStore', project.chainId)) ||
    !eq(directory, v6Address('JBDirectory', project.chainId)) ||
    actualProjectId !== BigInt(project.projectId) ||
    !eq(metadataIdTarget, implementation)
  )
    throw new DomainError(
      'INVALID_721_IDENTITY',
      'The NFT hook does not match the canonical store, directory, implementation metadata target, and project.',
    );
  return {
    hook,
    store,
    metadataIdTarget,
    pricing: { currency: Number(pricing[0]), decimals: Number(pricing[1]) },
  };
}
