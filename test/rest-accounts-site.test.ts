import { Hono } from "hono";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import type { JbcenterEnv } from "../src/types.js";
import { mountAccountsSite } from "../src/rest/accountsSite.js";
import { REST_PAGE_HEADERS } from "../src/rest/pageHeaders.js";
import { mountRestSite, type RestSite } from "../src/rest/site.js";

const origin = "https://accounts.example.test", audience = "https://api.example.test";
const accountsScript = "document.body.dataset.accountsScriptLoaded = 'true';";
function accounts() {
  const app = new Hono<JbcenterEnv>();
  mountAccountsSite(app, { audience, accountsScript });
  return app;
}

describe("standalone Accounts hosting", () => {
  it("serves the account page and local assets without mounting the reference API", async () => {
    const app = accounts(), response = await app.request(origin + "/accounts"), html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain(`data-audience="${audience}"`);
    for (const path of ["/api", "/api/docs/quickstart", "/api/docs/smart-accounts", "/api/docs/sessions", "/api#write", "/api#glossary-paymaster"])
      expect(html).toContain(`href="${audience}${path}"`);
    expect(html).toContain(`npm install ${audience}/api/client/juicebox-center-client-0.1.0.tgz`);
    expect(html).toContain('href="/assets/accounts-icon.svg?v=signa"');
    expect(html).not.toMatch(/href="\/(?:api|favicon\.svg)/);
    const script = await app.request(origin + "/assets/accounts.js");
    expect(script.headers.get("content-type")).toContain("application/javascript");
    expect(await script.text()).toBe(accountsScript);
    const style = await app.request(origin + "/assets/accounts.css");
    expect(style.status).toBe(200); expect(style.headers.get("content-type")).toContain("text/css");
    const icon = await app.request(origin + "/assets/accounts-icon.svg");
    expect(icon.status).toBe(200); expect(icon.headers.get("content-type")).toContain("image/svg+xml");
    for (const path of ["/", "/api", "/api/v1/accounts/me", "/mcp", "/wallet"])
      expect((await app.request(origin + path)).status).toBe(404);
  });

  it.each([
    "https://api.example.test/", "https://api.example.test/api", "https://api.example.test?x=1", "https://api.example.test#api",
    "https://user@api.example.test", "http://api.example.test", "https://*.example.test", "https://api.example.test;",
    "https://api.example.test,", "https://api.example.test\n", "data:text/html,accounts",
  ])("rejects an API audience that is not one exact CSP origin: %s", value => {
    expect(() => mountAccountsSite(new Hono<JbcenterEnv>(), { audience: value, accountsScript })).toThrow();
  });

  it("keeps the existing Center mount and reference CSP", async () => {
    const app = new Hono<JbcenterEnv>();
    const api = new Hono().get("/health", context => context.text("ok")) as unknown as RestSite["app"];
    mountRestSite(app, { app: api, audience, accountsScript,
      docsHtml: "reference docs", docsCss: "", documents: new Map() });
    expect((await app.request(audience + "/accounts")).status).toBe(200);
    expect(await (await app.request(audience + "/assets/accounts.js")).text()).toBe(accountsScript);
    expect(await (await app.request(audience + "/api/v1/health")).text()).toBe("ok");
    const docs = await app.request(audience + "/api");
    expect(await docs.text()).toBe("reference docs");
    expect(docs.headers.get("content-security-policy")).toBe(REST_PAGE_HEADERS["Content-Security-Policy"]);
  });

  it("allows a browser to reach the configured API and blocks another origin", async () => {
    const app = accounts(), browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage(), reached: string[] = [];
      await page.route(origin + "/**", async route => {
        const response = await app.request(route.request().url());
        await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
      });
      await page.route(audience + "/**", async route => {
        reached.push(route.request().url());
        expect(route.request().headers().origin).toBe(origin);
        await route.fulfill({ contentType: "application/json", headers: { "Access-Control-Allow-Origin": origin }, body: '{"ok":true}' });
      });
      await page.route("https://unrelated.example.test/**", async route => {
        reached.push(route.request().url());
        await route.fulfill({ body: "unexpected", headers: { "Access-Control-Allow-Origin": origin } });
      });
      await page.goto(origin + "/accounts");
      expect(await page.locator("body").getAttribute("data-accounts-script-loaded")).toBe("true");
      expect(await page.locator('link[rel="icon"]').getAttribute("href")).toBe("/assets/accounts-icon.svg?v=signa");
      const result = await page.evaluate(async () => {
        const configured = await fetch(document.body.dataset.audience + "/api/v1/health").then(response => response.json());
        const blocked = await fetch("https://unrelated.example.test/probe").then(() => false, () => true);
        return { configured, blocked };
      });
      expect(result).toEqual({ configured: { ok: true }, blocked: true });
      expect(reached).toEqual([audience + "/api/v1/health"]);
    } finally { await browser.close(); }
  });
});
