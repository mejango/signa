/** The chains Signa names. Base is the account's home. `signs` marks the chains an account signs typed
 * data and messages on; `operates` the chains it sends operations on, which need the account bound there.
 * Every chain-specific rule reads this list instead of assuming a chain. */
export interface SignaChain { chainId: number; name: string; family: "mainnet" | "testnet"; paymentChainId: number; centerPays: boolean; offered: boolean;
  signs: boolean; operates: boolean;
  /** The chain's public RPC, built into the pages: what a page signs is checked against the chain as it reports itself, never as Signa's server does. */
  publicRpc: string }
export const signaChains: readonly SignaChain[] = Object.freeze([
  { chainId: 1, name: "Ethereum", family: "mainnet", paymentChainId: 8453, centerPays: false, offered: false, signs: true, operates: false, publicRpc: "https://ethereum-rpc.publicnode.com" },
  { chainId: 10, name: "Optimism", family: "mainnet", paymentChainId: 8453, centerPays: true, offered: true, signs: true, operates: false, publicRpc: "https://mainnet.optimism.io" },
  { chainId: 8453, name: "Base", family: "mainnet", paymentChainId: 8453, centerPays: false, offered: false, signs: true, operates: true, publicRpc: "https://mainnet.base.org" },
  { chainId: 42161, name: "Arbitrum", family: "mainnet", paymentChainId: 8453, centerPays: true, offered: true, signs: true, operates: false, publicRpc: "https://arb1.arbitrum.io/rpc" },
  { chainId: 11155111, name: "Sepolia", family: "testnet", paymentChainId: 84532, centerPays: true, offered: true, signs: true, operates: false, publicRpc: "https://ethereum-sepolia-rpc.publicnode.com" },
  { chainId: 11155420, name: "OP Sepolia", family: "testnet", paymentChainId: 84532, centerPays: true, offered: true, signs: true, operates: false, publicRpc: "https://sepolia.optimism.io" },
  { chainId: 421614, name: "Arbitrum Sepolia", family: "testnet", paymentChainId: 84532, centerPays: true, offered: true, signs: true, operates: false, publicRpc: "https://sepolia-rollup.arbitrum.io/rpc" },
  { chainId: 84532, name: "Base Sepolia", family: "testnet", paymentChainId: 84532, centerPays: true, offered: true, signs: true, operates: false, publicRpc: "https://sepolia.base.org" },
]);
/** The chain the account was created on and whose owners every other chain must carry. */
export const SIGNA_HOME_CHAIN_ID = 8453 as const;
export const signaChain = (chainId: number): SignaChain | undefined => signaChains.find(chain => chain.chainId === chainId);
export const signaChainName = (chainId: number): string => signaChain(chainId)?.name ?? `Chain ${chainId}`;
