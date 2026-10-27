import { createConnector, type CreateConnectorFn } from "wagmi";
import { base } from "wagmi/chains";
import type { Address } from "viem";
import { SIGNA_HOME_CHAIN_ID, signaChains } from "../../../src/rest/wallet/chains.js";

/** The chains the account acts on today. */
const enabled = signaChains.filter((chain) => chain.enabled);
const isEnabled = (chainId: number) => enabled.some((chain) => chain.chainId === chainId);

/** The slice of a Signa wallet client the connector needs. Signing never crosses this seam. */
export type CenterAccountWallet = {
  restoreConnection(): {
    address: Address;
    chainId: typeof SIGNA_HOME_CHAIN_ID;
    accountId: string;
    expiresAt: number;
  } | null;
  disconnect(): void;
};
export type CenterAccountConnectorOptions = {
  wallet(): Promise<CenterAccountWallet>;
  /** A read on `chainId`, the chain the connector is on. */
  read(input: { method: string; params?: unknown[]; chainId: number }): Promise<unknown>;
};

const reads = new Set([
  "eth_call",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_blockNumber",
  "eth_getLogs",
]);
const unsupported = (chain = false) =>
  Object.assign(
    new Error(
      chain
        ? `This Signa account uses ${enabled.map((item) => item.name).join(" and ")}. Connect an external wallet for other networks.`
        : "This action needs its own review at Signa. Use a payment review, or connect an external wallet.",
    ),
    { code: chain ? 4902 : 4200 },
  );

/** A read-only wagmi connector for a Signa passkey account on every chain Signa enables. The connection's
 * request key cannot sign or send arbitrary operations; payments go through Signa's review flow. */
export function centerAccountConnector(
  options: CenterAccountConnectorOptions,
): CreateConnectorFn {
  return createConnector((config) => {
    let chainOn: number = SIGNA_HOME_CHAIN_ID;
    const connection = async () => {
      const value = (await options.wallet()).restoreConnection();
      if (
        !value ||
        value.chainId !== SIGNA_HOME_CHAIN_ID ||
        value.accountId !== `eip155:${SIGNA_HOME_CHAIN_ID}:` + value.address.toLowerCase() ||
        value.expiresAt <= Math.floor(Date.now() / 1000)
      )
        return null;
      return value;
    };
    const provider = {
      async request(input: { method: string; params?: unknown[] }) {
        const current = await connection();
        if (input.method === "eth_chainId") return `0x${chainOn.toString(16)}`;
        if (
          input.method === "eth_accounts" ||
          input.method === "eth_requestAccounts"
        )
          return current ? [current.address] : [];
        if (input.method === "wallet_switchEthereumChain") {
          const requested = input.params?.[0] as
            | { chainId?: string }
            | undefined;
          const chainId = Number(requested?.chainId);
          if (!isEnabled(chainId)) throw unsupported(true);
          chainOn = chainId;
          return null;
        }
        if (reads.has(input.method)) return options.read({ ...input, chainId: chainOn });
        throw unsupported();
      },
    };
    return {
      id: "juicebox-center",
      name: "Signa account",
      type: "juicebox-center",
      async connect(parameters) {
        if (parameters?.chainId !== undefined && !isEnabled(parameters.chainId))
          throw unsupported(true);
        const current = await connection();
        if (!current)
          throw new Error("Sign in with your Signa account first.");
        const accounts = (
          parameters as { withCapabilities?: boolean } | undefined
        )?.withCapabilities
          ? [{ address: current.address, capabilities: {} }]
          : [current.address];
        if (parameters?.chainId !== undefined) chainOn = parameters.chainId;
        return { accounts, chainId: chainOn } as never;
      },
      async disconnect() {
        (await options.wallet()).disconnect();
      },
      async getAccounts() {
        const current = await connection();
        return current ? [current.address] : [];
      },
      async getChainId() {
        return chainOn;
      },
      async getProvider() {
        return provider;
      },
      async isAuthorized() {
        return !!(await connection());
      },
      async switchChain({ chainId }) {
        const chain = config.chains.find((item) => item.id === chainId) ?? (chainId === base.id ? base : undefined);
        if (!isEnabled(chainId) || !chain) throw unsupported(true);
        chainOn = chainId;
        config.emitter.emit("change", { chainId });
        return chain;
      },
      onAccountsChanged(accounts) {
        if (!accounts.length) config.emitter.emit("disconnect");
        else config.emitter.emit("change", { accounts: accounts as Address[] });
      },
      onChainChanged(chainId) {
        if (!isEnabled(Number(chainId))) config.emitter.emit("disconnect");
      },
      onDisconnect() {
        config.emitter.emit("disconnect");
      },
    };
  });
}
