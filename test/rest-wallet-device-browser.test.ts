import { build } from "esbuild";
import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright";
import { hashTypedData } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Both pages of adding a device, in Chromium, against a modeled Center: the account page begins
 * and shows the link as a code, the other device's page registers and proves its passkey, the
 * account page approves with its passkey, and both pages finish. */
describe("served device pages", () => {
  let server: Server, browser: Browser, origin: string;
  let accountScript: string, deviceScript: string, accountHtml: string, deviceHtml: string, css: string;
  const encode = (value: Buffer) => value.toString("base64url");
  const csrf = encode(Buffer.alloc(32, 9)), walletAddress = `0x${"03".repeat(20)}`, link = encode(Buffer.alloc(32, 21));
  const possessionDocument = { domain: { name: "Juicebox Center Wallet Device", version: "1", chainId: 8453, verifyingContract: walletAddress as `0x${string}` },
    types: { WalletDevice: [{ name: "purpose", type: "string" }] }, primaryType: "WalletDevice", message: { purpose: "add-device" } } as const;
  const requests: { path: string; body: any }[] = [];
  let phase = "awaiting_registration", approvals = 0, activations = 0;
  const view = () => ({ id: "11111111-1111-4111-8111-111111111111", passkeyName: "Test phone", rpId: "localhost", origin, expiresAtMs: Date.now() + 300_000,
    walletAddress, primarySigner: `0x${"04".repeat(20)}`, deviceSigner: phase === "awaiting_registration" ? null : `0x${"05".repeat(20)}`, phase, transactionHashes: [],
    registration: phase === "awaiting_registration" ? { challenge: encode(Buffer.alloc(32, 13)), userHandle: encode(Buffer.alloc(32, 14)), excludeCredentialIds: [encode(Buffer.alloc(16, 7))] } : null,
    possession: phase === "awaiting_possession" ? { credentialId: "x", document: possessionDocument, challenge: hashTypedData(possessionDocument) } : null });
  const session = () => ({ accountId: `eip155:8453:${walletAddress}`, loginId: "22222222-2222-4222-8222-222222222222", walletAddress, chainId: 8453, expiresAtMs: Date.now() + 3_600_000, passkeyName: "Mac" });

  beforeAll(async () => {
    const bundle = async (entry: string) => (await build({ entryPoints: [new URL(entry, import.meta.url).pathname], bundle: true, platform: "browser", format: "esm", target: "es2022", write: false })).outputFiles[0]!.text;
    accountScript = await bundle("../src/rest/web/wallet.ts"); deviceScript = await bundle("../src/rest/web/walletDevice.ts");
    const pages = await import("../src/rest/web/walletPage.js"), devicePage = await import("../src/rest/web/walletDevicePage.js");
    accountHtml = pages.walletPage(); css = pages.walletCss(); deviceHtml = devicePage.walletDevicePage();
    server = createServer(async (request, response) => {
      const path = new URL(request.url!, "http://localhost").pathname;
      const json = (value: unknown, status = 200) => { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(value)); };
      const html = (value: string) => { response.writeHead(200, { "content-type": "text/html" }); response.end(value); };
      if (path === "/wallet") return html(accountHtml);
      if (path === "/wallet/add") return html(deviceHtml);
      if (path === "/wallet/assets/wallet.js") { response.writeHead(200, { "content-type": "text/javascript" }); return response.end(accountScript); }
      if (path === "/wallet/assets/wallet-device.js") { response.writeHead(200, { "content-type": "text/javascript" }); return response.end(deviceScript); }
      if (path.endsWith(".css")) { response.writeHead(200, { "content-type": "text/css" }); return response.end(css); }
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      requests.push({ path, body });
      if (path === "/wallet/config") return json({ version: "center-wallet-v1", issuer: origin, audience: `${origin}/v1`, rpId: "localhost" });
      if (path === "/wallet/session") return json({ session: session(), csrfToken: csrf });
      if (path === "/wallet/networks") return json({ networks: [{ chainId: 8453, name: "Base", state: "deployed", txHash: null }], offered: [], pending: [] });
      if (path === "/wallet/devices/begin") return json({ view: view(), link: `${origin}/wallet/add#${link}` });
      if (path === "/wallet/devices/11111111-1111-4111-8111-111111111111") return json({ view: view() });
      if (path === "/wallet/devices/11111111-1111-4111-8111-111111111111/review") return json({ review: { deviceId: "11111111-1111-4111-8111-111111111111" }, document: {}, challenge: `0x${"16".repeat(32)}` });
      if (path === "/wallet/devices/11111111-1111-4111-8111-111111111111/approve") { approvals++; phase = "adding"; setTimeout(() => { phase = "awaiting_activation"; }, 200); return json({ view: view() }); }
      if (path === "/wallet/devices/11111111-1111-4111-8111-111111111111/activate") { activations++; phase = "ready"; return json({ view: view() }); }
      if (path === "/wallet/devices/link/state") return body?.linkToken === link ? json({ view: view() }) : json({ error: { message: "no" } }, 403);
      if (path === "/wallet/devices/link/register") { if (body?.linkToken !== link || body.type !== "public-key") return json({ error: {} }, 400); phase = "awaiting_possession"; return json({ view: view() }); }
      if (path === "/wallet/devices/link/prove") { if (body?.linkToken !== link || !body.assertion?.signature) return json({ error: {} }, 400); phase = "awaiting_approval"; return json({ view: view() }); }
      if (path === "/wallet/devices/link/activate") { activations++; phase = "ready"; return json({ view: view() }); }
      json({ error: { message: `unexpected ${path}` } }, 404);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    origin = `http://localhost:${(server.address() as { port: number }).port}`;
    browser = await chromium.launch();
  });
  afterAll(async () => { await browser?.close(); await new Promise<void>(resolve => server?.close(() => resolve())); });
  async function withAuthenticator(context: BrowserContext, page: Page, seeded: boolean): Promise<CDPSession> {
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    if (seeded) await cdp.send("WebAuthn.addCredential", { authenticatorId, credential: { credentialId: Buffer.alloc(16, 7).toString("base64"), userHandle: Buffer.alloc(32, 8).toString("base64"), rpId: "localhost", isResidentCredential: true, signCount: 0,
      privateKey: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "der", type: "pkcs8" }).toString("base64") } });
    return cdp;
  }

  it("does not replace the account's passkey on a device whose passkey manager already holds it", async () => {
    // The account's passkey syncs to this device, so the new passkey would share its user handle and replace it.
    const other = await browser.newContext(), devicePage = await other.newPage();
    await withAuthenticator(other, devicePage, true);
    await devicePage.goto(`${origin}/wallet/add#${link}`);
    await expect.poll(() => devicePage.locator("#wallet-status").textContent()).toBe("This device already has your account’s passkey. Sign in here instead.");
    expect(await devicePage.locator("#wallet-status").getAttribute("data-state")).toBe("ready");
    expect(await devicePage.locator("#device-signin").isVisible()).toBe(true);
    expect(await devicePage.locator("#device-next").isHidden()).toBe(true);
    expect(requests.filter(item => item.path === "/wallet/devices/link/register")).toHaveLength(0);
    await other.close();
  });

  it("shows the link as a code on the account page, walks the other device through its passkey, and approves here", async () => {
    const account = await browser.newContext(), accountPage = await account.newPage();
    await withAuthenticator(account, accountPage, true);
    const errors: string[] = []; accountPage.on("pageerror", error => errors.push(String(error)));
    await accountPage.goto(`${origin}/wallet`);
    await expect.poll(() => accountPage.locator("#wallet-device-add").isVisible()).toBe(true);
    await accountPage.locator("#wallet-device-add").click();
    await expect.poll(() => accountPage.locator("#wallet-device-code svg").count()).toBe(1);
    expect(await accountPage.locator("#wallet-device-link").getAttribute("href")).toBe(`${origin}/wallet/add#${link}`);
    expect(await accountPage.locator("#wallet-status").textContent()).toContain("Waiting for the other device");

    // The other device follows the link: its own page, its own authenticator, its own passkey.
    const other = await browser.newContext(), devicePage = await other.newPage();
    await withAuthenticator(other, devicePage, false);
    devicePage.on("pageerror", error => errors.push(String(error)));
    // The page opens the passkey prompt by itself. A browser that wants a tap first refuses it with
    // NotAllowedError; the button is then the way on, and the page waits without spinning.
    await devicePage.addInitScript(() => {
      const original = navigator.credentials.create.bind(navigator.credentials);
      (window as any).autoPrompts = 0;
      navigator.credentials.create = async (options?: CredentialCreationOptions) => {
        if ((window as any).autoPrompts++ === 0) throw new DOMException("The operation either timed out or was not allowed.", "NotAllowedError");
        return original(options);
      };
    });
    await devicePage.goto(`${origin}/wallet/add#${link}`);
    await expect.poll(() => devicePage.locator("#device-next").isVisible()).toBe(true);
    expect(await devicePage.evaluate(() => (window as any).autoPrompts)).toBe(1);
    expect(await devicePage.locator("#device-next").textContent()).toBe("Create passkey");
    expect(await devicePage.locator("#wallet-status").textContent()).toBe("Create a passkey on this device.");
    expect(await devicePage.locator("#wallet-status").getAttribute("data-state")).toBe("ready");
    expect(await devicePage.locator("#device-address").textContent()).toContain("0x0303");
    await devicePage.locator("#device-next").click();
    await expect.poll(() => devicePage.locator("#wallet-status").textContent(), { timeout: 10_000 }).toContain("Approve this device from the device you started on. It shows this device as 050505.");
    expect(requests.filter(item => item.path === "/wallet/devices/link/register")).toHaveLength(1);
    expect(requests.filter(item => item.path === "/wallet/devices/link/prove")).toHaveLength(1);

    // Back on the account page the poll picks up the proved device; approving takes one passkey prompt.
    await expect.poll(() => accountPage.locator("#wallet-device-approve").isVisible(), { timeout: 10_000 }).toBe(true);
    expect(await accountPage.locator("#wallet-device-code").isHidden()).toBe(true);
    expect(await accountPage.locator("#wallet-status").textContent()).toContain("if it shows 050505");
    // The approval stands alone: the account details and the section heading step aside.
    expect(await accountPage.locator("#wallet-details").isHidden()).toBe(true);
    expect(await accountPage.locator("#wallet-device-title").isHidden()).toBe(true);
    await accountPage.locator("#wallet-device-approve").click();
    await expect.poll(() => accountPage.locator("#wallet-status").textContent(), { timeout: 15_000 }).toContain("The device is added");
    expect(await accountPage.locator("#wallet-details").isVisible()).toBe(true);
    expect(approvals).toBe(1);
    const approval = requests.find(item => item.path.endsWith("/approve"))!;
    expect(approval.body.review.deviceId).toBe("11111111-1111-4111-8111-111111111111");
    expect(approval.body.assertion.signature).toMatch(/^[A-Za-z0-9_-]+$/);
    await expect.poll(() => devicePage.locator("#device-signin").isVisible(), { timeout: 10_000 }).toBe(true);
    expect(activations).toBeGreaterThanOrEqual(1);
    expect(errors).toEqual([]);
    await other.close(); await account.close();
  }, 60_000);
});
