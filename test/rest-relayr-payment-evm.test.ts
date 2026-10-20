import { type ChildProcess } from 'node:child_process';
import { anvilAvailable, spawnAnvil } from './support/anvil.js';
import { createServer } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodeErrorResult, keccak256, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { RELAYR_PAYMENT_ADDRESS, RELAYR_PAYMENT_CODE_HASH, RELAYR_PAYMENT_SELECTOR } from '../src/rest/sponsorship/constants.js';
import { RELAYR_PAYMENT_RUNTIME } from './fixtures/relayr-payment.js';
import { RELAYR_PAYMENT_ABI, RELAYR_PAYMENT_RECIPIENT, verifyRelayrPaymentEvent } from '../src/rest/sponsorship/paymentContract.js';

const available = anvilAvailable();
const account = privateKeyToAccount(`0x${'11'.repeat(32)}`); // Public local-only fixture.
const id = 'a0a555ff-4444-4111-aaaa-333333333333';
describe.skipIf(!available)('actual pinned Relayr payment bytecode on unforked Anvil', () => {
  let child: ChildProcess, endpoint: string, counter = 0, snapshot: string, deadline: number;
  async function rpc<T = unknown>(method: string, params: readonly unknown[] = []): Promise<T> {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++counter, method, params }), signal: AbortSignal.timeout(3000) });
    const body = await response.json() as { result: T; error?: unknown };
    if (!response.ok) throw new Error('Local payment transport failed');
    if (body.error) throw Object.assign(new Error('Local payment RPC rejected ' + method), body.error);
    return body.result;
  }
  const calldata = (expires = deadline): Hex => `${RELAYR_PAYMENT_SELECTOR}${id.replaceAll('-', '').padEnd(64, '0')}${BigInt(expires).toString(16).padStart(64, '0')}`;
  async function pay(value = 1234n, nonce = 0, data = calldata()) {
    const raw = await account.signTransaction({ type: 'eip1559', chainId: 1, nonce, to: RELAYR_PAYMENT_ADDRESS, data, value,
      gas: 150000n, maxFeePerGas: 100000000000n, maxPriorityFeePerGas: 1000000000n, accessList: [] });
    expect(await rpc('eth_sendRawTransaction', [raw])).toBe(keccak256(raw));
    let receipt: { status: Hex; logs: unknown[]; transactionHash: Hex; blockHash: Hex; blockNumber: Hex } | null = null;
    await expect.poll(async () => {
      receipt = await rpc<typeof receipt>('eth_getTransactionReceipt', [keccak256(raw)]);
      return receipt;
    }).not.toBeNull();
    return receipt!;
  }
  beforeAll(async () => {
    expect(keccak256(RELAYR_PAYMENT_RUNTIME)).toBe(RELAYR_PAYMENT_CODE_HASH);
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>(resolve => server.close(() => resolve()));
    endpoint = `http://127.0.0.1:${port}`;
    child = spawnAnvil(['--host', '127.0.0.1', '--port', String(port), '--chain-id', '1', '--hardfork', 'cancun', '--silent']);
    const until = Date.now() + 5000;
    for (;;) {
      try { expect(await rpc('eth_chainId')).toBe('0x1'); break; }
      catch (error) { if (Date.now() >= until || child.exitCode !== null) throw error; await new Promise(r => setTimeout(r, 30)); }
    }
    const info = await rpc<{ forkConfig: { forkUrl: unknown } }>('anvil_nodeInfo'); expect(info.forkConfig.forkUrl).toBe(null);
    await rpc('anvil_setCode', [RELAYR_PAYMENT_ADDRESS, RELAYR_PAYMENT_RUNTIME]);
    await rpc('anvil_setBalance', [account.address, toHex(10n ** 18n)]);
  }, 10000);
  beforeEach(async () => {
    snapshot = await rpc<string>('evm_snapshot');
    deadline = Number(BigInt((await rpc<{ timestamp: Hex }>('eth_getBlockByNumber', ['latest', false])).timestamp)) + 300;
  });
  afterEach(async () => { await rpc('evm_revert', [snapshot]); });
  afterAll(async () => {
    if (child && child.exitCode === null) {
      const done = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 1000);
      await Promise.race([done, new Promise(resolve => setTimeout(resolve, 3000))]); clearTimeout(force);
    }
  });
  it('accepts the exact deadline, transfers the full value, and emits the exact bundle/value/deadline event', async () => {
    await rpc('evm_setNextBlockTimestamp', [deadline]);
    const before = BigInt(await rpc<Hex>('eth_getBalance', [RELAYR_PAYMENT_RECIPIENT, 'latest']));
    const receipt = await pay(); expect(receipt.status).toBe('0x1');
    expect(BigInt(await rpc<Hex>('eth_getBalance', [RELAYR_PAYMENT_RECIPIENT, 'latest'])) - before).toBe(1234n);
    expect(() => verifyRelayrPaymentEvent(receipt.logs, id, '1234', String(deadline))).not.toThrow();
    expect(() => verifyRelayrPaymentEvent(receipt.logs, id, '1235', String(deadline))).toThrow();
    expect(() => verifyRelayrPaymentEvent(receipt.logs, id, '1234', String(deadline + 1))).toThrow();
    expect(() => verifyRelayrPaymentEvent([...receipt.logs, ...receipt.logs], id, '1234', String(deadline))).toThrow();
  });
  it('reverts after the deadline without transferring value or emitting payment', async () => {
    await rpc('evm_setNextBlockTimestamp', [deadline + 1]);
    const before = await rpc('eth_getBalance', [RELAYR_PAYMENT_RECIPIENT, 'latest']);
    const receipt = await pay(); expect(receipt.status).toBe('0x0'); expect(receipt.logs).toEqual([]);
    expect(await rpc('eth_getBalance', [RELAYR_PAYMENT_RECIPIENT, 'latest'])).toBe(before);
    const data = encodeErrorResult({ abi: RELAYR_PAYMENT_ABI, errorName: 'deadlineExceeded', args: [
      `0x${id.replaceAll('-', '')}`, deadline, deadline + 1,
    ] });
    expect(data.slice(0, 10)).toBe('0x3c06f61c');
    await expect(rpc('eth_call', [{ from: account.address, to: RELAYR_PAYMENT_ADDRESS, value: '0x1', data: calldata() }, 'latest']))
      .rejects.toMatchObject({ code: 3, data });
  });
  it('rolls back payment if the immutable recipient rejects the transfer', async () => {
    await rpc('anvil_setCode', [RELAYR_PAYMENT_RECIPIENT, '0x5f5ffd']);
    const receipt = await pay(); expect(receipt.status).toBe('0x0'); expect(receipt.logs).toEqual([]);
  });
  it('rejects noncanonical bundle padding and out-of-range uint40 deadlines', async () => {
    for (const data of [`${calldata().slice(0, 73)}1${calldata().slice(74)}`,
      `${calldata().slice(0, 74)}${(1n << 40n).toString(16).padStart(64, '0')}`]) {
      await expect(rpc('eth_call', [{ from: account.address, to: RELAYR_PAYMENT_ADDRESS, value: '0x1', data }, 'latest']))
        .rejects.toMatchObject({ code: 3, data: '0x' });
    }
  });
  it('does not enforce quote amount or once-only payment: the operator must enforce both', async () => {
    const first = await pay(1234n), second = await pay(4321n, 1);
    expect(first.status).toBe('0x1'); expect(second.status).toBe('0x1');
    expect(() => verifyRelayrPaymentEvent(second.logs, id, '4321', String(deadline))).not.toThrow();
    expect(() => verifyRelayrPaymentEvent(second.logs, id, '1234', String(deadline))).toThrow();
  });
  it('rejects plain ETH and short calldata, but accepts trailing calldata that our quote binding must reject', async () => {
    const receipt = await pay(1234n, 0, '0x'); expect(receipt.status).toBe('0x0'); expect(receipt.logs).toEqual([]);
    await expect(rpc('eth_call', [{ from: account.address, to: RELAYR_PAYMENT_ADDRESS, data: calldata().slice(0, -2) }, 'latest']))
      .rejects.toMatchObject({ code: 3, data: '0x' });
    const trailing = await pay(1234n, 1, `${calldata()}01`); expect(trailing.status).toBe('0x1');
    expect(() => verifyRelayrPaymentEvent(trailing.logs, id, '1234', String(deadline))).not.toThrow();
  });
  it('reverts when the fixed recipient cannot finish within the transfer stipend', async () => {
    await rpc('anvil_setCode', [RELAYR_PAYMENT_RECIPIENT, '0x5b5f56']); // Bounded by the 2,300-gas stipend.
    const receipt = await pay(); expect(receipt.status).toBe('0x0'); expect(receipt.logs).toEqual([]);
  });
});
