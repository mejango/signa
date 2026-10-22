import { hashTypedData, type Hex } from "viem";
import { createWalletEnrollmentIntent, enrollmentDigest, prepareWalletEnrollmentCandidate, verifyWalletEnrollmentProof,
  walletEnrollmentDocument, type WalletEnrollment } from "../../src/rest/wallet/enrollment.js";
import { fingerprint } from "../../src/rest/smartAccounts/service.js";
import type { SmartAccountState } from "../../src/rest/smartAccounts/types.js";
import type { WalletAuthorityContext } from "../../src/rest/wallet/authority.js";
import { createRegistration, enrollmentBackupAccount, enrollmentManifest, signBackupProof, signGet } from "./wallet-enrollment-crypto.js";

/** Genuine W3 crypto with a pure receipt stand-in; synthetic chain and setup-binding metadata.
 * This fixture proves neither database admission nor canonical deployment or live setup possession. */
/** The primary passkey's signing material for the most recent fixture, for tests that must sign as it. */
export let lastFixturePrimary: { credentialId: string; key: import("node:crypto").KeyObject; publicKey: { x: Hex; y: Hex }; userHandle: string } | null = null;
export async function createWalletAuthorityContextFixture(now = 1_800_000_120_000, manifest = enrollmentManifest): Promise<WalletAuthorityContext> {
  const hash = (byte: string): Hex => `0x${byte.repeat(64)}`;
  const block = () => ({ chainId: 8453, blockNumber: "100", blockHash: hash("a"), timestamp: String(Math.floor(now / 1000)), source: "onchain" as const });
  const issued = now - 120_000;
  const issuedSeconds = Math.floor(issued / 1000);
  const intent = createWalletEnrollmentIntent({ manifest, rpId: "juicebox.center", origin: "https://juicebox.center",
    recoveryOwner: enrollmentBackupAccount.address, expiresAt: issued + 60000 });
  const empty: WalletEnrollment = { intent, createdAt: issued, state: "awaiting_registration", candidate: null,
    candidateDigest: null, creation: null, possession: null, receipt: null };
  const credential = createRegistration({ challenge: `0x${Buffer.from(intent.registration.challenge, "base64url").toString("hex")}`,
    rpId: intent.rpId, origin: intent.origin, userHandle: intent.userHandle });
  lastFixturePrimary = { credentialId: credential.credentialId, key: credential.key, publicKey: credential.publicKey, userHandle: intent.userHandle };
  const pending: WalletEnrollment = { ...empty, ...prepareWalletEnrollmentCandidate(empty, credential.response), state: "awaiting_possession" };
  const document = walletEnrollmentDocument(pending);
  const proof = await verifyWalletEnrollmentProof(pending, { assertion: signGet({ ...credential, challenge: hashTypedData(document),
    rpId: intent.rpId, origin: intent.origin }), backupSignature: await signBackupProof(document) });
  const accountId = `eip155:8453:${pending.creation!.address.toLowerCase()}`;
  const enrollment: WalletEnrollment = { ...pending, state: "verified", receipt: { id: intent.id, enrollmentId: intent.id,
    accountId, credentialId: credential.credentialId, initializerHash: pending.creation!.initializerHash,
    manifestCommitment: `0x${enrollmentDigest(intent.manifest)}`, manifestRevision: intent.manifest.revision,
    creationCommitment: `0x${enrollmentDigest(pending.creation)}`, verificationDigest: proof.verificationDigest, verifiedAt: issued + 1 } };
  // Explicit synthetic chain/binding metadata for PURE checks. Anvil/store suites prove provenance.
  const state: SmartAccountState = { chainId: 8453, address: pending.creation!.address, manifestId: intent.manifest.id,
    manifestRevision: intent.manifest.revision, owners: [pending.creation!.bootstrap.signerAddress, intent.recoveryOwner], threshold: 1,
    safeNonce: "0", stateHash: hash("b"), evidence: block(), codeHashes: [], executionVerified: false, moduleConfigurationVerified: true,
    modules: { stateHash: hash("c"), complete: true, arbitrarySigningDisabled: true, wildcardExecutionDisabled: true,
      details: { provenance: { initializerHash: pending.creation!.initializerHash }, sessions: { permissionIds: [] } } },
    ownerProfile: { version: "center-passkey-v1", signer: { address: pending.creation!.bootstrap.signerAddress, kind: "contract",
      ...credential.publicKey, verifiers: `0x${"11".repeat(22)}`, runtimeCodeHash: hash("d") },
      recoveryOwner: { address: intent.recoveryOwner, kind: "ecdsa" } } };
  return { version: "center-wallet-authority-context-v1", accountId, enrollment,
    credential: { accountId, enrollmentId: intent.id, rpId: intent.rpId, credentialId: credential.credentialId,
      userHandle: intent.userHandle, publicKey: credential.publicKey, backupEligible: true, verifiedAtMs: issued + 1, supersededAtMs: null },
    binding: { id: fingerprint({ ownerAccountId: accountId, wallet: state.address, chainId: 8453 }), ownerAccountId: accountId,
      ownerAddress: state.address, wallet: { address: state.address, chainId: 8453 }, manifestId: state.manifestId, state,
      authorization: { digest: hash("e"), nonce: hash("f"), expiresAt: issuedSeconds + 300,
        method: "safe-passkey-owner-threshold-and-api-grant", setup: { manifestRevision: state.manifestRevision,
          initializerHash: pending.creation!.initializerHash, issuedAt: issuedSeconds, grantId: "12345678-1234-4567-89ab-123456789abc",
          botAddress: "0x2222222222222222222222222222222222222222", scopes: ["read", "plan", "relay"],
          grantExpiresAt: issuedSeconds + 3600, label: "Pure authority fixture" } } }, prior: null };
}
