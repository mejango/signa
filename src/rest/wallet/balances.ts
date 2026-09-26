import type { RestRpc } from '../core.js';
import { WALLET_HOME_NETWORK, walletNetworkCatalog } from './networks.js';

/** What the account holds: ETH and USDC on every chain its address can exist on (the address is the same
 * everywhere, deployed there or not). The total counts mainnets only, pricing ETH with Chainlink's ETH/USD
 * feed on Base and USDC at $1. A chain or price that does not answer is unknown, never zero. */
export interface WalletChainBalance { chainId: number; name: string; testnet: boolean; eth: string | null; usdc: string | null }
export interface WalletBalances { chains: WalletChainBalance[]; ethUsd: string | null; totalUsdCents: string | null; complete: boolean }

// Circle's native USDC, 6 decimals on each; checked on chain 2026-09-26.
const usdc: Record<number, string> = {
  8453: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  10: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 42161: '0xaf88d065e77c8cC2239327C5EDB3A432268e5831',
  84532: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', 11155111: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  11155420: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7', 421614: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
};
/** Chainlink ETH/USD on Base (8 decimals, 20-minute heartbeat). An answer older than two hours is not a price. */
const ethUsdFeed = '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70', maximumPriceAgeSeconds = 7200;
const chains = [{ ...WALLET_HOME_NETWORK, family: 'mainnet' }, ...walletNetworkCatalog];

function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) throw new Error('Unexpected RPC value');
  return BigInt(value);
}

export function createWalletBalances(rpc: RestRpc) {
  return {
    async read(address: string, nowMs = Date.now()): Promise<WalletBalances> {
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('Invalid address');
      const signal = AbortSignal.timeout(10_000);
      const balanceOf = '0x70a08231' + address.slice(2).toLowerCase().padStart(64, '0');
      const read = await Promise.all(chains.map(async chain => {
        try {
          const [eth, token] = await Promise.all([rpc.request(chain.chainId, 'eth_getBalance', [address, 'latest'], signal),
            rpc.request(chain.chainId, 'eth_call', [{ to: usdc[chain.chainId], data: balanceOf }, 'latest'], signal)]);
          return { chainId: chain.chainId, name: chain.name, testnet: chain.family === 'testnet', eth: quantity(eth), usdc: quantity(token) };
        } catch { return { chainId: chain.chainId, name: chain.name, testnet: chain.family === 'testnet', eth: null, usdc: null }; }
      }));
      let price: bigint | null = null;
      try {
        const round = await rpc.request(8453, 'eth_call', [{ to: ethUsdFeed, data: '0xfeaf968c' }, 'latest'], signal);
        if (typeof round !== 'string' || !/^0x[0-9a-fA-F]{320}$/.test(round)) throw new Error('Unexpected round');
        const answer = BigInt('0x' + round.slice(66, 130)), updatedAt = Number(BigInt('0x' + round.slice(194, 258)));
        if (answer > 0n && answer < 2n ** 255n && nowMs / 1000 - updatedAt < maximumPriceAgeSeconds) price = answer;
      } catch { /* Unknown price: no total. */ }
      const mainnets = read.filter(chain => !chain.testnet);
      // Cents: USDC has 6 decimals; ETH wei × price (8 decimals) / 10^24 (floors, never rounds up).
      const cents = price === null ? null : mainnets.reduce((sum, chain) =>
        sum + (chain.usdc ?? 0n) / 10_000n + ((chain.eth ?? 0n) * price) / 10n ** 24n, 0n);
      return {
        chains: read.map(chain => ({ ...chain, eth: chain.eth === null ? null : String(chain.eth), usdc: chain.usdc === null ? null : String(chain.usdc) })),
        ethUsd: price === null ? null : String(price), totalUsdCents: cents === null ? null : String(cents),
        complete: price !== null && mainnets.every(chain => chain.eth !== null),
      };
    },
  };
}
