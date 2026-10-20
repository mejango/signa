import { readFile } from "node:fs/promises";
import { createProtocolOperations, createServices, loadConfig } from "@juicebox/mcp/host";
import { Ajv2020 } from "ajv/dist/2020.js";
import { beforeAll, describe, expect, it } from "vitest";
import { operationDescriptors } from "../src/rest/app.js";
import { getContractCatalog } from "../src/rest/contracts/catalog.js";
import { apiDocsCss, apiDocsPage, apiReferencePages, buildRestOpenApi, type OpenApiDocument } from "../src/rest/docs/index.js";
import { createIndexerReadService } from "../src/rest/indexer/index.js";

const origin = "https://juicebox.center";
const indexer = createIndexerReadService({});
const operations = createProtocolOperations(createServices(loadConfig({ NODE_ENV: "test", PUBLIC_ORIGIN: origin,
  PLAN_SECRET: "openapi-offline-tests-only-32-byte-secret" })));
let spec: OpenApiDocument;
beforeAll(async () => { spec = buildRestOpenApi({ contracts: await getContractCatalog(), indexer, operations, publicOrigin: origin }); });

function walk(value: unknown, visit: (value: Record<string, unknown>) => void): void {
  if (value && typeof value === "object") {
    if (!Array.isArray(value)) visit(value as Record<string, unknown>);
    for (const child of Object.values(value)) walk(child, visit);
  }
}
function resolvePointer(reference: string): unknown {
  return reference.slice(2).split("/").reduce<unknown>((value, segment) => {
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
  }, spec);
}

describe("REST OpenAPI contract", () => {
  it("validates against the official offline OpenAPI 3.1 schema and JSON Schema 2020-12", async () => {
    const official = JSON.parse(await readFile(new URL("../src/rest/docs/openapi-3.1.schema.json", import.meta.url), "utf8"));
    // Ajv supports dynamic anchors only at resource roots. This unextended official
    // document schema has one fixed #meta target in $defs/schema, so a static local
    // reference is equivalent here. Schema Objects are independently checked below.
    walk(official, (value) => {
      if (value.$dynamicRef === "#meta") { delete value.$dynamicRef; value.$ref = "#/$defs/schema"; }
    });
    const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
    const validate = ajv.compile(official);
    expect(validate(spec), JSON.stringify(validate.errors?.slice(0, 3))).toBe(true);
    for (const [name, schema] of Object.entries(spec.components.schemas)) {
      expect(ajv.validateSchema(schema), `${name}: ${JSON.stringify(ajv.errors)}`).toBe(true);
    }
    expect(spec.openapi).toBe("3.1.2");
    expect(Buffer.byteLength(JSON.stringify(spec))).toBeLessThan(5_242_880);
    const references: string[] = [];
    walk(spec, (value) => { if (typeof value.$ref === "string") references.push(value.$ref); });
    for (const reference of references.filter((value) => value.startsWith("#/"))) expect(resolvePointer(reference), reference).toBeDefined();
  });

  it("covers every registered HTTP route with matching methods and path parameters", async () => {
    const files = ["../src/rest/app.ts", "../src/rest/auth/router.ts"];
    for (const file of files) {
      const source = await readFile(new URL(file, import.meta.url), "utf8");
      for (const match of source.matchAll(/(?:app|router)\.(get|post|patch|delete)\((["'])([^"']+)\2/g)) {
        const path = match[3] === "/" ? "/api/v1" : `/api/v1${match[3]!.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}")}`;
        expect(spec.paths[path]?.[match[1]!], `${match[1]} ${path}`).toBeDefined();
      }
    }
    for (const kind of ["activation", "revocation"]) {
      const operation = spec.paths[`/api/v1/smart-accounts/sessions/{id}/${kind}-plans`]?.post;
      expect(operation, `${kind} lifecycle route`).toBeDefined();
      expect(operation?.["x-auth"]).toMatchObject({ ownerOnly: true, idempotencyRequired: true });
      expect(operation?.responses).toHaveProperty("201");
    }
    const ids = new Set<string>();
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const operation of Object.values(methods)) {
        expect(ids.has(operation.operationId), operation.operationId).toBe(false);
        ids.add(operation.operationId);
        const parameters = operation.parameters as Record<string, unknown>[];
        for (const match of path.matchAll(/\{([^}]+)\}/g)) {
          expect(parameters.some((parameter) => parameter.name === match[1] && parameter.in === "path" && parameter.required === true)).toBe(true);
        }
      }
    }
  });

  it("derives concrete operation paths and schemas without executing or serializing handlers", () => {
    const descriptors = operationDescriptors(operations);
    for (const descriptor of descriptors) {
      const path = descriptor.path;
      const operation = spec.paths[path]?.[descriptor.method.toLowerCase()];
      expect(operation, descriptor.id).toBeDefined();
      expect(operation?.["x-operation"]).toBe(descriptor.id);
      const schema = spec.components.schemas[`OperationInput_${descriptor.id}`]!;
      expect(schema.type).toBe(descriptor.inputJsonSchema.type);
      expect(schema.required).toEqual(descriptor.inputJsonSchema.required);
      expect(Object.keys(schema.properties as object)).toEqual(Object.keys(descriptor.inputJsonSchema.properties as object));
    }
    const serialized = JSON.stringify(spec);
    expect(serialized).not.toContain('"handler"');
    expect(serialized).not.toContain('"prepareDraft"');
    expect(serialized).not.toContain('"schema" : "zod"');
    for (const excluded of ["pin_project_metadata", "inspect_plan", "simulate_plan", "verify_plan"]) {
      expect(spec.paths[`/api/v1/operations/${excluded}`]).toBeUndefined();
    }
    for (const entity of indexer.catalog().entities) {
      expect(Boolean(spec.paths[`/api/v1/indexer/${entity.name}`])).toBe(entity.supported);
      if (entity.supported) expect(spec.components.schemas[`IndexerRow_${entity.name}`]).toBeDefined();
    }
  });

  it("models custom request signatures, public discovery, JSON query serialization and distinct transaction signatures", () => {
    for (const methods of Object.values(spec.paths)) for (const operation of Object.values(methods)) {
      const auth = operation["x-auth"] as { scheme: string; idempotencyRequired: boolean };
      const parameters = operation.parameters as Record<string, unknown>[];
      const headers = parameters.map((parameter) => typeof parameter.$ref === "string" ? resolvePointer(parameter.$ref) as Record<string, unknown> : parameter).filter((parameter) => parameter.in === "header");
      if (auth.scheme === "public") expect(headers).toHaveLength(0);
      else {
        for (const name of ["Account", "Signer", "Issued-At", "Expires-At", "Nonce", "Signature"]) {
          expect(headers.some((header) => header.name === `X-Juicebox-${name}` && header.required === true)).toBe(true);
        }
        expect(headers.find((header) => header.name === "Idempotency-Key")?.required).toBe(auth.idempotencyRequired);
      }
    }
    const method = spec.paths["/api/v1/protocol/read"]!.get!;
    const args = (method.parameters as Record<string, unknown>[]).find((parameter) => parameter.name === "args")!;
    expect(args.content).toHaveProperty("application/json");
    expect(args.schema).toBeUndefined();
    expect(spec.components.schemas.SignedTransactionSubmission!.required).toEqual(["rawSignedTransaction"]);
    expect(spec.paths["/api/v1/plans"]!.post!.responses).toHaveProperty("201");
    expect(spec.paths["/api/v1/plans/{id}/submissions"]!.post!.responses).toHaveProperty("202");
    expect(spec.paths["/api/v1/accounts/enroll"]!.post!.responses).toHaveProperty("200");
    const onboarding = spec.paths["/api/v1/smart-accounts/onboarding"]!.post!;
    expect(onboarding["x-auth"]).toMatchObject({ scheme: "public", idempotencyRequired: false });
    expect(onboarding["x-body-approval"]).toMatchObject({ required: true,
      owner: { field: "signature", primaryType: "SetupAccount" },
      browser: { field: "proofSignature", primaryType: "CenterSetupProof" },
      transactionAuthority: false, onchainSessionAuthority: false });
    expect(onboarding.responses).toHaveProperty("201");
    expect(JSON.stringify(spec)).not.toMatch(/"(?:bearer|oauth2|apiKey)"/);
  });

  it("validates durable plan inputs and lossless numbers from the published components", () => {
    const serialized = JSON.stringify({ $id: "urn:juicebox:test-schemas", $defs: spec.components.schemas }).replaceAll("#/components/schemas/", "#/$defs/");
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    ajv.addSchema(JSON.parse(serialized));
    const validate = ajv.compile({ $ref: "urn:juicebox:test-schemas#/$defs/CreatePlan" });
    const input = { operation: "contract_calls", input: { account: "0x0000000000000000000000000000000000000001", calls: [{ chainId: 1,
      contractId: "@bananapus/core-v6:src/JBProjects.sol:JBProjects", function: "transferFrom(address,address,uint256)",
      args: ["0x0000000000000000000000000000000000000001", "0x0000000000000000000000000000000000000002", "1"], value: "0" }] } };
    expect(validate(input), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...input, input: { ...input.input, unexpected: true } })).toBe(false);
    expect(validate({ ...input, operation: "invented_prepare" })).toBe(false);
    const amount = ajv.compile({ $ref: "urn:juicebox:test-schemas#/$defs/Uint256" });
    expect(amount(((1n << 256n) - 1n).toString())).toBe(true);
    expect(amount((1n << 256n).toString())).toBe(false);
    expect(amount(1000000000000000000)).toBe(false);
    expect(amount("1e18")).toBe(false);
    const grant = ajv.compile({ $ref: "urn:juicebox:test-schemas#/$defs/BotScopes" });
    for (const scopes of [["read"], ["read", "plan"], ["read", "plan", "relay"]]) expect(grant(scopes)).toBe(true);
    for (const scopes of [[], ["relay"], ["plan"], ["read", "relay"], ["plan", "read"], ["read", "read"]]) expect(grant(scopes)).toBe(false);
  });

  it("validates an actual normalized indexer response and its distinct list/read integer bounds", async () => {
    const service = createIndexerReadService({ mainnetUrl: "https://indexer.example.invalid/graphql", fetchJson: async () => ({ data: {
      projects: { items: [{ version: 6, chainId: 1, projectId: 1 }], totalCount: 1,
        pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: "first", endCursor: "first" } },
    } }) });
    const page = await service.list("project", { network: "mainnet", chainId: 1, projectId: "1", fields: ["version"] });
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    ajv.addSchema(JSON.parse(JSON.stringify({ $id: "urn:juicebox:indexer-response-schemas", $defs: spec.components.schemas }).replaceAll("#/components/schemas/", "#/$defs/")));
    const validate = ajv.compile({ $ref: "urn:juicebox:indexer-response-schemas#/$defs/IndexerPage_project" });
    expect(validate(page), JSON.stringify(validate.errors)).toBe(true);
    expect(page.items[0]!.projectId).toBe("1");
    const listProjectId = (spec.paths["/api/v1/indexer/project"]!.get!.parameters as Record<string, unknown>[]).find((parameter) => parameter.name === "projectId")!;
    const listId = ajv.compile(listProjectId.schema as object);
    expect(listId("2147483647")).toBe(true);
    expect(listId("2147483648")).toBe(false);
    const recordId = ajv.compile({ $ref: "urn:juicebox:indexer-response-schemas#/$defs/IndexerProjectId" });
    expect(recordId("9007199254740991")).toBe(true);
    for (const value of ["9007199254740992", "01", "-1", "1e3", 1]) expect(recordId(value)).toBe(false);
  });
});

describe("static REST documentation", () => {
  it("renders escaped, responsive docs with local progressive enhancement", () => {
    const unsafe = structuredClone(spec);
    unsafe.paths["/api/v1"]!.get!.summary = '<img src=x onerror="alert(1)">';
    unsafe.paths["/api/v1"]!.get!.description = 'Read `protocolVersion` and treat `</code><img src=x>` as text.';
    const html = apiDocsPage(unsafe);
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
    expect(html).toContain("Read <code>protocolVersion</code>");
    expect(html).toContain("<code>&lt;/code&gt;&lt;img src=x&gt;</code>");
    expect(html).toContain('src="/assets/docs.js"');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('href="/assets/api.css"');
    // Field tables load per endpoint; the page keeps only their names, for the filter.
    expect(html).not.toContain("schema-fields");
    expect(html).toMatch(/data-terms="[^"]*\bplanId\b/);
    const reference = apiReferencePages(unsafe);
    const pages = [...reference.values()].join("");
    expect(pages).toContain("Request body");
    expect(pages).toContain("Response 201");
    expect(pages).toContain('<code>planId</code>');
    expect(pages).toContain("Parameters");
    expect(pages).not.toContain("<img");
    for (const [operationId, page] of reference) {
      expect(html).toContain(`href="/api/reference/${encodeURIComponent(operationId)}"`);
      expect(page).toContain('class="endpoint-fields"');
    }
    expect(html).toContain('name="viewport"');
    expect(html).toContain('href="/api/v1/openapi.json"');
    expect(html).toContain('href="/api/docs/ai-guide"');
    expect(html + apiDocsCss).not.toContain("·");
    expect(apiDocsCss).toContain("@media(max-width:620px)");
    expect(apiDocsCss).not.toMatch(/border-radius\s*:/);
  });

  it("rejects credential-bearing or non-origin documentation hosts", async () => {
    const contracts = await getContractCatalog();
    for (const publicOrigin of ["https://secret@example.com", "https://example.com/path", "https://example.com?q=1", "http://example.com", "javascript:alert(1)"]) {
      expect(() => buildRestOpenApi({ contracts, indexer, operations, publicOrigin })).toThrow();
    }
  });
});
