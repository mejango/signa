import { describe, expect, test } from "vitest";
import {
  isSponsoredChain,
  sponsoredChains,
  sponsorFamily,
} from "../../src/sponsor/policy.js";
import { readSponsorPolicy, reservationWei } from "../../src/rest/sponsorCaps.js";

describe("sponsor policy", () => {
  test("family by chain set", () => {
    expect(sponsorFamily([8453, 10])).toBe("mainnet");
    expect(sponsorFamily([84532, 11155111])).toBe("testnet");
    expect(sponsorFamily([1, 8453])).toBeNull();
    expect(sponsorFamily([8453, 84532])).toBeNull();
    expect(sponsorFamily([])).toBeNull();
  });

  test("sponsorship read one chain at a time", () => {
    expect(sponsoredChains([1, 8453, 10])).toEqual([8453, 10]);
    expect(sponsoredChains([1])).toEqual([]);
    expect(sponsoredChains([84532, 421614])).toEqual([84532, 421614]);
    expect(isSponsoredChain(8453)).toBe(true);
    expect(isSponsoredChain(11155111)).toBe(true);
    expect(isSponsoredChain(1)).toBe(false);
    expect(isSponsoredChain(137)).toBe(false);
  });

  test("policy from env with defaults", () => {
    const policy = readSponsorPolicy({});
    expect(policy).toEqual({
      paused: false,
      perRequesterPerDay: 5,
      dailyBudgetWei: 50_000_000_000_000_000n,
      mcpDailyBudgetWei: 10_000_000_000_000_000n,
      maximumGas: 8_000_000n,
      maximumFeePerGas: 1_000_000_000n,
      confirmations: 2,
    });
    expect(readSponsorPolicy({ SPONSOR_PAUSED: "1" }).paused).toBe(true);
    // The MCP's slice follows the shared budget unless it is configured on its own.
    expect(readSponsorPolicy({ SPONSOR_DAILY_BUDGET_WEI: "100" }).mcpDailyBudgetWei).toBe(20n);
    expect(
      readSponsorPolicy({ SPONSOR_DAILY_BUDGET_WEI: "100", SPONSOR_MCP_DAILY_BUDGET_WEI: "7" })
        .mcpDailyBudgetWei,
    ).toBe(7n);
    // The deployment verifier requires two confirmations, so a lower setting is raised.
    expect(readSponsorPolicy({ SPONSOR_CONFIRMATIONS: "0" }).confirmations).toBe(2);
    expect(readSponsorPolicy({ SPONSOR_CONFIRMATIONS: "1" }).confirmations).toBe(2);
    expect(readSponsorPolicy({ SPONSOR_CONFIRMATIONS: "5" }).confirmations).toBe(5);
    expect(reservationWei(policy, 2)).toBe(2n * (8_000_000n * 1_000_000_000n + 100_000_000_000_000n));
  });
});
