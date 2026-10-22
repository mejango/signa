import { validateMnemonic } from '@scure/bip39';
import { concatHex, decodeAbiParameters, getAddress, getContractAddress, hashTypedData, isAddress, keccak256, type Address, type Hex } from 'viem';
import { SAFE_141_PROXY_CREATION_CODE } from '../smartAccounts/safeCode.js';
import { walletOwnerUpdateSafeTx } from './walletOwnerUpdate.js';
import { walletOwnerChangeSafeTx, walletOwnerPlan } from './walletRecoveryReview.js';
import { signaChains } from '../wallet/chains.js';
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
/** The account's owners on Base, as Base reports them, with a threshold of one. */
export async function readHomeOwners(walletAddress: string): Promise<Address[]> {
  const home = await readChainSafe(walletAddress, 8453);
  if (!home.deployed || home.threshold !== 1n) invalid();
  return home.owners;
}
/** One network's update to Base's owners, checked before anything signs it: the calls must be exactly the ones that take `from` to `owners`
 * (`walletOwnerPlan`: owner calls on this account only, a threshold of one, no owner added on the way that is not in
 * `owners`), on a chain the person chose, with the backup kept as an owner. `owners` must be exactly the owners this page
 * read from Base itself (`readHomeOwners`). On a deployed network, `from`, its order and the Safe nonce must be exactly what
 * this page read there (`readChainSafe`), so no signature waits for a later nonce; an undeployed one starts at nonce 0.
 * Returns the backup's address and each call's SafeTx, in order. */
export function walletOwnerUpdateDocuments(input: unknown, expected: { walletAddress: string; chainIds: number[]; homeOwners: Address[]; destination: WalletChainSafe;
  /** The backup file's record of the account's creation, when the backup came from the file. */
  initializerHash?: Hex }) {
  const update = input as { chainId: number; walletAddress: Address; recoveryOwner: Address; from: Address[]; owners: Address[]; safeNonce: string; steps: Hex[];
    creation?: { to: Address; data: Hex } };
  const owners = (value: unknown) => { if (!Array.isArray(value) || !value.length || value.length > 16) invalid(); for (const item of value) address(item); return (value as Address[]).map(item => getAddress(item)); };
  if (!update || typeof update !== 'object' || !expected.chainIds.includes(update.chainId) || !Array.isArray(update.steps) || !update.steps.length) invalid();
  address(update.walletAddress); address(update.recoveryOwner);
  if (getAddress(update.walletAddress) !== getAddress(expected.walletAddress) || typeof update.safeNonce !== 'string' || !/^(0|[1-9][0-9]{0,30})$/.test(update.safeNonce)) invalid();
  const backup = getAddress(update.recoveryOwner), from = owners(update.from), target = owners(update.owners);
  if (new Set(target).size !== target.length || !from.includes(backup) || !target.includes(backup)
    || target.length !== expected.homeOwners.length || target.some(owner => !expected.homeOwners.some(item => getAddress(item) === owner))) invalid();
  const there = expected.destination;
  const start = there.deployed ? { owners: there.owners, threshold: there.threshold, nonce: there.nonce } : { ...creationOwners(update.creation, update.walletAddress, expected.initializerHash), nonce: 0n };
  if (start.threshold !== 1n || BigInt(update.safeNonce) !== start.nonce || from.length !== start.owners.length || from.some((owner, index) => owner !== start.owners[index])) invalid();
  const plan = walletOwnerPlan(from, target);
  if (plan.steps.length !== update.steps.length || plan.steps.some((step, index) => step !== update.steps[index])) invalid();
  return { recoveryOwner: backup, documents: [walletOwnerUpdateSafeTx(getAddress(update.walletAddress), plan.steps, update.safeNonce, update.chainId)] };
}
/** The owners a network not deployed yet starts with: those its replayed creation call sets up. The call is trusted only
 * because it creates exactly this account's address (CREATE2 over the Safe 1.4.1 proxy, its singleton, initializer and
 * salt), and, given the backup file, because its initializer is the one the file recorded. */
function creationOwners(creation: { to: Address; data: Hex } | undefined, walletAddress: Address, initializerHash?: Hex) {
  if (!creation || typeof creation !== 'object' || typeof creation.data !== 'string' || !creation.data.startsWith('0x1688f0b9')) invalid(); // createProxyWithNonce
  address(creation.to);
  const [singleton, initializer, saltNonce] = decodeAbiParameters([{ type: 'address' }, { type: 'bytes' }, { type: 'uint256' }], `0x${creation.data.slice(10)}`);
  const salt = keccak256(concatHex([keccak256(initializer), `0x${saltNonce.toString(16).padStart(64, '0')}`]));
  const created = getContractAddress({ from: getAddress(creation.to), opcode: 'CREATE2', salt, bytecode: concatHex([SAFE_141_PROXY_CREATION_CODE, `0x${singleton.slice(2).padStart(64, '0')}`]) });
  if (created !== getAddress(walletAddress) || (initializerHash && keccak256(initializer) !== initializerHash.toLowerCase()) || !initializer.startsWith('0xb63e800d')) invalid(); // setup
  const [owners, threshold] = decodeAbiParameters([{ type: 'address[]' }, { type: 'uint256' }], `0x${initializer.slice(10)}`);
  return { owners: owners.map(owner => getAddress(owner)), threshold };
}
/** The backup file or password signs one checked network update (`walletOwnerUpdateDocuments`). */
export async function signWalletOwnerUpdate(mnemonic: string, input: unknown, expected: Parameters<typeof walletOwnerUpdateDocuments>[1]): Promise<Hex[]> {
  const { recoveryOwner, documents } = walletOwnerUpdateDocuments(input, expected), backup = recoveryAccountFromPhrase(mnemonic, recoveryOwner);
  return Promise.all(documents.map(document => backup.signTypedData(document)));
}
/** The SafeTx hash the primary passkey signs to add the device's signer on one chain, rebuilt from what this page shows
 * (the account and the device's signer), so a prompt never signs a hash the server chose. */
export function walletDeviceAdditionChallenge(walletAddress: string, deviceSigner: string, safeNonce: unknown, chainId: number): Hex {
  address(walletAddress); address(deviceSigner);
  if (typeof safeNonce !== 'string' || !/^(0|[1-9][0-9]{0,30})$/.test(safeNonce)) invalid();
  const data = `0x0d582f13${deviceSigner.slice(2).toLowerCase().padStart(64, '0')}${'1'.padStart(64, '0')}` as Hex; // addOwnerWithThreshold(device, 1)
  return hashTypedData(walletOwnerChangeSafeTx(getAddress(walletAddress), data, safeNonce, chainId));
}
