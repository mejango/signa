import { build } from "esbuild";
import { Hono } from "hono";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mountAccountsSite } from "../src/rest/accountsSite.js";
import type { JbcenterEnv } from "../src/types.js";
// @ts-expect-error The build script is plain ESM without declarations.
import { webBuildOptions } from "../scripts/rest/build-web.mjs";

const origin = "https://api.accounts.example.test", owner = "0x1111111111111111111111111111111111111111";

/** The production /accounts bundles: the signed-in controls are a second bundle the page loads after sign-in. */
describe("served /accounts page", () => {
  let browser: Browser, app: Hono<JbcenterEnv>;
  beforeAll(async () => {
    const built = await build({ ...webBuildOptions, entryPoints: { accounts: "src/rest/web/main.ts",
      "accounts-signed-in": "src/rest/web/accountsSignedIn.ts" }, write: false });
    const output = (name: string) => built.outputFiles!.find((file: { path: string }) => file.path.endsWith(`/${name}.js`))!.text;
    app = new Hono<JbcenterEnv>();
    mountAccountsSite(app, { audience: origin, accountsScript: output("accounts"), accountsSignedInScript: output("accounts-signed-in") });
    browser = await chromium.launch({ headless: true });
  }, 60_000);
  afterAll(async () => { await browser?.close(); });

  async function open(path: string, signedIn: boolean) {
    const page: Page = await browser.newPage(), lazy: string[] = [];
    await page.route(origin + "/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith("/assets/accounts-signed-in.")) lazy.push(url.pathname);
      if (url.pathname.startsWith("/api/")) return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      const response = await app.request(route.request().url());
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    });
    if (signedIn) await page.addInitScript(owner => {
      // A wallet this browser signed in with before, still connected: the page restores it without a prompt.
      localStorage.setItem("juicebox-center.sign-in", JSON.stringify({ version: 1, type: "external", rdns: "test.wallet", owner, chainId: 1 }));
      const provider = { request: async ({ method }: { method: string }) => method === "eth_accounts" ? [owner] : method === "eth_chainId" ? "0x1" : null, on() {}, removeListener() {} };
      window.addEventListener("eip6963:requestProvider", () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider",
        { detail: { info: { rdns: "test.wallet", name: "Test", icon: "data:," }, provider } })));
    }, owner);
    await page.goto(origin + path);
    return { page, lazy };
  }

  it("loads only the sign-in code for a signed-out visitor, and still opens a linked setup section", async () => {
    const { page, lazy } = await open("/accounts#operation-heading", false);
    await expect.poll(() => page.locator("#status").textContent()).toBe("Sign in to get started.");
    expect(await page.locator("#smart-setup").evaluate(node => (node as HTMLDetailsElement).open)).toBe(true);
    expect(await page.locator("#bot-management").isHidden()).toBe(true);
    expect(lazy).toEqual([]);
    await page.close();
  });

  it("loads the signed-in controls once an account connects, then shows them", async () => {
    const { page, lazy } = await open("/accounts", true);
    await expect.poll(() => page.locator("#status").textContent(), { timeout: 10_000 }).toBe("Signed in. Create or manage API access below.");
    expect(lazy).toHaveLength(1);
    expect(lazy[0]).toMatch(/^\/assets\/accounts-signed-in\.[0-9a-f]{12}\.js$/);
    expect(await page.locator("#bot-management").isVisible()).toBe(true);
    expect(await page.locator("#smart-fields").isDisabled()).toBe(false);
    await page.close();
  });
});
