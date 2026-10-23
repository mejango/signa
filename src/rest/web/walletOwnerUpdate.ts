import type { Address, Hex } from 'viem';
import { SAFE_141_MULTI_SEND } from '../smartAccounts/safeCode.js';
import { walletOwnerChangeSafeTx } from './walletRecoveryReview.js';

/** A network update's owner calls (`walletOwnerPlan`) as the one Safe transaction its owner signs, at the network's
 * current nonce: the call itself when there is one, otherwise the pinned Safe 1.4.1 MultiSend, delegatecalled, running
 * them in order as the Safe calling itself. Nothing is ever signed for a later nonce, so no signature can wait for one. */
export function walletOwnerUpdateSafeTx(walletAddress: Address, steps: readonly Hex[], safeNonce: string, chainId: number) {
  // Each step is checked as an owner call on this Safe by the shared SafeTx builder, which also binds the chain and nonce.
  const base = walletOwnerChangeSafeTx(walletAddress, steps[0]!, safeNonce, chainId);
  for (const step of steps.slice(1)) walletOwnerChangeSafeTx(walletAddress, step, safeNonce, chainId);
  if (steps.length === 1) return base;
  // multiSend(bytes): each call packed as operation 0, the Safe, value 0, the data length and the data.
  const word = (value: number | bigint) => value.toString(16).padStart(64, '0');
  const packed = steps.map(step => `00${walletAddress.slice(2).toLowerCase()}${word(0)}${word((step.length - 2) / 2)}${step.slice(2)}`).join('');
  const length = packed.length / 2, data = `0x8d80ff0a${word(32)}${word(length)}${packed}${'0'.repeat((64 - (packed.length % 64)) % 64)}` as Hex;
  return { ...base, message: { ...base.message, to: SAFE_141_MULTI_SEND, data, operation: 1 } };
}
