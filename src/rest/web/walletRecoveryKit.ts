import { validateMnemonic } from '@scure/bip39';
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { wordlist as english } from '@scure/bip39/wordlists/english';
import { generateMnemonic, mnemonicToAccount } from 'viem/accounts';

export const walletRecoveryDerivationPath = "m/44'/60'/0'/0/0";
export interface WalletRecoverySecret { mnemonic: string; recoveryOwner: Address }
export interface WalletRecoveryKitIdentity {
  network: 'base'; chainId: 8453; walletAddress: Address; recoveryOwner: Address; initializerHash: Hex;
}
export interface WalletRecoveryKit extends WalletRecoveryKitIdentity, WalletRecoverySecret {
  version: 'juicebox-recovery-kit-v1'; derivationPath: typeof walletRecoveryDerivationPath;
}
function invalid(): never { throw new Error('This backup file or password does not match the selected wallet.'); }
function address(value: unknown): asserts value is Address {
  if (typeof value !== 'string' || !isAddress(value) || BigInt(value) <= 1n) invalid();
}
function identity(value: WalletRecoveryKitIdentity) {
  if (!value || value.network !== 'base' || value.chainId !== 8453) invalid();
  address(value.walletAddress); address(value.recoveryOwner);
  if (getAddress(value.walletAddress) === getAddress(value.recoveryOwner) || typeof value.initializerHash !== 'string'
    || !/^0x[0-9a-f]{64}$/.test(value.initializerHash) || BigInt(value.initializerHash) === 0n) invalid();
}
/** Browser memory only. Callers must never put these return values in storage, telemetry,
 * URLs or request bodies. JavaScript cannot promise deterministic memory erasure. */
export function createWalletRecoverySecret(): WalletRecoverySecret {
  const mnemonic = generateMnemonic(english, 256);
  return { mnemonic, recoveryOwner: recoveryAccountFromPhrase(mnemonic).address };
}
export function recoveryAccountFromPhrase(input: string, expectedOwner?: Address) {
  if (typeof input !== 'string' || input.length > 512) invalid();
  const mnemonic = input.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!/^[a-z]+(?: [a-z]+){23}$/.test(mnemonic) || !validateMnemonic(mnemonic, english)) invalid();
  const account = mnemonicToAccount(mnemonic, { path: walletRecoveryDerivationPath });
  if (expectedOwner !== undefined) { address(expectedOwner); if (account.address !== getAddress(expectedOwner)) invalid(); }
  return account;
}
/** An explicit user download is the sole durable secret export. The Safe address is part
 * of the kit because a passkey-created Safe cannot be derived from the recovery phrase. */
export function serializeWalletRecoveryKit(secret: WalletRecoverySecret, selected: WalletRecoveryKitIdentity): string {
  identity(selected);
  if (recoveryAccountFromPhrase(secret.mnemonic, secret.recoveryOwner).address !== getAddress(selected.recoveryOwner)) invalid();
  return JSON.stringify({ version: 'juicebox-recovery-kit-v1', network: selected.network, chainId: selected.chainId,
    walletAddress: getAddress(selected.walletAddress), initializerHash: selected.initializerHash,
    recoveryOwner: getAddress(selected.recoveryOwner), derivationPath: walletRecoveryDerivationPath, mnemonic: secret.mnemonic }, null, 2);
}
export function readWalletRecoveryKit(input: string, expected?: WalletRecoveryKitIdentity): WalletRecoveryKit {
  if (typeof input !== 'string' || input.length > 8192) invalid();
  let value: WalletRecoveryKit;
  try { value = JSON.parse(input); } catch { return invalid(); }
  const fields = ['version', 'network', 'chainId', 'walletAddress', 'initializerHash', 'recoveryOwner', 'derivationPath', 'mnemonic'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length
    || fields.some(key => !Object.hasOwn(value, key)) || value.version !== 'juicebox-recovery-kit-v1'
    || value.derivationPath !== walletRecoveryDerivationPath) invalid();
  identity(value); recoveryAccountFromPhrase(value.mnemonic, value.recoveryOwner);
  if (expected) {
    identity(expected);
    if (value.network !== expected.network || value.chainId !== expected.chainId || value.initializerHash !== expected.initializerHash
      || getAddress(value.walletAddress) !== getAddress(expected.walletAddress) || getAddress(value.recoveryOwner) !== getAddress(expected.recoveryOwner)) invalid();
  }
  return value;
}
