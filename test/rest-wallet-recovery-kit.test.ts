import { describe, expect, it } from 'vitest';
import { mnemonicToAccount } from 'viem/accounts';
import { createWalletRecoverySecret, readWalletRecoveryKit, recoveryAccountFromPhrase, serializeWalletRecoveryKit, signWalletOwnerUpdate } from '../src/rest/web/walletRecoveryKit.js';
import { encodeFunctionData, getAddress, hashTypedData, parseAbi, recoverAddress, type Address } from 'viem';
import { walletOwnerChangeSafeTx, walletOwnerPlan } from '../src/rest/web/walletRecoveryReview.js';

// Public BIP39 test entropy; never used for real funds.
const phrase = 'abandon '.repeat(23) + 'art';
const account = mnemonicToAccount(phrase, { path: "m/44'/60'/0'/0/0" });
const identity = { network: 'base' as const, chainId: 8453 as const, walletAddress: `0x${'11'.repeat(20)}` as const,
  initializerHash: `0x${'22'.repeat(32)}` as const, recoveryOwner: account.address };
describe('browser-owned portable recovery kit', () => {
  it('uses a standard 24-word recovery phrase and explicit Ethereum derivation path', () => {
    const secret = createWalletRecoverySecret(), other = createWalletRecoverySecret();
    expect(secret.mnemonic.split(' ')).toHaveLength(24); expect(secret.recoveryOwner).not.toBe(other.recoveryOwner);
    expect(recoveryAccountFromPhrase(secret.mnemonic, secret.recoveryOwner).address).toBe(secret.recoveryOwner);
    expect(recoveryAccountFromPhrase(phrase, account.address).address).toBe(account.address);
  });
  it('restores the independent owner and original Safe without Center or browser storage', async () => {
    const encoded = serializeWalletRecoveryKit({ mnemonic: phrase, recoveryOwner: account.address }, identity);
    const kit = readWalletRecoveryKit(encoded, identity), restored = recoveryAccountFromPhrase(kit.mnemonic, kit.recoveryOwner);
    expect(kit.walletAddress).toBe(identity.walletAddress); expect(kit.initializerHash).toBe(identity.initializerHash);
    expect(kit.derivationPath).toBe("m/44'/60'/0'/0/0");
    expect(await restored.signMessage({ message: 'Public recovery fixture' })).toBe(await account.signMessage({ message: 'Public recovery fixture' }));
  });
  it('refuses a valid kit for another wallet, key, chain, initializer or version', () => {
    const encoded = serializeWalletRecoveryKit({ mnemonic: phrase, recoveryOwner: account.address }, identity);
    for (const patch of [{ walletAddress: `0x${'33'.repeat(20)}` }, { initializerHash: `0x${'33'.repeat(32)}` },
      { recoveryOwner: `0x${'44'.repeat(20)}` }, { chainId: 1 }, { network: 'local-test' }, { version: 'later' },
      { derivationPath: "m/44'/60'/0'/0/1" }, { passphrase: 'extra authority' }]) {
      const changed = { ...JSON.parse(encoded), ...patch };
      expect(() => readWalletRecoveryKit(JSON.stringify(changed), identity)).toThrow();
    }
    expect(() => readWalletRecoveryKit(encoded.slice(0, -1) + ',"__proto__":{}}', identity)).toThrow();
  });
  it('checks checksum and bounds before deriving secrets and rejects unexpected owners', () => {
    for (const value of ['', 'abandon '.repeat(24), 'abandon '.repeat(11) + 'about', 'x'.repeat(4097)])
      expect(() => recoveryAccountFromPhrase(value)).toThrow();
    expect(() => recoveryAccountFromPhrase(phrase, identity.walletAddress)).toThrow();
    expect(() => readWalletRecoveryKit('x'.repeat(8193))).toThrow();
    expect(() => serializeWalletRecoveryKit({ mnemonic: phrase, recoveryOwner: identity.walletAddress }, identity)).toThrow();
  });
});

describe('a network owner update signed with the backup', () => {
  const [p0, p1, d1] = ['a0', 'a1', 'd1'].map(byte => getAddress(`0x${byte.repeat(20)}`)) as [Address, Address, Address];
  const wallet = identity.walletAddress, abi = parseAbi(['function addOwnerWithThreshold(address owner,uint256 _threshold)', 'function removeOwner(address prevOwner,address owner,uint256 _threshold)']);
  const update = (steps = walletOwnerPlan([p0, account.address], [d1, p1, account.address]).steps, owners = [d1, p1, account.address]) =>
    ({ chainId: 10, walletAddress: wallet, recoveryOwner: account.address, from: [p0, account.address], owners, safeNonce: '4', steps });
  it('signs each owner call for its chain at consecutive nonces once the calls lead to the owners shown', async () => {
    const value = update(), signatures = await signWalletOwnerUpdate(phrase, value, { walletAddress: wallet, chainIds: [10] });
    expect(signatures).toHaveLength(2);
    for (const [index, signature] of signatures.entries())
      expect(await recoverAddress({ hash: hashTypedData(walletOwnerChangeSafeTx(wallet, value.steps[index]!, String(4 + index), 10)), signature })).toBe(account.address);
  });
  it('refuses calls that differ from what the page can check', async () => {
    const sign = (value: unknown, chainIds = [10], walletAddress: string = wallet) => signWalletOwnerUpdate(phrase, value, { walletAddress, chainIds });
    await expect(sign(update(), [42161])).rejects.toThrow();
    await expect(sign(update(), [10], `0x${'33'.repeat(20)}`)).rejects.toThrow();
    await expect(sign(update(undefined, [p1, account.address]))).rejects.toThrow();
    await expect(sign(update([encodeFunctionData({ abi, functionName: 'removeOwner', args: [p0, account.address, 1n] })], [p0]))).rejects.toThrow();
    await expect(sign(update([encodeFunctionData({ abi, functionName: 'addOwnerWithThreshold', args: [p1, 2n] })], [p1, p0, account.address]))).rejects.toThrow();
    await expect(sign(update([encodeFunctionData({ abi, functionName: 'removeOwner', args: [p1, p0, 1n] })], [account.address]))).rejects.toThrow();
    await expect(sign(update([`0x6a761202${'00'.repeat(64)}`], [p0, account.address]))).rejects.toThrow();
    expect(await sign(update([encodeFunctionData({ abi, functionName: 'removeOwner', args: ['0x0000000000000000000000000000000000000001', p0, 1n] })], [account.address]))).toHaveLength(1);
  });
});
