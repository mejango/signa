import { decodeFunctionResult, encodeFunctionData, getAddress, isAddress, keccak256, parseAbi, type Address, type Hex } from 'viem';
import { USDC_ADDRESSES } from '@bananapus/nana-sdk-core';
import publications from '../smartAccounts/targets-evidence/publications.json' with { type: 'json' };
import { RestError, type RestRpc } from '../core.js';
import { createConfiguredSmartAccountStack } from '../smartAccounts/stack/config.js';
import { preparePasskeyDependencyDeployment } from '../smartAccounts/passkeyProfile.js';
import { validatePasskeyCreationManifest } from '../smartAccounts/passkeyCreation.js';
import { fingerprint } from '../smartAccounts/service.js';
import type { SmartAccountManifest } from '../smartAccounts/types.js';
import { rpcHex } from '../protocol/code.js';
import { operationRpc, walletPreflightRpcBounds } from './operationRpc.js';

/** Fixed production candidate, derived from the same hash-checked compiler artifacts as
 * wallet inspection. No environment variable can substitute dependency addresses or code. */
export async function createBaseWalletProductionStack() {
  const base = await createConfiguredSmartAccountStack({ chainId: 8453 });
  const passkey = await preparePasskeyDependencyDeployment();
  const { revision: _baseRevision, ...baseManifest } = base.manifest;
  const body = { ...baseManifest, id: 'center-passkey-base-v1', policies: [], ownerProfile: passkey.profile,
    creationProfile: { version: 'center-passkey-bootstrap-v1' as const, multiSend: {
      address: '0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526' as const,
      runtimeCodeHash: '0x0e4f7fc66550a322d1e7688e181b75e217e662a4f3f4d6a29b22bc61217c4b77' as Hex,
      source: { repository: 'https://github.com/safe-global/safe-contracts',
        commit: 'bf943f80fec5ac647159d26161446ac5d716a294',
        artifactSha256: 'cdfa2bbcba64c698db975a0c332457f3ec1a0653f147ff6b5d2ee8771084961b' },
    } } };
  const manifest: SmartAccountManifest = { ...body, revision: fingerprint(body) };
  validatePasskeyCreationManifest(manifest);
  return { manifest, utility: base.utility, senderCreator: base.senderCreator, payments: basePaymentConfiguration(), ...passkey };
}

/** Payment reviews recognise one token and one terminal on Base: the SDK's USDC and the
 * JBMultiTerminal the verified V6 catalog pins. Trusted host configuration; a request can never
 * supply these. The approval page bundles the same pair at build time (scripts/rest/build-web.mjs). */
export function basePaymentConfiguration(): { token: Address; directV6Terminal: Address } {
  const pinned = publications.deployments.find(entry => entry.chainId === 8453 && entry.name === 'JBMultiTerminal');
  if (!pinned || !isAddress(pinned.deployment.address)) invalid('The V6 catalog does not pin JBMultiTerminal on Base.');
  return { token: getAddress(USDC_ADDRESSES[8453]), directV6Terminal: getAddress(pinned.deployment.address) };
}

const singletonAbi = parseAbi(['function SINGLETON() view returns(address)']);
function invalid(message: string): never { throw new RestError(503, 'WALLET_PRODUCTION_STACK_UNVERIFIED', message); }
function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i.test(value)) invalid('Invalid chain quantity.');
  return BigInt(value);
}
function block(value: unknown, now: number) {
  const v = value as { hash?: unknown; number?: unknown; timestamp?: unknown } | null;
  if (!v || typeof v.hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(v.hash) || BigInt(v.hash) === 0n) invalid('Missing canonical block.');
  const number = quantity(v.number), timestamp = quantity(v.timestamp);
  if (!Number.isSafeInteger(now) || now <= 0 || timestamp * 1000n > BigInt(now + 30000)
    || timestamp * 1000n < BigInt(now - 60000)) invalid('Fresh chain evidence is required.');
  return { number: v.number as Hex, hash: v.hash as Hex, timestamp: String(timestamp), blockNumber: String(number) };
}

/** Read-only qualification of dependencies, never treasury dispatch eligibility. Estimates
 * exclude L1/operator charges and cannot authorize spending or release a sender lane. */
export async function inspectBaseWalletProductionStack(options: { rpc: RestRpc; signal?: AbortSignal; now?: () => number }) {
  const stack = await createBaseWalletProductionStack(), m = stack.manifest;
  const now = options.now ?? Date.now, observedAt = now();
  const rpc = operationRpc(options.rpc, walletPreflightRpcBounds, options.signal);
  try {
    if (quantity(await rpc.request('eth_chainId', [])) !== 8453n) invalid('The provider chain differs from Base.');
    const head = block(await rpc.request('eth_getBlockByNumber', ['latest', false]), observedAt);
    const tag = { blockHash: head.hash, requireCanonical: true };
    const observed: { name: string; address: string; runtimeCodeHash: Hex; deployed: boolean }[] = [];
    const pins = [
      { name: 'DeploymentProxy', pin: { address: stack.deployer.address, runtimeCodeHash: keccak256(stack.deployer.runtime) } },
      ...Object.entries({ SafeL2: m.singleton, SafeProxyFactory: m.factory, Safe7579: m.safe7579,
        Safe7579Launchpad: m.launchpad, Safe7579DCUtil: stack.utility, EntryPoint: m.entryPoint,
        SenderCreator: stack.senderCreator, SmartSession: m.smartSessions, MultiSend: m.creationProfile!.multiSend,
        FCLP256Verifier: m.ownerProfile!.p256Verifier, SafeWebAuthnSignerFactory: m.ownerProfile!.signerFactory,
        SafeWebAuthnSignerSingleton: m.ownerProfile!.signerSingleton }).map(([name, pin]) => ({ name, pin })),
    ];
    // Independent code reads share the original deadline and byte budget. Four in flight
    // keeps the public RPC observation bounded without serial network round trips.
    for (let offset = 0; offset < pins.length; offset += 4) {
      const results = await Promise.all(pins.slice(offset, offset + 4).map(async ({ name, pin }) => {
        if (!pin) invalid(`The ${name} deployment pin is missing.`);
        return { name, pin, code: rpcHex(await rpc.request('eth_getCode', [pin.address, tag]), 'production dependency runtime') };
      }));
      for (const { name, pin, code } of results) {
        const deployed = code !== '0x';
        if ((!deployed && !['FCLP256Verifier', 'SafeWebAuthnSignerFactory', 'SafeWebAuthnSignerSingleton'].includes(name))
          || (deployed && keccak256(code) !== pin.runtimeCodeHash)) invalid(`${name} runtime differs from the tested artifact.`);
        observed.push({ name, address: pin.address, runtimeCodeHash: keccak256(code), deployed });
      }
    }
    const factory = observed.find(item => item.name === 'SafeWebAuthnSignerFactory')!;
    const singleton = observed.find(item => item.name === 'SafeWebAuthnSignerSingleton')!;
    if (factory.deployed !== singleton.deployed) invalid('Factory and singleton runtime evidence is inconsistent.');
    if (factory.deployed) {
      const result = rpcHex(await rpc.request('eth_call', [{ to: factory.address,
        data: encodeFunctionData({ abi: singletonAbi, functionName: 'SINGLETON' }) }, tag]), 'factory singleton');
      if (decodeFunctionResult({ abi: singletonAbi, functionName: 'SINGLETON', data: result }).toLowerCase()
        !== singleton.address.toLowerCase()) invalid('The factory uses another singleton.');
    }
    const missing: { name: string; address: string; runtimeCodeHash: Hex; initCodeHash: Hex;
      transaction: { to: string; data: Hex; value: '0' }; estimatedGas: string }[] = [];
    for (const item of stack.deployments) {
      if (observed.find(pin => pin.name === item.name)!.deployed) continue;
      const call = { ...item.transaction, value: '0x0' };
      const result = rpcHex(await rpc.request('eth_call', [call, tag]), 'deployment simulation');
      if (result.toLowerCase() !== item.pin.address.toLowerCase()) invalid('Deployment simulation returned another address.');
      const gas = quantity(await rpc.request('eth_estimateGas', [call, head.number]));
      if (gas <= 0n || gas > 8000000n) invalid('The deployment estimate exceeds the reviewed bound.');
      missing.push({ name: item.name, address: item.pin.address, runtimeCodeHash: item.pin.runtimeCodeHash,
        initCodeHash: item.initCodeHash, transaction: item.transaction, estimatedGas: String(gas) });
    }
    const current = block(await rpc.request('eth_getBlockByNumber', [head.number, false]), now());
    if (current.hash.toLowerCase() !== head.hash.toLowerCase() || current.number !== head.number
      || current.timestamp !== head.timestamp) invalid('The canonical observation changed.');
    rpc.check();
    return { version: 'center-wallet-production-stack-observation-v1' as const, chainId: 8453,
      status: missing.length ? 'dependencies-missing' as const : 'dependencies-verified' as const,
      observedAt, evidence: { blockNumber: head.blockNumber, blockHash: head.hash, timestamp: head.timestamp },
      manifest: m, utility: stack.utility, observed, missing, dispatchEnabled: false as const,
      feeScope: 'execution-gas-only-excludes-l1-and-operator-fees' as const };
  } finally { rpc.close(); }
}
