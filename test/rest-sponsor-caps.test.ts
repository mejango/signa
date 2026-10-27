import { describe, expect, it } from "vitest";
import { readRestExecutionConfiguration } from "../src/rest/executionConfig.js";
import { MemorySponsorCapStore, readSponsorCapPolicies, sponsorCapWindowMs, checkReviewGas } from "../src/rest/sponsorCaps.js";
import { userOperationMaximumCost } from "../src/rest/userOperations/codec.js";
import type { UserOperationV07 } from "../src/rest/userOperations/types.js";

const base = {
  chainId: 8453,
  bundlerUrl: "https://api.pimlico.io/v2/8453/rpc?apikey=DO_NOT_LEAK_TEST_KEY",
  paymasterUrl: "https://api.pimlico.io/v2/8453/rpc?apikey=DO_NOT_LEAK_TEST_KEY",
  paymasterPolicyId: "sp_fixture_policy",
  gas: { maximumCallGas: "1000000", maximumVerificationGas: "1000000", maximumPreVerificationGas: "100000", maximumPaymasterVerificationGas: "1000000",
    maximumPaymasterPostOpGas: "0", maximumFeePerGas: "3000000000", maximumPriorityFeePerGas: "1000000000", maximumCost: "10000000000000000" },
};
const config = JSON.stringify({ chains: [base] });

describe("sponsor cap policy", () => {
  it("startup fails when a chain with a Pimlico policy has no cap", async () => {
    await expect(readRestExecutionConfiguration({ REST_ERC4337_CONFIG: config })).rejects.toThrow(/SIGNA_SPONSOR_ACCOUNT_DAILY_WEI_8453 is required/);
    await expect(readRestExecutionConfiguration({ REST_ERC4337_CONFIG: config, SIGNA_SPONSOR_ACCOUNT_DAILY_WEI_8453: "-1" })).rejects.toThrow(/non-negative integer/);
    const configured = await readRestExecutionConfiguration({ REST_ERC4337_CONFIG: config, SIGNA_SPONSOR_ACCOUNT_DAILY_WEI_8453: "2000000000000000" });
    expect(configured.sponsorCaps).toEqual([{ chainId: 8453, accountDailyWei: 2_000_000_000_000_000n, paused: false }]);
    // No sponsor configured: nothing to cap, nothing required.
    expect((await readRestExecutionConfiguration({})).sponsorCaps).toEqual([]);
  });

  it("reads 0 as never sponsored and the pause for every chain", () => {
    expect(readSponsorCapPolicies({ SIGNA_SPONSOR_ACCOUNT_DAILY_WEI_8453: "0", SIGNA_SPONSOR_ACCOUNT_DAILY_WEI_10: "5", SIGNA_SPONSOR_PAUSED: "1" }, [8453, 10]))
      .toEqual([{ chainId: 8453, accountDailyWei: 0n, paused: true }, { chainId: 10, accountDailyWei: 5n, paused: true }]);
    expect(() => readSponsorCapPolicies({ SIGNA_SPONSOR_ACCOUNT_DAILY_WEI_8453: "1e18" }, [8453])).toThrow(/non-negative integer/);
  });
});

describe("sponsor cap store", () => {
  const policies = [{ chainId: 8453, accountDailyWei: 10n, paused: false }, { chainId: 10, accountDailyWei: 10n, paused: false }];
  const setup = () => {
    const clock = { now: 1_000_000 }, store = new MemorySponsorCapStore(policies, () => clock.now);
    const reserve = (operationId: string, reservationWei: bigint, options: { chainId?: number; accountId?: string; expiresAt?: number } = {}) =>
      store.reserve({ chainId: options.chainId ?? 8453, accountId: options.accountId ?? "account", operationId, reservationWei,
        expiresAt: options.expiresAt ?? clock.now + 300_000 });
    return { clock, store, reserve };
  };

  it("reserves within the account cap over a rolling 24h per chain", async () => {
    const { clock, store, reserve } = setup();
    expect(await reserve("a", 6n)).toEqual({ ok: true });
    await store.hold({ operationId: "a" });
    expect(await reserve("b", 5n)).toEqual({ ok: false, reason: "account-cap" });
    expect(await reserve("b", 4n)).toEqual({ ok: true });
    // Another chain and another account each have their own cap.
    expect(await reserve("c", 10n, { chainId: 10 })).toEqual({ ok: true });
    expect(await reserve("d", 10n, { accountId: "other" })).toEqual({ ok: true });
    // Reserving again replaces the operation's amount under the same cap.
    expect(await reserve("b", 5n)).toEqual({ ok: false, reason: "account-cap" });
    expect(await reserve("b", 1n)).toEqual({ ok: true });
    // The canonical charge replaces the reservation.
    await store.settle({ operationId: "a", spentWei: 2n });
    expect(await reserve("e", 7n)).toEqual({ ok: true });
    expect(await reserve("f", 1n)).toEqual({ ok: false, reason: "account-cap" });
    // A day later the window has rolled past all of it.
    clock.now += sponsorCapWindowMs;
    expect(await reserve("f", 10n, { expiresAt: clock.now + 1 })).toEqual({ ok: true });
  });

  it("releases only an unspent reservation, and lets an unsigned one lapse at its expiry", async () => {
    const { clock, store, reserve } = setup();
    await reserve("a", 10n, { expiresAt: clock.now + 1000 });
    expect(await reserve("b", 1n)).toMatchObject({ ok: false });
    clock.now += 1000;
    expect(await reserve("b", 10n)).toEqual({ ok: true });
    await store.release({ operationId: "b" });
    expect(await reserve("c", 10n)).toEqual({ ok: true });
    await store.hold({ operationId: "c" });
    await store.settle({ operationId: "c", spentWei: 4n });
    await store.release({ operationId: "c" });
    expect(await reserve("d", 7n)).toMatchObject({ ok: false });
  });

  it("refuses everything while paused, and a chain with no policy", async () => {
    const store = new MemorySponsorCapStore([{ chainId: 8453, accountDailyWei: 10n, paused: true }]);
    const input = { accountId: "account", operationId: "a", reservationWei: 1n, expiresAt: Date.now() + 1000 };
    expect(await store.reserve({ ...input, chainId: 8453 })).toEqual({ ok: false, reason: "paused" });
    expect(await store.reserve({ ...input, chainId: 1 })).toEqual({ ok: false, reason: "account-cap" });
  });
});

describe("review gas", () => {
  const operation = { sender: "0x0000000000000000000000000000000000000003", nonce: "0x0", callData: "0x", callGasLimit: "0x10", verificationGasLimit: "0x10",
    preVerificationGas: "0x10", maxFeePerGas: "0x2", maxPriorityFeePerGas: "0x1", signature: "0x" } as UserOperationV07;
  const sponsored = { ...operation, paymaster: "0x00000000000000fb866daaa79352cc568a005d96", paymasterVerificationGasLimit: "0x10",
    paymasterPostOpGasLimit: "0x0", paymasterData: "0x12" } as UserOperationV07;
  it("names only the payer the signed paymaster fields fix", () => {
    const paymaster = sponsored.paymaster!.toLowerCase();
    expect(checkReviewGas({ payer: "pimlico", chainId: 8453, paymaster }, sponsored, 8453)).toEqual({ payer: "pimlico", chainId: 8453, paymaster });
    const maximumWei = userOperationMaximumCost(operation).toString();
    const account = { payer: "account", chainId: 8453, maximumWei, reason: "account-cap", balanceWei: maximumWei, funded: true };
    expect(checkReviewGas(account, operation, 8453)).toEqual(account);
    for (const [gas, op] of [[account, sponsored], [{ payer: "pimlico", chainId: 8453, paymaster }, operation], [{ ...account, funded: false }, operation],
      [{ ...account, maximumWei: "1" }, operation], [{ ...account, chainId: 10 }, operation], [{ ...account, extra: 1 }, operation]] as const)
      expect(() => checkReviewGas(gas, op as UserOperationV07, 8453)).toThrow();
  });
});
