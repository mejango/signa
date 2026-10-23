import type { Address, Hex, TransactionSerializable } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** A server key as its callers use it: an address and transaction signing, nothing else. A hosted key
 * service implements the same two members, so a key can move off the host without touching callers. */
export interface ServerSigner {
  readonly address: Address;
  signTransaction(transaction: TransactionSerializable): Promise<Hex>;
}

/** The 32-byte hex private key named `name` in the environment, or undefined when unset. The value is never logged. */
export function envServerSigner(name: string): ServerSigner | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${name} must be a 32-byte hex private key`);
  const account = privateKeyToAccount(value as Hex);
  return Object.freeze({ address: account.address, signTransaction: (transaction: TransactionSerializable) => account.signTransaction(transaction) });
}
