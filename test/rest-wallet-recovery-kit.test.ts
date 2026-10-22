import { afterEach, describe, expect, it, vi } from 'vitest';
import { mnemonicToAccount } from 'viem/accounts';
import { createWalletRecoverySecret, readChainSafe, walletDeviceAdditionChallenge, walletDeviceAdditionChallenges, readHomeOwners, readWalletRecoveryKit, recoveryAccountFromPhrase, serializeWalletRecoveryKit, signWalletOwnerUpdate } from '../src/rest/web/walletRecoveryKit.js';
import { concatHex, encodeAbiParameters, encodeFunctionData, getAddress, getContractAddress, hashTypedData, keccak256, parseAbi, recoverAddress, zeroAddress, type Address, type Hex } from 'viem';
import { SAFE_CREATION_ABI, SAFE_SETUP_ABI } from '../src/rest/smartAccounts/creation.js';
import { SAFE_141_MULTI_SEND, SAFE_141_PROXY_CREATION_CODE } from '../src/rest/smartAccounts/safeCode.js';
import { walletOwnerUpdateSafeTx } from '../src/rest/web/walletOwnerUpdate.js';
import { walletOwnerPlan } from '../src/rest/web/walletRecoveryReview.js';
import { signaChains } from '../src/rest/wallet/chains.js';

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
  // Optimism as its public RPC reports it: the original owners, at nonce 4.
  const destination = { deployed: true, owners: [p0, account.address], threshold: 1n, nonce: 4n };
  it('signs one Safe transaction at the network nonce that runs every owner call in order', async () => {
    const value = update(), signatures = await signWalletOwnerUpdate(phrase, value, { walletAddress: wallet, chainIds: [10], homeOwners: [d1, p1, account.address], destination });
    // Two calls go as one MultiSend delegatecall at nonce 4; nothing is signed for nonce 5.
    expect(value.steps).toHaveLength(2);
    expect(signatures).toHaveLength(1);
    const document = walletOwnerUpdateSafeTx(wallet, value.steps, '4', 10);
    expect(document.message).toMatchObject({ to: SAFE_141_MULTI_SEND, operation: 1, nonce: 4n });
    expect(await recoverAddress({ hash: hashTypedData(document), signature: signatures[0]! })).toBe(account.address);
    // One call needs no MultiSend: it is the Safe calling itself.
    const single = walletOwnerUpdateSafeTx(wallet, [value.steps[0]!], '4', 10);
    expect(single.message).toMatchObject({ to: wallet, operation: 0, data: value.steps[0] });
  });
  it('refuses calls that differ from what the page can check', async () => {
    const sign = (value: unknown, chainIds = [10], walletAddress: string = wallet) => signWalletOwnerUpdate(phrase, value, { walletAddress, chainIds,
      homeOwners: (value as { owners: Address[] }).owners, destination });
    await expect(sign(update(), [42161])).rejects.toThrow();
    await expect(sign(update(), [10], `0x${'33'.repeat(20)}`)).rejects.toThrow();
    await expect(sign(update(undefined, [p1, account.address]))).rejects.toThrow();
    await expect(sign(update([encodeFunctionData({ abi, functionName: 'removeOwner', args: [p0, account.address, 1n] })], [p0]))).rejects.toThrow();
    await expect(sign(update([encodeFunctionData({ abi, functionName: 'addOwnerWithThreshold', args: [p1, 2n] })], [p1, p0, account.address]))).rejects.toThrow();
    await expect(sign(update([encodeFunctionData({ abi, functionName: 'removeOwner', args: [p1, p0, 1n] })], [account.address]))).rejects.toThrow();
    await expect(sign(update([`0x6a761202${'00'.repeat(64)}`], [p0, account.address]))).rejects.toThrow();
    expect(await sign(update([encodeFunctionData({ abi, functionName: 'removeOwner', args: ['0x0000000000000000000000000000000000000001', p0, 1n] })], [account.address]))).toHaveLength(1);
  });
  it('refuses owners from the server that Base does not hold, extra or substituted', async () => {
    const attacker = getAddress(`0x${'e1'.repeat(20)}`), base = [d1, p1, account.address];
    const sign = (owners: Address[]) => signWalletOwnerUpdate(phrase, update(walletOwnerPlan([p0, account.address], owners).steps, owners), { walletAddress: wallet, chainIds: [10], homeOwners: base, destination });
    await expect(sign([d1, p1, attacker, account.address])).rejects.toThrow();
    await expect(sign([attacker, p1, account.address])).rejects.toThrow();
    await expect(sign([p1, account.address])).rejects.toThrow();
    expect(await sign([p1, account.address, d1])).toHaveLength(1);
  });
  it('refuses a starting point a deployed network does not hold, so no signature waits for a later nonce', async () => {
    const owners = [p0, account.address], sign = (value: ReturnType<typeof update>) =>
      signWalletOwnerUpdate(phrase, value, { walletAddress: wallet, chainIds: [10], homeOwners: owners, destination });
    // The server claims only the backup is there, at a nonce ahead of the network's: signing would let it restore p0 later.
    const ahead = { ...update(walletOwnerPlan([account.address], owners).steps, owners), from: [account.address], safeNonce: '5' };
    await expect(sign(ahead)).rejects.toThrow();
    await expect(sign({ ...ahead, safeNonce: '4' })).rejects.toThrow();
    const real = update(walletOwnerPlan([p0, account.address], [d1, account.address]).steps, [d1, account.address]);
    const signReal = (there: typeof destination) => signWalletOwnerUpdate(phrase, real, { walletAddress: wallet, chainIds: [10], homeOwners: [d1, account.address], destination: there });
    expect(await signReal(destination)).toHaveLength(1);
    await expect(signReal({ ...destination, nonce: 5n })).rejects.toThrow();
    await expect(signReal({ ...destination, owners: [account.address, p0] })).rejects.toThrow();
    await expect(signReal({ ...destination, threshold: 2n })).rejects.toThrow();
  });
  it('starts a network not deployed yet from the owners its own creation sets, proved by the account address', async () => {
    // The account's real creation: the original passkey and the backup, threshold one, behind this exact address.
    const singleton = getAddress(`0x${'41'.repeat(20)}`), factory = getAddress(`0x${'4f'.repeat(20)}`), saltNonce = 7n;
    const initializer = encodeFunctionData({ abi: SAFE_SETUP_ABI, functionName: 'setup', args: [[p0, account.address], 1n, zeroAddress, '0x', zeroAddress, zeroAddress, 0n, zeroAddress] });
    const creation = { to: factory, data: encodeFunctionData({ abi: SAFE_CREATION_ABI, functionName: 'createProxyWithNonce', args: [singleton, initializer, saltNonce] }) };
    const safe = getContractAddress({ from: factory, opcode: 'CREATE2', salt: keccak256(concatHex([keccak256(initializer), encodeAbiParameters([{ type: 'uint256' }], [saltNonce])])),
      bytecode: concatHex([SAFE_141_PROXY_CREATION_CODE, encodeAbiParameters([{ type: 'address' }], [singleton])]) });
    const fresh = { deployed: false, owners: [], threshold: 0n, nonce: 0n }, target = [d1, account.address];
    const value = (from: Address[], extra: object = {}) => ({ chainId: 10, walletAddress: safe, recoveryOwner: account.address, from, owners: target, safeNonce: '0',
      steps: walletOwnerPlan(from, target).steps, creation, ...extra });
    const sign = (input: unknown, initializerHash?: Hex) => signWalletOwnerUpdate(phrase, input, { walletAddress: safe, chainIds: [10], homeOwners: target, destination: fresh,
      ...(initializerHash ? { initializerHash } : {}) });
    expect(await sign(value([p0, account.address]))).toHaveLength(1);
    expect(await sign(value([p0, account.address]), keccak256(initializer))).toHaveLength(1);
    // The server says the network starts with the backup alone: the revoked passkey would stay an owner there.
    await expect(sign(value([account.address]))).rejects.toThrow();
    await expect(sign(value([account.address, p0]))).rejects.toThrow();
    await expect(sign(value([p0, account.address], { safeNonce: '1' }))).rejects.toThrow();
    await expect(sign(value([p0, account.address], { creation: undefined }))).rejects.toThrow();
    await expect(sign(value([p0, account.address]), `0x${'22'.repeat(32)}`)).rejects.toThrow();
    // A creation that leads to another address proves nothing about this account.
    const other = encodeFunctionData({ abi: SAFE_CREATION_ABI, functionName: 'createProxyWithNonce', args: [singleton,
      encodeFunctionData({ abi: SAFE_SETUP_ABI, functionName: 'setup', args: [[account.address], 1n, zeroAddress, '0x', zeroAddress, zeroAddress, 0n, zeroAddress] }), saltNonce] });
    await expect(sign(value([account.address], { creation: { to: factory, data: other } }))).rejects.toThrow();
  });
});

describe("the account's Safe read from each chain's public RPC", () => {
  const wallet = identity.walletAddress, owners = [getAddress(`0x${'a1'.repeat(20)}`), account.address];
  const word = (value: bigint | string) => BigInt(value).toString(16).padStart(64, '0'), head = `0x${'ab'.repeat(32)}`;
  // Answers by what is asked: 0 chain, 1 code, 2 owners, 3 threshold, 4 nonce; every state read must name the head block by its hash, as canonical.
  // Each chain answers as itself; `overrides` may differ per chain, and `tip` is the block the chain names as its head.
  const answer = (overrides: Record<number, unknown> | ((chainId: number) => Record<number, unknown>) = {}, tip: unknown = { hash: head }) => vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string }) => {
    const chainId = signaChains.find(chain => chain.publicRpc === url)!.chainId, given = typeof overrides === 'function' ? overrides(chainId) : overrides;
    const results = [`0x${chainId.toString(16)}`, '0x6080', `0x${word(32n)}${word(BigInt(owners.length))}${owners.map(owner => word(owner)).join('')}`, `0x${word(1n)}`, `0x${word(7n)}`];
    const which = (request: { method: string; params: unknown[] }) => request.method === 'eth_chainId' ? 0 : request.method === 'eth_getCode' ? 1
      : ({ '0xa0e67e2b': 2, '0xe75235b8': 3, '0xaffed0e0': 4 } as Record<string, number>)[(request.params[0] as { data: string }).data]!;
    return new Response(JSON.stringify((JSON.parse(init.body) as { id: number; method: string; params: unknown[] }[]).reverse().map(request => ({ jsonrpc: '2.0', id: request.id,
      result: request.method === 'eth_getBlockByNumber' ? tip : request.method !== 'eth_chainId'
        && JSON.stringify(request.params.at(-1)) !== JSON.stringify({ blockHash: head, requireCanonical: true }) ? null
        : which(request) in given ? given[which(request)] : results[which(request)] }))));
  }));
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it('reads the owners, threshold and nonce a chain holds, and refuses another chain or a malformed answer', async () => {
    answer(); expect(await readHomeOwners(wallet)).toEqual(owners);
    answer(); expect(await readChainSafe(wallet, 8453)).toEqual({ deployed: true, owners, threshold: 1n, nonce: 7n });
    answer({ 1: '0x' }); expect(await readChainSafe(wallet, 8453)).toMatchObject({ deployed: false });
    answer({ 1: '0x' }); await expect(readHomeOwners(wallet)).rejects.toThrow();
    // Optimism's RPC answering as Base is refused.
    answer({ 0: '0x2105' }); await expect(readChainSafe(wallet, 10)).rejects.toThrow();
    answer({ 0: '0xa' }); await expect(readHomeOwners(wallet)).rejects.toThrow();
    answer({ 3: `0x${word(2n)}` }); await expect(readHomeOwners(wallet)).rejects.toThrow();
    answer({ 2: `0x${word(64n)}${word(2n)}` }); await expect(readHomeOwners(wallet)).rejects.toThrow();
    answer({ 2: null }); await expect(readHomeOwners(wallet)).rejects.toThrow();
    answer({ 4: null }); await expect(readHomeOwners(wallet)).rejects.toThrow();
  });
  it('refuses a chain that does not answer within ten seconds or names no canonical head block', async () => {
    // The chain never answers: the read gives up when its ten-second signal fires, and nothing is assumed.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => { expect(ms).toBe(10_000); return AbortSignal.abort(new DOMException('timed out', 'TimeoutError')); });
    vi.stubGlobal('fetch', vi.fn((_url: string, init: { signal: AbortSignal }) => init.signal.aborted ? Promise.reject(init.signal.reason) : new Promise(() => {})));
    await expect(readChainSafe(wallet, 8453)).rejects.toThrow('timed out');
    vi.restoreAllMocks();
    // No head hash, a malformed one, or a node that will not read at that block as canonical (an error, so no result).
    answer({}, null); await expect(readChainSafe(wallet, 8453)).rejects.toThrow();
    answer({}, { hash: '0x1234' }); await expect(readChainSafe(wallet, 8453)).rejects.toThrow();
    answer({ 1: undefined, 2: undefined, 3: undefined, 4: undefined }); await expect(readChainSafe(wallet, 8453)).rejects.toThrow();
  });
  it('rebuilds each device addition only at the nonce and owners each chain reports, before any prompt', async () => {
    const device = getAddress(`0x${'05'.repeat(20)}`), reviews = [{ chainId: 8453, safeNonce: '7' }, { chainId: 10, safeNonce: '7' }];
    answer(); expect(await walletDeviceAdditionChallenges(wallet, device, reviews))
      .toEqual([walletDeviceAdditionChallenge(wallet, device, '7', 8453), walletDeviceAdditionChallenge(wallet, device, '7', 10)]);
    // A later nonce is a signature the server could hold and run after the device is removed.
    answer(); await expect(walletDeviceAdditionChallenges(wallet, device, [reviews[0]!, { chainId: 10, safeNonce: '8' }])).rejects.toThrow();
    // Optimism's owners are not Base's, or its threshold is not one.
    answer(chainId => chainId === 10 ? { 2: `0x${word(32n)}${word(2n)}${word(owners[0]!)}${word(`0x${'cc'.repeat(20)}`)}` } : {});
    await expect(walletDeviceAdditionChallenges(wallet, device, reviews)).rejects.toThrow();
    answer(chainId => chainId === 10 ? { 3: `0x${word(2n)}` } : {}); await expect(walletDeviceAdditionChallenges(wallet, device, reviews)).rejects.toThrow();
    // The device is already an owner, a chain is not deployed, Base is missing or first is not Base, or a chain appears twice.
    answer(); await expect(walletDeviceAdditionChallenges(wallet, owners[0]!, reviews)).rejects.toThrow();
    answer(chainId => chainId === 10 ? { 1: '0x' } : {}); await expect(walletDeviceAdditionChallenges(wallet, device, reviews)).rejects.toThrow();
    answer(); await expect(walletDeviceAdditionChallenges(wallet, device, [reviews[1]!])).rejects.toThrow();
    answer(); await expect(walletDeviceAdditionChallenges(wallet, device, [reviews[0]!, reviews[1]!, reviews[1]!])).rejects.toThrow();
    // A chain that cannot be read signs nothing.
    answer(chainId => chainId === 10 ? { 4: null } : {}); await expect(walletDeviceAdditionChallenges(wallet, device, reviews)).rejects.toThrow();
  });
});
