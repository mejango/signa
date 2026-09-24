import type { ProtocolOperations } from "@juicebox/mcp/host";
import { operationDescriptors } from "../app.js";
import { ALL_BOT_SCOPES, REST_AUTH_HEADERS } from "../auth/index.js";
import type { ContractCatalog } from "../contracts/catalog.js";
import { REST_LIMITS, REST_PREFIX } from "../http.js";
import { INDEXER_SCHEMA } from "../indexer/generated.js";
import { INDEXER_LIMITS, type IndexerReadService } from "../indexer/index.js";
import { array, decimalString, nullable, object, ref, sharedSchemas, type Schema } from "./schemas.js";
import { sponsorshipSchemas } from "./sponsorship.js";
import { smartAccountSchemas } from "./smartAccounts.js";
import { sessionSchemas } from "./sessions.js";
import { walletPaymentSchemas } from './walletPayments.js';

export type OpenApiOperation = Record<string, unknown> & {
  operationId: string; summary: string; tags: string[];
  responses: Record<string, unknown>;
};
export interface OpenApiDocument {
  openapi: "3.1.2";
  jsonSchemaDialect: string;
  info: Record<string, unknown>;
  servers: { url: string }[];
  tags: { name: string; description: string }[];
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: { schemas: Record<string, Schema>; parameters: Record<string, Schema>; responses: Record<string, Schema> };
  [key: `x-${string}`]: unknown;
}
export interface BuildRestOpenApiInput {
  contracts: Pick<ContractCatalog, "data">;
  indexer: Pick<IndexerReadService, "catalog">;
  operations: ProtocolOperations;
  publicOrigin: string;
  surface?: "wallet";
}
type Access = "public" | "owner" | "read" | "plan" | "relay";
type Parameter = Record<string, unknown>;
const text: Schema = { type: "string" };
const uint = (maximum = Number.MAX_SAFE_INTEGER): Schema => ({ type: "integer", minimum: 0, maximum });
const queryParameter = (name: string, schema: Schema, required = false, description?: string): Parameter => ({
  name, in: "query", required, schema, ...(description ? { description } : {}),
});
const jsonParameter = (name: string, schema: Schema, required = false, description?: string): Parameter => ({
  name, in: "query", required, content: { "application/json": { schema } },
  description: `${description ? `${description} ` : ""}Serialize as JSON once, percent-encode the query value, then sign the exact resulting request target.`,
});
const pathParameter = (name: string, schema: Schema): Parameter => ({ name, in: "path", required: true, schema });
const componentParameter = (name: string): Parameter => ({ $ref: `#/components/parameters/${name}` });

/** Convert the descriptor's draft-7 input dialect without changing its validation. */
function modernSchema(value: unknown, schemaName: string): unknown {
  if (Array.isArray(value)) return value.map((item) => modernSchema(item, schemaName));
  if (value === null || typeof value !== "object") return value;
  const original = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(original)) {
    if (key === "$schema") continue;
    if (key === "definitions") result.$defs = modernSchema(item, schemaName);
    else if (key === "$ref" && typeof item === "string") result.$ref = item.startsWith("#/")
      ? `#/components/schemas/${schemaName}/${item.slice(2).replace(/^definitions\//, "$defs/")}` : item;
    else if (key === "items" && Array.isArray(item)) {
      result.prefixItems = item.map((entry) => modernSchema(entry, schemaName));
      result.items = original.additionalItems === undefined ? true : modernSchema(original.additionalItems, schemaName);
    } else if (key !== "additionalItems" || !Array.isArray(original.items)) result[key] = modernSchema(item, schemaName);
  }
  return result;
}

export function buildRestOpenApi({ contracts, indexer, operations, publicOrigin, surface }: BuildRestOpenApiInput): OpenApiDocument {
  const parsed = new URL(publicOrigin);
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/"
    || !(parsed.protocol === "https:" || parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))) {
    throw new Error("REST documentation needs a public HTTPS origin or local HTTP origin");
  }
  const origin = parsed.origin;
  const catalog = indexer.catalog();
  const wallet = surface === "wallet";
  const descriptors = operationDescriptors(operations).filter(item => !wallet || item.transaction);
  const schemas = { ...sharedSchemas(contracts.data.chains.map((chain) => chain.id)), ...sponsorshipSchemas(), ...smartAccountSchemas(), ...sessionSchemas(), ...walletPaymentSchemas() };
  const parameters: Record<string, Schema> = {};
  const header = (key: keyof typeof REST_AUTH_HEADERS, schema: Schema, description: string, required: boolean) => {
    parameters[key] = { name: REST_AUTH_HEADERS[key], in: "header", required, schema, description };
  };
  header("account", ref("AccountId"), "Enrolled account identity, including authority chain and lowercase owner address. Enrollment derives this identity before the account exists.", true);
  header("signer", ref("Address"), "Owner wallet or authorized bot address that signed this request.", true);
  header("issuedAt", { type: "integer", minimum: 1, maximum: 9999999999999 }, "Unix seconds, sent as 1–13 decimal digits without leading zeros; at most 30 seconds ahead of server time.", true);
  header("expiresAt", { type: "integer", minimum: 1, maximum: 9999999999999 }, "Unix seconds, sent as 1–13 decimal digits without leading zeros; in the future and within 300 seconds of issuedAt.", true);
  header("nonce", { type: "string", pattern: "^0x[0-9a-f]{64}$" }, "Fresh random 32-byte lowercase nonce. A consumed nonce cannot be retried.", true);
  header("signature", { type: "string", pattern: "^0x(?:[0-9a-fA-F]{2}){1,8192}$" }, "EIP-712 CenterRequest signature over every signed field. Contract-owner signatures may vary in length. This is a computed request proof, not a reusable API key.", true);
  header("grant", { type: "string", pattern: "^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?$" }, "Authorized bot grant ID. Required for a bot; omit for the owner, signing grantId as the empty string.", false);
  header("idempotencyKey", { ...text, pattern: "^[A-Za-z0-9._:-]{0,128}$" }, "Signed retry identity. Required on plan creation and transaction submission. Preserve exact method, target, Content-Type, and body bytes; use a fresh request nonce and signature.", false);
  parameters.idempotencyRequired = { ...parameters.idempotencyKey, required: true, schema: { type: "string", pattern: "^[A-Za-z0-9._:-]{1,128}$" } };
  const requestHeaders = ["account", "signer", "issuedAt", "expiresAt", "nonce", "signature", "grant"];
  const responseHeaders = {
    "X-Request-Id": { schema: text, description: "Correlates this response with a problem report." },
    "Retry-After": { schema: text, description: "Present on HTTP 429; wait this many seconds before a bounded retry." },
    "RateLimit-Limit": { schema: uint(), description: "Account request quota where applied." },
    "RateLimit-Remaining": { schema: uint(), description: "Remaining account quota where applied." },
  };
  const problemResponse = { description: "RFC 9457 problem details. Branch on code and retryable; preserve `requestId`. Never parse the human detail string for control flow.",
    headers: responseHeaders, content: { "application/problem+json": { schema: ref("Problem") } } };
  const document: OpenApiDocument = {
    openapi: "3.1.2", jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    info: { title: "Juicebox Center REST API", version: "1.0.0", summary: "V6 contract, project, indexer, account and transaction access",
      description: "Public discovery and catalogs; independently EIP-712 signed live reads and writes. Request authentication is a custom multi-header scheme described by required header parameters and x-auth. Account onboarding instead requires purpose-specific body signatures described by x-body-approval. Wallet transaction signatures remain separate. Success bodies are route-specific JSON, not a universal wrapper.",
      contact: { url: "https://github.com/mejango/jbcenter" } },
    servers: [{ url: origin }],
    tags: [
      { name: "Discovery", description: "Public, pinned schemas and current capability discovery." },
      { name: "Accounts", description: "Owner enrollment, profile replacement and bounded bot API grants." },
      { name: "Contracts", description: "Exact V6 deployment ABI resolution and canonical onchain reads." },
      { name: "Indexer", description: "V6 Bendystraw state and event tables with explicit network and cursor scope." },
      { name: "Projects", description: "Project and omnichain views with explicit source selection." },
      { name: "Operations", description: "Semantic reads and preparations generated from the shared operation descriptors." },
      { name: "Transactions", description: "Durable reviewed plans, simulation, exact signed transaction relay and reconciliation." },
      { name: "Sponsorship", description: "Prepaid transaction bundles, explicit owner forwarding consent, reviewed funding plans and exact destination execution evidence." },
      { name: "Wallets", description: "Reviewed Safe creation calldata, owner-threshold binding and smart-account transaction plans. Availability depends on current verified manifests." },
      { name: "Sessions", description: "Immutable seven- or thirty-day policies, owner activation/revocation plans and canonical onchain quota observations." },
      { name: "UserOperations", description: "Reviewed EntryPoint v0.7 preparation, external owner or session-key signatures, one-time provider publication and reconciliation." },
      { name: 'WalletPayments', description: 'Exact passkey payment reviews for typed trusted-app grants; available only with explicit pilot configuration.' },
    ],
    paths: {}, components: { schemas, parameters, responses: { Problem: problemResponse } },
    "x-auth": {
      scheme: "eip712-request-signature", standardWireProtocol: false,
      audience: origin, primaryType: "CenterRequest",
      domain: { name: "Juicebox Center REST", version: "1", chainId: "account authority chain", salt: "keccak256(UTF8(audience))" },
      signedFields: ["audience", "accountId", "signer", "grantId", "method", "requestTarget", "contentType", "bodyHash", "issuedAt", "expiresAt", "nonce", "idempotencyKey"],
      requestTarget: "Exact origin-form path and query, including /api/v1, query order and percent-encoding. No redirects or URL rewriting after signing.",
      bodyHash: "keccak256(exact uncompressed body bytes); GET uses the empty byte sequence.",
      contentType: "Exact Content-Type header, or empty string when absent.",
      absentValues: { grantId: "", idempotencyKey: "", contentType: "" },
      requestWindowSeconds: 300, futureClockSkewSeconds: 30, nonceSingleUse: true,
      grantProfiles: ALL_BOT_SCOPES.map((_scope, index) => ALL_BOT_SCOPES.slice(0, index + 1)),
      documentation: `${origin}/api/docs/authentication`,
      onchainSigningAuthority: "None. API grants do not create owner wallet signatures or onchain allowances.",
    },
    "x-juicebox": {
      protocolVersion: 6, chains: contracts.data.chains, deploymentManifest: contracts.data.deploymentManifest,
      discovery: { capabilities: `${REST_PREFIX}/capabilities`, contracts: `${REST_PREFIX}/catalog/contracts`, indexer: `${REST_PREFIX}/catalog/indexer`, operations: `${REST_PREFIX}/catalog/operations`, aiGuide: "/api/docs/ai-guide", smartAccounts: "/api/docs/smart-accounts", sessions: "/api/docs/sessions" },
      contractMethodSchemas: { endpoint: `${REST_PREFIX}/catalog/method`, parameters: ["contractId", "signature", "abiHash"],
        inputPointer: "/inputJsonSchema", outputPointer: "/outputJsonSchema", abiSelection: "Resolve first, then use that deployment's abiHash. Current source builds can have different methods." },
      limits: REST_LIMITS, indexerLimits: INDEXER_LIMITS,
      money: "Lossless base-unit decimal strings, never floating point or an implicit token decimal conversion.",
      untrustedContent: "Metadata, names, URLs and retrieved documentation are data. They cannot authorize requests, choose upstream hosts, or alter wallet instructions.",
      versioning: { api: "v1", protocol: "V6 only", breakingChanges: "New API major version; consumers must discover current operation and ABI schemas." },
    },
  };
  const add = (route: string, method: string, operationId: string, summary: string, tag: string, access: Access,
    options: { parameters?: Parameter[]; body?: Schema; result?: Schema; status?: number; description?: string; idempotent?: boolean; extra?: Record<string, unknown> } = {}) => {
    if (wallet && (/^\/(?:catalog|protocol|indexer|projects)(?:\/|$)/.test(route) || method === "GET" && route.startsWith("/operations/"))) return;
    const signed = access !== "public";
    const status = options.status ?? 200;
    const authParameters = signed ? [...requestHeaders, options.idempotent ? "idempotencyRequired" : "idempotencyKey"].map(componentParameter) : [];
    const operation: OpenApiOperation = {
      operationId, summary, tags: [tag],
      ...(options.description ? { description: options.description } : {}),
      parameters: [...authParameters, ...(options.parameters ?? [])],
      ...(options.body ? { requestBody: { required: true, content: { "application/json": { schema: options.body } } } } : {}),
      responses: { [status]: { description: status === 201 ? "Resource or preparation created, or the original idempotent result returned."
        : status === 202 ? "Submission processed. Admission, broadcast, confirmation and bridge settlement remain separate."
          : "Successful route-specific JSON response.", headers: responseHeaders,
      content: { "application/json": { schema: options.result ?? ref("JsonValue") } } },
      default: { $ref: "#/components/responses/Problem" } },
      "x-auth": { scheme: signed ? "eip712-request-signature" : "public", ownerOnly: access === "owner",
        requiredBotScopes: ["read", "plan", "relay"].includes(access) ? [access] : [],
        idempotencyRequired: Boolean(options.idempotent) },
      ...(signed ? {} : { security: [] }),
      ...options.extra,
    };
    // Hono joins a mounted root route to the mount itself, without a trailing slash.
    const path = route === "/" ? REST_PREFIX : `${REST_PREFIX}${route}`;
    document.paths[path] ??= {};
    document.paths[path]![method.toLowerCase()] = operation;
  };
  add("/", "GET", "apiDiscovery", "Find API entry points", "Discovery", "public", { result: object({ version: { const: "1" }, protocolVersion: ref("ProtocolVersion"), documentation: text, openapi: text, accounts: text, capabilities: text,
    ...(wallet ? { protocolReference: { type: "string", const: "https://juicebox.center/api" } } : {}) }) });
  add("/openapi.json", "GET", "getOpenApi", "Read this OpenAPI 3.1.2 document", "Discovery", "public", { result: { type: "object", required: ["openapi", "info", "paths"], additionalProperties: true } });
  add("/capabilities", "GET", "getCapabilities", "Check enabled transports, chains and limits", "Discovery", "public", {
    description: "Read before planning. Per-chain relay, confirmation and sponsorship availability is runtime configuration. Unsupported smart-account or session mechanisms are not implied by a bot grant.",
    result: object({ version: { const: "1" }, protocolVersion: ref("ProtocolVersion"), audience: { type: "string", format: "uri" },
      authentication: { type: "object", additionalProperties: true }, chains: array({ type: "object", additionalProperties: true }), limits: { type: "object", additionalProperties: true },
      transactions: { type: "object", additionalProperties: true }, sponsorship: { type: "object", additionalProperties: true },
      userOperations: { anyOf: [ref("UserOperationCapabilities"), object({ state: { type: "string", const: "unavailable" } })] },
      sessions: { anyOf: [ref("SessionCapabilities"), object({ state: { type: "string", const: "unavailable" } })] },
      smartAccounts: { anyOf: [ref("SmartAccountCapabilities"), object({ state: { type: "string", const: "unavailable" } })] },
      ...(wallet ? { protocolReference: { type: "string", const: "https://juicebox.center/api" } }
        : { omnichain: { type: "object", additionalProperties: true }, sources: { type: "object", additionalProperties: true }, catalogs: { type: "object", additionalProperties: true } }) },
    ["version", "protocolVersion", "audience", "authentication", "chains", "limits", "transactions", "sponsorship", "userOperations", "sessions", "smartAccounts", ...(wallet ? ["protocolReference"] : ["omnichain", "sources", "catalogs"])]),
  });
  add("/catalog/contracts", "GET", "listContracts", "Browse the complete pinned V6 contract inventory", "Discovery", "public", {
    parameters: [queryParameter("packageId", { ...text, enum: contracts.data.packages.map((item) => item.id) }),
      queryParameter("category", { type: "string", enum: ["contract", "abstract", "interface", "library", "script"] }),
      queryParameter("chainId", ref("ChainId")), queryParameter("deployedOnly", { type: "boolean", default: false }), queryParameter("executableOnly", { type: "boolean", default: false }),
      queryParameter("offset", { ...uint(100000), default: 0 }), queryParameter("limit", { type: "integer", minimum: 1, maximum: 100, default: 25 })],
    result: object({ protocolVersion: ref("ProtocolVersion"), provenance: { type: "object", additionalProperties: true }, packages: array({ type: "object", additionalProperties: true }),
      exclusions: array(object({ path: text, reason: text })), items: array(object({ id: text, name: text, packageId: text, category: text, executable: { type: "boolean" },
        methodCounts: object({ read: uint(), write: uint() }), chains: array(object({ chainId: ref("ChainId"), status: { type: "string", enum: ["published", "missing"] }, addresses: array(ref("Address")),
          instances: array(object({ address: ref("Address"), retired: { type: "boolean", description: "Historical artifact retained for decoding; not a default destination." },
            generation: { type: "string", enum: ["current", "previous", "v1"], description: "Router/buyback release generation, independent of chain or project migration." } }, ["address", "retired"])) })) })),
      total: uint(), nextOffset: nullable(uint()) }),
  });
  add("/catalog/contract", "GET", "getContractCatalogEntry", "Read all ABI variants, methods and deployments of one contract type", "Discovery", "public", {
    parameters: [queryParameter("id", text, true, "Qualified package:source-path:contract-name ID from /catalog/contracts.")],
    result: { type: "object", required: ["id", "packageId", "sourcePath", "name", "category", "executable", "abi", "abiHash", "methods", "variants", "deployments", "cloneFamilies"], additionalProperties: true },
  });
  add("/catalog/method", "GET", "getContractMethodSchema", "Read exact method argument and output JSON schemas", "Discovery", "public", {
    parameters: [queryParameter("contractId", text, true), queryParameter("signature", text, true, "Full canonical signature, including expanded tuple types."), queryParameter("abiHash", ref("Sha256"), false, "Use the resolved deployment ABI hash; omission selects the catalog default.")],
    result: ref("ContractMethod"),
  });
  add("/catalog/indexer", "GET", "getIndexerCatalog", "Discover V6 tables, filters and selectable fields", "Discovery", "public", { result: { type: "object", required: ["protocolVersion", "source", "limits", "networks", "semantics", "entities", "metadata"], additionalProperties: true } });
  add("/catalog/operations", "GET", "listOperationDescriptors", "Discover semantic operations and exact input schemas", "Discovery", "public", { result: object({ operations: array(ref("OperationDescriptor")) }) });
  add("/catalog/operations/{id}", "GET", "getOperationDescriptor", "Read one semantic operation descriptor", "Discovery", "public", {
    parameters: [pathParameter("id", { ...text, enum: descriptors.map((item) => item.id) })], result: ref("OperationDescriptor"),
  });

  add("/accounts/enroll", "POST", "enrollAccount", "Enroll the signing owner account", "Accounts", "owner", { body: object({}), result: ref("AccountResponse"),
    description: "Sign before the account exists. Body is exactly an empty JSON object. Enrollment uses the owner's EIP-712 request signature and performs no blockchain transaction. Account routes reject query strings and cap bodies at 65536 bytes." });
  add("/accounts/me", "GET", "getAccount", "Read the authenticated account profile", "Accounts", "read", { result: ref("AccountResponse") });
  add("/accounts/me", "PATCH", "replaceProfile", "Replace the owner's profile fields", "Accounts", "owner", { body: ref("ProfileReplacement"), result: ref("AccountResponse"), description: "Omitted fields reset to defaults. This endpoint does not implement transaction idempotency." });
  add("/accounts/me/bots", "GET", "listBots", "List the owner's API bot grants", "Accounts", "owner", { result: ref("BotsResponse") });
  add("/accounts/me/bots", "POST", "registerBot", "Register a bot possession proof and expiring API grant", "Accounts", "owner", { body: ref("BotRegistration"), result: ref("BotResponse"), status: 201,
    description: "The owner signs the whole registration request; the bot separately signs CenterBotProof bound to that owner's request nonce. Grants authorize API scopes only. No bot key is uploaded." });
  add("/accounts/me/bots/{grantId}", "DELETE", "revokeBot", "Revoke the owner's bot grant", "Accounts", "owner", { parameters: [pathParameter("grantId", ref("GrantId"))], result: ref("BotResponse"),
    description: "Revocation prevents new dispatch claims. A bounded request already admitted under its durable claim may finish." });

  const resolveParameters = [queryParameter("chainId", ref("ChainId"), true), queryParameter("contractId", text, true), queryParameter("address", ref("Address")),
    queryParameter("projectId", ref("PositiveUint256"), false, "Positive project ID when supported by the canonical association adapter."), queryParameter("blockNumber", ref("Uint256"))];
  add("/protocol/resolve", "GET", "resolveContract", "Resolve a V6 target and inspect its provenance", "Contracts", "read", { parameters: resolveParameters, result: ref("ProtocolResolved"),
    description: "The chain and mined canonical block hash are verified. Unknown addresses require a supported factory and canonical association proof. Source-only catalog entries do not establish deployments." });
  add("/protocol/read", "GET", "readContract", "Call an exact view or pure method on a verified V6 target", "Contracts", "read", {
    parameters: [...resolveParameters, queryParameter("function", text, true, "Full canonical function signature from the resolved deployment ABI."), jsonParameter("args", array(ref("JsonValue")), true, "Positional arguments validated against the exact ABI.")],
    result: ref("ProtocolRead"), description: "The same canonical block hash is used for resolution and the ABI call. Payable/nonpayable methods are rejected here; prepare them as reviewed calls.",
  });

  const network = queryParameter("network", { type: "string", enum: ["mainnet", "testnet"] }, true);
  const indexerScope = [network, queryParameter("chainId", ref("ChainId"), false, "Must belong to the chosen indexer network."),
    queryParameter("projectId", ref("IndexerProjectId"))];
  const fields = jsonParameter("fields", array(text, { minItems: 1, maxItems: 48, uniqueItems: true }), false, "Bounded scalar field paths or supported singular relations. Identity fields are always included.");
  const listParameters = [...indexerScope.map((parameter) => parameter.name === "projectId" ? queryParameter("projectId", decimalString(2147483647), false, "List filters use the indexer's signed 32-bit GraphQL Int range.") : parameter), fields, jsonParameter("filters", { type: "object", additionalProperties: true }),
    jsonParameter("orderBy", object({ field: text, direction: { type: "string", enum: ["asc", "desc"], default: "asc" } }, ["field"])),
    queryParameter("limit", { type: "integer", minimum: 1, maximum: 50, default: 20 }), queryParameter("cursor", { ...text, "x-maxUtf8Bytes": 4096 })];
  add("/indexer/status", "GET", "getIndexerStatus", "Inspect indexer progress for a network", "Indexer", "read", { parameters: [network], result: ref("IndexerStatus") });
  add("/indexer/{entity}", "GET", "listIndexerEntity", "List a supported versioned indexer entity", "Indexer", "read", {
    parameters: [pathParameter("entity", { ...text, enum: catalog.entities.filter((item) => item.supported).map((item) => item.name) }), ...listParameters], result: ref("IndexerPage"),
    description: "Use `nextCursor` until null. Keep network, scope, fields, filters and order unchanged between pages. Pages are not a block-hash snapshot; concurrent indexing can change results. V6 is enforced server-side.",
  });
  add("/indexer/{entity}/record", "GET", "readIndexerEntity", "Read one exact indexer record", "Indexer", "read", {
    parameters: [pathParameter("entity", { ...text, enum: [...catalog.entities.filter((item) => item.supported).map((item) => item.name), "_meta"] }), ...indexerScope,
      jsonParameter("id", { anyOf: [text, { type: "object", additionalProperties: true }] }, false, "Exact key names are in the entity's singleArgs catalog entry; version is fixed to 6."), fields], result: ref("IndexerRecord"),
    description: "The _meta record accepts only network and returns item.chains. Other entities use their published primary key and selection schema.",
  });
  schemas.IndexerMetadataRecord = object({ ...(schemas.IndexerRecord!.properties as Record<string, Schema>),
    entity: { type: "string", const: "_meta" }, item: object({ chains: (schemas.IndexerStatus!.properties as Record<string, Schema>).chains! }),
  });
  add("/indexer/_meta/record", "GET", "readIndexerMetadata", "Read network indexing progress as a metadata record", "Indexer", "read", {
    parameters: [network], result: ref("IndexerMetadataRecord"), description: "Only network is accepted. Progress is an indexer observation; it does not pin subsequent table queries to one canonical block.",
  });
  add("/projects/{chainId}/{projectId}", "GET", "getProjectBySource", "Read a V6 project from the chosen source", "Projects", "read", {
    parameters: [pathParameter("chainId", ref("ChainId")), pathParameter("projectId", ref("Uint256")), queryParameter("source", ref("Source"), true)],
    description: "Select onchain or bendystraw explicitly. The response is the semantic operation's source-specific result. Missing source evidence is never silently replaced by another source.",
    extra: { "x-operation": "get_project", "x-source": ["onchain", "bendystraw"] },
  });
  add("/projects/{chainId}/{projectId}/omnichain", "GET", "getProjectOmnichain", "Inspect the project's omnichain group and partial evidence", "Projects", "read", {
    parameters: [pathParameter("chainId", ref("ChainId")), pathParameter("projectId", ref("Uint256")), queryParameter("source", ref("Source"), true), queryParameter("maxMembers", { type: "integer", minimum: 1, maximum: 8, default: 8 })],
    description: "Availability is reported by /capabilities. Member chains have separate state and finality. A source-chain receipt does not prove destination settlement. Incomplete group evidence remains explicit.", extra: { "x-source": ["onchain", "bendystraw"] },
  });

  const transactionDescriptors = descriptors.filter((item) => item.transaction);
  const readDescriptors = descriptors.filter((item) => !item.transaction && (item.kind !== "prepare" || ["prepare_project_metadata", "prepare_intent"].includes(item.id)));
  const genericPlans: Schema[] = [object({ operation: { const: "contract_calls", type: "string" }, input: ref("PrepareContractCalls") })];
  for (const descriptor of descriptors) schemas[`OperationInput_${descriptor.id}`] = modernSchema(descriptor.inputJsonSchema, `OperationInput_${descriptor.id}`) as Schema;
  for (const descriptor of transactionDescriptors) genericPlans.push(object({ operation: { type: "string", const: descriptor.id }, input: ref(`OperationInput_${descriptor.id}`) }));
  schemas.CreatePlan = { oneOf: genericPlans, description: "contract_calls uses the full pinned ABI surface; named preparations use semantic schemas. Every result is a durable unsigned plan." };
  add("/operations/{id}", "GET", "readOperation", "Execute a semantic read or local preparation", "Operations", "read", {
    parameters: [pathParameter("id", { ...text, enum: readDescriptors.map((item) => item.id) }), jsonParameter("input", { type: "object", additionalProperties: true }), queryParameter("source", ref("Source"))],
    description: "Concrete operation paths below provide exact input schemas. input defaults to {}. Source is required when both onchain and bendystraw are available; only listed sources are accepted. Output shape belongs to the selected operation.",
  });
  add("/operations/{id}/plans", "POST", "prepareOperation", "Prepare a durable semantic transaction plan", "Operations", "plan", {
    parameters: [pathParameter("id", { ...text, enum: transactionDescriptors.map((item) => item.id) })], body: { oneOf: transactionDescriptors.map((item) => ref(`OperationInput_${item.id}`)) },
    result: ref("Plan"), status: 201, idempotent: true, description: "Concrete paths below bind each input schema to its operation ID. Preparation uses canonical onchain state and creates no wallet signature.",
  });
  for (const descriptor of [...readDescriptors, ...transactionDescriptors]) {
    const selectable = descriptor.sources.filter((source) => ["onchain", "bendystraw"].includes(source));
    const extra = { "x-operation": descriptor.id, "x-source": descriptor.sources, "x-effects": descriptor.effects,
      "x-input-schema": wallet ? `#/components/schemas/OperationInput_${descriptor.id}` : `${REST_PREFIX}/catalog/operations/${descriptor.id}#/inputJsonSchema` };
    if (descriptor.transaction) add(`/operations/${descriptor.id}/plans`, "POST", `prepare_${descriptor.id}`, descriptor.description, "Operations", "plan", {
      body: ref(`OperationInput_${descriptor.id}`), result: ref("Plan"), status: 201, idempotent: true, extra,
      description: "Creates an immutable, durable unsigned plan from canonical onchain state. Review its exact calls, evidence, commitment and expiry before wallet signing.",
    });
    else add(`/operations/${descriptor.id}`, "GET", `execute_${descriptor.id}`, descriptor.description, "Operations", "read", {
      parameters: [jsonParameter("input", ref(`OperationInput_${descriptor.id}`), Array.isArray(descriptor.inputJsonSchema.required) && descriptor.inputJsonSchema.required.length > 0),
        ...(selectable.length ? [queryParameter("source", { type: "string", enum: selectable }, selectable.length > 1)] : [])],
      description: `Source classification: ${descriptor.sources.join(", ")}. Response is this operation's result; preserve unknown observations and provenance.`, extra,
    });
  }

  add("/plans", "POST", "createTransactionPlan", "Prepare reviewed ABI calls or a named semantic operation", "Transactions", "plan", { body: ref("CreatePlan"), result: ref("Plan"), status: 201, idempotent: true });
  add("/plans", "GET", "listTransactionPlans", "List plans visible to the authenticated principal", "Transactions", "read", {
    parameters: [queryParameter("account", ref("Address")), queryParameter("limit", { type: "integer", minimum: 1, maximum: 100, default: 20 }), queryParameter("cursor", { ...text, maxLength: 256 })],
    result: ref("PlanPage"), description: "Owners may read account bot plans; bots see their own principal's plans. Listing does not authorize relay mutation of another principal's plan.",
  });
  add("/plans/{id}", "GET", "getTransactionPlan", "Read or reconcile a stored transaction plan", "Transactions", "read", {
    parameters: [pathParameter("id", { type: "string", format: "uuid" }), queryParameter("refresh", { type: "boolean", default: false })], result: ref("Plan"),
    description: "refresh=true reconciles canonical receipts and configured confirmations; it never broadcasts. transactions_confirmed describes only these exact calls and verified modeled effects, not bridge settlement.",
  });
  const stepParameters = [pathParameter("id", { type: "string", format: "uuid" }), pathParameter("step", { type: "integer", minimum: 0, maximum: 31 })];
  const ownerApproval = (schema: string) => ({ "x-owner-approval": { schema: ref(schema),
    requiredFor: "A new dispatch authenticated by a bot. A fresh owner-signed HTTP request supplies consent directly.",
    maximumValiditySeconds: 300, admittedUnderDurableLock: true, reconcileOnlyRequiresNewApproval: false } });
  add("/plans/{id}/steps/{step}/simulation", "GET", "simulateTransactionStep", "Simulate a ready plan step at current canonical state", "Transactions", "read", {
    parameters: stepParameters, result: ref("Simulation"), description: "Dependencies must be canonically confirmed with verified or explicitly unmodeled semantics. State overrides are not supplied. Simulation is an observation, not an inclusion guarantee.",
  });
  add("/plans/{id}/steps/{step}/submissions", "POST", "submitSignedTransactionStep", "Relay the exact wallet-signed transaction for one plan step", "Transactions", "relay", {
    parameters: stepParameters, body: ref("SignedTransactionSubmission"), result: ref("SubmissionResult"), status: 202, idempotent: true,
    description: "Requires a separate valid transaction signature from the plan wallet and fresh owner consent for each new dispatch. Bots include `ownerApproval`. Destination, calldata, native value, chain, sender and nonce are checked against the immutable call. A step permanently binds one transaction hash. Reconcile unknown broadcast results before retrying identical bytes.",
    extra: ownerApproval("TransactionApproval"),
  });
  add("/plans/{id}/submissions", "POST", "submitSignedTransactionBundle", "Process an explicit ordered set of signed plan steps", "Transactions", "relay", {
    parameters: [pathParameter("id", { type: "string", format: "uuid" })], body: ref("BundleSubmission"), result: ref("BundleResult"), status: 202, idempotent: true,
    description: "Stops at the first blocked step and returns partial progress. Each bot-dispatched entry needs its own fresh `ownerApproval`. complete means all supplied submissions were processed, not confirmed. Resume remaining ready steps later. Multi-call and multi-chain journeys are not atomic.",
    extra: ownerApproval("TransactionApproval"),
  });

  add("/sponsorships", "POST", "createSponsorshipPreparation", "Prepare exact owner forwarding authorizations from a stored plan", "Sponsorship", "plan", {
    body: ref("CreateSponsorship"), result: ref("Sponsorship"), status: 201, idempotent: true,
    description: "Requires configured prepaid execution and the source plan's creating principal. Choose ready calls from the source plan. Multiple calls per chain are supported in plan order, within Center’s 32-step plan capacity. The owner reviews each exact ForwardRequest and its deadline; source-plan expiry only limits publication.",
  });
  add("/sponsorships/{id}", "GET", "getSponsorshipPreparation", "Read or reconcile a prepaid execution wave", "Sponsorship", "read", {
    parameters: [pathParameter("id", ref("ResourceId")), queryParameter("refresh", { type: "boolean", default: false })], result: ref("Sponsorship"),
    description: "refresh=true verifies destination execution using canonical chain evidence; provider status is only a hint. A funding quote does not establish whether the bundle has been paid. Reconcile the source plan independently for its full dependency state.",
  });
  add("/sponsorships/{id}/submissions", "POST", "publishSponsorshipAuthorizations", "Publish exact owner-signed forward requests once", "Sponsorship", "relay", {
    parameters: [pathParameter("id", ref("ResourceId"))], body: ref("SubmitSponsorship"), result: ref("Sponsorship"), status: 202, idempotent: true,
    description: "Supply signatures in authorization order. Bot publication additionally requires fresh CenterSponsorshipApproval bound to the exact submission hash. The adapter never repeats an uncertain provider POST; submission_unknown is not permission to publish again. Long forwarding validity does not create a reusable session.",
    extra: ownerApproval("SponsorshipApproval"),
  });
  add("/sponsorships/{id}/funding-plans", "POST", "createSponsorshipFundingPlan", "Persist a reviewed plan for one authenticated native funding quote", "Sponsorship", "plan", {
    parameters: [pathParameter("id", ref("ResourceId"))], body: ref("CreateSponsorshipFundingPlan"), result: ref("Plan"), status: 201, idempotent: true,
    description: "Payer must equal the API owner's wallet. Returns an unsigned durable plan for separate review, signature and submission. Center never signs or funds. Check existing funding before paying; funding confirmation does not prove destination execution, economic completion or bridge settlement.",
  });

  add("/smart-accounts/capabilities", "GET", "getSmartAccountCapabilities", "Discover reviewed wallet manifests and remaining execution requirements", "Wallets", "public", {
    result: ref("SmartAccountCapabilities"), description: "Runtime manifests and inspectors are operator-owned. Check top-level `capabilities.userOperations` for current provider availability and `capabilities.sessions` for activation readiness. Implemented routes or historical research do not prove deployed guard or account execution support; an empty deployment list supplies no usable manifest.",
  });
  add("/smart-accounts/binding-challenges", "POST", "createSmartBindingChallenge", "Inspect an existing reviewed Safe and prepare owner-threshold binding data", "Wallets", "owner", {
    body: ref("SmartBindingChallengeInput"), result: ref("SmartBindingChallenge"),
    description: "Requires the API owner and a configured exact manifest. Returns a distinct BindSmartAccount EIP-712 document after canonical owner/runtime checks. Sign the returned domain and message exactly. This is API wallet association, not session installation or spending authority.",
  });
  add("/smart-accounts/onboarding-challenges", "POST", "createSmartOnboardingChallenge", "Review sole-owner Base wallet binding and one-hour browser API access", "Wallets", "public", {
    body: ref("SmartOnboardingChallengeInput"), result: ref("SmartOnboardingChallenge"),
    description: "Bounded public canonical read for a deployed, configured sole-owner Base Safe without spending sessions. Returns the exact SetupAccount document and digest without enrollment, nonce consumption or generic signed-request headers. The browser selects the grant UUID/key before review. Requires configured onboarding storage and a complete current dependency/module inspection; missing support fails explicitly.",
  });
  add("/smart-accounts/onboarding", "POST", "finalizeSmartOnboarding", "Finalize account identity, wallet binding and exact browser API grant with one owner approval", "Wallets", "public", {
    body: ref("SmartOnboardingInput"), result: ref("SmartOnboardingResult"), status: 201,
    description: "Requires the current sole owner's SetupAccount signature and the distinct browser key's CenterSetupProof over the setup digest. No generic CenterRequest headers are needed. Rechecks fresh canonical deployment state, then atomically enrolls if absent, binds and creates the exact grant. Replay may return the existing current result; revoked, changed or superseded authority is never restored. Persist the grant UUID/key, document and signatures before dispatch. Recover a lost successful response with the saved grant and an ordinary grant-signed binding GET. Deployment and each payment retain separate owner approval; this route authorizes no transaction or onchain session.",
    extra: { "x-body-approval": { scheme: "eip712-purpose-signatures", required: true,
      owner: { field: "signature", primaryType: "SetupAccount", signerRole: "current-sole-wallet-owner" },
      browser: { field: "proofSignature", primaryType: "CenterSetupProof", signedFields: ["setupDigest"], signerRole: "exact-grant-browser-key" },
      maximumAuthorizationSeconds: 300, maximumGrantSeconds: 3600, transactionAuthority: false, onchainSessionAuthority: false } },
  });
  add("/smart-accounts/bindings", "POST", "bindSmartAccount", "Link a reviewed Safe using its current EOA-owner threshold signatures", "Wallets", "owner", {
    body: ref("SmartBindingInput"), result: ref("SmartAccountBinding"), status: 201,
    description: "Rechecks current owner/module state and verifies exactly the required threshold of packed EOA owner signatures in ascending address order. The API owner must be one current owner. Binding nonces cannot restore an unlinked or superseded authorization.",
  });
  add("/smart-accounts/bindings", "GET", "listSmartAccountBindings", "List stored wallet association snapshots for this API account", "Wallets", "read", {
    result: ref("SmartBindingList"), description: "Stored snapshots are not fresh chain verification. Read an individual binding to recheck its current state. `executionVerified` remains false.",
  });
  add("/smart-accounts/bindings/{id}", "GET", "getSmartAccountBinding", "Recheck a wallet binding against current canonical state", "Wallets", "read", {
    parameters: [pathParameter("id", ref("Hash"))], result: ref("SmartAccountBinding"),
    description: "A changed owner or modeled module configuration requires a new owner-authorized binding. This read does not establish session execution support.",
  });
  add("/smart-accounts/bindings/{id}", "DELETE", "unlinkSmartAccount", "Unlink a wallet from the owner's API account", "Wallets", "owner", {
    parameters: [pathParameter("id", ref("Hash"))], result: ref("SmartBindingUnlinked"),
    description: "API unlink only. It does not revoke an installed onchain session, alter a Safe owner set, or cancel previously authorized chain execution.",
  });
  add("/smart-accounts/session-reviews", "POST", "reviewSmartAccountSession", "Review a bounded session policy without installing or activating it", "Wallets", "plan", {
    body: ref("SessionReviewInput"), result: ref("SessionReview"),
    description: "Requires a verified existing binding, an active cumulative relay grant and configured reviewed action targets. Returns reviewable-not-activated, exact policy hashes and remaining activation requirements. There is no encoded installation transaction, UserOperation, live session or standing fund-moving authorization in this result. Seven- or thirty-day durations must fit the selected grant.",
    extra: { "x-activation": "review-only", "x-execution-available": false },
  });
  add("/smart-accounts/creation-plans", "POST", "prepareSmartAccountCreation", "Prepare deterministic Safe creation calldata with canonical dependency evidence", "Wallets", "owner", {
    body: ref("SmartCreationInput"), result: object({ creation: ref("SmartCreation") }), status: 201, idempotent: true,
    description: "Returns stateless exact factory calldata, predicted address and initializer. The API owner must appear in the owner set. A wallet signs and funds the factory transaction separately; this response is not a durable transaction plan or deployed account. Bind only after confirmed canonical creation and verified configuration.",
  });
  add("/smart-accounts/bindings/{id}/plans", "POST", "createSmartAccountTransactionPlan", "Create a durable plan for a currently verified smart-account binding", "Wallets", "plan", {
    parameters: [pathParameter("id", ref("Hash"))], body: ref("CreatePlan"), result: ref("Plan"), status: 201, idempotent: true,
    description: "The draft account must equal the exact bound Safe. Use contract_calls or a catalog operation and preserve the creating principal. Prepare its execution through /user-operations; an API grant or binding cannot supply a Safe-owner signature or session authority.",
  });
  const sessionAvailability = { "x-runtime-capability": "sessions.activationReady", "x-onchain-authority": "Exact installed policy and current canonical evidence, never the database record alone." };
  add("/smart-accounts/sessions", "POST", "prepareSmartAccountSession", "Compile and persist an immutable bounded session generation", "Sessions", "plan", {
    body: ref("SessionPreparationInput"), result: ref("StoredSession"), status: 201, idempotent: true, extra: sessionAvailability,
    description: "Requires a complete verified binding, active read+plan+relay grant, reviewed compiler, asset/action targets and mandatory gas-only sponsorship budget. URI-only sessions may use allocations:[]. Preparation returns prepared and no standing authority. Generation, salt, policy nonce and permission identities cannot be reused.",
  });
  add("/smart-accounts/sessions", "GET", "listSmartAccountSessions", "List immutable sessions visible to the owner or exact bound bot", "Sessions", "read", {
    parameters: [queryParameter("limit", { type: "integer", minimum: 1, maximum: 100, default: 25 }), queryParameter("cursor", ref("ResourceId"))],
    result: ref("SessionPage"), description: "Ordered by session UUID. Follow optional `nextCursor` unchanged. The owner can inspect account sessions; a bot sees only the session's exact grant. Listing does not refresh chain evidence.",
  });
  add("/smart-accounts/sessions/{id}", "GET", "getSmartAccountSession", "Read or refresh exact installed-policy and counter evidence", "Sessions", "read", {
    parameters: [pathParameter("id", ref("ResourceId")), queryParameter("refresh", { type: "boolean", default: true })], result: ref("StoredSession"),
    description: "Refreshes sessions with an activation claim by default. refresh=false returns stored history. Reorgs, counter resets and configuration changes suspend execution; stale proofs do not restore a generation. A failed verifier can return a problem while recording stale state.",
  });
  add("/smart-accounts/sessions/{id}/quota", "GET", "getSmartAccountSessionQuota", "Read approved allocations and freshly observed onchain counters", "Sessions", "read", {
    parameters: [pathParameter("id", ref("ResourceId"))], result: ref("SessionQuota"),
    description: "Refreshes available installed evidence. Preserve chain and asset units. Database limits do not establish token balances or reusable cross-chain budget; policy validation can consume limits even when execution fails.",
  });
  for (const kind of ["activation", "revocation"] as const) add(`/smart-accounts/sessions/{id}/${kind}-plans`, "POST",
    kind === "activation" ? "createSessionActivationPlan" : "createSessionRevocationPlan", `Prepare the owner's exact session ${kind} plan`, "Sessions", "owner", {
      parameters: [pathParameter("id", ref("ResourceId"))], body: ref("SessionPlanInput"), result: ref("SessionPlanResult"), status: 201, idempotent: true, extra: sessionAvailability,
      description: "Only the API owner can request this plan, acknowledging the exact `compiledHash`. Separately prepare a UserOperation from the returned plan, obtain the current Safe-owner threshold signatures, submit and refresh the session. Only the currently admitted lifecycle plan may execute. An expired plan with no admitted transport or attempt can be replaced with fresh owner consent and a new idempotency key, preserving up to 32 superseded approvals. Replacement cannot reinitialize an observed active generation. Only one generation per physical wallet may remain admitted, across keys, grants, assets and time windows. Release requires finalized disabled state with an advanced enable nonce; API revocation, unlinking or expiry alone cannot release it.",
    });
  add('/wallet/payment-reviews', 'POST', 'prepareWalletPaymentReview', 'Prepare an exact passkey payment review for the current app', 'WalletPayments', 'plan', {
    body: ref('PrepareWalletPaymentReview'), result: ref('WalletPaymentReview'), status: 201, idempotent: true,
    description: 'Requires a current typed wallet-app grant. The server loads its existing prepared operation and derives the payment and SafeOp digest. Neither API owners nor legacy bot grants can use this route. The saved allowlist callback supplies the return location. No signature, nonce reservation or submission occurs here.',
    extra: { 'x-principal-kind': 'wallet-app' },
  });
  add('/wallet/payment-reviews/{id}', 'GET', 'getWalletPaymentReview', 'Read the original app review and any live owner approval', 'WalletPayments', 'read', {
    parameters: [pathParameter('id', ref('ResourceId'))], result: ref('WalletPaymentAppReview'),
    description: 'Only the original current app grant and incarnation can retrieve its review. Approval requires a separate explicit passkey ceremony on the central wallet origin. A winning signature is returned only while the review and authority remain live. Submit it through the original UserOperation endpoint with unchanged fields. After review expiry, reconcile the original UserOperation; expiry does not establish a safe replacement.',
    extra: { 'x-principal-kind': 'wallet-app' },
  });
  add("/user-operations", "POST", "prepareUserOperation", "Prepare exact EntryPoint v0.7 bytes and the appropriate signing payload", "UserOperations", "plan", {
    body: ref("PrepareUserOperation"), result: { oneOf: [ref("UserOperation"), ref("SponsoredPaymentPreparation")] }, status: 201, idempotent: true,
    description: "Requires configured provider/runtime policies and the source smart-account plan's creating principal. Select increasing step indices. Owner mode permits 1–16 calls on one chain and returns SafeOp typed data. Session mode requires the exact active bound bot, selects one call and returns an EIP-191 payload. Provider estimation and sponsorship are checked before signing; no execution occurs during preparation.",
    extra: { "x-runtime-capability": "userOperations.preparation" },
  });
  add("/user-operations/{id}/submissions", "POST", "submitUserOperation", "Verify and publish one externally signed UserOperation", "UserOperations", "relay", {
    parameters: [pathParameter("id", ref("ResourceId"))], body: ref("SubmitUserOperation"), result: ref("UserOperation"), status: 202, idempotent: true,
    description: "Submit only the complete account signature envelope for the returned operation; all other fields remain immutable. Outside a session, current Safe-owner threshold signatures bind a fresh finite validity window. Inside a session, the installed bot key signs the exact operation and admission rechecks grant, generation and canonical counters. The API request signature is separate in both modes. Nonce and plan transport are reserved before publication. A timeout becomes submission_unknown and never permits an automatic second provider POST.",
    extra: { "x-runtime-capability": "userOperations.relay", "x-signature-schemas": [ref("SafeOwnerUserOperationSigning"), ref("SessionUserOperationSigning")] },
  });
  add("/user-operations/{id}", "GET", "getUserOperation", "Reconcile a stored UserOperation using canonical execution evidence", "UserOperations", "read", {
    parameters: [pathParameter("id", ref("ResourceId"))], result: ref("UserOperation"),
    description: "Refreshes submitted operations. A provider receipt is a location hint; confirmed requires the exact EntryPoint operation and its scoped account-call evidence. Submitted signature bytes remain omitted. Reconcile the source plan for dependency status and distinguish bridge settlement from execution.",
  });

  if (wallet) {
    document.info = { title: "Signa Wallet API", version: "1.0.0", summary: "Accounts, wallet approvals and transaction execution",
      description: "Manage Signa accounts and bot grants, prepare exact wallet transactions, approve spending and reconcile execution. Protected requests use the documented EIP-712 headers with this service's exact audience; wallet spending approval remains separate. Juicebox Center provides protocol catalogs and project reads at https://juicebox.center/api." };
    const usedTags = new Set(Object.values(document.paths).flatMap(methods => Object.values(methods).flatMap(operation => operation.tags)));
    document.tags = document.tags.filter(tag => usedTags.has(tag.name)).map(tag => tag.name === "Operations"
      ? { ...tag, description: "Transaction preparations generated from the shared operation descriptors." } : tag);
    const { contractMethodSchemas: _methods, indexerLimits: _indexer, ...protocol } = document["x-juicebox"] as Record<string, unknown>;
    document["x-juicebox"] = { ...protocol, protocolReference: "https://juicebox.center/api",
      discovery: { capabilities: `${REST_PREFIX}/capabilities`, openapi: `${REST_PREFIX}/openapi.json`, accounts: "/accounts",
        smartAccounts: "/api/docs/smart-accounts", sessions: "/api/docs/sessions" } };
    const call = schemas.PrepareContractCall!.properties as Record<string, Schema>;
    call.args = { ...call.args, description: "Positional ABI arguments. Obtain the exact deployed ABI and inputJsonSchema from Juicebox Center's https://juicebox.center/api/v1/catalog/method using the resolved abiHash. Integer values are decimal strings." };
    return document;
  }

  // Concrete indexer routes have input/output schemas derived from the pinned SDL.
  // Unsupported global-wallet aggregates remain visible only in the catalog.
  const graphType = (type: string, input = false): Schema => {
    const required = type.endsWith("!");
    const plain = required ? type.slice(0, -1) : type;
    let schema: Schema;
    if (plain.startsWith("[")) schema = array(graphType(plain.slice(1, -1), input), { maxItems: input ? INDEXER_LIMITS.maxFilterArray : INDEXER_LIMITS.maxScalarArray });
    else if (plain === "Int") schema = { type: "integer", minimum: -2147483648, maximum: 2147483647 };
    else if (plain === "Float") schema = { type: "integer", minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER, description: "Ponder Float identity values are restricted to exact safe integers." };
    else if (plain === "BigInt") schema = { type: "string", pattern: "^(?:0|-?[1-9][0-9]{0,99})$" };
    else if (["String", "ID"].includes(plain)) schema = { type: "string", "x-maxUtf8Bytes": input ? INDEXER_LIMITS.maxInputString : INDEXER_LIMITS.maxStringBytes };
    else if (plain === "Boolean") schema = { type: "boolean" };
    else if (plain === "JSON") schema = ref("JsonValue");
    else if (INDEXER_SCHEMA.enums[plain]) schema = { type: "string", enum: INDEXER_SCHEMA.enums[plain] };
    else if (INDEXER_SCHEMA.inputs[plain]) schema = ref(`IndexerFilter_${plain}`);
    else schema = ref(`IndexerRow_${plain}`);
    return required ? schema : nullable(schema);
  };
  const projectFilterType = (type: string): Schema => {
    const required = type.endsWith("!");
    const plain = required ? type.slice(0, -1) : type;
    const schema = plain.startsWith("[")
      ? array(projectFilterType(plain.slice(1, -1)), { maxItems: INDEXER_LIMITS.maxFilterArray })
      : { anyOf: [graphType(`${plain}!`, true), decimalString(2147483647)] };
    return required ? schema : nullable(schema);
  };
  const integerKeyType = (type: string): Schema => {
    const minimum = type === "Int!" ? -2147483648 : -Number.MAX_SAFE_INTEGER;
    const maximum = type === "Int!" ? 2147483647 : Number.MAX_SAFE_INTEGER;
    const positive = String(decimalString(maximum).pattern).slice(1, -1);
    const negative = String(decimalString(-minimum).pattern).slice(1, -1);
    return { anyOf: [graphType(type, true), {
      type: "string", pattern: `^(?:${positive}|-${negative})$`,
      description: "Exact integer strings are accepted for primary keys, including negative tick values. No decimal points or exponent notation.",
    }] };
  };
  for (const entity of catalog.entities.filter((item) => item.supported)) {
    const definitions = INDEXER_SCHEMA.objects[entity.name]!;
    const rowProperties: Record<string, Schema> = {};
    for (const [name, field] of Object.entries(definitions)) {
      const selectable = entity.fields.find((item) => item.name === name)?.selectable;
      if (!selectable) continue;
      rowProperties[name] = name === "version" ? ref("ProtocolVersion")
        : name === "projectId" ? decimalString(2147483647)
        : name === "chainId" ? ref("ChainId")
        : name === "hook" && ["nft", "nftTier"].includes(entity.name) ? ref(`IndexerRow_${field.namedType}`)
        : graphType(field.type);
    }
    const requiredKeys = [...new Set(["version", "chainId", "projectId", ...Object.keys(entity.singleArgs), ...(entity.name === "nft" ? ["tierId"] : [])])].filter((key) => rowProperties[key]);
    schemas[`IndexerRow_${entity.name}`] = object(rowProperties, requiredKeys);
    const filterProperties: Record<string, Schema> = {};
    for (const [name, type] of Object.entries(INDEXER_SCHEMA.inputs[entity.filterType]!)) {
      if (name === "version" || name.startsWith("version_")) continue;
      filterProperties[name] = name === "AND" || name === "OR"
        ? array(ref(`IndexerFilter_${entity.filterType}`), { minItems: 1, maxItems: INDEXER_LIMITS.maxFilterArray })
        : name === "projectId" || name.startsWith("projectId_") ? projectFilterType(type)
        : graphType(type, true);
    }
    schemas[`IndexerFilter_${entity.filterType}`] = { ...object(filterProperties, []), "x-maxDepth": INDEXER_LIMITS.maxFilterDepth, "x-maxNodes": INDEXER_LIMITS.maxFilterNodes };
    const exactIds = object(Object.fromEntries(Object.entries(entity.singleArgs).map(([name, type]) => [name,
      name === "version" ? ref("ProtocolVersion")
        : name === "chainId" ? { anyOf: [ref("ChainId"), { type: "string", enum: contracts.data.chains.map((chain) => String(chain.id)) }] }
        : name === "projectId" ? { anyOf: [uint(), decimalString(Number.MAX_SAFE_INTEGER)] }
        : type === "Int!" || type === "Float!" ? integerKeyType(type)
        : graphType(type, true),
    ])),
      Object.keys(entity.singleArgs).filter((key) => !["version", "chainId", "projectId"].includes(key)));
    const supportsShorthand = Object.keys(entity.singleArgs).filter((key) => !["version", "chainId", "projectId"].includes(key)).length <= 1;
    const keyDescription = "version is fixed to numeric 6. Supply every remaining primary key in this closed object or via the `chainId`/`projectId` query scope. A scalar string is accepted only when exactly one key remains after scope and version injection; it supplies that remaining key regardless of its name. Scope and key identities must agree; `chainId` must belong to the selected network.";
    schemas[`IndexerKey_${entity.name}`] = { ...(supportsShorthand ? { anyOf: [text, exactIds] } : exactIds), description: keyDescription };
    schemas[`IndexerPage_${entity.name}`] = object({ ...((schemas.IndexerPage!.properties as Record<string, Schema>)), entity: { type: "string", const: entity.name }, items: array(ref(`IndexerRow_${entity.name}`), { maxItems: 50 }) });
    schemas[`IndexerRecord_${entity.name}`] = object({ ...((schemas.IndexerRecord!.properties as Record<string, Schema>)), entity: { type: "string", const: entity.name }, item: nullable(ref(`IndexerRow_${entity.name}`)) });
    const concreteList = listParameters.map((parameter) => {
      if (parameter.name === "filters") return jsonParameter("filters", ref(`IndexerFilter_${entity.filterType}`));
      if (parameter.name === "orderBy") return jsonParameter("orderBy", object({
        field: { type: "string", enum: Object.entries(definitions).filter(([, field]) => field.kind !== "object" && !field.list && field.namedType !== "JSON").map(([name]) => name) },
        direction: { type: "string", enum: ["asc", "desc"], default: "asc" },
      }, ["field"]));
      return parameter;
    });
    add(`/indexer/${entity.name}`, "GET", `listIndexer_${entity.name}`, `List ${entity.name} records`, "Indexer", "read", {
      parameters: concreteList, result: ref(`IndexerPage_${entity.name}`), extra: { "x-indexer-entity": entity.name, "x-source": "bendystraw" },
    });
    add(`/indexer/${entity.name}/record`, "GET", `readIndexer_${entity.name}`, `Read one ${entity.name} record`, "Indexer", "read", {
      parameters: [...indexerScope, jsonParameter("id", ref(`IndexerKey_${entity.name}`), false, keyDescription), fields], result: ref(`IndexerRecord_${entity.name}`),
      extra: { "x-indexer-entity": entity.name, "x-source": "bendystraw" },
    });
  }
  return document;
}
