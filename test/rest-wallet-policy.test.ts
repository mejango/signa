import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { environmentName, firstPartyForEnvironment, originsForEnvironment } from "../src/firstParty.js";
import { canonicalJson } from "../src/intent.js";
import type { Json } from "../src/types.js";
import {
  validateWalletPolicyCallback, validateWalletPolicyConfiguration, validateWalletPolicyOrigin,
  walletPolicyConfigurationHash, type WalletPolicyConfiguration,
} from "../src/rest/wallet/policy.js";

const origin = "https://beep.biz";
const configuration = (): WalletPolicyConfiguration => ({ version: "center-wallet-policy-v1", applications: [
  { origin, walletCallbacks: [origin + "/wallet/return"] },
] });
const invalid = (operation: () => unknown) => expect(operation).toThrow(expect.objectContaining({ code: "WALLET_POLICY_INVALID" }));

afterEach(() => vi.unstubAllEnvs());

describe("one first-party configuration", () => {
  it("preserves all existing production and development origins and their order", () => {
    expect(originsForEnvironment("production")).toEqual([
      "https://juicebox.money", "https://revnet.money", "https://eth.shop", "https://succulent.money", "https://homerun.money", "https://beep.biz",
    ]);
    expect(originsForEnvironment("dev")).toEqual([
      "https://dev.juicebox.money", "https://dev.revnet.money", "http://localhost:3001", "http://localhost:3002",
      "https://dev.eth.shop", "http://localhost:3003", "https://dev.succulent.money", "http://localhost:3004", "http://localhost:3010", "http://localhost:3014",
      "http://127.0.0.1:8787",
    ]);
    expect(originsForEnvironment("preview")).toEqual(originsForEnvironment("production"));
    expect(originsForEnvironment("production")).not.toContain("https://juicebox.center");
    expect(originsForEnvironment("dev")).not.toContain("https://dev.juicebox.center");
  });
  it("selects dev first-party apps from SIGNA_ENVIRONMENT, ahead of the Railway name", () => {
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "production");
    vi.stubEnv("SIGNA_ENVIRONMENT", "dev");
    expect(originsForEnvironment()).toEqual(originsForEnvironment("dev"));
    expect(environmentName({ SIGNA_ENVIRONMENT: "dev" })).toBe("dev");
    expect(environmentName({ RAILWAY_ENVIRONMENT_NAME: "dev" })).toBe("dev");
    expect(environmentName({})).toBeUndefined();
  });
  it("retains the existing environment default and enables no return handlers", () => {
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "dev");
    expect(originsForEnvironment()).toEqual(originsForEnvironment("dev"));
    for (const environment of ["production", "dev"]) {
      const applications = firstPartyForEnvironment(environment);
      expect(applications.map(application => application.origin)).toEqual(originsForEnvironment(environment));
      expect(applications.every(application => application.walletCallbacks.length === 0)).toBe(true);
      expect(validateWalletPolicyConfiguration({ version: "center-wallet-policy-v1", applications })).toEqual({
        version: "center-wallet-policy-v1", applications: [...applications].sort((a, b) => a.origin < b.origin ? -1 : 1),
      });
    }
  });
  it("does not let callers change the shared trusted origins or callback metadata", () => {
    const origins = originsForEnvironment("production") as string[];
    origins.push("https://attacker.example");
    expect(originsForEnvironment("production")).not.toContain("https://attacker.example");
    const applications = firstPartyForEnvironment("production");
    expect(() => (applications[0]!.walletCallbacks as string[]).push(origin + "/return")).toThrow();
    expect(() => { applications[0]!.origin = "https://attacker.example"; }).toThrow();
  });
});

describe("exact wallet policy URLs", () => {
  it.each([origin, "https://app.example:444", "http://localhost:3001", "http://127.0.0.1:1234", "http://[::1]:1234"])("accepts canonical configured origin %s", value => {
    expect(validateWalletPolicyOrigin(value)).toBe(value);
    expect(validateWalletPolicyCallback(value + "/wallet/return", value)).toBe(value + "/wallet/return");
  });
  it.each([
    "https://beep.biz/", "https://beep.biz/path", "https://beep.biz?", "https://beep.biz#", "https://beep.biz/?x=1",
    "https://BEep.biz", "HTTPS://beep.biz", "https://beep.biz:443", "https://user@beep.biz", "https://@beep.biz",
    "https://*.beep.biz", "https://beep.biz\\", " https://beep.biz", "https://beep.biz\n", "//beep.biz",
    "http://beep.biz", "http://localhost.evil", "http://127.1:3000", "http://2130706433:3000", "http://[0:0:0:0:0:0:0:1]:3000",
    "https://bücher.example", "file:///tmp/callback", "data:text/html,hello", "null", "", null, 1,
  ])("rejects origin ambiguity or unsupported transport %s", value => invalid(() => validateWalletPolicyOrigin(value)));
  it.each([
    "https://juicebox.money/wallet/return", "https://sub.beep.biz/wallet/return", "https://beep.biz.evil/wallet/return",
    "https://beep.biz:444/wallet/return", "http://beep.biz/wallet/return", "//beep.biz/wallet/return",
    "https://user@beep.biz/wallet/return", "https://BEep.biz/wallet/return", "https://beep.biz:443/wallet/return",
    "https://beep.biz/wallet/../return", "https://beep.biz/./return", "https://beep.biz/%2e/return",
    "https://beep.biz/wallet/%72eturn", "https://beep.biz/wallet%2freturn", "https://beep.biz//wallet/return",
    "https://beep.biz\\wallet\\return", "https://beep.biz/wallet/return?", "https://beep.biz/wallet/return#",
    "https://beep.biz/wallet/return?code=occupied", "https://beep.biz/wallet/return#fragment", "https://beep.biz/*",
    "https://beep.biz/wallet/return\n", "https://beep.biz/retürn", "", null, 1,
  ])("rejects callback aliases and origin expansion %s", value => invalid(() => validateWalletPolicyCallback(value, origin)));
  it("validates the origin argument and requires an explicit callback path", () => {
    invalid(() => validateWalletPolicyCallback(origin + "/wallet/return", origin + "/"));
    invalid(() => validateWalletPolicyCallback(origin, origin));
    expect(validateWalletPolicyCallback(origin + "/", origin)).toBe(origin + "/");
  });
});

describe("bounded canonical wallet policy", () => {
  it("copies and sorts entries and callbacks without changing input or granting a new origin", () => {
    const input: WalletPolicyConfiguration = { version: "center-wallet-policy-v1", applications: [
      { origin: "https://juicebox.money", walletCallbacks: [] },
      { origin, walletCallbacks: [origin + "/z-return", origin + "/a-return"] },
    ] };
    const original = structuredClone(input);
    const result = validateWalletPolicyConfiguration(input);
    expect(result.applications.map(application => application.origin)).toEqual([origin, "https://juicebox.money"]);
    expect(result.applications[0]!.walletCallbacks).toEqual([origin + "/a-return", origin + "/z-return"]);
    expect(input).toEqual(original);
    expect(result).not.toBe(input);
    expect(result.applications[0]).not.toBe(input.applications[1]);
    expect(result.applications[0]!.walletCallbacks).not.toBe(input.applications[1]!.walletCallbacks);
    input.applications[1]!.origin = "https://attacker.example";
    expect(result.applications[0]!.origin).toBe(origin);
    invalid(() => validateWalletPolicyConfiguration({ version: "center-wallet-policy-v1", applications: [
      { origin, walletCallbacks: ["https://attacker.example/return"] },
    ] }));
  });
  it("hashes the validated sorted public configuration with SHA256 of Center canonical JSON", () => {
    const input = configuration();
    const expected = createHash("sha256").update(canonicalJson(input as unknown as Json)).digest("hex");
    expect(walletPolicyConfigurationHash(input)).toBe(expected);
    const alternate: WalletPolicyConfiguration = { version: input.version, applications: [
      { origin: "https://juicebox.money", walletCallbacks: [] }, { origin, walletCallbacks: [origin + "/z", origin + "/a"] },
    ] };
    const reordered: WalletPolicyConfiguration = { version: input.version, applications: [
      { origin, walletCallbacks: [origin + "/a", origin + "/z"] }, { origin: "https://juicebox.money", walletCallbacks: [] },
    ] };
    expect(walletPolicyConfigurationHash(alternate)).toBe(walletPolicyConfigurationHash(reordered));
    expect(walletPolicyConfigurationHash(alternate)).not.toBe(expected);
    invalid(() => walletPolicyConfigurationHash({ ...input, extra: true } as WalletPolicyConfiguration));
  });
  it.each([
    null, [], {}, { version: "center-wallet-policy-v2", applications: [] }, { version: "center-wallet-policy-v1", applications: [], enabled: true },
    { version: "center-wallet-policy-v1", applications: [{ origin }] },
    { version: "center-wallet-policy-v1", applications: [{ origin, walletCallbacks: [], enabled: true }] },
    { version: "center-wallet-policy-v1", applications: [{ origin, walletCallbacks: [], appId: "beep" }] },
    { version: "center-wallet-policy-v1", applications: [{ origin, walletCallbacks: [origin + "/return", origin + "/return"] }] },
    { version: "center-wallet-policy-v1", applications: [{ origin, walletCallbacks: [] }, { origin, walletCallbacks: [] }] },
  ])("rejects unknown fields, incomplete records and duplicates %#", value => invalid(() => validateWalletPolicyConfiguration(value)));
  it("accepts an empty trusted policy and exact count limits, rejects overflow", () => {
    expect(validateWalletPolicyConfiguration({ version: "center-wallet-policy-v1", applications: [] }).applications).toEqual([]);
    const input: WalletPolicyConfiguration = { version: "center-wallet-policy-v1", applications: Array.from({ length: 64 }, (_, index) => {
      const entryOrigin = `https://app${index}.example`;
      return { origin: entryOrigin, walletCallbacks: Array.from({ length: 4 }, (_, callback) => `${entryOrigin}/return${callback}`) };
    }) };
    expect(validateWalletPolicyConfiguration(input).applications).toHaveLength(64);
    invalid(() => validateWalletPolicyConfiguration({ ...input, applications: [...input.applications, { origin: "https://extra.example", walletCallbacks: [] }] }));
    invalid(() => validateWalletPolicyConfiguration({ ...input, applications: [{ origin, walletCallbacks: Array.from({ length: 5 }, (_, index) => `${origin}/return${index}`) }] }));
  });
  it("bounds URL lengths before parsing and the complete serialized configuration at 32KiB", () => {
    const longOrigin = "https://" + "x".repeat(504);
    expect(validateWalletPolicyOrigin(longOrigin)).toBe(longOrigin);
    invalid(() => validateWalletPolicyOrigin(longOrigin + "x"));
    const longCallback = origin + "/" + "x".repeat(2048 - origin.length - 1);
    expect(validateWalletPolicyCallback(longCallback, origin)).toBe(longCallback);
    invalid(() => validateWalletPolicyCallback(longCallback + "x", origin));
    const input: WalletPolicyConfiguration = { version: "center-wallet-policy-v1", applications: Array.from({ length: 8 }, (_, index) => {
      const entryOrigin = `https://app${index}.example`;
      return { origin: entryOrigin, walletCallbacks: Array.from({ length: 4 }, (_, callback) => `${entryOrigin}/${callback}${"x".repeat(1100)}`) };
    }) };
    invalid(() => validateWalletPolicyConfiguration(input));
  });
  it("accepts exactly 32KiB of canonical configuration and rejects one extra byte", () => {
    const input = { version: "center-wallet-policy-v1" as const, applications: Array.from({ length: 8 }, (_, index) => {
      const entryOrigin = `https://app${index}.example`;
      return { origin: entryOrigin, walletCallbacks: [0, 1].map(callback => `${entryOrigin}/${callback}${"x".repeat(1700)}`) };
    }) };
    let remaining = 32_768 - Buffer.byteLength(canonicalJson(input));
    for (const application of input.applications) {
      for (let index = 0; index < application.walletCallbacks.length; index++) {
        const growth = Math.min(remaining, 2048 - application.walletCallbacks[index]!.length);
        application.walletCallbacks[index] += "x".repeat(growth);
        remaining -= growth;
      }
    }
    expect(remaining).toBe(0);
    expect(Buffer.byteLength(canonicalJson(input))).toBe(32_768);
    expect(validateWalletPolicyConfiguration(input).applications).toHaveLength(8);
    input.applications.at(-1)!.walletCallbacks[1] += "x";
    invalid(() => validateWalletPolicyConfiguration(input));
  });
  it("rejects accessors, custom serialization, private objects and malformed arrays without executing them", () => {
    let invoked = 0;
    const getter = () => { invoked++; return origin; };
    const application = Object.defineProperty({ walletCallbacks: [] }, "origin", { enumerable: true, get: getter });
    const root = Object.defineProperty({ applications: [] }, "version", { enumerable: true, get: getter });
    const accessorCallbacks = Object.defineProperty([], "0", { enumerable: true, get: getter });
    const toJSON = () => { invoked++; return configuration(); };
    const inputs: unknown[] = [
      root, { version: "center-wallet-policy-v1", applications: [application] },
      { version: "center-wallet-policy-v1", applications: [{ origin, walletCallbacks: accessorCallbacks }] },
      Object.assign(configuration(), { toJSON }), Object.assign(configuration(), { [Symbol("hidden")]: "value" }),
      Object.defineProperty(configuration(), "secret", { value: "not public", enumerable: false }),
      Object.assign(Object.create({ toJSON }), configuration()), new Date(), new Map(), Buffer.from("private"),
      { version: "center-wallet-policy-v1", applications: Array(1) },
      { version: "center-wallet-policy-v1", applications: Object.assign([], { extra: true }) },
      new Proxy(configuration(), { get() { invoked++; throw new Error("proxy executed"); } }),
    ];
    for (const value of inputs) invalid(() => validateWalletPolicyConfiguration(value));
    expect(invoked).toBe(0);
  });
});
