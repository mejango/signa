import * as sdk from '@bananapus/nana-sdk-core';
import { jbSuckerV6Abi } from '@bananapus/nana-sdk-core/v6';
import { decodeFunctionData, type Abi, type Hex } from 'viem';
import { DomainError } from '../domain/errors.js';
import { jsonSafe } from '../domain/json.js';
import type { ChainId } from '../domain/types.js';
import { deploymentAddress, rollout, routerGatewayAbi, ratioPriceFeedAbi } from './rollout.js';

const ABI_REGISTRY: Record<string, Abi> = {
  JBProjects: sdk.jbProjectsAbi,
  JBDirectory: sdk.jbDirectoryAbi,
  JBController: sdk.jbControllerAbi,
  JBMultiTerminal: sdk.jbMultiTerminalAbi,
  JBTerminalStore: sdk.jbTerminalStoreAbi,
  JBRulesets: sdk.jbRulesetsAbi,
  JBSplits: sdk.jbSplitsAbi,
  JBFundAccessLimits: sdk.jbFundAccessLimitsAbi,
  JBTokens: sdk.jbTokensAbi,
  JBPermissions: sdk.jbPermissionsAbi,
  JBPrices: sdk.jbPricesAbi,
  JB721TiersHook: sdk.jb721TiersHookAbi,
  JB721TiersHookStore: sdk.jb721TiersHookStoreAbi,
  JB721TiersHookDeployer: sdk.jb721TiersHookDeployerAbi,
  JB721TiersHookProjectDeployer: sdk.jb721TiersHookProjectDeployerAbi,
  JBBuybackHook: sdk.jbBuybackHookAbi,
  JBBuybackHookRegistry: sdk.jbBuybackHookRegistryAbi,
  JBRouterTerminal: sdk.jbRouterTerminalAbi,
  JBRouterTerminalRegistry: sdk.jbRouterTerminalRegistryAbi,
  JBRouterTerminalGateway: routerGatewayAbi,
  JBRatioPriceFeed: ratioPriceFeedAbi,
  JBSuckerRegistry: sdk.jbSuckerRegistryAbi,
  JBSucker: jbSuckerV6Abi,
  JBOmnichainDeployer: sdk.jbOmnichainDeployerAbi,
  JBAddressRegistry: sdk.jbAddressRegistryAbi,
  REVDeployer: sdk.revDeployerAbi,
  REVLoans: sdk.revLoansAbi,
  REVOwner: sdk.revOwnerAbi,
  ERC2771Forwarder: sdk.erc2771ForwarderAbi,
};

export class ContractService {
  catalog() {
    return {
      version: 6,
      source: '@bananapus/nana-sdk-core@3.4.1',
      contracts: Object.entries(ABI_REGISTRY).map(([name, abi]) => ({
        name,
        abiEntries: rollout.contracts[name]?.abi.length ?? abi.length,
        deployments: rollout.contracts[name]
          ? Object.fromEntries(
              rollout.contracts[name]!.deployments.filter((item) => !item.retired).map((item) => [
                item.chainId,
                item.address,
              ]),
            )
          : ((sdk.jbContractAddress['6'] as Record<string, Partial<Record<ChainId, string>>>)[
              name
            ] ?? {}),
        ...(rollout.contracts[name]
          ? {
              generations: rollout.contracts[name]!.deployments,
              deploymentSource: { repository: rollout.source, commit: rollout.commit },
            }
          : {}),
        identity:
          name === 'JBSucker'
            ? 'project-instance'
            : rollout.contracts[name]
              ? 'deployment-records'
              : 'sdk-deployment-registry',
      })),
      warning:
        'Deployment records describe executed deployments per chain. Mainnet proposals are not active deployments. Retired implementations remain available for history and projects that have not migrated. Resolve registry -> gateway -> ROUTER and hookOf on-chain; an address is provenance, not a bytecode safety audit.',
    };
  }

  get(name: string, chainId?: ChainId, functionName?: string) {
    const abi = this.abi(name);
    const entries = functionName
      ? abi.filter((item) => 'name' in item && item.name === functionName)
      : abi;
    if (functionName && entries.length === 0)
      throw new DomainError(
        'FUNCTION_NOT_FOUND',
        'The named function or event is not in this contract ABI.',
      );
    return {
      version: 6,
      name,
      source: rollout.contracts[name] ? rollout.source : '@bananapus/nana-sdk-core@3.4.1',
      ...(chainId === undefined
        ? {}
        : { chainId, address: deploymentAddress(name, chainId) ?? null }),
      ...(rollout.contracts[name]
        ? {
            generations: rollout.contracts[name]!.deployments.filter(
              (item) => chainId === undefined || item.chainId === chainId,
            ),
            deploymentSource: { repository: rollout.source, commit: rollout.commit },
          }
        : {}),
      abi: entries,
    };
  }

  decode(name: string, data: Hex) {
    try {
      return {
        contract: name,
        version: 6,
        ...(jsonSafe(decodeFunctionData({ abi: this.abi(name), data })) as object),
        warning:
          'Decoding identifies an ABI call, not its destination or authorization. No transaction is prepared or sent.',
      };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        'CALLDATA_INVALID',
        'The calldata does not decode with the selected V6 ABI.',
      );
    }
  }

  private abi(name: string): Abi {
    if (Object.hasOwn(rollout.contracts, name)) return rollout.contracts[name]!.abi;
    if (!Object.hasOwn(ABI_REGISTRY, name))
      throw new DomainError(
        'CONTRACT_NOT_FOUND',
        'This contract is not in the supported V6 ABI registry.',
      );
    return ABI_REGISTRY[name]!;
  }
}
