import { validateMnemonic } from '@scure/bip39';
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { signaChains } from '../wallet/chains.js';
import { walletOwnerChangeSafeTx } from './walletRecoveryReview.js';
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

/** The account's Safe on one chain as that chain's public RPC reports it, never as Signa's server does: whether it is
 * deployed and, if so, its owners in order, threshold and nonce. The RPC must answer as that chain, within ten seconds. */
export interface WalletChainSafe { deployed: boolean; owners: Address[]; threshold: bigint; nonce: bigint }
export async function readChainSafe(walletAddress: string, chainId: number): Promise<WalletChainSafe> {
  address(walletAddress);
  const rpc = signaChains.find(chain => chain.chainId === chainId)?.publicRpc ?? invalid();
  const signal = AbortSignal.timeout(10_000);
  const batch = async (calls: readonly (readonly [string, readonly unknown[]])[]) => {
    const response = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer',
      signal, body: JSON.stringify(calls.map(([method, params], id) => ({ jsonrpc: '2.0', id, method, params }))) });
    const replies = await response.json() as { id: number; result?: unknown }[];
    return calls.map((_, id) => Array.isArray(replies) ? replies.find(reply => reply?.id === id)?.result : undefined);
  };
  // Every read is at one block, named by its hash and required to be canonical, so the owners and the nonce describe the same state.
  const [chain, head] = await batch([['eth_chainId', []], ['eth_getBlockByNumber', ['latest', false]]]);
  const hash = (head as { hash?: unknown } | null)?.hash;
  if (chain !== `0x${chainId.toString(16)}` || typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) invalid();
  const block = { blockHash: hash, requireCanonical: true };
  const call = (data: string) => ['eth_call', [{ to: walletAddress, data }, block]] as const;
  const [code, owners, threshold, nonce] = await batch([['eth_getCode', [walletAddress, block]], call('0xa0e67e2b'), call('0xe75235b8'), call('0xaffed0e0')]);
  const word = (value: unknown) => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value) ? BigInt(value) : invalid();
  if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(code)) invalid();
  if (code === '0x') return { deployed: false, owners: [], threshold: 0n, nonce: 0n };
  if (typeof owners !== 'string' || !/^0x(?:[0-9a-fA-F]{64})+$/.test(owners)) invalid();
  // getOwners() returns one address[]: its offset, its length, then one word per owner.
  const words = owners.slice(2).match(/.{64}/g)!, count = Number(BigInt(`0x${words[1] ?? ''}`));
  if (BigInt(`0x${words[0]}`) !== 32n || !count || count > 16 || words.length !== count + 2) invalid();
  return { deployed: true, owners: words.slice(2).map(item => { if (!/^0{24}/.test(item)) invalid(); return getAddress(`0x${item.slice(24)}`); }),
    threshold: word(threshold), nonce: word(nonce) };
}
/** Safe's owner calls by selector, with their argument count; the arguments are plain 32-byte words. */
const ownerCalls: Record<string, ['add' | 'remove' | 'swap', number]> = { '0x0d582f13': ['add', 2], '0xf8dc5dd9': ['remove', 3], '0xe318b52b': ['swap', 3] };
function ownerCall(data: unknown) {
  if (typeof data !== 'string' || !/^0x[0-9a-f]+$/.test(data)) invalid();
  const [kind, count] = ownerCalls[data.slice(0, 10)] ?? invalid();
  if (data.length !== 10 + 64 * count) invalid();
  const words = Array.from({ length: count }, (_, i) => data.slice(10 + 64 * i, 74 + 64 * i));
  const owner = (word: string) => { if (!word.startsWith('0'.repeat(24))) invalid(); return getAddress(`0x${word.slice(24)}`); };
  return { kind, words, owner };
}
/** One network's update to Base's owners, checked as far as the page can: owner calls on this account only, on a
 * chain the person chose, each a valid step of Safe's owner list from `from` to `owners`, with a threshold of one
 * and the backup kept as an owner. Then the backup signs each call in order, from the update's Safe nonce. */
export async function signWalletOwnerUpdate(mnemonic: string, input: unknown, expected: { walletAddress: string; chainIds: number[] }): Promise<Hex[]> {
  const update = input as { chainId: number; walletAddress: Address; recoveryOwner: Address; from: Address[]; owners: Address[]; safeNonce: string; steps: Hex[] };
  const owners = (value: unknown) => { if (!Array.isArray(value) || !value.length || value.length > 16) invalid(); for (const item of value) address(item); return (value as Address[]).map(item => getAddress(item)); };
  if (!update || typeof update !== 'object' || !expected.chainIds.includes(update.chainId) || !Array.isArray(update.steps) || !update.steps.length || update.steps.length > 16) invalid();
  address(update.walletAddress); address(update.recoveryOwner);
  if (getAddress(update.walletAddress) !== getAddress(expected.walletAddress) || typeof update.safeNonce !== 'string' || !/^(0|[1-9][0-9]{0,30})$/.test(update.safeNonce)) invalid();
  const backup = recoveryAccountFromPhrase(mnemonic, update.recoveryOwner), target = owners(update.owners);
  let list = owners(update.from);
  const previous = (owner: Address) => { const index = list.indexOf(owner); if (index < 0) invalid(); return index ? list[index - 1]! : '0x0000000000000000000000000000000000000001'; };
  for (const step of update.steps) {
    const { kind, words, owner } = ownerCall(step), last = BigInt(`0x${words[words.length - 1]}`);
    if (kind === 'add') { const added = owner(words[0]!); if (last !== 1n || list.includes(added)) invalid(); list = [added, ...list]; continue; }
    const [prev, removed] = [owner(words[0]!), owner(words[1]!)];
    if (removed === backup.address || prev !== getAddress(previous(removed))) invalid();
    if (kind === 'remove') { if (last !== 1n) invalid(); list = list.filter(item => item !== removed); }
    else { const next = owner(words[2]!); if (list.includes(next)) invalid(); list = list.map(item => item === removed ? next : item); }
  }
  if (list.length !== target.length || target.some(owner => !list.includes(owner)) || !list.includes(backup.address)) invalid();
  return Promise.all(update.steps.map((step, index) => backup.signTypedData(walletOwnerChangeSafeTx(update.walletAddress, step, String(BigInt(update.safeNonce) + BigInt(index)), update.chainId))));
}
