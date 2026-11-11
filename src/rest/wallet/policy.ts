import { createHash } from "node:crypto";
import { types } from "node:util";
import type { FirstPartyApplication } from "../../firstParty.js";
import { canonicalJson } from "./json.js";
import type { Json } from "../../types.js";
import { RestError } from "../core.js";
import { walletAppGrantMaximumLifetimeSeconds } from "./grantLifetime.js";
export { walletAppGrantDefaultLifetimeSeconds, walletAppGrantMaximumLifetimeSeconds } from "./grantLifetime.js";

export type WalletPolicyConfiguration = {
  version: "center-wallet-policy-v1";
  applications: FirstPartyApplication[];
};

function invalid(): never {
  throw new RestError(400, "WALLET_POLICY_INVALID", "Wallet policy fields, URLs or bounds are invalid.");
}

function url(value: unknown, maximum: number): URL {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum ||
      /[^\x21-\x7e]|[*\\%?#]/.test(value)) invalid();
  try { return new URL(value); } catch { return invalid(); }
}

/** Exact origins only; the URL parser may validate but must never normalize trust. */
export function validateWalletPolicyOrigin(value: unknown): string {
  const parsed = url(value, 512);
  if (parsed.origin !== value || parsed.username || parsed.password ||
      !(parsed.protocol === "https:" || parsed.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))) invalid();
  return value as string;
}

/** V1 uses literal ASCII return paths, without encoded aliases or response parameters. */
export function validateWalletPolicyCallback(value: unknown, origin: string): string {
  validateWalletPolicyOrigin(origin);
  const parsed = url(value, 2048);
  if (parsed.origin !== origin || parsed.href !== value || parsed.username || parsed.password ||
      parsed.pathname.includes("//")) invalid();
  return value as string;
}

function fields(value: unknown, expected: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const keys = Reflect.ownKeys(value), allowed = [...expected, ...optional];
  if (keys.length < expected.length || keys.length > allowed.length
    || keys.some(key => typeof key !== "string" || !allowed.includes(key)) || expected.some(key => !keys.includes(key))) invalid();
  const result: Record<string, unknown> = {};
  for (const key of allowed) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) { if (expected.includes(key)) invalid(); continue; }
    if (!("value" in descriptor) || !descriptor.enumerable) invalid();
    result[key] = descriptor.value;
  }
  return result;
}

function array(value: unknown, maximum: number): unknown[] {
  if (!value || typeof value !== "object" || types.isProxy(value) || !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum ||
      Reflect.ownKeys(value).length !== value.length + 1) invalid();
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
    result.push(descriptor.value);
  }
  return result;
}

/** Only trusted server configuration can supply applications. Callback metadata cannot
 * expand an entry's origin. Copy plain public data before sorting or serialization. */
export function validateWalletPolicyConfiguration(value: unknown): WalletPolicyConfiguration {
  const input = fields(value, ["version", "applications"]);
  if (input.version !== "center-wallet-policy-v1") invalid();
  const seen = new Set<string>();
  const applications = array(input.applications, 64).map(value => {
    const entry = fields(value, ["origin", "walletCallbacks"], ["grantLifetimeSeconds"]);
    const origin = validateWalletPolicyOrigin(entry.origin);
    const lifetime = entry.grantLifetimeSeconds;
    if (lifetime !== undefined && (typeof lifetime !== "number" || !Number.isSafeInteger(lifetime) || lifetime < 60
      || lifetime > walletAppGrantMaximumLifetimeSeconds)) invalid();
    if (seen.has(origin)) invalid();
    seen.add(origin);
    const walletCallbacks = array(entry.walletCallbacks, 4).map(callback => validateWalletPolicyCallback(callback, origin));
    if (new Set(walletCallbacks).size !== walletCallbacks.length) invalid();
    return { origin, walletCallbacks: walletCallbacks.sort(), ...(lifetime !== undefined ? { grantLifetimeSeconds: lifetime } : {}) };
  }).sort((a, b) => a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0);
  const configuration: WalletPolicyConfiguration = { version: input.version, applications };
  if (Buffer.byteLength(canonicalJson(configuration as unknown as Json)) > 32_768) invalid();
  return configuration;
}

export function walletPolicyConfigurationHash(configuration: WalletPolicyConfiguration): string {
  const validated = validateWalletPolicyConfiguration(configuration);
  return createHash("sha256").update(canonicalJson(validated as unknown as Json)).digest("hex");
}
