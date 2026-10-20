import { createProtocolOperations, createServices, loadConfig } from "@juicebox/mcp/host";
import { build } from "esbuild";
import { Hono } from "hono";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getContractCatalog } from "../src/rest/contracts/catalog.js";
import { apiDocsCss, apiDocsPage, apiReferencePages, buildRestOpenApi, type OpenApiDocument } from "../src/rest/docs/index.js";
import { createIndexerReadService } from "../src/rest/indexer/index.js";
import { mountRestSite, type RestSite } from "../src/rest/site.js";
import type { JbcenterEnv } from "../src/types.js";

const origin = "https://juicebox.center";
let spec: OpenApiDocument, app: Hono<JbcenterEnv>, browser: Browser, page: Page;
const fetched: string[] = [], errors: string[] = [];
let failReference = false;

beforeAll(async () => {
  const operations = createProtocolOperations(createServices(loadConfig({ NODE_ENV: "test", PUBLIC_ORIGIN: origin,
    PLAN_SECRET: "openapi-offline-tests-only-32-byte-secret" })));
  spec = buildRestOpenApi({ contracts: await getContractCatalog(), indexer: createIndexerReadService({}), operations, publicOrigin: origin });
  const bundle = await build({ entryPoints: [new URL("../src/rest/docs/main.ts", import.meta.url).pathname],
    bundle: true, format: "esm", write: false, platform: "browser" });
  app = new Hono<JbcenterEnv>();
  mountRestSite(app, { app: new Hono() as unknown as RestSite["app"], audience: origin, accountsScript: "",
    docsHtml: apiDocsPage(spec), apiReference: apiReferencePages(spec), docsCss: apiDocsCss,
    docsScript: bundle.outputFiles[0]!.text, documents: new Map() });
  browser = await chromium.launch({ headless: true });
}, 60_000);
afterAll(async () => { await browser?.close(); });
beforeEach(async () => {
  fetched.length = 0; errors.length = 0; failReference = false;
  page = await browser.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.route(origin + "/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api/reference/")) {
      fetched.push(url.pathname);
      if (failReference) return route.fulfill({ status: 503, body: "unavailable" });
    }
    const response = await app.request(url.href);
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
  });
});
afterEach(async () => { await page.close(); expect(errors).toEqual([]); });

// The first endpoint with a request body: its field names are searchable before its tables load.
const sample = () => {
  for (const methods of Object.values(spec.paths)) for (const operation of Object.values(methods))
    if (operation.requestBody) return operation.operationId;
  throw new Error("no endpoint with a request body");
};

// The loaded tables replace the link, so find the endpoint by its operationId line.
const locate = (operationId: string) => page.locator(".endpoint", { has: page.getByText(`operationId: ${operationId}`, { exact: true }) });

describe("/api endpoint reference", () => {
  it("loads an endpoint's tables once, when it is opened", async () => {
    await page.goto(origin + "/api");
    expect(await page.locator(".schema-fields").count()).toBe(0);
    const operationId = sample();
    const endpoint = locate(operationId);
    await endpoint.evaluate(node => { (node.closest(".group") as HTMLDetailsElement).open = true; });
    await endpoint.locator(":scope > summary").click();
    await expect.poll(() => endpoint.locator(".schema-fields").count()).toBeGreaterThan(0);
    expect(await endpoint.locator(".endpoint-fields h4").first().textContent()).toMatch(/Parameters|Request body|Response/);
    await endpoint.locator(":scope > summary").click();
    await endpoint.locator(":scope > summary").click();
    expect(fetched).toEqual([`/api/reference/${operationId}`]);
  });

  it("keeps the link when the tables cannot load, and retries on the next open", async () => {
    failReference = true;
    await page.goto(origin + "/api");
    const operationId = sample();
    const endpoint = locate(operationId);
    await endpoint.evaluate(node => { (node.closest(".group") as HTMLDetailsElement).open = true; });
    await endpoint.locator(":scope > summary").click();
    await expect.poll(() => fetched.length).toBe(1);
    await expect.poll(() => endpoint.locator(".endpoint-fields").getAttribute("data-state")).toBe(null);
    expect(await endpoint.locator(`.endpoint-fields a[href="/api/reference/${operationId}"]`).count()).toBe(1);
    failReference = false;
    await endpoint.locator(":scope > summary").click();
    await endpoint.locator(":scope > summary").click();
    await expect.poll(() => endpoint.locator(".schema-fields").count()).toBeGreaterThan(0);
  });

  it("filters on field names that only the search terms carry", async () => {
    await page.goto(origin + "/api");
    // A field name that appears in no endpoint's visible text, so only data-terms can match it.
    const term = await page.evaluate(() => {
      const visible = Array.from(document.querySelectorAll<HTMLElement>(".endpoint"), node => node.textContent!.toLowerCase()).join(" ");
      for (const node of document.querySelectorAll<HTMLElement>(".endpoint[data-terms]"))
        for (const name of node.dataset.terms!.split(" ")) if (name.length > 6 && !visible.includes(name.toLowerCase())) return name;
    });
    expect(term).toBeTruthy();
    await page.fill("#endpoint-filter", term!);
    const shown = page.locator(".endpoint:not([hidden])");
    await expect.poll(() => shown.count()).toBeGreaterThan(0);
    for (const terms of await shown.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.terms ?? "")))
      expect(terms.toLowerCase()).toContain(term!.toLowerCase());
    expect(await page.locator("#endpoint-count").textContent()).toBe(`${await shown.count()} endpoints`);
    // Loaded tables do not widen the match: descriptions inside them stay out of the filter.
    await page.fill("#endpoint-filter", "no endpoint has this text");
    await expect.poll(() => shown.count()).toBe(0);
    await page.fill("#endpoint-filter", "");
    expect(await shown.count()).toBe(await page.locator(".endpoint").count());
  });
});
