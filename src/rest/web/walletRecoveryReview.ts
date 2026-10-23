import { concatHex, encodeAbiParameters, encodeFunctionData, getAddress, getContractAddress, isAddress, toHex, zeroAddress, zeroHash, type Address, type Hex } from 'viem';
import type { WalletRecoveryRotation } from '../wallet/recoveryRotation.js';
import { SIGNA_HOME_CHAIN_ID } from '../wallet/chains.js';
import { SAFE_WEBAUTHN_SIGNER_PROXY_CREATION_CODE } from '../smartAccounts/passkeyCreation.js';

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
export function walletRecoveryRotationSafeTx(walletAddress: Address, data: Hex, safeNonce: string, chainId: number = SIGNA_HOME_CHAIN_ID) {
  if (!/^0x[0-9a-f]{200}$/.test(data)) invalid();
  return walletOwnerChangeSafeTx(walletAddress, data, safeNonce, chainId);
}
/** The same standard SafeTx for any reviewed owner change: a swap (100 bytes) or an addition (68 bytes).
 * The chain id is in the domain, so an approval for one chain never executes on another. */
export function walletOwnerChangeSafeTx(walletAddress: Address, data: Hex, safeNonce: string, chainId: number = SIGNA_HOME_CHAIN_ID) {
  if (!isAddress(walletAddress) || !/^0x[0-9a-f]{136}$|^0x[0-9a-f]{200}$/.test(data) || !Number.isSafeInteger(chainId) || chainId <= 0
    || !/^(0|[1-9][0-9]{0,77})$/.test(safeNonce) || BigInt(safeNonce) >= 1n << 256n) invalid();
  return { domain: { chainId, verifyingContract: walletAddress }, types, primaryType: 'SafeTx' as const,
    message: { to: walletAddress, value: 0n, data, operation: 0, safeTxGas: 0n, baseGas: 0n,
      gasPrice: 0n, gasToken: zeroAddress, refundReceiver: zeroAddress, nonce: BigInt(safeNonce) } };
}
/** The passkey signer contracts of every Signa account (`preparePasskeyDependencyDeployment`), built into the page so a
 * recovery's new owner is derived here from the passkey this browser created, never taken from Signa's server. */
export const WALLET_PASSKEY_PROFILE = { signerFactory: '0x48c4F4B3d2684f39437F68faC4Ecc49f8F85163D', signerSingleton: '0x6613cA05f68002B7091963D9D4AB0DB232ed0648',
  p256Verifier: '0xFbe0614fFB2226cd6d1D3F9A79BC73d7647b4C61' } as const satisfies Record<string, Address>;
const P256 = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn, P256_B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
/** A P-256 public key from a new passkey's SubjectPublicKeyInfo (`getPublicKey()`), the only form browsers give it in. */
export function walletPasskeyPublicKey(spki: ArrayBuffer | null, algorithm: number): { x: Hex; y: Hex } {
  const bytes = spki ? new Uint8Array(spki) : new Uint8Array();
  if (algorithm !== -7 || bytes.length !== 91 || toHex(bytes.slice(0, 27)) !== '0x3059301306072a8648ce3d020106082a8648ce3d03010703420004') invalid();
  return { x: toHex(bytes.slice(27, 59)), y: toHex(bytes.slice(59)) };
}
/** The Safe owner a passkey becomes and the call that creates it, from its public key and the built-in profile alone. */
export function walletPasskeySigner(publicKey: { x: Hex; y: Hex }) {
  if (!/^0x[0-9a-f]{64}$/.test(publicKey?.x) || !/^0x[0-9a-f]{64}$/.test(publicKey?.y)) invalid();
  const x = BigInt(publicKey.x), y = BigInt(publicKey.y), p = WALLET_PASSKEY_PROFILE;
  if (x >= P256 || y >= P256 || (((y * y - x * x * x + 3n * x - P256_B) % P256) + P256) % P256 !== 0n) invalid();
  return { replacementSigner: getContractAddress({ from: p.signerFactory, opcode: 'CREATE2', salt: zeroHash,
    bytecode: concatHex([SAFE_WEBAUTHN_SIGNER_PROXY_CREATION_CODE, encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint176' }],
      [p.signerSingleton, x, y, BigInt(p.p256Verifier)])]) }),
    rotationContext: { publicKey, signerFactory: p.signerFactory as Address, verifiers: p.p256Verifier as Hex } };
}
const ownerAbi = [
  {"name":"addOwnerWithThreshold","type":"function","stateMutability":"nonpayable","inputs":[{"type":"address","name":"owner"},{"type":"uint256","name":"_threshold"}],"outputs":[]},
  {"name":"removeOwner","type":"function","stateMutability":"nonpayable","inputs":[{"type":"address","name":"prevOwner"},{"type":"address","name":"owner"},{"type":"uint256","name":"_threshold"}],"outputs":[]},
  {"name":"swapOwner","type":"function","stateMutability":"nonpayable","inputs":[{"type":"address","name":"prevOwner"},{"type":"address","name":"oldOwner"},{"type":"address","name":"newOwner"}],"outputs":[]},
] as const;
/** The Safe owner calls, in order, that take `owners` (in the Safe's own list order) to exactly `target` with a threshold
 * of one: a swap for each owner replaced, then additions at the head, then removals. Each call is one SafeTx; `path[i]`
 * is the owner list before call `i`, and the last entry is the list after them all. Shared by the server, which builds
 * the update, and the backup kit, which rebuilds it before signing. */
export function walletOwnerPlan(owners: readonly Address[], target: readonly Address[]): { steps: Hex[]; path: Address[][] } {
  const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase(), has = (list: readonly Address[], owner: Address) => list.some(item => same(item, owner));
  let list = owners.map(owner => getAddress(owner));
  const wanted = target.map(owner => getAddress(owner)), remove = list.filter(owner => !has(wanted, owner)), add = wanted.filter(owner => !has(list, owner));
  const steps: Hex[] = [], path: Address[][] = [[...list]];
  const previous = (owner: Address) => { const index = list.indexOf(owner); return index === 0 ? '0x0000000000000000000000000000000000000001' as Address : list[index - 1]!; };
  const step = (data: Hex, next: Address[]) => { steps.push(data); list = next; path.push([...list]); };
  const swaps = Math.min(remove.length, add.length);
  for (let i = 0; i < swaps; i++)
    step(encodeFunctionData({ abi: ownerAbi, functionName: 'swapOwner', args: [previous(remove[i]!), remove[i]!, add[i]!] }), list.map(owner => owner === remove[i] ? add[i]! : owner));
  for (const owner of add.slice(swaps)) step(encodeFunctionData({ abi: ownerAbi, functionName: 'addOwnerWithThreshold', args: [owner, 1n] }), [owner, ...list]);
  for (const owner of remove.slice(swaps)) step(encodeFunctionData({ abi: ownerAbi, functionName: 'removeOwner', args: [previous(owner), owner, 1n] }), list.filter(item => item !== owner));
  return { steps, path };
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
  // A review for another chain names it; the home chain's review carries no chain id.
  const chain = review && Object.hasOwn(review, 'chainId') ? review.chainId : undefined;
  if (chain !== undefined && (!Number.isSafeInteger(chain) || chain <= 0 || chain === SIGNA_HOME_CHAIN_ID)) invalid();
  if (!review || typeof previous !== 'string' || !isAddress(previous, { strict: true }) || previous === zeroAddress || previous === selected.priorSigner || previous === selected.replacementSigner) invalid();
  const p = selected.rotationContext;
  if (!p || !/^0x[0-9a-f]{64}$/.test(p.publicKey?.x) || !/^0x[0-9a-f]{64}$/.test(p.publicKey?.y)
    || !/^0x[0-9a-fA-F]{1,44}$/.test(p.verifiers) || BigInt(p.verifiers) <= 1n
    || !isAddress(p.signerFactory) || !isAddress(selected.walletAddress)) invalid();
  const expected: WalletRecoveryRotation = { version: 'center-wallet-recovery-rotation-v1', ...(chain === undefined ? {} : { chainId: chain }), recoveryId: selected.id,
    candidateDigest: selected.candidateDigest, walletAddress: getAddress(selected.walletAddress), initializerHash: selected.initializerHash,
    recoveryOwner: selected.recoveryOwner, priorSigner: selected.priorSigner, replacementSigner: selected.replacementSigner,
    previousOwner: review.previousOwner, safeNonce: review.safeNonce,
    createSigner: { to: getAddress(p.signerFactory), value: '0', data: encodeFunctionData({ abi: factoryAbi, functionName: 'createSigner',
      args: [BigInt(p.publicKey.x), BigInt(p.publicKey.y), BigInt(p.verifiers)] }) },
    swapOwner: { to: getAddress(selected.walletAddress), value: '0', data: encodeFunctionData({ abi: safeAbi, functionName: 'swapOwner',
      args: [review.previousOwner as Address, selected.priorSigner, selected.replacementSigner] }) } };
  const document = walletRecoveryRotationSafeTx(expected.walletAddress, expected.swapOwner.data, expected.safeNonce, chain);
  const expectedJson = JSON.parse(JSON.stringify({ review: expected, document }, (_key, item) => typeof item === 'bigint' ? String(item) : item));
  if (received !== canonical(expectedJson)) invalid();
  return document;
}
