import { decodeFunctionData, encodeAbiParameters } from "viem";
import { jbPermissionsAbi } from "@bananapus/nana-sdk-core";
import { describe, expect, it, vi } from "vitest";

const { prepareCheck } = await import(new URL("../scripts/rest/production-check.mjs", import.meta.url).href);
const wallet = "0x1111111111111111111111111111111111111111";
const target = "0xf92AC1aB5A00033E35a3975739124F61928C36B0";
const blockHash = `0x${"22".repeat(32)}`;
const bitmap = (value: bigint) => encodeAbiParameters([{ type: "uint256" }], [value]);
const observed = (chainId = 8453) => ({ address: target, evidence: [{ chainId, blockHash, blockNumber: "100" }] });

describe("read-only production check preparation", () => {
  it("prepares only a zero-value empty self-permission call after canonical reads", async () => {
    for (const chainId of [1, 10, 8453, 42161]) {
      const resolve = vi.fn().mockResolvedValue(observed(chainId));
      const prepare = vi.fn().mockResolvedValue({ calls: [] });
      const request = vi.fn().mockResolvedValueOnce(bitmap(0n)).mockResolvedValueOnce("0x6000");
      const result = await prepareCheck(chainId, wallet, { resolve }, { prepare }, { request });
      expect(resolve).toHaveBeenCalledExactlyOnceWith({ chainId, contractId: "@bananapus/core-v6:src/JBPermissions.sol:JBPermissions" }, expect.any(AbortSignal));
      expect(request).toHaveBeenNthCalledWith(1, chainId, "eth_call", [{ to: target, data: expect.any(String) }, { blockHash, requireCanonical: true }], expect.any(AbortSignal));
      expect(decodeFunctionData({ abi: jbPermissionsAbi, data: request.mock.calls[0]![2][0].data })).toEqual({ functionName: "permissionsOf", args: [wallet, wallet, 0n] });
      expect(request).toHaveBeenNthCalledWith(2, chainId, "eth_getCode", [wallet, { blockHash, requireCanonical: true }], expect.any(AbortSignal));
      expect(result.input.calls).toEqual([{ chainId, contractId: "@bananapus/core-v6:src/JBPermissions.sol:JBPermissions", address: target, function: "setPermissionsFor(address,(address,uint64,uint8[]))", args: [wallet, { operator: wallet, projectId: "0", permissionIds: [] }], value: "0" }]);
      expect(prepare).toHaveBeenCalledExactlyOnceWith("contract_calls", result.input, { signal: expect.any(AbortSignal) });
    }
  });

  it("does not prepare when permissions exist or the permission response is malformed", async () => {
    const prepare = vi.fn();
    for (const value of [bitmap(1n), bitmap(256n), undefined, "0x", `${bitmap(0n)}00`]) {
      const request = vi.fn().mockResolvedValue(value);
      await expect(prepareCheck(8453, wallet, { resolve: async () => observed() }, { prepare }, { request })).rejects.toThrow("Self permissions are not zero");
      expect(request).toHaveBeenCalledTimes(1);
    }
    expect(prepare).not.toHaveBeenCalled();
  });

  it("does not prepare when canonical evidence is unavailable or the wallet is undeployed", async () => {
    const prepare = vi.fn();
    const request = vi.fn();
    await expect(prepareCheck(8453, wallet, { resolve: async () => { throw new Error("canonical resolution unavailable"); } }, { prepare }, { request })).rejects.toThrow("canonical resolution unavailable");
    expect(request).not.toHaveBeenCalled();
    const resolver = { resolve: async () => observed() };
    request.mockRejectedValueOnce(new Error("canonical permissions read unavailable"));
    await expect(prepareCheck(8453, wallet, resolver, { prepare }, { request })).rejects.toThrow("canonical permissions read unavailable");
    request.mockResolvedValueOnce(bitmap(0n)).mockResolvedValueOnce("0x");
    await expect(prepareCheck(8453, wallet, resolver, { prepare }, { request })).rejects.toThrow("not deployed");
    request.mockResolvedValueOnce(bitmap(0n)).mockRejectedValueOnce(new Error("canonical wallet read unavailable"));
    await expect(prepareCheck(8453, wallet, resolver, { prepare }, { request })).rejects.toThrow("canonical wallet read unavailable");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects another chain or invalid wallet before any network access", async () => {
    const resolve = vi.fn();
    for (const [chainId, address] of [[137, wallet], [1, "0x0"], [1, `0x${"0".repeat(40)}`]]) {
      await expect(prepareCheck(chainId, address, { resolve }, {}, {})).rejects.toThrow();
    }
    expect(resolve).not.toHaveBeenCalled();
  });
});
