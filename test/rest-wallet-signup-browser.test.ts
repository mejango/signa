import { build } from "esbuild";
import { createServer, type Server } from "node:http";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** The served signup page in Chromium, with a modeled Center. */
describe("served Center signup page", () => {
  let server: Server, browser: Browser, page: Page, origin: string, script: string, pageHtml: string, css: string;
  let releaseLogin: (() => void) | null = null;
  const errors: string[] = [];

  beforeAll(async () => {
    const built = await build({ entryPoints: [new URL("../src/rest/web/walletSignup.ts", import.meta.url).pathname],
      bundle: true, platform: "browser", format: "esm", target: "es2022", write: false });
    script = built.outputFiles[0]!.text;
    const production = await import("../src/rest/web/walletSignupPage.js");
    pageHtml = production.walletSignupPage(); css = production.walletSignupCss();
    server = createServer(async (request, response) => {
      const path = new URL(request.url!, "http://localhost").pathname;
      const json = (value: unknown, status = 200) => {
        response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(value));
      };
      if (path === "/wallet") { response.writeHead(200, { "content-type": "text/html" }); response.end(pageHtml); return; }
      if (path === "/wallet/assets/wallet-signup.js") { response.writeHead(200, { "content-type": "text/javascript" }); response.end(script); return; }
      if (path === "/wallet/assets/wallet-signup.css") { response.writeHead(200, { "content-type": "text/css" }); response.end(css); return; }
      if (path === "/wallet/config") return json({ version: "center-wallet-v1", issuer: origin, audience: `${origin}/v1`, rpId: "localhost" });
      if (path === "/wallet/signup/state") return json({ view: null });
      if (path === "/wallet/login/begin") {
        // Hold the sign-in open: the page must not keep offering the signup form meanwhile.
        await new Promise<void>(resolve => { releaseLogin = resolve; });
        return json({ error: { code: "WALLET_LOGIN_UNAVAILABLE", message: "private-detail" } }, 503);
      }
      json({ error: { message: `unexpected ${path}` } }, 404);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    origin = `http://localhost:${(server.address() as { port: number }).port}`;
    browser = await chromium.launch();
    page = await browser.newPage();
    page.on("pageerror", error => errors.push(String(error)));
  });
  afterAll(async () => { await browser?.close(); await new Promise<void>(resolve => server?.close(() => resolve())); });

  it("keeps the local default and edited name, and guides a passkey retry within the same signup", async () => {
    const context = await browser.newContext({ locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
    const signup = await context.newPage();
    try {
      await signup.clock.setFixedTime(new Date('2026-09-24T20:26:00Z'));
      await signup.goto(`${origin}/wallet`);
      const name = signup.getByLabel('Passkey name', { exact: true });
      await expect.poll(() => name.inputValue()).toBe('localhost | 5:26 PM Sep 24, 2026');
      await name.fill('My phone');
      await signup.getByLabel('A wallet you already have', { exact: true }).check();
      expect(await name.inputValue()).toBe('My phone');
      expect(await signup.locator('.brand').textContent()).toBe('🚬 SIGNA');
      expect(await signup.locator('#signup-begin').textContent()).toBe('Signa up');
      expect(await signup.locator('#signup-resume').textContent()).toBe('Signa in');
      await signup.getByLabel('A backup password made for you', { exact: true }).check();
      let begins = 0;
      await signup.route('**/wallet/signup/begin', route => {
        begins++;
        expect(route.request().postDataJSON().passkeyName).toBe('My phone');
        return route.fulfill({ json: { view: { phase: 'awaiting_registration', enrollmentId: 'same-signup',
          origin, rpId: 'localhost', passkeyName: 'My phone',
          registration: { challenge: Buffer.alloc(32, 1).toString('base64url'), userHandle: Buffer.alloc(32, 2).toString('base64url') } } } });
      });
      await signup.evaluate(() => {
        navigator.credentials.create = async () => { throw new DOMException('See https://www.w3.org/TR/webauthn-2/', 'NotAllowedError'); };
      });
      await signup.locator('#signup-begin').click();
      await expect.poll(() => signup.locator('#wallet-status').textContent()).toContain('We couldn’t finish with your passkey.');
      expect(await signup.locator('#wallet-status').getAttribute('data-state')).toBe('ready');
      expect(await signup.locator('#wallet-status').textContent()).not.toMatch(/NotAllowedError|https:/);
      await signup.getByRole('button', { name: 'Signa up', exact: true }).click();
      await expect.poll(() => signup.locator('#wallet-status').textContent()).toContain('We couldn’t finish with your passkey.');
      expect(begins).toBe(1);
    } finally { await context.close(); }
  });

  it("shows one filled button at a time, with clear space between buttons, on a phone", async () => {
    await page.setViewportSize({ width: 393, height: 852 });
    await page.goto(`${origin}/wallet`);
    await expect.poll(() => page.locator("#signup-form").isVisible()).toBe(true);
    // A signup begin that got no answer leaves the form up and offers a check; the check must not
    // compete with the form's own button, nor touch it.
    releaseLogin = null;
    await page.route("**/wallet/signup/begin", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "private-detail" } }) }));
    await page.locator("#signup-begin").click();
    await expect.poll(() => page.locator("#signup-check").isVisible(), { timeout: 10_000 }).toBe(true);
    const layout = await page.evaluate(() => {
      const visible = [...document.querySelectorAll("button")].filter(button => button.offsetParent !== null);
      const filled = visible.filter(button => getComputedStyle(button).backgroundColor !== "rgba(0, 0, 0, 0)");
      const begin = document.getElementById("signup-begin")!.getBoundingClientRect(), check = document.getElementById("signup-check")!.getBoundingClientRect();
      const actions = document.getElementById("signup-check")!.parentElement!;
      return { visible: visible.map(button => `${button.id}:${getComputedStyle(button).backgroundColor}`), filled: filled.map(button => button.id), gap: check.top - begin.bottom,
        debug: { begin: [begin.top, begin.bottom], check: [check.top, check.bottom], actionsTop: actions.getBoundingClientRect().top, actionsMargin: getComputedStyle(actions).marginTop, checkClass: document.getElementById("signup-check")!.className, formHidden: document.getElementById("signup-form")!.hidden } };
    });
    expect(layout.filled, JSON.stringify(layout.visible)).toEqual(["signup-begin"]);
    expect(layout.gap, JSON.stringify(layout.debug)).toBeGreaterThanOrEqual(12);
    await page.unroute("**/wallet/signup/begin");
    await page.setViewportSize({ width: 1200, height: 900 });
  });

  it("hides the signup form while sign-in is in progress, and offers it again after a failure", async () => {
    await page.goto(`${origin}/wallet`);
    await expect.poll(() => page.locator("#signup-form").isVisible()).toBe(true);
    await page.locator("#signup-resume").click();
    await expect.poll(() => page.locator("#signup-form").isHidden()).toBe(true);
    await expect.poll(() => page.locator("#wallet-status").textContent()).toContain("Signing in");
    expect(await page.locator("#signup-form").isHidden()).toBe(true);
    expect(await page.locator("#signup-resume").isHidden()).toBe(true);
    // On a phone every line of text shares one left edge and the status mark (a ::before
    // pseudo-element) hangs in the gutter, clear of the screen edge.
    await page.setViewportSize({ width: 390, height: 844 });
    const box = await page.evaluate(() => {
      const status = document.getElementById("wallet-status")!, main = document.querySelector("main")!, heading = document.querySelector("h1")!;
      const statusLeft = status.getBoundingClientRect().left;
      return { statusLeft, headingLeft: heading.getBoundingClientRect().left, mainLeft: main.getBoundingClientRect().left + parseFloat(getComputedStyle(main).paddingLeft),
        markScreenLeft: statusLeft + parseFloat(getComputedStyle(status, "::before").left) };
    });
    expect(box.statusLeft).toBeGreaterThanOrEqual(box.mainLeft - 0.5);
    expect(Math.abs(box.headingLeft - box.statusLeft)).toBeLessThan(1);
    expect(box.markScreenLeft).toBeGreaterThanOrEqual(12);
    await page.setViewportSize({ width: 1200, height: 900 });
    // Under load the held log-in request may not have reached the server yet.
    await expect.poll(() => releaseLogin !== null, { timeout: 10_000 }).toBe(true);
    releaseLogin!();
    await expect.poll(() => page.locator("#signup-form").isVisible()).toBe(true);
    expect(await page.locator("body").textContent()).not.toContain("private-detail");
    expect(errors).toEqual([]);
  }, 20_000);
});
