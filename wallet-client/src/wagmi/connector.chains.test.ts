import { describe, expect, test, vi } from "vitest";
import { optimism } from "wagmi/chains";

// Optimism operating beside Base, as Signa's chain list opens networks.
vi.mock("../../../src/rest/wallet/chains.js", async (original) => {
  const chains = await original<typeof import("../../../src/rest/wallet/chains.js")>();
  return { ...chains, signaChains: chains.signaChains.map((chain) => (chain.chainId === 10 ? { ...chain, operates: true } : chain)) };
});
const { centerAccountConnector } = await import("./connector");

const address = ("0x" + "ab".repeat(20)) as `0x${string}`;

describe("centerAccountConnector on every enabled chain", () => {
  test("switches among enabled chains read-only, reading on the chain it is on", async () => {
    const read = vi.fn(async () => "0x1"), emitter = { emit: vi.fn() };
    const connector = centerAccountConnector({
      wallet: async () => ({ restoreConnection: () => ({ address, chainId: 8453, accountId: "eip155:8453:" + address,
        expiresAt: Math.floor(Date.now() / 1000) + 60 }), disconnect: vi.fn() }),
      read,
    })({ emitter, chains: [optimism], storage: null } as never);
    const provider = (await connector.getProvider()) as { request(input: { method: string; params?: unknown[] }): Promise<unknown> };
    expect(await connector.connect({ chainId: 10 } as never)).toEqual({ accounts: [address], chainId: 10 });
    expect(await provider.request({ method: "eth_chainId" })).toBe("0xa");
    await provider.request({ method: "eth_call", params: [] });
    expect(read).toHaveBeenLastCalledWith({ method: "eth_call", params: [], chainId: 10 });
    expect(await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x2105" }] })).toBeNull();
    expect(await connector.getChainId()).toBe(8453);
    expect((await connector.switchChain!({ chainId: 10 })).id).toBe(10);
    expect(emitter.emit).toHaveBeenCalledWith("change", { chainId: 10 });
    await provider.request({ method: "eth_getBalance", params: [address] });
    expect(read).toHaveBeenLastCalledWith({ method: "eth_getBalance", params: [address], chainId: 10 });
    await expect(connector.switchChain!({ chainId: 1 })).rejects.toMatchObject({ code: 4902, message: expect.stringContaining("Optimism and Base") });
    await expect(provider.request({ method: "eth_sendTransaction" })).rejects.toMatchObject({ code: 4200 });
    connector.onChainChanged("0xa");
    expect(emitter.emit).not.toHaveBeenCalledWith("disconnect");
  });
});
