import { describe, expect, it } from "vitest";
import { readRestExecutionConfiguration } from "../src/rest/executionConfig.js";
import { LEGACY_COMPILER_RUNTIME_HASHES } from "../src/rest/smartAccounts/compiler.js";

const gas = {
  maximumCallGas: "1000000",
  maximumVerificationGas: "1000000",
  maximumPreVerificationGas: "100000",
  maximumPaymasterVerificationGas: "1000000",
  maximumPaymasterPostOpGas: "0",
  maximumFeePerGas: "3000000000",
  maximumPriorityFeePerGas: "1000000000",
  maximumCost: "10000000000000000",
};
const configured = {
  chainId: 11155111,
  bundlerUrl:
    "https://api.pimlico.io/v2/11155111/rpc?apikey=DO_NOT_LEAK_TEST_KEY",
  paymasterUrl:
    "https://api.pimlico.io/v2/11155111/rpc?apikey=DO_NOT_LEAK_TEST_KEY",
  paymasterPolicyId: "sp_fixture_policy",
  gas,
};
const parse = (chain: unknown) =>
  readRestExecutionConfiguration(JSON.stringify({ chains: [chain] }));
describe("server-owned hosted execution configuration", () => {
  it("provides eight verified owner stacks without inventing providers, sponsor budgets or guard deployments", async () => {
    const result = await readRestExecutionConfiguration({});
    expect(result.stacks).toHaveLength(8);
    expect(result.providers).toEqual([]);
    expect(result.policies).toEqual([]);
    expect(result.paymasters).toEqual([]);
    for (const stack of result.stacks) {
      expect(stack.manifest.mode).toBe("execution-candidate");
      expect(stack.manifest.entryPoint?.version).toBe("0.7");
      expect(() => stack.createCompiler()).toThrow(/deployment/);
    }
  });
  it("loads exact server URLs, sponsored profile and explicit bigint gas admission ceilings", async () => {
    const result = await parse(configured);
    expect(result.providers[0]).toMatchObject({
      chainId: 11155111,
      providerId: "operator-pimlico-11155111",
      bundlerUrl: configured.bundlerUrl,
      paymasterPolicy: {
        id: configured.paymasterPolicyId,
        profile: "pimlico-v7-legacy-mode",
        maximumPaymasterDataLength: 130,
        context: { sponsorshipPolicyId: configured.paymasterPolicyId },
      },
    });
    expect(result.policies[0]).toMatchObject({
      chainId: 11155111,
      confirmations: 1,
      gas: {
        maximumCallGas: 1000000n,
        maximumPaymasterPostOpGas: 0n,
        requirePaymaster: false,
      },
    });
    expect(result.sponsorCaps).toBeUndefined();
    expect((await parse({ ...configured, gas: { ...gas, requirePaymaster: true } })).policies[0]?.gas.requirePaymaster).toBe(true);
    await expect(parse({ ...configured, gas: { ...gas, requirePaymaster: "yes" } })).rejects.toMatchObject({ code: "REST_EXECUTION_CONFIG_INVALID" });
    expect(result.paymasters[0]?.address.toLowerCase()).toBe(
      result.providers[0]?.paymasterPolicy?.contract.address.toLowerCase(),
    );
    expect(
      result.stacks.find((s) => s.manifest.chainId === configured.chainId)
        ?.compilerStack,
    ).toBeUndefined();
  });
  it("uses only operator-supplied guard addresses and the reviewed runtime identity", async () => {
    const result = await parse({
      ...configured,
      sessionGuardAddress: "0x6000000000000000000000000000000000000006",
      confirmations: 4,
    });
    const stack = result.stacks.find(
      (s) => s.manifest.chainId === configured.chainId,
    )!;
    expect(stack.compilerStack?.sessionGuard.runtimeCodeHash).toBe(
      LEGACY_COMPILER_RUNTIME_HASHES.sessionGuard,
    );
    expect(stack.createCompiler()).toHaveProperty("compile");
    expect(result.policies[0]?.confirmations).toBe(4);
  });
  it.each([
    { ...configured, gas: undefined },
    { ...configured, gas: { ...gas, maximumFeePerGas: 3000000000 } },
    { ...configured, gas: { ...gas, maximumCost: "01" } },
    { ...configured, gas: { ...gas, maximumPriorityFeePerGas: "9000000000" } },
    { ...configured, gas: { ...gas, maximumCallGas: (1n << 128n).toString() } },
    { ...configured, chainId: 31337 },
    { ...configured, paymasterPolicyId: "" },
    {
      ...configured,
      bundlerUrl: "http://provider.invalid/?key=DO_NOT_LEAK_TEST_KEY",
    },
    {
      ...configured,
      bundlerUrl: "https://DO_NOT_LEAK_TEST_KEY@provider.invalid",
    },
    {
      ...configured,
      paymasterUrl: "https://provider.invalid/#DO_NOT_LEAK_TEST_KEY",
    },
    {
      ...configured,
      bundlerUrl: "https://provider.invalid/ DO_NOT_LEAK_TEST_KEY",
    },
    { ...configured, sessionGuardAddress: "DO_NOT_LEAK_TEST_KEY" },
    { ...configured, privateKey: "DO_NOT_LEAK_TEST_KEY" },
  ])(
    "rejects invalid or unexpected execution configuration without echoing credentials (%#)",
    async (input) => {
      try {
        await parse(input);
        throw new Error("Expected rejection");
      } catch (error) {
        expect(error).toMatchObject({
          code: "REST_EXECUTION_CONFIG_INVALID",
          status: 500,
        });
        expect(String(error)).not.toContain("DO_NOT_LEAK_TEST_KEY");
      }
    },
  );
  it("rejects duplicate chains and malformed/oversized JSON without disclosing its contents", async () => {
    await expect(
      readRestExecutionConfiguration(
        JSON.stringify({ chains: [configured, configured] }),
      ),
    ).rejects.toMatchObject({ code: "REST_EXECUTION_CONFIG_INVALID" });
    for (const raw of ["DO_NOT_LEAK_TEST_KEY", "x".repeat(65537), ""]) {
      await expect(readRestExecutionConfiguration(raw)).rejects.toMatchObject({
        code: "REST_EXECUTION_CONFIG_INVALID",
      });
    }
  });
});
