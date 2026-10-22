/** The chains Signa names. Base is the account's home; `enabled` marks the chains the wallet acts on
 * today. Every chain-specific rule reads this list instead of assuming a chain. */
export interface SignaChain { chainId: number; name: string; family: "mainnet" | "testnet"; paymentChainId: number; centerPays: boolean; offered: boolean; enabled: boolean }
export const signaChains: readonly SignaChain[] = Object.freeze([
  { chainId: 1, name: "Ethereum", family: "mainnet", paymentChainId: 8453, centerPays: false, offered: false, enabled: false },
  { chainId: 10, name: "Optimism", family: "mainnet", paymentChainId: 8453, centerPays: true, offered: true, enabled: false },
  { chainId: 8453, name: "Base", family: "mainnet", paymentChainId: 8453, centerPays: false, offered: false, enabled: true },
  { chainId: 42161, name: "Arbitrum", family: "mainnet", paymentChainId: 8453, centerPays: true, offered: true, enabled: false },
  { chainId: 11155111, name: "Sepolia", family: "testnet", paymentChainId: 84532, centerPays: true, offered: true, enabled: false },
  { chainId: 11155420, name: "OP Sepolia", family: "testnet", paymentChainId: 84532, centerPays: true, offered: true, enabled: false },
  { chainId: 421614, name: "Arbitrum Sepolia", family: "testnet", paymentChainId: 84532, centerPays: true, offered: true, enabled: false },
  { chainId: 84532, name: "Base Sepolia", family: "testnet", paymentChainId: 84532, centerPays: true, offered: true, enabled: false },
]);
/** The chain the account was created on and whose owners every other chain must carry. */
export const SIGNA_HOME_CHAIN_ID = 8453 as const;
export const signaChainName = (chainId: number): string => signaChains.find(chain => chain.chainId === chainId)?.name ?? `Chain ${chainId}`;
