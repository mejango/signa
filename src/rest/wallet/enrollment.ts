import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getAddress, hashTypedData, isAddress, recoverAddress, type Address, type Hex } from "viem";
import { canonicalJson } from "./json.js";
import type { Json } from "../../types.js";
import { RestError } from "../core.js";
import { canonicalEoaSignature } from "../smartAccounts/accountExecution.js";
import { preparePasskeySafe7579Creation, validatePasskeyCreationManifest } from "../smartAccounts/creation.js";
import type { ContractPin, SmartAccountManifest } from "../smartAccounts/types.js";
import { assertWalletCeremonyDraft, createWalletCeremony, type WalletCeremonyDraft } from "./ceremonies.js";
import { parseWalletRegistration, type WalletRegistrationCandidate, type WalletRegistrationResponse } from "./registration.js";
import { validateWalletRpConfiguration, verifyWalletAssertion, type WalletAssertion, type WalletCeremonyOptions } from "./webauthn.js";

export interface WalletEnrollmentIntent {
  id: string;
  userHandle: string;
  saltNonce: string;
  manifest: SmartAccountManifest;
  rpId: string;
  origin: string;
  recoveryOwner: Address;
  expiresAt: number;
  registration: WalletCeremonyDraft;
}
export interface WalletEnrollmentReceipt {
  id: string;
  accountId: string;
  enrollmentId: string;
  credentialId: string;
  initializerHash: Hex;
  manifestCommitment: Hex;
  manifestRevision: Hex;
  creationCommitment: Hex;
  verificationDigest: string;
  verifiedAt: number;
}
export interface WalletEnrollment {
  intent: WalletEnrollmentIntent;
  createdAt: number;
  state: "awaiting_registration" | "awaiting_possession" | "verified";
  candidate: WalletRegistrationCandidate | null;
  candidateDigest: string | null;
  creation: ReturnType<typeof preparePasskeySafe7579Creation> | null;
  possession: { nonce: Hex; ceremony: WalletCeremonyDraft } | null;
  receipt: WalletEnrollmentReceipt | null;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const word = /^0x[0-9a-fA-F]{64}$/;
const digest = /^[0-9a-f]{64}$/;
const asHex = (value: string): Hex => `0x${value}`;
const accountId = (id: string) => `wallet-enrollment:${id}`;
function invalid(): never {
  throw new RestError(400, "WALLET_ENROLLMENT_INVALID", "Wallet enrollment fields or context are invalid.");
}

/** Strict bounded JSON before canonicalization: no dropped fields, bigint coercion, custom
 * serialization, typed arrays, private KeyObjects or unbounded recursive object graphs. */
function publicJson(value: unknown, depth = 0, budget = { nodes: 0, bytes: 0 }): Json {
  if (++budget.nodes > 4096 || depth > 12) invalid();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) invalid();
    return value;
  }
  if (typeof value === "string") {
    budget.bytes += Buffer.byteLength(value);
    if (value.length > 65_536 || budget.bytes > 131_072) invalid();
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 256 || Object.getPrototypeOf(value) !== Array.prototype ||
        Reflect.ownKeys(value).length !== value.length + 1) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Json[] = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
      result.push(publicJson(descriptor.value, depth + 1, budget));
    }
    return result;
  }
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  if (Reflect.ownKeys(value).length !== Object.keys(value).length) invalid();
  const entries = Object.entries(Object.getOwnPropertyDescriptors(value));
  if (entries.length > 64 || entries.some(([key, descriptor]) => key.length > 128 || !("value" in descriptor))) invalid();
  return Object.fromEntries(entries.map(([key, descriptor]) => [key, publicJson(descriptor.value, depth + 1, budget)]));
}

/** SHA256 of existing Center canonical JSON. Hashing does not make an arbitrary object trusted. */
export function enrollmentDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(publicJson(value))).digest("hex");
}
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}
function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}
function encodedBytes(value: unknown, maximum: number, exact?: number): void {
  if (!text(value, Math.ceil(maximum * 4 / 3)) || !/^[A-Za-z0-9_-]+$/.test(value)) invalid();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length > maximum || (exact !== undefined && bytes.length !== exact) || bytes.toString("base64url") !== value) invalid();
}
function validPin(value: ContractPin, extra: readonly string[] = []): void {
  fields(value, ["address", "runtimeCodeHash", "source", ...extra]);
  if (!isAddress(value.address) || BigInt(value.address) <= 1n || !word.test(value.runtimeCodeHash)) invalid();
  fields(value.source, ["repository", "artifactSha256"], ["commit", "contentSha256"]);
  if (!text(value.source.repository, 2048) || !digest.test(value.source.artifactSha256) ||
      (value.source.commit !== undefined && !/^[0-9a-f]{40}$/.test(value.source.commit)) ||
      (value.source.contentSha256 !== undefined && !digest.test(value.source.contentSha256)) ||
      (!value.source.commit && !value.source.contentSha256)) invalid();
  const repository = new URL(value.source.repository);
  if (repository.protocol !== "https:" || repository.username || repository.password || repository.search || repository.hash) invalid();
}
function validManifest(value: SmartAccountManifest): void {
  fields(value, ["id", "mode", "chainId", "revision", "safeVersion", "proxyRuntimeCodeHash", "singleton", "factory", "safe7579",
    "launchpad", "smartSessions", "policies", "moduleInspectorId", "ownerProfile", "creationProfile"], ["entryPoint"]);
  if (!text(value.id, 128) || !text(value.moduleInspectorId, 128) || value.mode !== "execution-candidate" ||
      value.chainId !== 8453 || !word.test(value.revision) || !word.test(value.proxyRuntimeCodeHash) ||
      !Array.isArray(value.policies) || value.policies.length > 32) invalid();
  for (const pin of [value.singleton, value.factory, value.safe7579, value.launchpad, ...value.policies]) validPin(pin);
  validPin(value.smartSessions, ["generation"]);
  if (value.entryPoint !== undefined) {
    validPin(value.entryPoint, ["version"]);
    if (value.entryPoint.version !== "0.7") invalid();
  }
  fields(value.ownerProfile, ["version", "signerFactory", "signerSingleton", "p256Verifier"]);
  for (const pin of [value.ownerProfile.signerFactory, value.ownerProfile.signerSingleton, value.ownerProfile.p256Verifier]) validPin(pin);
  fields(value.creationProfile, ["version", "multiSend"]);
  validPin(value.creationProfile.multiSend);
  validatePasskeyCreationManifest(value);
}
const intentFields = ["id", "userHandle", "saltNonce", "manifest", "rpId", "origin", "recoveryOwner", "expiresAt", "registration"];
function baseIntent(intent: Omit<WalletEnrollmentIntent, "registration"> | WalletEnrollmentIntent) {
  return { id: intent.id, userHandle: intent.userHandle, saltNonce: intent.saltNonce, manifest: intent.manifest,
    rpId: intent.rpId, origin: intent.origin, recoveryOwner: intent.recoveryOwner, expiresAt: intent.expiresAt };
}

/** Validates an existing server-owned immutable draft; the database decides expiry and admission. */
export function assertWalletEnrollmentIntent(intent: WalletEnrollmentIntent): void {
  try {
    publicJson(intent);
    fields(intent, intentFields);
    if (!uuid.test(intent.id) || !text(intent.saltNonce, 78) || !/^(0|[1-9][0-9]*)$/.test(intent.saltNonce) ||
        BigInt(intent.saltNonce) >= 1n << 256n || !Number.isSafeInteger(intent.expiresAt) || intent.expiresAt < 1 ||
        !text(intent.rpId, 253) || !text(intent.origin, 1024) || !isAddress(intent.recoveryOwner) ||
        BigInt(intent.recoveryOwner) <= 1n || intent.recoveryOwner !== intent.recoveryOwner.toLowerCase()) invalid();
    encodedBytes(intent.userHandle, 32, 32);
    validateWalletRpConfiguration(intent);
    validManifest(intent.manifest);
    assertWalletCeremonyDraft(intent.registration);
    if (intent.registration.accountId !== accountId(intent.id) || intent.registration.purpose !== "registration" ||
        intent.registration.expiresAt !== intent.expiresAt || intent.registration.contextDigest !== enrollmentDigest(baseIntent(intent))) invalid();
  } catch { invalid(); }
}

/** Creates an isolated public configuration snapshot. This grants no session or wallet authority. */
export function createWalletEnrollmentIntent(input: {
  manifest: SmartAccountManifest; rpId: string; origin: string; recoveryOwner: Address; expiresAt: number;
}): WalletEnrollmentIntent {
  try {
    publicJson(input);
    fields(input, ["manifest", "rpId", "origin", "recoveryOwner", "expiresAt"]);
    const base = { ...structuredClone(input), id: randomUUID(), userHandle: randomBytes(32).toString("base64url"),
      saltNonce: BigInt(asHex(randomBytes(32).toString("hex"))).toString(), recoveryOwner: getAddress(input.recoveryOwner).toLowerCase() as Address };
    const result = { ...base, registration: createWalletCeremony({ accountId: accountId(base.id), purpose: "registration",
      contextDigest: enrollmentDigest(base), expiresAt: base.expiresAt }) };
    assertWalletEnrollmentIntent(result);
    return result;
  } catch { return invalid(); }
}

function checkedCandidate(intent: WalletEnrollmentIntent, candidate: WalletRegistrationCandidate): void {
  publicJson(candidate);
  fields(candidate, ["credentialId", "userHandle", "publicKey", "signCount", "backupEligible", "backedUp", "aaguid"]);
  fields(candidate.publicKey, ["x", "y"]);
  encodedBytes(candidate.credentialId, 1023);
  if (candidate.userHandle !== intent.userHandle || !word.test(candidate.publicKey.x) || !word.test(candidate.publicKey.y) ||
      !Number.isInteger(candidate.signCount) || candidate.signCount < 0 || candidate.signCount > 0xffffffff ||
      typeof candidate.backupEligible !== "boolean" || typeof candidate.backedUp !== "boolean" ||
      (candidate.backedUp && !candidate.backupEligible) || !/^0x[0-9a-f]{32}$/.test(candidate.aaguid)) invalid();
}
const documentTypes = { WalletEnrollment: [
  { name: "enrollmentId", type: "string" }, { name: "purpose", type: "string" }, { name: "version", type: "uint256" },
  { name: "manifestCommitment", type: "bytes32" }, { name: "manifestRevision", type: "bytes32" },
  { name: "predictedSafe", type: "address" }, { name: "initializerHash", type: "bytes32" },
  { name: "creationCommitment", type: "bytes32" }, { name: "rpId", type: "string" }, { name: "origin", type: "string" },
  { name: "userHandleCommitment", type: "bytes32" }, { name: "candidateCommitment", type: "bytes32" },
  { name: "recoveryOwner", type: "address" }, { name: "nonce", type: "bytes32" }, { name: "expiresAtMs", type: "uint64" },
] } as const;
function document(intent: WalletEnrollmentIntent, candidateDigest: string,
  creation: ReturnType<typeof preparePasskeySafe7579Creation>, nonce: Hex) {
  return {
    domain: { name: "Juicebox Center Wallet Enrollment", version: "1", chainId: 8453, verifyingContract: creation.address },
    types: structuredClone(documentTypes), primaryType: "WalletEnrollment" as const,
    message: { enrollmentId: intent.id, purpose: "registration", version: 1n,
      manifestCommitment: asHex(enrollmentDigest(intent.manifest)), manifestRevision: intent.manifest.revision,
      predictedSafe: creation.address, initializerHash: creation.initializerHash, creationCommitment: asHex(enrollmentDigest(creation)),
      rpId: intent.rpId, origin: intent.origin, userHandleCommitment: asHex(enrollmentDigest(intent.userHandle)),
      candidateCommitment: asHex(candidateDigest), recoveryOwner: intent.recoveryOwner, nonce, expiresAtMs: BigInt(intent.expiresAt) },
  };
}

/** Reconstructs the registration-only document from stored intent and exact creation. It is
 * neither SafeOp nor SafeMessage approval, and says nothing about deployed code or sessions. */
export function walletEnrollmentDocument(record: WalletEnrollment) {
  assertWalletEnrollmentIntent(record.intent);
  if (!record.candidate || !record.creation || !record.possession || !record.candidateDigest ||
      !["awaiting_possession", "verified"].includes(record.state)) invalid();
  checkedCandidate(record.intent, record.candidate);
  if (!digest.test(record.candidateDigest) || record.candidateDigest !== enrollmentDigest(record.candidate) ||
      !word.test(record.possession.nonce)) invalid();
  const creation = preparePasskeySafe7579Creation({ manifest: record.intent.manifest, publicKey: record.candidate.publicKey,
    recoveryOwner: record.intent.recoveryOwner, saltNonce: record.intent.saltNonce });
  if (enrollmentDigest(creation) !== enrollmentDigest(record.creation)) invalid();
  const result = document(record.intent, record.candidateDigest, creation, record.possession.nonce);
  const challenge = hashTypedData(result), ceremony = record.possession.ceremony;
  assertWalletCeremonyDraft(ceremony);
  if (ceremony.accountId !== accountId(record.intent.id) || ceremony.purpose !== "registration" ||
      ceremony.expiresAt !== record.intent.expiresAt || ceremony.contextDigest !== enrollmentDigest(challenge) ||
      ceremony.challenge !== Buffer.from(challenge.slice(2), "hex").toString("base64url")) invalid();
  return result;
}

/** Unproven none attestation freezes a candidate only. The caller must atomically consume
 * registration and persist this candidate with its new possession ceremony, or persist neither. */
export function prepareWalletEnrollmentCandidate(record: WalletEnrollment, response: WalletRegistrationResponse, options: WalletCeremonyOptions = {}) {
  try {
    assertWalletEnrollmentIntent(record.intent);
    const intent = record.intent;
    const candidate = parseWalletRegistration(response, { challenge: asHex(Buffer.from(intent.registration.challenge, "base64url").toString("hex")),
      rpId: intent.rpId, origin: intent.origin, userHandle: intent.userHandle, ...(options.topOrigin ? { topOrigin: options.topOrigin } : {}) });
    const candidateDigest = enrollmentDigest(candidate);
    const creation = preparePasskeySafe7579Creation({ manifest: intent.manifest, publicKey: candidate.publicKey,
      recoveryOwner: intent.recoveryOwner, saltNonce: intent.saltNonce });
    const nonce = asHex(randomBytes(32).toString("hex"));
    const challenge = hashTypedData(document(intent, candidateDigest, creation, nonce));
    const ceremony: WalletCeremonyDraft = { id: randomUUID(), accountId: accountId(intent.id), purpose: "registration",
      contextDigest: enrollmentDigest(challenge), challenge: Buffer.from(challenge.slice(2), "hex").toString("base64url"), expiresAt: intent.expiresAt };
    assertWalletCeremonyDraft(ceremony);
    return { candidate, candidateDigest, creation, possession: { nonce, ceremony } };
  } catch { return invalid(); }
}

/** Crypto only. The durable caller rechecks frozen state, deadline and uniqueness under locks,
 * then consumes the ceremony and writes the original receipt in the same transaction. */
/** `passkeyChallenge` lets one passkey assertion serve both purposes: the creation approval's
 * assertion (over the deployment document) also proves possession, while the recovery owner
 * still signs the enrollment document itself. The receipt digest binds identity, not the
 * challenge, so a folded proof and a separate proof produce the same verified receipt. */
export async function verifyWalletEnrollmentProof(record: WalletEnrollment, proof: { assertion: WalletAssertion; backupSignature: Hex },
  options: { passkeyChallenge?: Hex } & WalletCeremonyOptions = {}): Promise<{ verificationDigest: string }> {
  try {
    fields(proof, ["assertion", "backupSignature"]);
    fields(options, [], ["passkeyChallenge", "topOrigin"]);
    if (options.passkeyChallenge !== undefined && !/^0x[0-9a-f]{64}$/.test(options.passkeyChallenge)) invalid();
    // Snapshot bounded public context; submitted proof bytes are bounded/verified synchronously
    // before recovery's await, so no unbounded proof clone or caller-owned context survives it.
    publicJson(record);
    const snapshot = structuredClone(record);
    const typedData = walletEnrollmentDocument(snapshot), challenge = hashTypedData(typedData), candidate = snapshot.candidate!;
    verifyWalletAssertion(proof.assertion, { purpose: "registration", challenge: options.passkeyChallenge ?? challenge, rpId: snapshot.intent.rpId, origin: snapshot.intent.origin,
      ...(options.topOrigin ? { topOrigin: options.topOrigin } : {}), requireUserHandle: true, credential: { id: candidate.credentialId, userHandle: candidate.userHandle,
        publicKey: candidate.publicKey, backupEligible: candidate.backupEligible } });
    const signature = canonicalEoaSignature(proof.backupSignature);
    const backupOwner = (await recoverAddress({ hash: challenge, signature })).toLowerCase();
    if (backupOwner !== snapshot.intent.recoveryOwner) invalid();
    return { verificationDigest: enrollmentDigest({ version: "center-wallet-enrollment-proof-v1", documentHash: challenge,
      credentialId: candidate.credentialId, publicKey: candidate.publicKey, backupOwner }) };
  } catch {
    throw new RestError(403, "WALLET_ENROLLMENT_PROOF_INVALID", "Wallet enrollment requires matching passkey and backup ownership proofs.");
  }
}

/** A registered passkey and frozen wallet identity, verified or not yet. The returned commitment
 * covers exactly the intent, passkey candidate and creation, so it is identical before and after
 * possession is proved; a verified record must additionally carry a consistent receipt. */
export function assertRegisteredWalletEnrollment(enrollment: WalletEnrollment): Hex {
  enrollmentDigest(enrollment);
  fields(enrollment, ["intent", "createdAt", "state", "candidate", "candidateDigest", "creation", "possession", "receipt"]);
  if (!["awaiting_possession", "verified"].includes(enrollment.state) || !enrollment.candidate || !enrollment.creation || !enrollment.possession ||
      enrollment.candidateDigest !== enrollmentDigest(enrollment.candidate) || !Number.isSafeInteger(enrollment.createdAt) || enrollment.createdAt <= 0) invalid();
  walletEnrollmentDocument(enrollment);
  if (enrollment.state === "verified") assertVerifiedWalletEnrollment(enrollment);
  else if (enrollment.receipt !== null) invalid();
  return asHex(enrollmentDigest({ version: "center-wallet-enrollment-identity-v1", intent: enrollment.intent, candidate: enrollment.candidate, creation: enrollment.creation }));
}

/** Input is an internal record loaded from W3's durable store, never HTTP JSON. These consistency
 * checks cannot turn a caller-forged receipt into verified enrollment or current onchain authority. */
export function assertVerifiedWalletEnrollment(enrollment: WalletEnrollment): Hex {
  enrollmentDigest(enrollment);
  const timestamp = (value: number) => Number.isSafeInteger(value) && value > 0;
  fields(enrollment, ["intent", "createdAt", "state", "candidate", "candidateDigest", "creation", "possession", "receipt"]);
  const registration = walletEnrollmentDocument(enrollment);
  if (enrollment.state !== "verified" || !enrollment.receipt || !timestamp(enrollment.createdAt)) invalid();
  const receipt = enrollment.receipt, creation = enrollment.creation!, candidate = enrollment.candidate!;
  fields(receipt, ["id", "accountId", "enrollmentId", "credentialId", "initializerHash", "manifestCommitment",
    "manifestRevision", "creationCommitment", "verificationDigest", "verifiedAt"]);
  if (receipt.id !== enrollment.intent.id || receipt.enrollmentId !== enrollment.intent.id ||
      receipt.accountId !== `eip155:8453:${creation.address.toLowerCase()}` || receipt.credentialId !== candidate.credentialId ||
      receipt.initializerHash !== creation.initializerHash || receipt.manifestRevision !== enrollment.intent.manifest.revision ||
      receipt.manifestCommitment !== asHex(enrollmentDigest(enrollment.intent.manifest)) || receipt.creationCommitment !== asHex(enrollmentDigest(creation)) ||
      !timestamp(receipt.verifiedAt) || receipt.verifiedAt < enrollment.createdAt || receipt.verifiedAt >= enrollment.intent.expiresAt ||
      receipt.verificationDigest !== enrollmentDigest({ version: "center-wallet-enrollment-proof-v1",
        documentHash: hashTypedData(registration), credentialId: candidate.credentialId, publicKey: candidate.publicKey,
        backupOwner: enrollment.intent.recoveryOwner })) invalid();
  return asHex(enrollmentDigest(enrollment));
}
