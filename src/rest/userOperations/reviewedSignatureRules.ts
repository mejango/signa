import { hashMessage, hashTypedData, isAddress, type Address, type Hex, type TypedDataDefinition } from "viem";
import { safe7579MessageSigningPayload } from "../smartAccounts/passkeySignatures.js";

/** The rules of a signature request that the approval page applies too: viem only, no SDK. */

export const REVIEWED_SIGNATURE_KIND = "reviewed-signature-v1";
const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
const ZERO = "0x0000000000000000000000000000000000000000";

/** What an app asks a Signa account to sign: eth_signTypedData_v4 JSON, or personal_sign text. */
export type SignatureRequest =
  | { kind: "typed-data"; chainId: number; typedData: { domain: Record<string, unknown>; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> } }
  | { kind: "message"; chainId: number; message: string };
export type ReviewedSignatureRefusal = "account-self-administration" | "chain-mismatch" | "account-not-deployed" | "owners-diverged";
/** The call a signature lets someone run, from the address that runs it. */
export interface SignatureCall { from: Address; to: Address; value: string; data: Hex }
/** What a signature authorizes, read from the exact request. Addresses lowercase, integers decimal. */
export type SignatureFacts =
  | { kind: "permit2"; spender: Address; deadline: string; tokens: { token: Address; amount: string; expiration: string | null }[] }
  | { kind: "forward-request"; forwarder: Address; deadline: string; call: SignatureCall }
  | { kind: "safe-tx"; safe: Address; nonce: string; operation: number; refund: boolean; call: SignatureCall }
  | { kind: "message"; text: string }
  | { kind: "typed-data"; primaryType: string; fields: SignedField[] };
/** One signed value: its path, its declared type, its value as text (an empty array is "[]") and its label, which names every
 * enclosing struct and array type, as `grant (Permit) > ids (uint256[1]) > [0]`. */
export type SignedField = [path: string, type: string, value: string, label: string];

const fail = (): never => { throw new Error("signature request"); };
const record = (value: unknown, keys?: string[]): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  if (keys) { const own = Object.keys(value as object); if (own.length !== keys.length || own.some(key => !keys.includes(key))) fail(); }
  return value as Record<string, unknown>;
};
const field = (name: string, type: string) => ({ name, type });
const DOMAIN_TYPES: Record<string, string> = { name: "string", version: "string", chainId: "uint256", verifyingContract: "address", salt: "bytes32" };
const DETAILS = [field("token", "address"), field("amount", "uint160"), field("expiration", "uint48"), field("nonce", "uint48")];
const PERMISSIONS = [field("token", "address"), field("amount", "uint256")];
const transfer = (permitted: string) => [field("permitted", permitted), field("spender", "address"), field("nonce", "uint256"), field("deadline", "uint256")];
const allowance = (details: string) => [field("details", details), field("spender", "address"), field("sigDeadline", "uint256")];
// The exact Permit2, ERC-2771 forwarder and Safe structs and domain fields, keyed by primary type. Anything else is shown field by field.
const KNOWN: Record<string, Record<string, { name: string; type: string }[]>> = {
  PermitSingle: { PermitSingle: allowance("PermitDetails"), PermitDetails: DETAILS },
  PermitBatch: { PermitBatch: allowance("PermitDetails[]"), PermitDetails: DETAILS },
  PermitTransferFrom: { PermitTransferFrom: transfer("TokenPermissions"), TokenPermissions: PERMISSIONS },
  PermitBatchTransferFrom: { PermitBatchTransferFrom: transfer("TokenPermissions[]"), TokenPermissions: PERMISSIONS },
  ForwardRequest: { ForwardRequest: [field("from", "address"), field("to", "address"), field("value", "uint256"), field("gas", "uint256"),
    field("nonce", "uint256"), field("deadline", "uint48"), field("data", "bytes")] },
  SafeTx: { SafeTx: [field("to", "address"), field("value", "uint256"), field("data", "bytes"), field("operation", "uint8"), field("safeTxGas", "uint256"),
    field("baseGas", "uint256"), field("gasPrice", "uint256"), field("gasToken", "address"), field("refundReceiver", "address"), field("nonce", "uint256")] },
};
const KNOWN_DOMAIN: Record<string, string> = { PermitSingle: "chainId,name,verifyingContract", PermitBatch: "chainId,name,verifyingContract",
  PermitTransferFrom: "chainId,name,verifyingContract", PermitBatchTransferFrom: "chainId,name,verifyingContract",
  ForwardRequest: "chainId,name,verifyingContract,version", SafeTx: "chainId,verifyingContract" };

/** One value of `type`, checked strictly and normalized for hashing; each leaf is listed as text. */
function value(types: Record<string, { name: string; type: string }[]>, type: string, input: unknown, path: string, label: string,
  leaves: SignedField[], depth: number): unknown {
  if (depth > 8 || leaves.length > 512) fail();
  const array = /^(.+)\[(\d*)\]$/.exec(type);
  if (array) {
    if (!Array.isArray(input) || input.length > 256 || (array[2] !== "" && input.length !== Number(array[2]))) fail();
    if (!(input as unknown[]).length) leaves.push([path, type, "[]", label]);
    return (input as unknown[]).map((item, index) => value(types, array[1]!, item, `${path}[${index}]`, `${label} (${type}) > [${index}]`, leaves, depth + 1));
  }
  const struct = types[type];
  if (struct) {
    const v = record(input, struct.map(item => item.name));
    if (!struct.length) leaves.push([path, type, "{}", label]);
    return Object.fromEntries(struct.map(item => [item.name, value(types, item.type, v[item.name], path ? `${path}.${item.name}` : item.name,
      label ? `${label} (${type}) > ${item.name}` : item.name, leaves, depth + 1)]));
  }
  let out: unknown = input;
  const integer = /^(u?)int(\d*)$/.exec(type), bytes = /^bytes(\d*)$/.exec(type);
  if (type === "address") { if (typeof input !== "string" || !isAddress(input, { strict: false })) fail(); out = (input as string).toLowerCase(); }
  else if (type === "bool") { if (typeof input !== "boolean") fail(); }
  else if (type === "string") { if (typeof input !== "string" || input.length > 16_384) fail(); }
  else if (bytes) {
    const size = bytes[1] ? Number(bytes[1]) : null;
    if (typeof input !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(input) || (size !== null && (size < 1 || size > 32 || input.length !== 2 + 2 * size)) ||
      input.length > 2 + 2 * 65_536) fail();
    out = (input as string).toLowerCase();
  } else if (integer) {
    const bits = integer[2] ? Number(integer[2]) : 256;
    if (bits < 8 || bits > 256 || bits % 8) fail();
    // Numbers only while exact; larger values must be decimal strings.
    if (!(typeof input === "number" && Number.isSafeInteger(input)) && !(typeof input === "string" && /^-?(0|[1-9][0-9]{0,77})$/.test(input))) fail();
    const n = BigInt(input as string | number), limit = 1n << BigInt(integer[1] ? bits : bits - 1);
    if (integer[1] ? n < 0n || n >= limit : n < -limit || n >= limit) fail();
    out = n;
  } else fail();
  leaves.push([path, type, typeof out === "bigint" ? out.toString() : String(out), label]);
  return out;
}

/** The typed data exactly as viem hashes it, with every message field listed. Throws on anything not exact. */
export function typedDataOf(input: unknown): { typedData: TypedDataDefinition; fields: SignedField[] } {
  const t = record(input, ["domain", "types", "primaryType", "message"]), domain = record(t.domain), types = record(t.types);
  if (Object.keys(types).length > 32) fail();
  const structs: Record<string, { name: string; type: string }[]> = {};
  for (const [name, entries] of Object.entries(types)) {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) || !Array.isArray(entries) || entries.length > 64) fail();
    structs[name] = (entries as unknown[]).map(entry => {
      const e = record(entry, ["name", "type"]);
      if (typeof e.name !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(e.name) || typeof e.type !== "string" || e.type.length > 128) fail();
      return { name: e.name as string, type: e.type as string };
    });
  }
  // A listed EIP712Domain must name each of the domain's own fields once, with its standard type: what is hashed is what is shown.
  const keys = Object.keys(domain), members = structs.EIP712Domain;
  if (keys.some(key => !DOMAIN_TYPES[key]) || (members && (members.length !== keys.length || new Set(members.map(entry => entry.name)).size !== members.length ||
    members.some(entry => DOMAIN_TYPES[entry.name] !== entry.type || !keys.includes(entry.name))))) fail();
  const { EIP712Domain: _domain, ...messageTypes } = structs;
  if (typeof t.primaryType !== "string" || !messageTypes[t.primaryType]) fail();
  const domainLeaves: SignedField[] = [], leaves: SignedField[] = [];
  const normalized = value({ EIP712Domain: keys.map(key => field(key, DOMAIN_TYPES[key]!)) }, "EIP712Domain", domain, "domain", "domain", domainLeaves, 0) as Record<string, unknown>;
  if ("chainId" in domain && typeof domain.chainId !== "number") fail();
  const message = value(messageTypes, t.primaryType as string, t.message, "", "", leaves, 0) as Record<string, unknown>;
  const typedData = { domain: { ...normalized, ...("chainId" in normalized ? { chainId: Number(normalized.chainId) } : {}) },
    types: structs, primaryType: t.primaryType as string, message } as unknown as TypedDataDefinition;
  hashTypedData(typedData);
  return { typedData, fields: [...domainLeaves, ...leaves] };
}

/** The request an app sends, checked exactly. Throws on anything else. */
export function signatureRequestOf(input: unknown): SignatureRequest {
  const kind = record(input).kind;
  const r = record(input, ["kind", "chainId", kind === "message" ? "message" : "typedData"]);
  if (!Number.isSafeInteger(r.chainId) || (r.chainId as number) <= 0) fail();
  if (kind === "message") {
    if (typeof r.message !== "string" || r.message.length < 1 || r.message.length > 16_384) fail();
    return { kind: "message", chainId: r.chainId as number, message: r.message as string };
  }
  if (kind !== "typed-data") fail();
  typedDataOf(r.typedData);
  return { kind: "typed-data", chainId: r.chainId as number, typedData: r.typedData as never };
}

/** Read from the raw request, before any decode. A document addressed to the account itself, one of
 * Signa's own authority documents or a SmartSession enable could change who controls the account;
 * typed data must name the request's chain, so it cannot be replayed on another one. */
export function signatureRefusal(account: string, request: SignatureRequest): Exclude<ReviewedSignatureRefusal, "account-not-deployed" | "owners-diverged"> | null {
  if (request.kind === "message") return null;
  const { domain } = request.typedData;
  if (typeof domain.verifyingContract === "string" && domain.verifyingContract.toLowerCase() === account.toLowerCase()) return "account-self-administration";
  if (typeof domain.name === "string" && (domain.name.startsWith("Juicebox Center") || domain.name === "SmartSession")) return "account-self-administration";
  if (domain.chainId !== request.chainId) return "chain-mismatch";
  return null;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const text = (leaves: SignedField[], name: string) => leaves.find(([path]) => path === name)![2];
/** The structs `primary` reaches, by name: what its hash encodes, whatever the order of `types` or any unused type. */
function reachable(types: Record<string, { name: string; type: string }[]>, primary: string) {
  const found: Record<string, { name: string; type: string }[]> = {};
  const visit = (name: string) => { const struct = types[name]; if (!struct || found[name]) return; found[name] = struct; for (const entry of struct) visit(entry.type.replace(/(\[\d*\])+$/, "")); };
  visit(primary);
  return found;
}
const known = (types: Record<string, { name: string; type: string }[]>, primary: string) => {
  const expected = KNOWN[primary], got = reachable(types, primary);
  return !!expected && Object.keys(got).length === Object.keys(expected).length && Object.entries(expected).every(([name, struct]) => same(got[name], struct));
};
/** What the request authorizes. Permit2, a forward request from the account and a SafeTx are recognized
 * only with their exact structs and domain fields; any other typed data is every field, as signed. */
export function signatureFacts(account: string, request: SignatureRequest): SignatureFacts {
  if (request.kind === "message") return { kind: "message", text: request.message };
  const { typedData, fields } = typedDataOf(request.typedData), { EIP712Domain: _domain, ...types } = typedData.types as unknown as Record<string, { name: string; type: string }[]>;
  const message = fields.filter(([path]) => !path.startsWith("domain.")), at = (name: string) => text(message, name);
  const domain = typedData.domain as Record<string, unknown>, primary = typedData.primaryType as string;
  const contract = typeof domain.verifyingContract === "string" ? domain.verifyingContract as Address : null;
  if (contract && known(types, primary) && Object.keys(domain).sort().join() === KNOWN_DOMAIN[primary]) {
    if (contract === PERMIT2 && domain.name === "Permit2") {
      const entries = (primary.startsWith("PermitBatch") ? (n: number) => `[${n}]` : () => "");
      const list = primary.startsWith("Permit") && primary.endsWith("TransferFrom") ? "permitted" : "details";
      const count = message.filter(([path]) => new RegExp(`^${list}(\\[\\d+\\])?\\.token$`).test(path)).length;
      return { kind: "permit2", spender: at("spender") as Address, deadline: at(list === "details" ? "sigDeadline" : "deadline"),
        tokens: Array.from({ length: count }, (_, index) => ({ token: at(`${list}${entries(index)}.token`) as Address,
          amount: at(`${list}${entries(index)}.amount`), expiration: list === "details" ? at(`details${entries(index)}.expiration`) : null })) };
    }
    if (primary === "ForwardRequest" && at("from") === account.toLowerCase())
      return { kind: "forward-request", forwarder: contract, deadline: at("deadline"),
        call: { from: at("from") as Address, to: at("to") as Address, value: at("value"), data: at("data") as Hex } };
    if (primary === "SafeTx")
      return { kind: "safe-tx", safe: contract, nonce: at("nonce"), operation: Number(at("operation")),
        refund: at("gasPrice") !== "0" || at("baseGas") !== "0" || at("gasToken") !== ZERO || at("refundReceiver") !== ZERO,
        call: { from: contract, to: at("to") as Address, value: at("value"), data: at("data") as Hex } };
  }
  return { kind: "typed-data", primaryType: primary, fields };
}

/** The page's warning codes for what a signature authorizes, strongest first. */
export function signatureWarnings(facts: SignatureFacts): string[] {
  if (facts.kind === "typed-data") return ["unknown-typed-data"];
  if (facts.kind === "safe-tx") return [...(facts.operation !== 0 ? ["delegatecall"] : []), ...(facts.refund ? ["safe-gas-nonzero"] : [])];
  if (facts.kind === "permit2") return facts.tokens.some(token => BigInt(token.amount) >= (1n << 160n) - 1n) ? ["unlimited-approval"] : [];
  return [];
}

/** The digest the account's ERC-1271 signature is for, and the SafeMessage digest the passkey signs over it. */
export function signatureSigning(account: Address, request: SignatureRequest): { digest: Hex; requestDigest: Hex } {
  const requestDigest = request.kind === "message" ? hashMessage(request.message) : hashTypedData(typedDataOf(request.typedData).typedData);
  return { digest: safe7579MessageSigningPayload({ safe: account, chainId: request.chainId, requestDigest }).digest, requestDigest };
}
