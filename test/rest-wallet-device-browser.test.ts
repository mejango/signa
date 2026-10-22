import { build } from "esbuild";
import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright";
import { hashTypedData } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signaChains } from "../src/rest/wallet/chains.js";
import { walletDeviceAdditionChallenge } from "../src/rest/web/walletRecoveryKit.js";

/** Both pages of adding a device, in Chromium, against a modeled Center: the account page begins
 * and shows the link as a code, the other device's page registers and proves its passkey, the
 * account page approves with its passkey, and both pages finish. */
describe("served device pages", () => {
  let server: Server, browser: Browser, origin: string;
  let qrScript: string, qrRequests = 0;
  let accountScript: string, deviceScript: string, accountHtml: string, deviceHtml: string, css: string;
  const encode = (value: Buffer) => value.toString("base64url");
  const csrf = encode(Buffer.alloc(32, 9)), walletAddress = `0x${"03".repeat(20)}`, link = encode(Buffer.alloc(32, 21));
  const possessionDocument = { domain: { name: "Juicebox Center Wallet Device", version: "1", chainId: 8453, verifyingContract: walletAddress as `0x${string}` },
    types: { WalletDevice: [{ name: "purpose", type: "string" }] }, primaryType: "WalletDevice", message: { purpose: "add-device" } } as const;
  const requests: { path: string; body: any }[] = [];
  let phase = "awaiting_registration", approvals = 0, activations = 0, otherChains = false, tampered = false, skewed = false, kitScript = "";
  // The account page rebuilds each addition it signs from the account and the device signer it shows.
  const deviceSigner = `0x${"05".repeat(20)}`, challengeOn = (chainId: number, nonce = "0") => walletDeviceAdditionChallenge(walletAddress, deviceSigner, nonce, chainId);
  const view = () => ({ id: "11111111-1111-4111-8111-111111111111", passkeyName: "Test phone", rpId: "localhost", origin, expiresAtMs: Date.now() + 300_000,
    walletAddress, primarySigner: `0x${"04".repeat(20)}`, deviceSigner: phase === "awaiting_registration" ? null : `0x${"05".repeat(20)}`, phase, transactionHashes: [],
    registration: phase === "awaiting_registration" ? { challenge: encode(Buffer.alloc(32, 13)), userHandle: encode(Buffer.alloc(32, 14)), excludeCredentialIds: [encode(Buffer.alloc(16, 7))] } : null,
    possession: phase === "awaiting_possession" ? { credentialId: "x", document: possessionDocument, challenge: hashTypedData(possessionDocument) } : null });
  const session = () => ({ accountId: `eip155:8453:${walletAddress}`, loginId: "22222222-2222-4222-8222-222222222222", walletAddress, chainId: 8453, expiresAtMs: Date.now() + 3_600_000, passkeyName: "Mac" });

  beforeAll(async () => {
    const bundle = async (entry: string) => (await build({ entryPoints: [new URL(entry, import.meta.url).pathname], bundle: true, platform: "browser", format: "esm", target: "es2022", write: false })).outputFiles[0]!.text;
    accountScript = await bundle("../src/rest/web/wallet.ts"); kitScript = await bundle("../src/rest/web/walletRecoveryKit.ts"); deviceScript = await bundle("../src/rest/web/walletDevice.ts");
    // The account page draws the device link's QR code with its own bundle, from the URL the page names.
    qrScript = await bundle("../src/rest/web/qr.ts");
    const pages = await import("../src/rest/web/walletPage.js"), devicePage = await import("../src/rest/web/walletDevicePage.js");
    accountHtml = pages.walletPage(); css = pages.walletCss(); deviceHtml = devicePage.walletDevicePage();
    server = createServer(async (request, response) => {
      const path = new URL(request.url!, "http://localhost").pathname;
      const json = (value: unknown, status = 200) => { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(value)); };
      const html = (value: string) => { response.writeHead(200, { "content-type": "text/html" }); response.end(value); };
      if (path === "/wallet") return html(accountHtml);
      if (path === "/wallet/add") return html(deviceHtml);
      if (path === "/wallet/assets/wallet.js") { response.writeHead(200, { "content-type": "text/javascript" }); return response.end(accountScript); }
      if (path === "/wallet/assets/wallet-qr.js") { qrRequests++; response.writeHead(200, { "content-type": "text/javascript" }); return response.end(qrScript); }
      if (path === "/wallet/assets/wallet-recovery-kit.js") { response.writeHead(200, { "content-type": "text/javascript" }); return response.end(kitScript); }
      if (path === "/wallet/assets/wallet-device.js") { response.writeHead(200, { "content-type": "text/javascript" }); return response.end(deviceScript); }
      if (path.endsWith(".css")) { response.writeHead(200, { "content-type": "text/css" }); return response.end(css); }
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      requests.push({ path, body });
      if (path === "/wallet/config") return json({ version: "center-wallet-v1", issuer: origin, audience: `${origin}/v1`, rpId: "localhost" });
      if (path === "/wallet/session") return json({ session: session(), csrfToken: csrf });
      if (path === "/wallet/networks") return json({ networks: [{ chainId: 8453, name: "Base", state: "deployed", txHash: null },
        ...(otherChains ? [{ chainId: 10, name: "Optimism", state: "deployed", txHash: null }, { chainId: 42161, name: "Arbitrum", state: "deployed", txHash: null }] : [])], offered: [], pending: [] });
      if (path === "/wallet/devices/begin") return json({ view: view(), link: `${origin}/wallet/add#${link}` });
      if (path === "/wallet/devices/11111111-1111-4111-8111-111111111111") return json({ view: view() });
      if (path === "/wallet/devices/11111111-1111-4111-8111-111111111111/review") return json({ review: { deviceId: "11111111-1111-4111-8111-111111111111", safeNonce: "0" }, document: {}, challenge: challengeOn(8453),
        chains: otherChains ? [{ chainId: 10, review: { chainId: 10, safeNonce: skewed ? "1" : "0" }, challenge: tampered ? `0x${"17".repeat(32)}` : challengeOn(10, skewed ? "1" : "0") },
          { chainId: 42161, review: { chainId: 42161, safeNonce: "0" }, challenge: challengeOn(42161) }] : [] });
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
  /** Each chain's public RPC as the account page reads it: the account's one passkey signer owns it, at nonce 0. */
  async function chainRpcs(context: BrowserContext) {
    const word = (value: string | bigint) => BigInt(value).toString(16).padStart(64, "0"), reads: number[] = [];
    await context.route(url => signaChains.some(chain => url.href.replace(/\/$/, "") === chain.publicRpc), async route => {
      const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      const chainId = signaChains.find(chain => route.request().url().replace(/\/$/, "") === chain.publicRpc)!.chainId; reads.push(chainId);
      const calls: Record<string, string> = { "0xa0e67e2b": `0x${word(32n)}${word(1n)}${word(`0x${"04".repeat(20)}`)}`, "0xe75235b8": `0x${word(1n)}`, "0xaffed0e0": `0x${word(0n)}` };
      const result = (request: { method: string; params: any[] }) => request.method === "eth_chainId" ? `0x${chainId.toString(16)}`
        : request.method === "eth_getBlockByNumber" ? { hash: `0x${"ab".repeat(32)}` } : request.method === "eth_getCode" ? "0x6080" : calls[request.params[0].data];
      return route.fulfill({ headers: cors, json: (JSON.parse(route.request().postData()!) as { id: number; method: string; params: any[] }[]).map(request => ({ jsonrpc: "2.0", id: request.id, result: result(request) })) });
    });
    return reads;
  }
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
    await chainRpcs(account);
    await withAuthenticator(account, accountPage, true);
    const errors: string[] = []; accountPage.on("pageerror", error => errors.push(String(error)));
    await accountPage.goto(`${origin}/wallet`);
    await expect.poll(() => accountPage.locator("#wallet-device-add").isVisible()).toBe(true);
    expect(qrRequests).toBe(0);
    await accountPage.locator("#wallet-device-add").click();
    await expect.poll(() => accountPage.locator("#wallet-device-code svg").count()).toBe(1);
    expect(qrRequests).toBe(1);
    // Without the code (its bundle stalls or fails), the link is still offered and the page moves on.
    const fallback = await account.newPage();
    await fallback.route("**/wallet/assets/wallet-qr.js", () => new Promise<void>(() => {}));
    await fallback.goto(`${origin}/wallet`);
    await expect.poll(() => fallback.locator("#wallet-device-add").isVisible()).toBe(true);
    await fallback.locator("#wallet-device-add").click();
    await expect.poll(() => fallback.locator("#wallet-device-link").getAttribute("href")).toBe(`${origin}/wallet/add#${link}`);
    await expect.poll(() => fallback.locator("#wallet-status").textContent()).toContain("Waiting for the other device");
    expect(await fallback.locator("#wallet-device-code svg").count()).toBe(0);
    await fallback.close();
    // A failed bundle shows the same link and raises no page error.
    const failed = await account.newPage(), failedErrors: string[] = []; failed.on("pageerror", error => failedErrors.push(String(error)));
    // The link request is held until the bundle has failed, so the failure lands while it is pending.
    let qrFailed!: () => void; const qrFailure = new Promise<void>(resolve => { qrFailed = resolve; });
    await failed.route("**/wallet/assets/wallet-qr.js", async route => { await route.abort(); setTimeout(qrFailed, 200); });
    await failed.route("**/wallet/devices/begin", async route => { await qrFailure; await route.continue(); });
    await failed.goto(`${origin}/wallet`);
    await expect.poll(() => failed.locator("#wallet-device-add").isVisible()).toBe(true);
    await failed.locator("#wallet-device-add").click();
    await expect.poll(() => failed.locator("#wallet-device-link").getAttribute("href")).toBe(`${origin}/wallet/add#${link}`);
    await expect.poll(() => failed.locator("#wallet-status").textContent()).toContain("Waiting for the other device");
    expect(await failed.locator("#wallet-device-code svg").count()).toBe(0);
    expect(failedErrors).toEqual([]);
    await failed.close();
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
  it("adds the device on every network the account is on, one confirmation each, keeping those given when a prompt is dropped", async () => {
    phase = "awaiting_approval"; otherChains = true; approvals = 0; requests.length = 0;
    const account = await browser.newContext(), accountPage = await account.newPage();
    const reads = await chainRpcs(account);
    await withAuthenticator(account, accountPage, true);
    const errors: string[] = []; accountPage.on("pageerror", error => errors.push(String(error)));
    // The second prompt is dropped once, as a browser that wants a fresh tap per prompt does.
    await accountPage.addInitScript(() => {
      const original = navigator.credentials.get.bind(navigator.credentials);
      (window as any).prompts = [];
      navigator.credentials.get = async (options?: CredentialRequestOptions) => {
        const raw = options!.publicKey!.challenge, bytes = ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : new Uint8Array(raw);
        const challenge = bytes[0]!.toString(16).padStart(2, "0");
        (window as any).prompts.push(challenge);
        if ((window as any).prompts.length === 2) throw new DOMException("The operation either timed out or was not allowed.", "NotAllowedError");
        return original(options);
      };
    });
    await accountPage.goto(`${origin}/wallet`);
    await expect.poll(() => accountPage.locator("#wallet-device-add").isVisible()).toBe(true);
    await accountPage.locator("#wallet-device-add").click();
    // One screen says where the device is added and that this device confirms each.
    await expect.poll(() => accountPage.locator("#wallet-status").textContent()).toBe(
      "The other device is ready and shows 050505. Add this device on Base, Optimism and Arbitrum. Your current device confirms each.");
    // A review whose hash is not the addition this page shows is refused before any prompt.
    tampered = true;
    await expect.poll(() => accountPage.locator("#wallet-device-approve").isVisible()).toBe(true);
    await accountPage.locator("#wallet-device-approve").click();
    await expect.poll(() => accountPage.locator("#wallet-status").textContent()).toContain("could not be verified");
    expect(await accountPage.evaluate(() => (window as any).prompts)).toEqual([]);
    tampered = false;
    // So is an addition rebuilt as asked but at a nonce Optimism is not at: it could be held and run after the device is removed.
    skewed = true; reads.length = 0;
    await accountPage.locator("#wallet-device-approve").click();
    await expect.poll(() => reads.includes(10)).toBe(true);
    await expect.poll(() => accountPage.locator("#wallet-status").textContent()).toContain("could not be verified");
    expect(await accountPage.evaluate(() => (window as any).prompts)).toEqual([]);
    skewed = false;
    await accountPage.locator("#wallet-device-approve").click();
    await expect.poll(() => accountPage.evaluate(() => (window as any).prompts.length)).toBe(2);
    await expect.poll(() => accountPage.locator("#wallet-device-approve").isVisible()).toBe(true);
    expect(approvals).toBe(0);
    // The next tap asks only for what is missing: Optimism again, then Arbitrum. Base's confirmation is kept.
    await accountPage.locator("#wallet-device-approve").click();
    await expect.poll(() => approvals, { timeout: 15_000 }).toBe(1);
    const first = (chainId: number) => challengeOn(chainId).slice(2, 4);
    expect(await accountPage.evaluate(() => (window as any).prompts)).toEqual([first(8453), first(10), first(10), first(42161)]);
    const approval = requests.find(item => item.path.endsWith("/approve"))!;
    expect(approval.body.chains.map((item: { chainId: number }) => item.chainId)).toEqual([10, 42161]);
    expect(new Set([approval.body.assertion.signature, ...approval.body.chains.map((item: { assertion: { signature: string } }) => item.assertion.signature)]).size).toBe(3);
    expect(errors).toEqual([]);
    otherChains = false; await account.close();
  }, 60_000);
});
