import { readFileSync } from 'node:fs';
import { jbContractAddress } from '@bananapus/nana-sdk-core';
import type { Abi, Address } from 'viem';

export const rollout = JSON.parse(
  readFileSync(new URL('../../data/rollout.json', import.meta.url), 'utf8'),
) as {
  source: string;
  commit: string;
  contracts: Record<
    string,
    {
      abi: Abi;
      deployments: {
        chainId: number;
        address: Address;
        generation: 'current' | 'previous' | 'v2' | 'v1';
        retired: boolean;
        source: string;
      }[];
    }
  >;
};

/** Only executed deployment records advertise a chain address; proposals do not. */
export function deploymentAddress(name: string, chainId: number): Address | undefined {
  const entry = rollout.contracts[name];
  if (entry)
    return entry.deployments.find((item) => item.chainId === chainId && !item.retired)?.address;
  return (jbContractAddress['6'] as Record<string, Record<number, Address>>)[name]?.[chainId];
}

/** Retired addresses remain recognizable for existing projects and historical decoding. */
export function deploymentAddresses(name: string, chainId: number): Address[] {
  const entry = rollout.contracts[name];
  if (entry)
    return [
      ...new Set(
        entry.deployments.filter((item) => item.chainId === chainId).map((item) => item.address),
      ),
    ];
  const address = deploymentAddress(name, chainId);
  return address ? [address] : [];
}

export const routerGatewayAbi = rollout.contracts.JBRouterTerminalGateway!.abi;
export const ratioPriceFeedAbi = rollout.contracts.JBRatioPriceFeed!.abi;
