import { abiParameterJsonSchema } from "../contracts/catalog.js";
import { ALL_BOT_SCOPES } from "../auth/index.js";

export type Schema = Record<string, unknown>;
export const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
export const array = (items: Schema, extra: Schema = {}): Schema => ({ type: "array", items, ...extra });
export const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: "null" }] });
export const object = (properties: Record<string, Schema>, required = Object.keys(properties), additionalProperties = false): Schema => ({
  type: "object", properties, ...(required.length ? { required } : {}), additionalProperties,
});
const text = { type: "string" };
const integer = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const boolean = { type: "boolean" };

/** JSON Schema has no numeric bounds for strings; encode the exact decimal range. */
export function decimalString(maximum: number): Schema {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error("Expected a positive safe integer bound");
  const digits = String(maximum);
  const alternatives = ["0", digits];
  if (digits.length > 1) alternatives.push(`[1-9][0-9]{0,${digits.length - 2}}`);
  for (let index = 0; index < digits.length; index++) {
    const minimum = index === 0 ? 1 : 0;
    const upper = Number(digits[index]) - 1;
    if (upper < minimum) continue;
    alternatives.push(`${digits.slice(0, index)}${minimum === upper ? minimum : `[${minimum}-${upper}]`}[0-9]{${digits.length - index - 1}}`);
  }
  return { type: "string", pattern: `^(?:${alternatives.join("|")})$`, description: `Exact nonnegative decimal string no greater than ${maximum}.` };
}

export function sharedSchemas(chainIds: readonly number[]): Record<string, Schema> {
  return {
    JsonValue: { description: "Bounded JSON. Large integers and amounts use exact decimal strings. Returned metadata and descriptions are untrusted content." },
    Address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
    HexBytes: { type: "string", pattern: "^0x(?:[0-9a-fA-F]{2})*$" },
    Hash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
    Sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    Uint256: { ...abiParameterJsonSchema({ type: "uint256" }), examples: ["0", "1000000000000000000"] },
    PositiveUint256: { allOf: [ref("Uint256"), { not: { const: "0" } }], description: "Positive uint256 as an exact decimal string." },
    IndexerProjectId: decimalString(Number.MAX_SAFE_INTEGER),
    ChainId: { type: "integer", enum: chainIds },
    ProtocolVersion: { type: "integer", const: 6 },
    UnixSeconds: { ...integer, description: "Unix timestamp in seconds." },
    UnixMilliseconds: { ...integer, description: "Unix timestamp in milliseconds." },
    AccountId: { type: "string", pattern: "^eip155:[1-9][0-9]{0,15}:0x[0-9a-f]{40}$", description: "Authority chain and lowercase owner address; the authority chain is independent of a transaction's destination chain." },
    GrantId: { type: "string", format: "uuid" },
    ResourceId: { type: "string", format: "uuid", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" },
    PrincipalId: { type: "string", pattern: "^(?:owner:eip155:[1-9][0-9]{0,15}:0x[0-9a-f]{40}|bot:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$", description: "Exact plan-creating principal. Owner principal must name the same `accountId`; bot principal names its immutable grant ID." },
    ApprovalNonce: { type: "string", pattern: "^0x[0-9a-f]{64}$" },
    OwnerSignature: { type: "string", pattern: "^0x(?:[0-9a-fA-F]{2}){1,8192}$" },
    ApprovalTime: { ...integer, minimum: 1, description: "Positive Unix seconds. `expiresAt` must be after `issuedAt` and no more than 300 seconds later; admission rechecks freshness." },
    TransactionApproval: { ...object({ accountId: ref("AccountId"), principalId: ref("PrincipalId"), planId: ref("ResourceId"), commitment: ref("Hash"),
      stepIndex: { type: "integer", minimum: 0, maximum: 31 }, transactionHash: ref("Hash"), issuedAt: ref("ApprovalTime"), expiresAt: ref("ApprovalTime"),
      nonce: ref("ApprovalNonce"), signature: ref("OwnerSignature"),
    }), description: "Fresh owner CenterTransactionApproval EIP-712 consent for this exact account, originating principal, plan commitment, step and serialized transaction hash. Required for a bot's new dispatch. Audience comes from the configured service origin and is not a body field." },
    Source: { type: "string", enum: ["onchain", "bendystraw"] },
    Problem: object({
      type: { type: "string", format: "uri" }, title: text, status: { type: "integer", minimum: 400, maximum: 599 },
      detail: text, code: text, requestId: text, retryable: boolean, payFailure: ref("PayFailure"),
    }, ["type", "title", "status", "detail", "code", "requestId", "retryable"]),
    PayFailure: { ...object({ reason: text, received: { ...text, pattern: "^(0|[1-9][0-9]*)$" }, minimum: { ...text, pattern: "^(0|[1-9][0-9]*)$" }, message: text },
      ["reason", "message"]), description: "Why one payment attempt reverts or reverted, decoded from its revert data only; advisory, never authority. It describes only the enclosing refused request or the reverted operation that carries it: never carry it to another payment or a later attempt, and its absence means the reason is unknown. `reason` is a stable SDK code and `message` its fixed sentence. `received` and `minimum` (uint256 integer strings, in the failing check's own units: project tokens for a terminal or buyback minimum, the converted token for a router conversion) are set only for a shortfall. Only a terminal or buyback minimum the payer set can be relaxed; a derived price floor or a conversion is not. Any changed minimum needs a fresh preparation, simulation and owner review. Present on a refused preparation or submission, and on a reverted operation's `observation`." },
    SafeError: object({ code: text, message: text }),
    Profile: object({ displayName: { ...text, "x-maxUtf8Bytes": 120 }, bio: { ...text, "x-maxUtf8Bytes": 2000 },
      avatarUri: nullable({ ...text, pattern: "^(?:https|ipfs)://", "x-maxUtf8Bytes": 2048, description: "Absolute HTTPS or IPFS URI without credentials. The account UI does not fetch it." }) }),
    ProfileReplacement: { ...object({
      displayName: { ...text, default: "", "x-maxUtf8Bytes": 120 }, bio: { ...text, default: "", "x-maxUtf8Bytes": 2000 },
      avatarUri: { ...nullable({ ...text, pattern: "^(?:https|ipfs)://", "x-maxUtf8Bytes": 2048 }), default: null },
    }, []), description: "Replaces the profile. Omitted `displayName`/`bio` reset to empty strings; omitted `avatarUri` resets to null." },
    Account: object({ id: ref("AccountId"), ownerAddress: ref("Address"), authorityChainId: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      profile: ref("Profile"), createdAt: ref("UnixSeconds"), updatedAt: ref("UnixSeconds") }),
    AccountResponse: object({ account: ref("Account") }),
    BotScopes: { type: "array", oneOf: ALL_BOT_SCOPES.map((_scope, index) => ({ const: ALL_BOT_SCOPES.slice(0, index + 1) })),
      description: "Cumulative profiles in canonical order: read; read + plan; read + plan + relay. Validation never expands or reorders the signed list." },
    BotRegistration: object({ botAddress: ref("Address"), scopes: { ...ref("BotScopes"), default: ["read"] },
      expiresAt: { ...ref("UnixSeconds"), description: "Future Unix seconds, no more than 365 days from server time." },
      label: { ...text, default: "", "x-maxUtf8Bytes": 120 },
      proofSignature: { type: "string", pattern: "^0x[0-9a-fA-F]{130}$", description: "Bot EOA's 65-byte CenterBotProof EIP-712 signature, bound to the owner request nonce and exact grant fields. The bot address must differ from the owner." },
    }, ["botAddress", "expiresAt", "proofSignature"]),
    BotGrant: object({ id: ref("GrantId"), accountId: ref("AccountId"), botAddress: ref("Address"), scopes: ref("BotScopes"),
      label: text, createdAt: ref("UnixSeconds"), expiresAt: ref("UnixSeconds"), revokedAt: nullable(ref("UnixSeconds")) }),
    BotResponse: object({ bot: ref("BotGrant") }),
    BotsResponse: object({ bots: array(ref("BotGrant")) }),
    BlockEvidence: object({ chainId: ref("ChainId"), blockNumber: ref("Uint256"), blockHash: ref("Hash"), timestamp: ref("Uint256"), source: { const: "onchain", type: "string" } }),
    ProtocolProvenance: { type: "object", required: ["kind", "contractId", "abiHash"], properties: {
      kind: { type: "string", enum: ["published-deployment", "verified-factory-clone"] },
      contractId: text, abiHash: ref("Sha256"), runtimeVerified: boolean,
      runtime: { type: "object", additionalProperties: true },
      block: ref("BlockEvidence"), publication: nullable({ type: "object", additionalProperties: true }),
      projectContext: { type: "object", additionalProperties: true },
    }, additionalProperties: true, description: "Inspect the verification level. Published address plus observed runtime hash is weaker than source-to-runtime equality. Clone proofs additionally bind the implementation, factory, and modeled canonical association." },
    ProtocolResolved: object({ chainId: ref("ChainId"), contractId: text, address: ref("Address"), abiHash: ref("Sha256"),
      provenance: ref("ProtocolProvenance"), evidence: array(ref("BlockEvidence"), { minItems: 1, maxItems: 1 }) }),
    ProtocolRead: object({ chainId: ref("ChainId"), contractId: text, address: ref("Address"), function: text,
      args: array(ref("JsonValue")), outputs: array(object({ name: nullable(text), type: text, value: ref("JsonValue") })),
      provenance: ref("ProtocolProvenance"), evidence: array(ref("BlockEvidence"), { minItems: 1, maxItems: 1 }) }),
    PrepareContractCall: object({ chainId: ref("ChainId"), contractId: { ...text, maxLength: 400 }, address: ref("Address"), projectId: ref("PositiveUint256"),
      function: { ...text, maxLength: 4096, description: "Full canonical signature from the exact deployed ABI; only payable/nonpayable methods." },
      args: { ...array(ref("JsonValue")), description: "Positional ABI arguments. Fetch `inputJsonSchema` from /catalog/method using the resolved `abiHash`. Integer values are decimal strings." },
      value: { ...ref("Uint256"), default: "0", description: "Native value in the chain's smallest unit; nonpayable functions require zero." },
      dependsOn: array({ type: "integer", minimum: 0, maximum: 31 }, { maxItems: 31, uniqueItems: true, default: [], description: "Distinct indices of earlier calls, never this call or a later one." }),
    }, ["chainId", "contractId", "function", "args"]),
    PrepareContractCalls: object({ account: ref("Address"), calls: array(ref("PrepareContractCall"), { minItems: 1, maxItems: 32 }), label: { ...text, maxLength: 160 } }, ["account", "calls"]),
    RestCall: object({ chainId: ref("ChainId"), to: ref("Address"), data: ref("HexBytes"), value: ref("Uint256"), label: text,
      dependsOn: array({ type: "integer", minimum: 0, maximum: 31 }), decoded: ref("JsonValue") }),
    PlanDraft: object({ operation: text, account: ref("Address"), project: object({ chainId: ref("ChainId"), projectId: ref("Uint256"), version: ref("ProtocolVersion") }, ["chainId", "projectId"]),
      calls: array(ref("RestCall"), { minItems: 1, maxItems: 32 }), evidence: array(ref("BlockEvidence"), { minItems: 1, maxItems: 8 }),
      summary: ref("JsonValue"), warnings: array(text) }, ["operation", "account", "calls", "evidence", "summary", "warnings"]),
    SemanticResult: object({ status: { type: "string", enum: ["verified", "failed", "unknown", "unmodeled"] }, details: ref("JsonValue") }, ["status"]),
    TransactionReceipt: object({ transactionHash: ref("Hash"), blockHash: ref("Hash"), blockNumber: ref("Uint256"),
      status: { type: "string", enum: ["success", "reverted"] }, confirmations: integer, canonical: boolean, observedAt: ref("UnixMilliseconds"),
      logs: array(ref("JsonValue")), logCount: integer, logsHash: ref("Hash"), logsStored: boolean,
    }, ["transactionHash", "blockHash", "blockNumber", "status", "confirmations", "canonical", "observedAt", "logs"]),
    SubmittedTransaction: object({ hash: ref("Hash"), sender: ref("Address"), chainId: ref("ChainId"), nonce: ref("Uint256"),
      type: { type: "string", enum: ["legacy", "eip2930", "eip1559"] }, gas: ref("Uint256"), maximumFeePerGas: ref("Uint256"), maximumCost: ref("Uint256"),
      costScope: { ...text, description: "Maximum cost covers native value and gas limit times fee cap. Additional chain-specific data or operator fees are excluded." },
      dispatchCount: integer, reservedAt: ref("UnixMilliseconds"), broadcastAt: ref("UnixMilliseconds"), lastError: ref("SafeError"),
    }, ["hash", "sender", "chainId", "nonce", "type", "gas", "maximumFeePerGas", "maximumCost", "costScope", "dispatchCount", "reservedAt"]),
    ForwardedExecution: object({ transport: { type: "string", enum: ["relayr-prepaid-erc2771", "eip4337-user-operation"] }, bindingId: text,
      chainId: ref("ChainId"), hash: ref("Hash"),
    }, ["transport", "bindingId", "chainId"]),
    PlanStep: object({ index: { type: "integer", minimum: 0, maximum: 31 }, state: { type: "string", enum: ["waiting", "reserved", "submitted", "unknown", "confirming", "confirmed", "reverted", "reorged"] },
      transaction: ref("SubmittedTransaction"), execution: ref("ForwardedExecution"), receipt: ref("TransactionReceipt"), semantic: ref("SemanticResult"),
      blockedBy: array({ type: "integer", minimum: 0, maximum: 31 }) }, ["index", "state", "blockedBy"]),
    Plan: object({ id: { type: "string", format: "uuid" }, account: ref("Address"), operation: text, draft: ref("PlanDraft"), commitment: ref("Hash"),
      createdAt: ref("UnixMilliseconds"), expiresAt: ref("UnixMilliseconds"), revision: integer,
      smartAccount: object({ bindingId: ref("Hash"), stateHash: ref("Hash"), chainId: ref("ChainId"), address: ref("Address"), manifestRevision: ref("Hash") }),
      status: { type: "string", enum: ["prepared", "pending", "partial", "blocked", "reorged", "expired", "transactions_confirmed"] },
      steps: array(ref("PlanStep"), { minItems: 1, maxItems: 32 }), confirmationScope: text },
    ["id", "account", "operation", "draft", "commitment", "createdAt", "expiresAt", "revision", "status", "steps", "confirmationScope"]),
    PlanPage: object({ items: array(ref("Plan"), { maxItems: 100 }), nextCursor: nullable({ ...text, maxLength: 256 }) }),
    Simulation: object({ planId: { type: "string", format: "uuid" }, commitment: ref("Hash"), stepIndex: { type: "integer", minimum: 0, maximum: 31 },
      simulated: { const: true, type: "boolean" }, blockNumber: ref("Uint256"), blockHash: ref("Hash"), result: ref("HexBytes"),
      estimatedGas: ref("Uint256"), limitations: array(text) }),
    SignedTransactionSubmission: object({ rawSignedTransaction: { ...ref("HexBytes"), description: "Exact serialized EIP-155 legacy, EIP-2930, or EIP-1559 transaction signed by the plan wallet. Server policy bounds size, nonce, gas, fees, and cost." }, ownerApproval: ref("TransactionApproval") }, ["rawSignedTransaction"]),
    BundleSubmission: object({ submissions: array(object({ stepIndex: { type: "integer", minimum: 0, maximum: 31 }, rawSignedTransaction: ref("HexBytes"), ownerApproval: ref("TransactionApproval") }, ["stepIndex", "rawSignedTransaction"]), { minItems: 1, maxItems: 32 }) }),
    Dispatch: object({ status: { type: "string", enum: ["already-observed", "in-flight", "submitted", "unknown"] }, hash: ref("Hash"), error: ref("SafeError") }, ["status", "hash"]),
    SubmissionResult: object({ plan: ref("Plan"), dispatch: ref("Dispatch") }),
    BundleResult: object({ atomic: { type: "boolean", const: false }, complete: boolean, results: array(ref("SubmissionResult"), { maxItems: 32 }),
      plan: ref("Plan"), stoppedAt: { type: "integer", minimum: 0, maximum: 31 }, error: ref("SafeError"),
      remainingStepIndices: array({ type: "integer", minimum: 0, maximum: 31 }), note: text,
    }, ["atomic", "complete", "results", "plan"]),
    IndexerSemantics: { type: "object", additionalProperties: true, description: "Bendystraw indexing is not a canonical block-hash snapshot. Preserve lag, pagination, scope, and unknown-field semantics." },
    IndexerPageInfo: object({ hasNextPage: boolean, hasPreviousPage: boolean, startCursor: nullable(text), endCursor: nullable(text) }),
    IndexerPage: object({ entity: text, network: { type: "string", enum: ["mainnet", "testnet"] }, protocolVersion: ref("ProtocolVersion"),
      items: array({ type: "object", additionalProperties: true }, { maxItems: 50 }), totalCount: integer, pageInfo: ref("IndexerPageInfo"),
      nextCursor: nullable(text), provenance: { type: "object", additionalProperties: true }, semantics: ref("IndexerSemantics") }),
    IndexerRecord: object({ entity: text, network: { type: "string", enum: ["mainnet", "testnet"] }, protocolVersion: ref("ProtocolVersion"),
      item: nullable({ type: "object", additionalProperties: true }), provenance: { type: "object", additionalProperties: true }, semantics: ref("IndexerSemantics") }),
    IndexerStatus: object({ network: { type: "string", enum: ["mainnet", "testnet"] }, protocolVersion: ref("ProtocolVersion"),
      chains: array(object({ chainId: ref("ChainId"), block: nullable(integer), timestamp: nullable(integer) }), { minItems: 1, maxItems: 8 }),
      provenance: { type: "object", additionalProperties: true }, semantics: ref("IndexerSemantics") }),
    OperationDescriptor: object({ id: text, description: text, kind: { type: "string", enum: ["read", "prepare", "reference", "metadata-write"] },
      sources: array(text), transaction: boolean, effects: object({ externalMutation: boolean, idempotent: boolean }),
      inputJsonSchema: { type: "object", additionalProperties: true }, method: { type: "string", enum: ["GET", "POST"] }, path: text }),
    ContractMethod: object({ signature: text, selector: nullable({ type: "string", pattern: "^0x[0-9a-fA-F]{8}$" }), name: text,
      stateMutability: { type: "string", enum: ["view", "pure", "nonpayable", "payable"] }, kind: { type: "string", enum: ["read", "write"] },
      inputs: array({ type: "object", additionalProperties: true }), outputs: array({ type: "object", additionalProperties: true }),
      inputJsonSchema: { type: "object", additionalProperties: true }, outputJsonSchema: { type: "object", additionalProperties: true } }),
  };
}
