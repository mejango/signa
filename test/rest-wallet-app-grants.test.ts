import { describe, expect, it } from "vitest";
import { parseWalletAppPrincipalId, validateWalletAppGrant, validateWalletAppGrantAdmission, walletAppPrincipalId,
  type WalletAppGrant, type WalletAppGrantAdmission } from "../src/rest/wallet/appGrants.js";

const accountId = `eip155:8453:0x${"11".repeat(20)}`, origin = "https://beep.biz";
const admission = (): WalletAppGrantAdmission => ({ accountId, signerAddress: `0x${"22".repeat(20)}`, origin,
  callbackUri: `${origin}/wallet/callback`, audience: "https://juicebox.center", expectedAppGeneration: 1,
  expectedAuthorityEpoch: "1", expectedSessionEpoch: "1", expiresAt: 1800003600 });
const grant = (): WalletAppGrant => ({ kind: "wallet-app", id: "11111111-1111-4111-8111-111111111111", incarnation: "9007199254740993",
  accountId, signerAddress: `0x${"22".repeat(20)}`, scopes: ["read", "plan", "relay"], origin, callbackUri: `${origin}/wallet/callback`,
  audience: "https://juicebox.center", appGeneration: 1, authorityEpoch: "9007199254740993", sessionEpoch: "1", createdAt: 1800000000,
  expiresAt: 1800003600, revokedAt: null, retainUntil: 1800090000 });

describe("typed wallet app grant identity and bounded public metadata", () => {
  it("retains BIGINT identities beyond Number precision and requires the exact incarnation", () => {
    const value = grant(), actor = walletAppPrincipalId(value);
    expect(actor).toBe(`app:${value.id}:9007199254740993`);
    expect(parseWalletAppPrincipalId(actor)).toEqual({ id: value.id, incarnation: "9007199254740993" });
    expect(validateWalletAppGrant(value).authorityEpoch).toBe("9007199254740993");
    expect(parseWalletAppPrincipalId(`app:${value.id}:9223372036854775807`)?.incarnation).toBe("9223372036854775807");
  });
  it.each(["bot:11111111-1111-4111-8111-111111111111", "app:11111111-1111-4111-8111-111111111111",
    "app:11111111-1111-4111-8111-111111111111:01", "app:11111111-1111-4111-8111-111111111111:0",
    "app:11111111-1111-4111-8111-111111111111:9223372036854775808", "app:bad:1"])("rejects malformed actor %s", actor => {
    expect(parseWalletAppPrincipalId(actor)).toBeNull();
  });
  it("bounds the API audience in UTF-8 bytes before PostgreSQL insertion", () => {
    expect(() => validateWalletAppGrantAdmission({ ...admission(), audience: `https://center.test/${"é".repeat(1024)}` })).toThrow();
  });
  it("accepts exactly ninety days and rejects one second more against fixed grant creation time", () => {
    const value = grant(), expiresAt = value.createdAt + 90 * 86_400;
    expect(validateWalletAppGrant({ ...value, expiresAt, retainUntil: expiresAt + 86_400 }).expiresAt).toBe(expiresAt);
    expect(() => validateWalletAppGrant({ ...value, expiresAt: expiresAt + 1, retainUntil: expiresAt + 86_401 }))
      .toThrow(expect.objectContaining({ code: "WALLET_APP_GRANT_INVALID" }));
  });
  it.each([{ authorityEpoch: "01" }, { sessionEpoch: 1 }, { incarnation: "9223372036854775808" },
    { scopes: ["read"] }, { scopes: ["read", "plan", "relay", "spend"] }, { kind: "bot" }, { privateKey: "secret" },
    { callbackUri: "https://juicebox.money/wallet/callback" }, { appGeneration: Number.MAX_SAFE_INTEGER + 1 },
    { accountId: `eip155:1:0x${"11".repeat(20)}` }, { retainUntil: 1800090001 }])("rejects authority/shape mutation %j", change => {
    expect(() => validateWalletAppGrant({ ...grant(), ...change })).toThrow();
  });
  it("copies metadata and rejects executable object shapes without invoking them", () => {
    const value = grant(), result = validateWalletAppGrant(value);
    value.scopes.pop(); value.origin = "https://juicebox.money";
    expect(result.scopes).toEqual(["read", "plan", "relay"]); expect(result.origin).toBe(origin);
    let invoked = 0;
    const getter = Object.defineProperty(admission(), "origin", { enumerable: true, get() { invoked++; return origin; } });
    expect(() => validateWalletAppGrantAdmission(getter)).toThrow();
    expect(() => validateWalletAppGrant(new Proxy(grant(), { getPrototypeOf() { invoked++; return Object.prototype; } }))).toThrow();
    expect(invoked).toBe(0);
  });
});
