import { describe, expect, it } from 'vitest';
import { createWalletBalances } from '../src/rest/wallet/balances.js';

const address = '0x00000000000000000000000000000000000000aa';
const word = (value: bigint) => '0x' + value.toString(16).padStart(64, '0');
const nowMs = 1_800_000_000_000;
// ETH/USD $2,500.00 (8 decimals), updated a minute ago.
const round = (updatedAt = nowMs / 1000 - 60) => '0x' + [1n, 250_000_000_000n, 0n, BigInt(updatedAt), 1n].map(value => value.toString(16).padStart(64, '0')).join('');

function rpc(options: { down?: number[]; round?: string } = {}) {
  const calls: { chainId: number; method: string; params: readonly unknown[] }[] = [];
  return { calls, rpc: { async request(chainId: number, method: string, params: readonly unknown[]) {
    calls.push({ chainId, method, params });
    if (options.down?.includes(chainId)) throw new Error('down');
    if (method === 'eth_getBalance') return chainId === 8453 ? '0xde0b6b3a7640000' : chainId === 84532 ? '0x1' : '0x0'; // 1 ETH on Base
    const call = params[0] as { to: string; data: string };
    if (call.data === '0xfeaf968c') return options.round ?? round();
    return word(chainId === 10 ? 12_345_678n : chainId === 11155111 ? 5_000_000n : 0n); // 12.345678 USDC on Optimism
  } } };
}

describe('account balances', () => {
  it('reads ETH and USDC on every chain and totals mainnets in cents', async () => {
    const { calls, rpc: client } = rpc();
    const result = await createWalletBalances(client).read(address, nowMs);
    expect(result.chains.map(chain => chain.chainId).sort((a, b) => a - b)).toEqual([1, 10, 8453, 42161, 84532, 421614, 11155111, 11155420]);
    // 1 ETH × $2,500 + 12.34 USDC (floored); testnet funds never count.
    expect(result).toMatchObject({ ethUsd: '250000000000', totalUsdCents: '251234', complete: true });
    expect(result.chains.find(chain => chain.chainId === 10)).toEqual({ chainId: 10, name: 'Optimism', testnet: false, eth: '0', usdc: '12345678' });
    expect(result.chains.find(chain => chain.chainId === 11155111)).toMatchObject({ testnet: true, usdc: '5000000' });
    const usdcCall = calls.find(call => call.chainId === 8453 && call.method === 'eth_call' && (call.params[0] as { data: string }).data.startsWith('0x70a08231'))!;
    expect(usdcCall.params[0]).toEqual({ to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', data: '0x70a08231' + address.slice(2).padStart(64, '0') });
  });
  it('reports a chain that does not answer as unknown, not zero, and marks the total incomplete', async () => {
    const result = await createWalletBalances(rpc({ down: [10] }).rpc).read(address, nowMs);
    expect(result.chains.find(chain => chain.chainId === 10)).toMatchObject({ eth: null, usdc: null });
    expect(result).toMatchObject({ totalUsdCents: '250000', complete: false });
  });
  it('has no total without a fresh price', async () => {
    for (const stale of [round(nowMs / 1000 - 7201), '0x1234'])
      expect(await createWalletBalances(rpc({ round: stale }).rpc).read(address, nowMs)).toMatchObject({ ethUsd: null, totalUsdCents: null, complete: false });
  });
});
