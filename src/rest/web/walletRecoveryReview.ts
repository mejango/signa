import { encodeFunctionData, getAddress, isAddress, zeroAddress, type Address, type Hex } from 'viem';
import type { WalletRecoveryRotation } from '../wallet/recoveryRotation.js';

export interface WalletRecoveryReviewSelection {
  id: string; candidateDigest: string; walletAddress: Address; initializerHash: Hex;
  recoveryOwner: Address; priorSigner: Address; replacementSigner: Address;
  rotationContext: { publicKey: { x: Hex; y: Hex }; signerFactory: Address; verifiers: Hex };
}
const factoryAbi = [{"name":"createSigner","type":"function","stateMutability":"nonpayable","inputs":[{"type":"uint256","name":"x"},{"type":"uint256","name":"y"},{"type":"uint176","name":"verifiers"}],"outputs":[{"type":"address"}]}] as const;
const safeAbi = [{"name":"swapOwner","type":"function","stateMutability":"nonpayable","inputs":[{"type":"address","name":"previousOwner"},{"type":"address","name":"oldOwner"},{"type":"address","name":"newOwner"}],"outputs":[]}] as const;
const types = { SafeTx: [
  { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' },
  { name: 'operation', type: 'uint8' }, { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
  { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' }, { name: 'refundReceiver', type: 'address' },
  { name: 'nonce', type: 'uint256' },
] } as const;
function invalid(): never { throw new Error('The recovery rotation review changed. Reload the original recovery before approving.'); }
/** Browser-compatible standard SafeTx builder, shared with the server's validated review.
 * This returns signing data only; callers must establish the selected review's provenance. */
export function walletRecoveryRotationSafeTx(walletAddress: Address, data: Hex, safeNonce: string) {
  if (!/^0x[0-9a-f]{200}$/.test(data)) invalid();
  return walletOwnerChangeSafeTx(walletAddress, data, safeNonce);
}
/** The same standard SafeTx for any reviewed owner change: a swap (100 bytes) or an addition (68 bytes). */
export function walletOwnerChangeSafeTx(walletAddress: Address, data: Hex, safeNonce: string) {
  if (!isAddress(walletAddress) || !/^0x[0-9a-f]{136}$|^0x[0-9a-f]{200}$/.test(data)
    || !/^(0|[1-9][0-9]{0,77})$/.test(safeNonce) || BigInt(safeNonce) >= 1n << 256n) invalid();
  return { domain: { chainId: 8453, verifyingContract: walletAddress }, types, primaryType: 'SafeTx' as const,
    message: { to: walletAddress, value: 0n, data, operation: 0, safeTxGas: 0n, baseGas: 0n,
      gasPrice: 0n, gasToken: zeroAddress, refundReceiver: zeroAddress, nonce: BigInt(safeNonce) } };
}
function canonical(value: unknown, depth = 0, budget = { nodes: 0, bytes: 0 }): string {
  if (++budget.nodes > 256 || depth > 8) invalid();
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isSafeInteger(value) || Object.is(value, -0)) invalid(); return String(value); }
  if (typeof value === 'string') { budget.bytes += value.length; if (budget.bytes > 16384) invalid(); return JSON.stringify(value); }
  if (!value || typeof value !== 'object' || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Object.keys(value);
  if (Reflect.ownKeys(value).length !== keys.length + (Array.isArray(value) ? 1 : 0)
    || keys.some(key => !descriptors[key] || !('value' in descriptors[key]!))) invalid();
  if (Array.isArray(value)) {
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) invalid();
    return '[' + keys.map(key => canonical(descriptors[key]!.value, depth + 1, budget)).join(',') + ']';
  }
  return '{' + keys.sort().map(key => JSON.stringify(key) + ':' + canonical(descriptors[key]!.value, depth + 1, budget)).join(',') + '}';
}
/** Validate the exact JSON reply against the browser's already selected public identity.
 * Recovery words, provider methods and signing capabilities never enter this helper. */
export function assertWalletRecoveryRotationReview(input: unknown, selected: WalletRecoveryReviewSelection) {
  const received = canonical(input); canonical(selected);
  const value = input as { review: WalletRecoveryRotation; document: unknown }, review = value.review;
  // The previous owner is the sentinel, the recovery owner, or a device passkey's signer (devices sit
  // ahead of the primary in the Safe list). A wrong value only reverts the swap; the rotating signers
  // themselves are rebuilt from the selection below, so they can never be the link.
  const previous = review?.previousOwner;
  if (!review || typeof previous !== 'string' || !isAddress(previous, { strict: true }) || previous === zeroAddress || previous === selected.priorSigner || previous === selected.replacementSigner) invalid();
  const p = selected.rotationContext;
  if (!p || !/^0x[0-9a-f]{64}$/.test(p.publicKey?.x) || !/^0x[0-9a-f]{64}$/.test(p.publicKey?.y)
    || !/^0x[0-9a-fA-F]{1,44}$/.test(p.verifiers) || BigInt(p.verifiers) <= 1n
    || !isAddress(p.signerFactory) || !isAddress(selected.walletAddress)) invalid();
  const expected: WalletRecoveryRotation = { version: 'center-wallet-recovery-rotation-v1', recoveryId: selected.id,
    candidateDigest: selected.candidateDigest, walletAddress: getAddress(selected.walletAddress), initializerHash: selected.initializerHash,
    recoveryOwner: selected.recoveryOwner, priorSigner: selected.priorSigner, replacementSigner: selected.replacementSigner,
    previousOwner: review.previousOwner, safeNonce: review.safeNonce,
    createSigner: { to: getAddress(p.signerFactory), value: '0', data: encodeFunctionData({ abi: factoryAbi, functionName: 'createSigner',
      args: [BigInt(p.publicKey.x), BigInt(p.publicKey.y), BigInt(p.verifiers)] }) },
    swapOwner: { to: getAddress(selected.walletAddress), value: '0', data: encodeFunctionData({ abi: safeAbi, functionName: 'swapOwner',
      args: [review.previousOwner as Address, selected.priorSigner, selected.replacementSigner] }) } };
  const document = walletRecoveryRotationSafeTx(expected.walletAddress, expected.swapOwner.data, expected.safeNonce);
  const expectedJson = JSON.parse(JSON.stringify({ review: expected, document }, (_key, item) => typeof item === 'bigint' ? String(item) : item));
  if (received !== canonical(expectedJson)) invalid();
  return document;
}
