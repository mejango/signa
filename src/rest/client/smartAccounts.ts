import {
  concatHex,
  hashTypedData,
  isAddress,
  keccak256,
  recoverAddress,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import {
  assertSafe7579Execution,
  encodeLegacyUseSignature,
  encodeSafe7579OwnerSignature,
  legacySessionSigningPayload,
  safe7579OwnerSigningPayload,
  type Safe7579OwnerSigningInput,
} from "../smartAccounts/accountExecution.js";
import type { safe7579PasskeyOwnerSigningPayload } from "../smartAccounts/passkeySignatures.js";
import type {
  SessionPolicyInput,
  SmartAccountBinding,
  SmartAccountState,
  SmartAccountManifest,
} from "../smartAccounts/types.js";
import { prepareSafe7579Creation } from "../smartAccounts/creation.js";
import type { StoredSession, SessionQuota } from "../sessions/types.js";
import type { StoredPlan } from "../transactions/types.js";
import type { UserOperationRecord } from "../userOperations/store.js";
import { getUserOperationHash as legacyOperationHash } from "../userOperations/codec.js";
import {
  RestClientError,
  SignedRestClient,
  clientAudience,
  newRequestNonce,
} from "./index.js";

export interface WalletProvider {
  request(input: { method: string; params?: unknown[] }): Promise<unknown>;
}
export interface WalletTypedData {
  domain: Record<string, unknown>;
  types: Record<string, readonly { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}
export interface SmartAccountCapabilities {
  deployments: {
    manifestId: string;
    chainId: number;
    mode: string;
    revision: Hex;
    moduleGeneration: string;
    moduleInspectionConfigured: boolean;
    entryPointSourceVerified: boolean;
    manifest?: SmartAccountManifest;
  }[];
  requirements: string[];
  walletCreation: boolean;
  userOperationPreparation?: boolean;
  userOperationSimulation?: boolean;
  userOperationRelay?: boolean;
  sessionDurationsDays: number[];
}
export interface BindingRequest {
  manifestId: string;
  address: Address;
  nonce: Hex;
  expiresAt: number;
}
export interface BindingChallenge {
  state: SmartAccountState;
  typedData: WalletTypedData;
  digest: Hex;
}
export interface WalletCreationRequest {
  manifestId: string;
  owners: Address[];
  threshold: number;
  saltNonce: string;
}
export type WalletCreationPreparation = ReturnType<
  typeof prepareSafe7579Creation
> & { deploymentConfirmed: false; evidence: unknown };
export type OwnerSigningPayload = ReturnType<
  typeof safe7579OwnerSigningPayload
>;
/** Contract owners sign this exact SafeOp digest using a WebAuthn assertion; its dynamic
 * envelope is distinct from the EOA-only ownerOperationSignature packing helper below.
 * The profile field describes the prepared encoding, not deployment or provider readiness.
 */
export type PasskeyOwnerSigningPayload = ReturnType<
  typeof safe7579PasskeyOwnerSigningPayload
> & { ownerProfile: "center-passkey-v1" };
export type SessionSigningPayload = ReturnType<
  typeof legacySessionSigningPayload
>;
export type SmartWalletPlan = Pick<
  StoredPlan,
  | "id"
  | "draft"
  | "commitment"
  | "createdAt"
  | "expiresAt"
  | "revision"
  | "smartAccount"
> & {
  steps: Pick<StoredPlan["steps"][number], "index" | "state">[];
  status?: string;
};
/** The HTTP view deliberately excludes actor, sender (available on operation), and signed bytes. */
export type PreparedUserOperation = Omit<
  UserOperationRecord,
  "actor" | "sender" | "submission" | "preparationKey" | "inputHash"
> & {
  signing: OwnerSigningPayload | PasskeyOwnerSigningPayload | SessionSigningPayload;
  submission?: { commitment: Hex; startedAt: number };
};
const prefix = "/api/v1";
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const invalid = (message: string): never => {
  throw new RestClientError("SMART_CLIENT_INVALID", message);
};
const id = (value: string) => {
  if (!/^(?:0x[0-9a-fA-F]{64}|[A-Za-z0-9_-]{1,128})$/.test(value))
    invalid("Use the exact identifier returned by the service.");
  return encodeURIComponent(value);
};
export function smartRequestKey(): string {
  return `smart-${newRequestNonce().slice(2)}`;
}

/** Public-key material, policies and signatures only. This facade never accepts a private key. */
export class SmartAccountClient {
  constructor(readonly client: SignedRestClient) {}
  private post<T>(
    path: string,
    json: unknown,
    key = smartRequestKey(),
  ): Promise<T> {
    return this.client.request<T>({
      method: "POST",
      requestTarget: `${prefix}${path}`,
      json,
      idempotencyKey: key,
    });
  }
  capabilities() {
    return this.client.request<SmartAccountCapabilities>({
      requestTarget: `${prefix}/smart-accounts/capabilities`,
    });
  }
  prepareCreation(input: WalletCreationRequest, key?: string) {
    return this.post<{ creation: WalletCreationPreparation }>(
      "/smart-accounts/creation-plans",
      input,
      key,
    );
  }
  challenge(input: BindingRequest) {
    return this.post<BindingChallenge>(
      "/smart-accounts/binding-challenges",
      input,
    );
  }
  bind(
    input: BindingRequest & { stateHash: Hex; signature: Hex },
    key?: string,
  ) {
    return this.post<SmartAccountBinding>(
      "/smart-accounts/bindings",
      input,
      key,
    );
  }
  bindings() {
    return this.client.request<{
      items: Pick<SmartAccountBinding, "id" | "wallet" | "manifestId">[];
    }>({ requestTarget: `${prefix}/smart-accounts/bindings` });
  }
  binding(bindingId: Hex) {
    return this.client.request<SmartAccountBinding>({
      requestTarget: `${prefix}/smart-accounts/bindings/${id(bindingId)}`,
    });
  }
  preparePlan(bindingId: Hex, operation: string, input: unknown, key?: string) {
    return this.post<SmartWalletPlan>(
      `/smart-accounts/bindings/${id(bindingId)}/plans`,
      { operation, input },
      key,
    );
  }
  prepareSession(input: SessionPolicyInput, key?: string) {
    return this.post<StoredSession>("/smart-accounts/sessions", input, key);
  }
  session(sessionId: string) {
    return this.client.request<StoredSession>({
      requestTarget: `${prefix}/smart-accounts/sessions/${id(sessionId)}`,
    });
  }
  quota(sessionId: string) {
    return this.client.request<SessionQuota>({
      requestTarget: `${prefix}/smart-accounts/sessions/${id(sessionId)}/quota`,
    });
  }
  sessionPlan(
    sessionId: string,
    kind: "activation" | "revocation",
    compiledHash: Hex,
    key?: string,
  ) {
    return this.post<{
      session: StoredSession;
      plan: SmartWalletPlan;
      installationConfirmed: boolean;
    }>(
      `/smart-accounts/sessions/${id(sessionId)}/${kind}-plans`,
      { compiledHash },
      key,
    );
  }
  prepareUserOperation(
    input: { planId: string; stepIndexes: number[]; sessionId?: string },
    key?: string,
  ) {
    return this.post<PreparedUserOperation>("/user-operations", input, key);
  }
  /** One call: the plan (idempotent on `plan.idempotencyKey`) and the sponsored operation over every
   * one of its steps (idempotent on `key`). When the voucher does not cover the plan Center built,
   * the answer carries the plan alone and `sponsorship: "refused"`, to be sponsored on its own. */
  prepareSponsoredPayment(
    plan: { bindingId: Hex; operation: string; input: unknown; idempotencyKey: string },
    sponsorAuthorization: string,
    key?: string,
  ) {
    return this.post<{ plan: SmartWalletPlan; operation?: PreparedUserOperation; sponsorship: "accepted" | "refused" }>(
      "/user-operations",
      { plan: { bindingId: id(plan.bindingId), operation: plan.operation, input: plan.input, idempotencyKey: plan.idempotencyKey }, sponsorAuthorization },
      key,
    );
  }
  submitUserOperation(operationId: string, signature: Hex, key?: string) {
    if (!/^0x(?:[0-9a-fA-F]{2}){65,16384}$/.test(signature))
      invalid("Use a complete owner or session signature envelope.");
    return this.post<PreparedUserOperation>(
      `/user-operations/${id(operationId)}/submissions`,
      { signature },
      key,
    );
  }
  /** With `wait`, the answer is held (up to 20 s) until the operation moves past the revision seen. */
  userOperation(operationId: string, wait?: { seconds: number; since: number }) {
    if (wait && (!Number.isInteger(wait.seconds) || wait.seconds < 1 || wait.seconds > 20 || !Number.isInteger(wait.since) || wait.since < 0))
      invalid("Wait 1–20 seconds past a revision already seen.");
    return this.client.request<PreparedUserOperation>({
      requestTarget: `${prefix}/user-operations/${id(operationId)}${wait ? `?wait=${wait.seconds}&since=${wait.since}` : ""}`,
      // The server may hold the answer for the wait and then observe once more (a full observation
      // can take several seconds), so the request outlives the ordinary bound by that much.
      ...(wait ? { timeoutMs: wait.seconds * 1000 + 15_000 } : {}),
    });
  }
}

export function verifyWalletCreation(input: {
  manifest: SmartAccountManifest;
  request: WalletCreationRequest;
  creation: WalletCreationPreparation;
}) {
  const expected = prepareSafe7579Creation({
    manifest: input.manifest,
    ...input.request,
  });
  const actual = input.creation;
  if (
    input.request.manifestId !== input.manifest.id ||
    actual.chainId !== expected.chainId ||
    actual.manifestId !== expected.manifestId ||
    !same(actual.manifestRevision, expected.manifestRevision) ||
    !same(actual.address, expected.address) ||
    !same(actual.initializerHash, expected.initializerHash) ||
    !same(actual.transaction.to, expected.transaction.to) ||
    actual.transaction.value !== "0" ||
    !same(actual.transaction.data, expected.transaction.data)
  )
    invalid(
      "Wallet creation differs from the selected deployment, owners or threshold.",
    );
  return expected;
}

export function assertReviewedOperation(
  record: PreparedUserOperation,
  plan: SmartWalletPlan,
  now = Date.now(),
) {
  if (
    record.state !== "prepared" ||
    record.expiresAt <= now ||
    record.createdAt > now + 30_000 ||
    record.planId !== plan.id ||
    !same(record.planCommitment, plan.commitment) ||
    !plan.smartAccount ||
    !same(record.accountBindingId, plan.smartAccount.bindingId) ||
    record.chainId !== plan.smartAccount.chainId ||
    !same(record.operation.sender, plan.smartAccount.address) ||
    record.operation.signature !== "0x" ||
    !record.stepIndexes.length ||
    new Set(record.stepIndexes).size !== record.stepIndexes.length
  )
    invalid(
      "Prepare a fresh operation for the exact reviewed plan and wallet.",
    );
  const calls = record.stepIndexes.map((index) => {
    const call =
      Number.isSafeInteger(index) && index >= 0
        ? plan.draft.calls[index]
        : undefined;
    if (!call || call.chainId !== record.chainId)
      return invalid("The operation selects an invalid plan step.");
    return { target: call.to, value: call.value, callData: call.data };
  });
  assertSafe7579Execution(record.operation.callData, calls);
  if (
    !same(
      record.operationHash,
      legacyOperationHash(record.operation, record.entryPoint, record.chainId),
    )
  )
    invalid("The prepared operation hash differs from its contents.");
}

/** Concrete call template for one reviewed session action; the API still verifies deployment and available authority. */
export function sessionActionPlanInput(
  session: StoredSession,
  input: {
    actionIndex?: number;
    uri?: string;
    amount?: string;
    tokenContractId?: string;
  },
) {
  const policy = session.compiled.reviewedPolicy as {
    actions?: {
      kind: string;
      target: Address;
      projectId?: string;
      asset?: Address;
      beneficiary?: Address;
      minReturnedTokens?: string;
      perCallLimit?: string;
    }[];
  };
  const index = input.actionIndex ?? 0,
    action =
      Number.isSafeInteger(index) && index >= 0
        ? policy.actions?.[index]
        : undefined;
  if (!action || !isAddress(action.target))
    return invalid("Choose an exact reviewed session action.");
  const call = { chainId: session.compiled.chainId, address: action.target };
  if (action.kind === "v6-project-uri") {
    if (
      typeof input.uri !== "string" ||
      !/^(ipfs:\/\/|https:\/\/)/.test(input.uri) ||
      input.uri.length > 2048
    )
      invalid("Use the pinned metadata's ipfs:// URI or an HTTPS URI.");
    return {
      account: session.compiled.wallet,
      calls: [
        {
          ...call,
          contractId: "@bananapus/core-v6:src/JBController.sol:JBController",
          projectId: action.projectId,
          function: "setUriOf(uint256,string)",
          args: [action.projectId, input.uri],
          value: "0",
        },
      ],
    };
  }
  if (
    !input.amount ||
    !/^[1-9][0-9]{0,77}$/.test(input.amount) ||
    !action.perCallLimit ||
    BigInt(input.amount) > BigInt(action.perCallLimit)
  )
    invalid(
      "Enter a positive raw-unit amount within the reviewed per-call limit.",
    );
  if (action.kind === "v6-pay")
    return {
      account: session.compiled.wallet,
      calls: [
        {
          ...call,
          contractId:
            "@bananapus/core-v6:src/JBMultiTerminal.sol:JBMultiTerminal",
          projectId: action.projectId,
          function: "pay(uint256,address,uint256,address,uint256,string,bytes)",
          args: [
            action.projectId,
            action.asset,
            input.amount,
            action.beneficiary,
            action.minReturnedTokens,
            "",
            "0x",
          ],
          value:
            action.asset?.toLowerCase() ===
            "0x000000000000000000000000000000000000eeee"
              ? input.amount
              : "0",
        },
      ],
    };
  if (
    action.kind !== "erc20-transfer" ||
    !input.tokenContractId ||
    input.tokenContractId.length > 512
  )
    invalid(
      "An ERC20 transfer needs its exact verified contract ID from Juicebox Center's contract catalog.",
    );
  return {
    account: session.compiled.wallet,
    calls: [
      {
        ...call,
        contractId: input.tokenContractId,
        function: "transfer(address,uint256)",
        args: [action.beneficiary, input.amount],
        value: "0",
      },
    ],
  };
}

/** EIP-712 domains vary: request authentication, Safe binding and SafeOp use different fields. */
export function walletTypedDataDocument(document: WalletTypedData): string {
  const domainFields = [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
    { name: "salt", type: "bytes32" },
  ].filter(({ name }) => document.domain[name] !== undefined);
  if (
    Object.keys(document.domain).some(
      (name) => !domainFields.some((field) => field.name === name),
    )
  )
    invalid("Unsupported signing domain field.");
  return JSON.stringify(
    { ...document, types: { ...document.types, EIP712Domain: domainFields } },
    (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
  );
}
export async function assertWalletIdentity(
  provider: WalletProvider,
  address: Address,
  chainId: number,
  stillCurrent: () => boolean = () => true,
) {
  if (!Number.isSafeInteger(chainId) || chainId < 1 || !isAddress(address))
    invalid("Invalid wallet identity.");
  const [accounts, chain] = await Promise.all([
    provider.request({ method: "eth_accounts" }),
    provider.request({ method: "eth_chainId" }),
  ]);
  if (
    !stillCurrent() ||
    !Array.isArray(accounts) ||
    !accounts.some((item) => typeof item === "string" && same(item, address)) ||
    typeof chain !== "string" ||
    !/^0x[0-9a-fA-F]+$/.test(chain) ||
    BigInt(chain) !== BigInt(chainId)
  )
    invalid(
      "The wallet account or chain changed. Connect again and review the request.",
    );
}
export async function signWalletTypedData(input: {
  provider: WalletProvider;
  address: Address;
  chainId: number;
  document: WalletTypedData;
  stillCurrent?: () => boolean;
  signatureFormat?: "eoa" | "wallet";
}): Promise<Hex> {
  await assertWalletIdentity(
    input.provider,
    input.address,
    input.chainId,
    input.stillCurrent,
  );
  if (BigInt(String(input.document.domain.chainId)) !== BigInt(input.chainId))
    invalid("The signing domain uses another chain.");
  const signature = await input.provider.request({
    method: "eth_signTypedData_v4",
    params: [input.address, walletTypedDataDocument(input.document)],
  });
  await assertWalletIdentity(
    input.provider,
    input.address,
    input.chainId,
    input.stillCurrent,
  );
  const signaturePattern =
    input.signatureFormat === "wallet"
      ? /^0x(?:[0-9a-fA-F]{2}){1,8192}$/
      : /^0x[0-9a-fA-F]{130}$/;
  if (typeof signature !== "string" || !signaturePattern.test(signature))
    invalid("The wallet returned an invalid signature.");
  return signature as Hex;
}

/** Rebuild the exact binding document locally instead of signing arbitrary server-provided typed data. */
export function smartBindingDocument(
  input: {
    audience: string;
    accountId: string;
    owner: Address;
    request: BindingRequest;
    challenge: BindingChallenge;
  },
  now = Math.floor(Date.now() / 1000),
): WalletTypedData {
  const { request, challenge, owner } = input;
  const state = challenge.state;
  if (
    !same(request.address, state.address) ||
    state.manifestId !== request.manifestId ||
    !state.owners.some((entry) => same(entry, owner)) ||
    request.expiresAt <= now ||
    request.expiresAt > now + 900 ||
    !Number.isSafeInteger(state.threshold) ||
    state.threshold < 1 ||
    state.threshold > state.owners.length ||
    !/^0x[0-9a-fA-F]{64}$/.test(state.stateHash)
  )
    invalid(
      "The binding challenge differs from the reviewed wallet, owners or expiration.",
    );
  const document = {
    domain: {
      name: "Juicebox Center Smart Account",
      version: "1",
      chainId: state.chainId,
      verifyingContract: state.address,
      salt: keccak256(
        stringToHex(new URL(clientAudience(input.audience)).toString()),
      ),
    },
    types: {
      BindSmartAccount: [
        { name: "accountId", type: "string" },
        { name: "owner", type: "address" },
        { name: "stateHash", type: "bytes32" },
        { name: "nonce", type: "bytes32" },
        { name: "expiresAt", type: "uint64" },
      ],
    },
    primaryType: "BindSmartAccount",
    message: {
      accountId: input.accountId,
      owner,
      stateHash: state.stateHash,
      nonce: request.nonce,
      expiresAt: BigInt(request.expiresAt),
    },
  } as const;
  if (!same(hashTypedData(document), challenge.digest))
    invalid(
      "The binding digest differs from the locally reconstructed document.",
    );
  return document;
}

export async function packOwnerSignatures(input: {
  digest: Hex;
  owners: readonly Address[];
  threshold: number;
  signatures: readonly Hex[];
}): Promise<Hex> {
  if (
    !Number.isSafeInteger(input.threshold) ||
    input.threshold < 1 ||
    input.threshold > 16 ||
    input.signatures.length !== input.threshold
  )
    invalid("Collect exactly the wallet's current owner threshold.");
  const order =
    0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const signatures = await Promise.all(
    input.signatures.map(async (signature) => {
      if (
        !/^0x[0-9a-fA-F]{130}$/.test(signature) ||
        !/^(1b|1c)$/i.test(signature.slice(-2))
      )
        invalid("Use direct EOA typed-data signatures with v27/28.");
      const r = BigInt(`0x${signature.slice(2, 66)}`),
        s = BigInt(`0x${signature.slice(66, 130)}`);
      if (!r || r >= order || !s || s > order / 2n)
        invalid("Use canonical low-s owner signatures.");
      const address = await recoverAddress({ hash: input.digest, signature });
      if (!input.owners.some((owner) => same(owner, address)))
        invalid("A signature is not from a current wallet owner.");
      return { address, signature };
    }),
  );
  signatures.sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
  if (
    new Set(signatures.map(({ address }) => address.toLowerCase())).size !==
    input.threshold
  )
    invalid("Owner signatures must be distinct.");
  return concatHex(signatures.map(({ signature }) => signature));
}

/** EOA signing view, also usable by the passkey profile's independent recovery EOA.
 * Passkey callers use PreparedUserOperation.signing's explicit profile and signedData.
 */
export function ownerOperationSigning(
  input: Safe7579OwnerSigningInput & {
    record: PreparedUserOperation;
    binding: SmartAccountBinding;
  },
): OwnerSigningPayload {
  const { record, binding } = input;
  if (
    record.state !== "prepared" ||
    record.expiresAt <= Date.now() ||
    record.session ||
    !same(record.accountBindingId, binding.id) ||
    !same(record.operation.sender, binding.wallet.address) ||
    !same(record.accountStateHash, binding.state.stateHash) ||
    record.chainId !== binding.wallet.chainId ||
    record.chainId !== input.chainId ||
    !same(record.entryPoint, input.entryPoint) ||
    !same(
      record.operationHash,
      legacyOperationHash(record.operation, record.entryPoint, record.chainId),
    )
  )
    invalid(
      "The owner operation differs from the selected wallet or prepared operation.",
    );
  const payload = safe7579OwnerSigningPayload({
    ...input,
    operation: record.operation,
  });
  if (
    !same(payload.digest, record.signing.digest) ||
    input.validAfter !== String(Math.floor(record.createdAt / 1000)) ||
    input.validUntil !== String(Math.floor(record.expiresAt / 1000))
  )
    invalid("The owner signing window or digest changed.");
  return payload;
}

/** Packs EOA signatures only. WebAuthn assertions require the profile's dynamic contract envelope. */
export async function ownerOperationSignature(
  payload: OwnerSigningPayload,
  binding: SmartAccountBinding,
  signatures: readonly Hex[],
) {
  const packed = await packOwnerSignatures({
    digest: payload.digest,
    owners: binding.state.owners,
    threshold: binding.state.threshold,
    signatures,
  });
  return encodeSafe7579OwnerSignature({
    validAfter: payload.validAfter,
    validUntil: payload.validUntil,
    signatures: packed,
  });
}
export async function signSessionUserOperation(input: {
  record: PreparedUserOperation;
  session: StoredSession;
  signer: {
    address: Address;
    signMessage(input: { message: { raw: Hex } }): Promise<Hex>;
  };
}): Promise<Hex> {
  const { record, session, signer } = input,
    c = session.compiled;
  const now = Math.floor(Date.now() / 1000);
  if (
    session.state !== "active" ||
    !record.session ||
    record.session.id !== session.id ||
    !same(signer.address, c.sessionKey) ||
    !same(record.session.sessionKey, c.sessionKey) ||
    record.session.grantId !== c.grantId ||
    !same(record.session.compiledHash, c.compiledHash) ||
    !same(record.session.permissionId, c.permissionId) ||
    !same(record.accountBindingId, c.bindingId) ||
    record.chainId !== c.chainId ||
    !same(record.operation.sender, c.wallet) ||
    c.validAfter > now ||
    c.validUntil <= now ||
    record.state !== "prepared" ||
    record.expiresAt <= Date.now()
  )
    invalid(
      "This operation is not bound to the active local session key and policy.",
    );
  const payload = legacySessionSigningPayload({
    operation: record.operation,
    chainId: record.chainId,
    entryPoint: record.entryPoint,
    smartSessions: c.smartSessions.address,
    permissionId: c.permissionId,
  });
  if (
    !same(payload.operationHash, record.operationHash) ||
    !same(payload.digest, record.signing.digest)
  )
    invalid("The operation hash changed before signing.");
  const signature = await signer.signMessage({
    message: { raw: payload.operationHash },
  });
  if (
    !same(
      await recoverAddress({ hash: payload.digest, signature }),
      signer.address,
    )
  )
    invalid("The session signer returned the wrong signature.");
  return encodeLegacyUseSignature(c.permissionId, signature);
}
