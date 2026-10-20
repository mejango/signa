import { z } from 'zod';
import { getAddress, isAddress } from 'viem';
import { PAY_MAX_SLIPPAGE_BPS } from '@bananapus/nana-sdk-core/v6';
import { assertUnambiguousJson } from './json.js';

export const chainIdSchema = z.union([
  z.literal(1),
  z.literal(10),
  z.literal(8453),
  z.literal(42161),
  z.literal(11155111),
  z.literal(11155420),
  z.literal(84532),
  z.literal(421614),
]);
export const uintSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/, {
    message: 'Use a base-10 integer string, without decimals or exponents.',
    abort: true,
  })
  .max(78, { abort: true })
  .refine(
    (value) => /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 78 && BigInt(value) < 1n << 256n,
    { message: 'Must fit uint256.', abort: true },
  );
export const positiveUintSchema = uintSchema.refine(
  (value) => /^[1-9][0-9]*$/.test(value),
  'Must be positive.',
);
export const addressSchema = z
  .string()
  .refine((value) => isAddress(value, { strict: true }), 'Use a valid EVM address.')
  .transform((value) => getAddress(value));
export const hexSchema = z
  .string()
  .regex(/^0x(?:[a-fA-F0-9]{2})*$/)
  .max(262146)
  .transform((value) => value as `0x${string}`);
export const hashSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/)
  .transform((value) => value as `0x${string}`);
export const projectSchema = z
  .object({
    chainId: chainIdSchema,
    projectId: positiveUintSchema,
    version: z.literal(6).default(6),
  })
  .strict();
export const slippageSchema = z
  .number()
  .int()
  .min(0)
  .max(1000)
  .default(100)
  .describe('Slippage in basis points, 0–1000. Default 100 (1%).');
/** A payment's tolerance reaches the SDK's payer maximum, the one every pay client caps at. Cash outs,
 * payouts and loans keep the tighter 1000 above. */
export const paySlippageSchema = z
  .number()
  .int()
  .min(0)
  .max(Number(PAY_MAX_SLIPPAGE_BPS))
  .default(100)
  .describe(`Slippage in basis points, 0–${PAY_MAX_SLIPPAGE_BPS}. Default 100 (1%).`);
export const pageSchema = {
  limit: z.number().int().min(1).max(50).default(20),
  cursor: z.string().max(1024).optional(),
};
export const jsonObjectSchema = z.preprocess(
  (value, ctx) => {
    try {
      assertUnambiguousJson(value);
      return value;
    } catch {
      ctx.addIssue({
        code: 'custom',
        message:
          'JSON must be bounded and must not contain reserved object keys (__proto__, constructor, prototype). No altered commitment will be produced.',
      });
      return z.NEVER;
    }
  },
  z.record(z.string(), z.json()),
);
