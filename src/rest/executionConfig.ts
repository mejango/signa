import {UserOperationSponsorRoutes} from './userOperations/sponsorRoutes.js';
import { getAddress, isAddress, type Address } from "viem";
import { RestError } from "./core.js";
import { createConfiguredSmartAccountStack } from "./smartAccounts/stack/config.js";
import { LEGACY_COMPILER_RUNTIME_HASHES } from "./smartAccounts/compiler.js";
import {
  CURRENT_PIMLICO_GUARD_RUNTIME_HASH,
  type SessionGuardVersion,
  type SmartAccountPaymasterProfile,
} from "./smartAccounts/stack/current-pimlico/pins.js";
import type { ReviewedSessionPaymaster } from "./smartAccounts/policy.js";
import {
  createPimlicoV7PaymasterPolicy,
  createPimlicoCurrentV7PaymasterPolicy,
  UserOperationProvider,
} from "./userOperations/provider.js";
import type {
  UserOperationProviderConfig,
  UserOperationGasPolicy,
} from "./userOperations/types.js";
import type { UserOperationChainPolicy } from "./userOperations/service.js";
import { readSponsorCapPolicies, type SponsorCapPolicy } from "./sponsorCaps.js";
import { signaChains } from "./wallet/chains.js";

const CHAIN_IDS = signaChains.map((chain) => chain.chainId);
const GAS_FIELDS = [
  "maximumCallGas",
  "maximumVerificationGas",
  "maximumPreVerificationGas",
  "maximumPaymasterVerificationGas",
  "maximumPaymasterPostOpGas",
  "maximumFeePerGas",
  "maximumPriorityFeePerGas",
  "maximumCost",
] as const;
type ConfiguredStack = Awaited<
  ReturnType<typeof createConfiguredSmartAccountStack>
>;
export interface RestExecutionConfiguration {
  sponsorRoutes?: UserOperationSponsorRoutes;
  stacks: ConfiguredStack[];
  providers: UserOperationProviderConfig[];
  /** Read from the environment beside the Pimlico policies; absent when configured from bare JSON. */
  sponsorCaps?: SponsorCapPolicy[];
  policies: UserOperationChainPolicy[];
  paymasters: ReviewedSessionPaymaster[];
}
function invalid(message: string): never {
  throw new RestError(500, "REST_EXECUTION_CONFIG_INVALID", message);
}
function object(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    return invalid(
      "Execution configuration contains an invalid object or unsupported field.",
    );
  return value as Record<string, unknown>;
}
function endpoint(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    /[\u0000-\u0020\u007f]/.test(value)
  )
    return invalid("Configure bounded fixed HTTPS provider URLs.");
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      !url.hostname
    )
      return invalid(
        "Configure fixed HTTPS provider URLs without embedded user credentials or fragments.",
      );
    return url.href;
  } catch {
    return invalid("A configured provider URL is invalid.");
  }
}
function amount(value: unknown, bits: number, zeroAllowed = false): bigint {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    value.length > 78
  )
    return invalid(
      "Every provider gas ceiling must be an explicit canonical decimal integer string.",
    );
  const n = BigInt(value);
  if (n >= 1n << BigInt(bits) || (!zeroAllowed && n === 0n))
    return invalid(
      "A provider gas ceiling is outside its supported integer bounds.",
    );
  return n;
}
function gasPolicy(chainId: number, input: unknown): UserOperationGasPolicy {
  const value = object(input, [...GAS_FIELDS, "requirePaymaster"]);
  if (value.requirePaymaster !== undefined && typeof value.requirePaymaster !== "boolean")
    return invalid("requirePaymaster must be a boolean.");
  const result = {
    id: `operator-hosted-gas-${chainId}`,
    maximumCallGas: amount(value.maximumCallGas, 128),
    maximumVerificationGas: amount(value.maximumVerificationGas, 128),
    maximumPreVerificationGas: amount(value.maximumPreVerificationGas, 128),
    maximumPaymasterVerificationGas: amount(
      value.maximumPaymasterVerificationGas,
      128,
    ),
    maximumPaymasterPostOpGas: amount(
      value.maximumPaymasterPostOpGas,
      128,
      true,
    ),
    maximumFeePerGas: amount(value.maximumFeePerGas, 128),
    maximumPriorityFeePerGas: amount(value.maximumPriorityFeePerGas, 128, true),
    maximumCost: amount(value.maximumCost, 256),
    // An owner operation the sponsor cap or Pimlico refuses may be paid by its account, shown in its
    // one review. `true` refuses it instead; session operations are always sponsored.
    requirePaymaster: value.requirePaymaster === true,
  };
  if (result.maximumPriorityFeePerGas > result.maximumFeePerGas)
    return invalid(
      "The priority fee ceiling cannot exceed the total fee ceiling.",
    );
  return result;
}

/** Startup configuration only. Never mount this parser as an HTTP endpoint or serialize its returned provider URLs. */
export async function readRestExecutionConfiguration(
  envOrJson: Record<string, string | undefined> | string = process.env,
): Promise<RestExecutionConfiguration> {
  const raw =
    typeof envOrJson === "string" ? envOrJson : envOrJson.REST_ERC4337_CONFIG;
  let entries: unknown[] = [];
  if (raw !== undefined) {
    if (
      typeof raw !== "string" ||
      raw.length === 0 ||
      Buffer.byteLength(raw) > 65536
    )
      invalid("REST_ERC4337_CONFIG must be bounded nonempty JSON.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return invalid("REST_ERC4337_CONFIG must contain valid JSON.");
    }
    const value = object(parsed, ["chains"]);
    if (!Array.isArray(value.chains) || value.chains.length > 8)
      invalid(
        "Execution configuration must contain at most eight explicit chains.",
      );
    entries = value.chains;
  }
  const stacks = new Map<number, ConfiguredStack>();
  const providers: UserOperationProviderConfig[] = [];
  const policies: UserOperationChainPolicy[] = [];
  const paymasters: ReviewedSessionPaymaster[] = [];
  const usedChains = new Set<number>();
  for (const entry of entries) {
    const value = object(entry, [
      "chainId",
      "bundlerUrl",
      "paymasterUrl",
      "paymasterPolicyId",
      "paymasterProfile",
      "simulationBundlerAddress",
      "sessionGuardAddress",
      "sessionGuardVersion",
      "gas",
      "confirmations",
    ]);
    if (
      typeof value.chainId !== "number" ||
      !Number.isSafeInteger(value.chainId) ||
      !CHAIN_IDS.includes(value.chainId) ||
      usedChains.has(value.chainId)
    )
      invalid("Provider chains must be supported, explicit and unique.");
    const chainId = value.chainId;
    usedChains.add(chainId);
    const paymasterProfile = value.paymasterProfile ?? "pimlico-v7-legacy-mode";
    const guardVersion = value.sessionGuardVersion ?? "legacy-v1";
    if ((paymasterProfile !== "pimlico-v7-legacy-mode" && paymasterProfile !== "pimlico-v7-current-flags") ||
        (guardVersion !== "legacy-v1" && guardVersion !== "current-v2") ||
        (value.sessionGuardVersion !== undefined && value.sessionGuardAddress === undefined) ||
        (value.sessionGuardAddress !== undefined &&
          (guardVersion === "current-v2") !== (paymasterProfile === "pimlico-v7-current-flags")))
      invalid("Select an exact reviewed paymaster profile and its matching guard version.");
    if (
      typeof value.paymasterPolicyId !== "string" ||
      !/^[A-Za-z0-9._-]{1,128}$/.test(value.paymasterPolicyId)
    )
      invalid("A bounded hosted sponsorship policy identifier is required.");
    let guardAddress: Address | undefined;
    let simulationBundlerAddress: Address | undefined;
    if (value.simulationBundlerAddress !== undefined) {
      if (paymasterProfile !== "pimlico-v7-current-flags" ||
          typeof value.simulationBundlerAddress !== "string" ||
          !isAddress(value.simulationBundlerAddress) || BigInt(value.simulationBundlerAddress) === 0n)
        invalid("A simulation bundler requires the current paymaster profile and an explicit nonzero address.");
      simulationBundlerAddress = getAddress(value.simulationBundlerAddress);
    }
    if (value.sessionGuardAddress !== undefined) {
      if (
        typeof value.sessionGuardAddress !== "string" ||
        !isAddress(value.sessionGuardAddress) ||
        BigInt(value.sessionGuardAddress) === 0n
      )
        invalid(
          "The operator guard address must be a valid nonzero deployment address.",
        );
      guardAddress = getAddress(value.sessionGuardAddress);
    }
    const confirmations = value.confirmations ?? 1;
    if (
      typeof confirmations !== "number" ||
      !Number.isSafeInteger(confirmations) ||
      confirmations < 1 ||
      confirmations > 1024
    )
      invalid(
        "Confirmation requirements must be an integer from one through 1024.",
      );
    const gas = gasPolicy(chainId, value.gas);
    const stack = await createConfiguredSmartAccountStack({
      chainId,
      paymasterProfile: paymasterProfile as SmartAccountPaymasterProfile,
      ...(guardAddress
        ? {
            sessionGuard: {
              address: guardAddress,
              version: guardVersion as SessionGuardVersion,
              runtimeCodeHash: guardVersion === "current-v2"
                ? CURRENT_PIMLICO_GUARD_RUNTIME_HASH : LEGACY_COMPILER_RUNTIME_HASHES.sessionGuard,
            },
          }
        : {}),
    });
    stacks.set(chainId, stack);
    const createPaymasterPolicy = paymasterProfile === "pimlico-v7-current-flags"
      ? createPimlicoCurrentV7PaymasterPolicy : createPimlicoV7PaymasterPolicy;
    const paymasterPolicy = createPaymasterPolicy({
      chainId,
      policyId: value.paymasterPolicyId,
      context: { sponsorshipPolicyId: value.paymasterPolicyId },
    });
    if (
      paymasterPolicy.contract.address.toLowerCase() !==
        stack.paymaster.address.toLowerCase() ||
      paymasterPolicy.contract.runtimeCodeHash !==
        stack.paymaster.runtimeCodeHash
    )
      invalid(
        "The provider profile does not match the reviewed stack paymaster.",
      );
    providers.push({
      chainId,
      providerId: `operator-pimlico-${chainId}`,
      entryPoint: stack.entryPoint,
      bundlerUrl: endpoint(value.bundlerUrl),
      paymasterUrl: endpoint(value.paymasterUrl),
      paymasterPolicy,
      ...(simulationBundlerAddress ? { simulationBundlerAddress } : {}),
    });
    policies.push({ chainId, gas, confirmations });
    paymasters.push({
      chainId,
      address: stack.paymaster.address,
      runtimeCodeHash: stack.paymaster.runtimeCodeHash,
      reviewId: stack.paymaster.profileId,
    });
  }
  // A server configured from REST_ERC4337_CONFIG operates on every chain Signa accounts operate on; a
  // missing one fails startup. Bare JSON, like an unset variable, configures no operations.
  if (typeof envOrJson !== "string" && raw !== undefined)
    for (const chain of signaChains)
      if (chain.operates && !usedChains.has(chain.chainId))
        invalid(`REST_ERC4337_CONFIG needs a provider for ${chain.name} (${chain.chainId}), where Signa accounts operate.`);
  // The provider constructor independently validates the finalized server-owned transport config without making requests.
  new UserOperationProvider(providers);
  // Each chain's Pimlico paymaster policy stays the sponsor; its cap is read beside it, and a chain
  // without one fails startup rather than going unsponsored or unmetered.
  const sponsorCaps = typeof envOrJson === "string" ? undefined
    : readSponsorCapPolicies(envOrJson, providers.filter((provider) => provider.paymasterPolicy).map((provider) => provider.chainId));
  for (const chainId of CHAIN_IDS)
    if (!stacks.has(chainId))
      stacks.set(chainId, await createConfiguredSmartAccountStack({ chainId }));
  return {
    stacks: CHAIN_IDS.map((chainId) => stacks.get(chainId)!),
    providers,
    sponsorRoutes: new UserOperationSponsorRoutes(providers, typeof envOrJson === "string" ? undefined : envOrJson.REST_ERC4337_SPONSOR_ROUTES),
    policies,
    paymasters,
    ...(sponsorCaps ? { sponsorCaps } : {}),
  };
}
