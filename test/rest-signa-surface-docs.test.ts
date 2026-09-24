import { readFile } from "node:fs/promises";
import { createProtocolOperations, createServices, loadConfig } from "@juicebox/mcp/host";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import type { JbcenterEnv } from "../src/types.js";
import { operationDescriptors } from "../src/rest/app.js";
import { getContractCatalog } from "../src/rest/contracts/catalog.js";
import { apiDocsCss, apiDocsPage, buildRestOpenApi, type OpenApiDocument } from "../src/rest/docs/index.js";
import { createIndexerReadService } from "../src/rest/indexer/index.js";
import { mountRestSite, type RestSite } from "../src/rest/site.js";

const origin = "https://api.signa.center";
const indexer = createIndexerReadService({});
const operations = createProtocolOperations(createServices(loadConfig({ NODE_ENV: "test", PUBLIC_ORIGIN: origin,
  PLAN_SECRET: "signa-surface-docs-only-32-byte-secret" })));
let full: OpenApiDocument, wallet: OpenApiDocument;
beforeAll(async () => {
  const input = { contracts: await getContractCatalog(), indexer, operations, publicOrigin: origin };
  full = buildRestOpenApi(input);
  wallet = buildRestOpenApi({ ...input, surface: "wallet" });
});

function walk(value: unknown, visit: (value: Record<string, unknown>) => void): void {
  if (!value || typeof value !== "object") return;
  if (!Array.isArray(value)) visit(value as Record<string, unknown>);
  for (const child of Object.values(value)) walk(child, visit);
}
function resolve(reference: string): unknown {
  return reference.slice(2).split("/").reduce<unknown>((value, part) => value && typeof value === "object"
    ? (value as Record<string, unknown>)[part.replaceAll("~1", "/").replaceAll("~0", "~")] : undefined, wallet);
}

describe("Signa wallet API documentation", () => {
  it("retains account and execution endpoints while excluding protocol read surfaces", () => {
    const families = new Set(["accounts", "smart-accounts", "wallet", "plans", "sponsorships", "user-operations", "capabilities", "openapi.json"]);
    for (const [path, methods] of Object.entries(full.paths)) {
      const family = path.split("/")[3];
      for (const method of Object.keys(methods)) {
        const retained = !family || families.has(family) || family === "operations" && method === "post";
        expect(Boolean(wallet.paths[path]?.[method]), `${method} ${path}`).toBe(retained);
      }
    }
    for (const descriptor of operationDescriptors(operations)) {
      const schema = `#/components/schemas/OperationInput_${descriptor.id}`;
      if (descriptor.transaction) {
        expect(wallet.paths[descriptor.path]?.post?.["x-input-schema"]).toBe(schema);
        expect(resolve(schema)).toBeDefined();
      } else {
        expect(wallet.paths[descriptor.path]).toBeUndefined();
        expect(resolve(schema)).toBeUndefined();
      }
    }
    expect(wallet["x-auth"]).toEqual(full["x-auth"]);
    expect(wallet.servers).toEqual([{ url: origin }]);
    expect(wallet.info.title).toBe("Signa Wallet API");
    for (const tag of ["Contracts", "Indexer", "Projects"]) expect(wallet.tags.map(item => item.name)).not.toContain(tag);
    expect(wallet["x-juicebox"]).toMatchObject({ protocolReference: "https://juicebox.center/api", discovery: { openapi: "/api/v1/openapi.json" } });
    for (const property of ["contractMethodSchemas", "discovery.contracts", "discovery.indexer", "discovery.operations"])
      expect(wallet["x-juicebox"]).not.toHaveProperty(property);
    for (const path of ["/api/v1", "/api/v1/capabilities"]) {
      const response = wallet.paths[path]!.get!.responses["200"] as { content: { "application/json": { schema: { properties: Record<string, unknown>; required: string[] } } } };
      const schema = response.content["application/json"].schema;
      expect(schema.required).toContain("protocolReference");
      for (const field of ["catalogs", "sources", "omnichain"]) {
        expect(schema.properties).not.toHaveProperty(field);
        expect(schema.required).not.toContain(field);
      }
    }
    expect(full.paths["/api/v1/catalog/contracts"]?.get).toBeDefined();
    expect(full.info.title).toBe("Juicebox Center REST API");
  });

  it("publishes a valid offline OpenAPI document with resolvable schemas", async () => {
    const official = JSON.parse(await readFile(new URL("../src/rest/docs/openapi-3.1.schema.json", import.meta.url), "utf8"));
    // The official document's fixed meta target is equivalent to a local reference for Ajv.
    walk(official, value => { if (value.$dynamicRef === "#meta") { delete value.$dynamicRef; value.$ref = "#/$defs/schema"; } });
    const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
    const validate = ajv.compile(official);
    expect(validate(wallet), JSON.stringify(validate.errors?.slice(0, 3))).toBe(true);
    for (const [name, schema] of Object.entries(wallet.components.schemas))
      expect(ajv.validateSchema(schema), `${name}: ${JSON.stringify(ajv.errors)}`).toBe(true);
    walk(wallet, value => {
      if (typeof value.$ref === "string" && value.$ref.startsWith("#/")) expect(resolve(value.$ref), value.$ref).toBeDefined();
    });
  });

  it("renders local wallet endpoints and examples with safe shared rendering", () => {
    const unsafe = structuredClone(wallet);
    unsafe.paths["/api/v1"]!.get!.summary = '<img src=x onerror="alert(1)">';
    const html = apiDocsPage(unsafe, "wallet");
    expect(html).toContain("Wallet API | Signa");
    expect(html).toContain(`curl ${origin}/api/v1/capabilities`);
    expect(html).toContain(`npm install ${origin}/api/client/juicebox-center-client-0.1.0.tgz`);
    expect(html).toContain('href="https://juicebox.center/api"');
    expect(html).toContain('href="https://juicebox.center/api/docs/client"');
    expect(html).toContain('rel="icon" type="image/svg+xml" href="/assets/accounts-icon.svg?v=signa"');
    for (const text of ["/api/v1/accounts/me", "/api/v1/user-operations", "Request body", "Response 201", "&lt;img"])
      expect(html).toContain(text);
    for (const text of ["<img", "Choose a data source", 'href="/api/v1/catalog/', 'class="route">/api/v1/projects/', 'href="/"', "·"])
      expect(html).not.toContain(text);
    expect(apiDocsPage(full)).toContain("Choose a data source");
  });

  it("serves the wallet reference locally and redirects inherited guides to Center", async () => {
    const mount = (surface?: "wallet") => {
      const app = new Hono<JbcenterEnv>();
      mountRestSite(app, { app: new Hono() as unknown as RestSite["app"], ...(surface ? { surface } : {}), audience: origin,
        accountsScript: "", docsHtml: apiDocsPage(surface ? wallet : full, surface), docsCss: apiDocsCss,
        documents: new Map([["quickstart", "# Center quickstart"], ["client", "# Client workflows"], ["contracts", "# Contracts"]]) });
      return app;
    };
    const app = mount("wallet");
    expect(await (await app.request("/api")).text()).toContain("Wallet API | Signa");
    const icon = await app.request("/assets/accounts-icon.svg");
    expect(icon.status).toBe(200); expect(icon.headers.get("content-type")).toContain("image/svg+xml");
    for (const name of ["quickstart", "client", "contracts", "CLIENT.md"]) {
      const response = await app.request(`/api/docs/${name}`);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`https://juicebox.center/api/docs/${name.toLowerCase()}`);
      expect(await response.text()).not.toContain("<article>");
    }
    expect((await app.request("/api/docs/missing")).status).toBe(404);
    const center = mount();
    expect(await (await center.request("/api/docs/client")).text()).toContain("<article>");
    expect(await (await center.request("/api/docs/client.md")).text()).toBe("# Client workflows");
  });
});
