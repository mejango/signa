import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { createPublicKey, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type Browser, type CDPSession, type Page } from "playwright";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { parseWalletRegistration, type WalletRegistrationCandidate } from "../src/rest/wallet/registration.js";
import { verifyWalletAssertion, type WalletAssertion } from "../src/rest/wallet/webauthn.js";
import { walletPageHeaders } from "../src/rest/wallet/http.js";

const encode = (value: Uint8Array) => Buffer.from(value).toString("base64url");
const decode = (value: string) => Buffer.from(value, "base64url");
const hex = (value: Uint8Array): `0x${string}` => `0x${Buffer.from(value).toString("hex")}`;
const output = new URL("../.generated/wallet-observations/browser-required/", import.meta.url);
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Center passkey compatibility</title>
<style>body{font:16px monospace;background:#faf9f6;color:#171717;max-width:640px;margin:80px auto;padding:24px}pre{white-space:pre-wrap;line-height:1.6}</style></head>
<body><h1>Center passkey compatibility</h1><pre id="status">Testing registration and possession proof.</pre><p>Local virtual authenticator. No wallet or payment is created.</p><p>Physical-device acceptance remains pending.</p></body></html>`;

describe("actual Chromium WebAuthn producer and Center verification", () => {
  let server: Server | undefined;
  let browser: Browser | undefined;
  let page: Page;
  let cdp: CDPSession;
  let authenticatorId: string;
  let origin: string;
  let candidate: WalletRegistrationCandidate;
  let browserPublicKey: WalletRegistrationCandidate["publicKey"];
  const userHandle = encode(randomBytes(32));
  const registrationChallenge = randomBytes(32);
  const pageErrors: string[] = [];

  beforeAll(async () => {
    server = createServer((_, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(html);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Local browser test server did not start.");
    origin = `http://localhost:${address.port}`;
    // Pinned Playwright installs its matching Chromium in local development and CI.
    // This is a virtual-authenticator observation, never a physical-device assertion.
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1000, height: 750 } });
    page = await context.newPage();
    page.on("pageerror", error => pageErrors.push(error.message));
    cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    ({ authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
      protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
    } }));
    await page.goto(origin);
    await enrollCandidate();
  }, 30_000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()));
  });

  async function assertion(challenge: Uint8Array, userVerification: "required" | "discouraged" = "required"): Promise<WalletAssertion> {
    const response = await page.evaluate(async input => {
      const bytes = (value: string) => Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
      const encode = (value: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
      // Deliberately omit allowCredentials: the stable handle must come from discoverable selection.
      const credential = await navigator.credentials.get({ publicKey: {
        rpId: "localhost", challenge: bytes(input.challenge), userVerification: input.userVerification, timeout: 5_000,
      } }) as PublicKeyCredential;
      const response = credential.response as AuthenticatorAssertionResponse;
      return { credentialId: credential.id, authenticatorData: encode(response.authenticatorData), clientDataJSON: encode(response.clientDataJSON),
        signature: encode(response.signature), userHandle: response.userHandle ? encode(response.userHandle) : null };
    }, { challenge: encode(challenge), userVerification });
    return { ...response, authenticatorData: decode(response.authenticatorData), clientDataJSON: decode(response.clientDataJSON), signature: decode(response.signature) };
  }

  const expected = (challenge: Uint8Array) => ({ purpose: "registration" as const, challenge: hex(challenge), rpId: "localhost", origin,
    credential: { id: candidate.credentialId, publicKey: candidate.publicKey, userHandle, backupEligible: candidate.backupEligible }, requireUserHandle: true });

  async function enrollCandidate() {
    const registration = await page.evaluate(async input => {
      const bytes = (value: string) => Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
      const encode = (value: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
      const credential = await navigator.credentials.create({ publicKey: {
        rp: { id: "localhost", name: "Center local compatibility" },
        user: { id: bytes(input.userHandle), name: "Local test", displayName: "Local test" },
        challenge: bytes(input.challenge), pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
        attestation: "none", timeout: 5_000,
      } }) as PublicKeyCredential;
      const response = credential.response as AuthenticatorAttestationResponse;
      return { type: credential.type, credentialId: credential.id, rawId: encode(credential.rawId), clientDataJSON: encode(response.clientDataJSON),
        attestationObject: encode(response.attestationObject), publicKey: encode(response.getPublicKey()!) };
    }, { challenge: encode(registrationChallenge), userHandle });
    if (registration.type !== "public-key") throw new Error("Browser returned an unsupported credential.");
    candidate = parseWalletRegistration({ type: registration.type, credentialId: registration.credentialId, rawId: decode(registration.rawId),
      clientDataJSON: decode(registration.clientDataJSON), attestationObject: decode(registration.attestationObject) },
    { challenge: hex(registrationChallenge), rpId: "localhost", origin, userHandle });
    const jwk = createPublicKey({ key: decode(registration.publicKey), format: "der", type: "spki" }).export({ format: "jwk" });
    browserPublicKey = { x: hex(decode(jwk.x!)), y: hex(decode(jwk.y!)) };
  }

  it("parses actual none attestation and proves possession with a discoverable UV assertion", async () => {
    expect(candidate.publicKey).toEqual(browserPublicKey);
    const challenge = randomBytes(32), response = await assertion(challenge);
    expect(response.userHandle).toBe(userHandle);
    const verified = verifyWalletAssertion(response, expected(challenge));
    expect((verified.contractSignature.length - 2) / 2).toBeLessThanOrEqual(2240);
    expect(pageErrors).toEqual([]);
    await page.locator("#status").evaluate(element => { element.textContent = "Browser credential parsed by Center.\nDiscoverable possession assertion verified.\nExpected user handle matched."; });
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: new URL("chromium-passkey.png", output).pathname, fullPage: true });
    // No credential, assertion or private key is persisted in the observation.
    await writeFile(new URL("summary.json", output), JSON.stringify({ tier: "virtual-authenticator", browserVersion: browser!.version(),
      registrationParsed: true, possessionVerified: true, discoverableGet: true, userHandleMatched: true,
      contractSignatureBytes: (verified.contractSignature.length - 2) / 2, physicalDeviceObserved: false }, null, 2), { mode: 0o600 });
  }, 20_000);

  it("rejects genuine browser assertions for a different challenge or origin", async () => {
    const challenge = randomBytes(32), response = await assertion(challenge), expectation = expected(challenge);
    expect(() => verifyWalletAssertion(response, expectation)).not.toThrow();
    expect(() => verifyWalletAssertion(response, { ...expectation, challenge: hex(randomBytes(32)) })).toThrow();
    expect(() => verifyWalletAssertion(response, { ...expectation, origin: "http://localhost:1" })).toThrow();
  });

  it("rejects an actual authenticator signature without user verification", async () => {
    await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: false });
    try {
      const challenge = randomBytes(32), response = await assertion(challenge, "discouraged");
      expect(response.authenticatorData[32]! & 4).toBe(0);
      expect(() => verifyWalletAssertion(response, expected(challenge))).toThrow();
    } finally { await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: true }); }
  });
});

describe("served Center wallet UI (local HTTP contract, virtual authenticator)", () => {
  let server: Server, browser: Browser, page: Page, origin: string, script: string, signupScript: string;
  let pageHtml: string, css: string, productionWaysHtml: string, signupHtml: string, signupCss: string;
  // Production serves the landing with signup and recovery offered; most tests here use the plain page.
  let landingWays = false;
  // Onramp routes answer only in the funds test; elsewhere they 404 and the link stays hidden.
  let onramp = false;
  const vid = (n: number) => `onramp_verification_${String(n).repeat(8)}-0000-4000-8000-000000000000`;
  const csrf = encode(Buffer.alloc(32, 9)), intentId = encode(Buffer.alloc(32, 10));
  const state = encode(Buffer.alloc(32, 11)), code = encode(Buffer.alloc(32, 12));
  const challenge = encode(Buffer.alloc(32, 13)), handle = encode(Buffer.alloc(32, 14));
  const walletAddress = `0x${"03".repeat(20)}`;
  const requests: { path: string; body: any; headers: Record<string, string | string[] | undefined> }[] = [];
  let authenticated: boolean, unavailableSessions: number, unavailableCompletions: number, droppedCompletion: boolean;
  let unavailableIssues = 0;
  let requireSessionCookie: boolean, recoveredLoginId: string | undefined;
  let redirectOverride: string | undefined, sessionReads: number, begins: number, completions: number, issues: number;
  let authenticatorId: string, cdp: CDPSession;
  const errors: string[] = [];
  const loginId = "11111111-1111-4111-8111-111111111111";
  const publicSession = () => ({ accountId: `eip155:8453:${walletAddress}`, loginId, walletAddress, chainId: 8453, expiresAtMs: Date.now() + 3_600_000 });
  const callback = () => `${origin}/app/callback`;
  let intentExpired = false;
  const intent = () => ({ id: intentId, state: "prepared", createdAtMs: Date.now() - 1_000, expiresAtMs: Date.now() + 180_000,
    request: { origin, callbackUri: callback(), state, issuer: origin, audience: `${origin}/v1` } });

  beforeAll(async () => {
    // Build the production browser entry; test-only DOM controllers cannot satisfy this suite.
    const built = await build({ entryPoints: [new URL("../src/rest/web/wallet.ts", import.meta.url).pathname],
      bundle: true, platform: "browser", format: "esm", target: "es2022", write: false });
    script = built.outputFiles[0]!.text;
    const productionPage = await import("../src/rest/web/walletPage.js");
    pageHtml = productionPage.walletPage(); css = productionPage.walletCss(); productionWaysHtml = productionPage.walletPage(true, true);
    signupScript = (await build({ entryPoints: [new URL("../src/rest/web/walletSignup.ts", import.meta.url).pathname],
      bundle: true, platform: "browser", format: "esm", target: "es2022", write: false })).outputFiles[0]!.text;
    const signupPage = await import("../src/rest/web/walletSignupPage.js");
    signupHtml = signupPage.walletSignupPage(); signupCss = signupPage.walletSignupCss();
    server = createServer(async (request, response) => {
      const path = new URL(request.url!, origin).pathname;
      const json = (value: unknown, status = 200) => {
        response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify(value));
      };
      if (path === "/wallet" || path === "/wallet/ways") {
        // /wallet/ways renders the landing with signup and recovery offered, as production does for an app intent.
        response.writeHead(200, { "content-type": "text/html", "content-security-policy": walletPageHeaders["Content-Security-Policy"] });
        response.end(path === "/wallet/ways" || landingWays ? productionWaysHtml : pageHtml); return;
      }
      if (path === "/wallet/create") { response.writeHead(200, { "content-type": "text/html" }); response.end(signupHtml); return; }
      if (path === "/wallet/assets/wallet-signup.js" || path === "/wallet/assets/wallet-signup.css") {
        response.writeHead(200, { "content-type": path.endsWith(".js") ? "text/javascript" : "text/css" });
        response.end(path.endsWith(".js") ? signupScript : signupCss); return;
      }
      if (path === "/wallet/assets/wallet.js" || path === "/wallet/assets/wallet.css") {
        response.writeHead(200, { "content-type": path.endsWith(".js") ? "text/javascript" : "text/css" });
        response.end(path.endsWith(".js") ? script : css); return;
      }
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      requests.push({ path, body, headers: request.headers });
      if (path === "/wallet/config") return json({ version: "center-wallet-v1", issuer: origin, audience: `${origin}/v1`, rpId: "localhost" });
      if (path === "/wallet/session") {
        sessionReads++;
        if (unavailableSessions-- > 0) return json({ error: { message: "private-provider-detail" } }, 503);
        if (recoveredLoginId) return json({ session: { ...publicSession(), loginId: recoveredLoginId }, csrfToken: encode(Buffer.alloc(32, 31)) });
        return json(authenticated && (!requireSessionCookie || request.headers.cookie?.includes("test-session=opaque"))
          ? { session: publicSession(), csrfToken: csrf } : { session: null });
      }
      if (path === "/wallet/signup/state" || path === "/wallet/signup/framed/state") return json({ view: null });
      if (path === `/wallet/authorize/${intentId}/begin`) {
        begins++;
        return json({ loginId, flowToken: encode(Buffer.alloc(32, 15)), publicKey: { rpId: "localhost", challenge, userVerification: "required", timeout: 90_000 },
          expiresAtMs: Date.now() + 180_000 }, 201);
      }
      if (path === `/wallet/authorize/${intentId}`) return intentExpired
        ? json({ error: { code: "WALLET_HANDOFF_EXPIRED", message: "private-detail" }, app: { origin: "https://beep.example" } }, 410) : json(intent());
      if (path === "/wallet/login/begin") {
        begins++;
        response.setHeader("set-cookie", "test-flow=opaque; HttpOnly; SameSite=Lax; Path=/wallet");
        return json({ loginId: "11111111-1111-4111-8111-111111111111", publicKey: {
          rpId: "localhost", challenge, userVerification: "required", timeout: 90_000,
        }, expiresAtMs: Date.now() + 180_000, csrfToken: csrf }, 201);
      }
      if (path === "/wallet/login/complete") {
        completions++;
        if (unavailableCompletions-- > 0) return json({ error: { message: "private-provider-detail" } }, 503);
        authenticated = true; requireSessionCookie = true;
        response.setHeader("set-cookie", ["test-session=opaque; HttpOnly; SameSite=Lax; Path=/wallet", "test-flow=; Max-Age=0; Path=/wallet"]);
        if (droppedCompletion) {
          droppedCompletion = false;
          // Cut a response after headers/body start, so Chromium cannot transparently retry
          // a request whose acceptance is unknown to the page.
          response.writeHead(200, { "content-type": "application/json", "content-length": "4096" });
          response.write('{"session":', () => response.destroy()); return;
        }
        return json({ session: publicSession(), csrfToken: csrf, replayed: completions > 1 });
      }
      if (path === "/wallet/authorize/issue") {
        issues++;
        if (unavailableIssues-- > 0) return json({ error: { code: "WALLET_AUTHORITY_CHECKING", message: "private-provider-detail" } }, 503);
        return json({ redirectUri: redirectOverride ?? `${callback()}?${new URLSearchParams({ code, state, iss: origin })}` });
      }
      if (onramp && path === "/wallet/onramp") return json({ applePay: true });
      if (onramp && path === "/wallet/balances") return json({ ethUsd: "250000000000", totalUsdCents: "251234", complete: false, chains: [
        { chainId: 8453, name: "Base", testnet: false, eth: "1000000000000000000", usdc: "0" },
        { chainId: 10, name: "Optimism", testnet: false, eth: "0", usdc: "12345678" },
        { chainId: 42161, name: "Arbitrum", testnet: false, eth: null, usdc: null },
        { chainId: 84532, name: "Base Sepolia", testnet: true, eth: "0", usdc: "5000000" },
        { chainId: 1, name: "Ethereum", testnet: false, eth: "0", usdc: "0" }] });
      if (onramp && path === "/wallet/onramp/verify") return json({ verificationId: vid(body.channel === "sms" ? 1 : 2) });
      if (onramp && path === "/wallet/onramp/confirm") return body.code === "123456" ? json({ verificationId: body.verificationId, verifiedAtMs: Date.now(), expiresAt: null })
        : json({ error: { code: "WALLET_ONRAMP_CODE_INVALID", message: "x" } }, 400);
      if (onramp && path === "/wallet/onramp/order") return json({ orderId: "order-1", url: "https://pay.coinbase.com/apple-pay?order=1", userAuthToken: "auth-token" });
      if (onramp && path === "/wallet/onramp/session") return json({ url: "https://pay.coinbase.com/buy?sessionToken=t" });
      if (onramp && path === "/wallet/onramp/status") return json({ orderId: "order-1", status: "pending_payment", txHash: null });
      if (path === "/wallet/logout") { authenticated = false; return json({ loggedOut: true, replayed: false }); }
      if (path === "/app/callback") { response.writeHead(200, { "content-type": "text/html" }); response.end("<p>App callback</p>"); return; }
      return json({}, 404);
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing browser fixture port");
    origin = `http://localhost:${address.port}`;
    browser = await chromium.launch({ headless: true });
  }, 30_000);

  beforeEach(async () => {
    authenticated = false; landingWays = false; onramp = false; unavailableSessions = 0; unavailableCompletions = 0; droppedCompletion = false;
    requireSessionCookie = false; recoveredLoginId = undefined;
    redirectOverride = undefined; sessionReads = 0; begins = 0; completions = 0; issues = 0;
    requests.length = 0; errors.length = 0;
    const context = await browser.newContext({ viewport: { width: 360, height: 780 } });
    page = await context.newPage(); page.setDefaultTimeout(3_000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "log") errors.push(message.text()); });
    await page.addInitScript(() => {
      const original = navigator.credentials.get.bind(navigator.credentials);
      (window as any).passkeyRequests = 0;
      navigator.credentials.get = options => { (window as any).passkeyRequests++; return original(options); };
    });
    cdp = await context.newCDPSession(page); await cdp.send("WebAuthn.enable");
    ({ authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
      protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
    } }));
  });
  afterEach(async () => { await page?.context().close(); });
  afterAll(async () => {
    const results = await Promise.allSettled([browser?.close(), server?.listening ? new Promise<void>(resolve => server.close(() => resolve())) : undefined]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
  });
  const status = async (expected: string) => expect.poll(() => page.locator("#wallet-status").getAttribute("data-state"), { timeout: 5_000 }).toBe(expected);
  async function loadAndEnroll() {
    await page.goto(`${origin}/wallet`); await status("ready");
    // Fixture enrollment creates only a virtual device credential; production UI exposes no enrollment.
    await page.evaluate(async ({ handle }) => {
      await navigator.credentials.create({ publicKey: { rp: { id: "localhost", name: "UI fixture" },
        user: { id: Uint8Array.from(atob(handle), value => value.charCodeAt(0)), name: "Fixture", displayName: "Fixture" },
        challenge: new Uint8Array(32).fill(17), pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        authenticatorSelection: { residentKey: "required", userVerification: "required" }, attestation: "none" } });
    }, { handle });
  }

  it("offers the other ways in as quiet text links under one primary button", async () => {
    authenticated = false;
    // An app return without a session is where the other ways in are offered.
    await page.goto(`${origin}/wallet/ways?intent=${intentId}`); await status("ready");
    expect(await page.locator('#wallet-signin').textContent()).toBe('Signa in');
    expect(await page.locator('#wallet-status').textContent()).toContain('Face ID, Touch ID');
    const brandLabel = await page.locator('.brand-label').boundingBox();
    const brandIcon = await page.locator('.brand-icon').boundingBox();
    const heading = await page.locator('h1').boundingBox();
    expect(brandLabel && brandIcon && heading && Math.abs(brandLabel.x - heading.x)).toBeLessThan(1);
    // The mark sits clear of the word, and still inside the screen.
    expect(brandLabel!.x - (brandIcon!.x + brandIcon!.width)).toBeGreaterThanOrEqual(10);
    expect(brandIcon!.x).toBeGreaterThanOrEqual(0);
    const links = await page.evaluate(() => [...document.querySelectorAll("#wallet-links a")].map(a => ({
      text: a.textContent!.trim(), color: getComputedStyle(a).color, size: parseFloat(getComputedStyle(a).fontSize) })));
    expect(links.map(link => link.text)).toEqual(["Signa up", "Recover"]);
    const body = parseFloat(await page.evaluate(() => getComputedStyle(document.body).fontSize));
    for (const link of links) { expect(link.color).not.toBe("rgb(0, 0, 238)"); expect(link.size).toBeLessThan(body); }
    expect(await page.evaluate(() => [...document.querySelectorAll("button")].filter(b => b.offsetParent !== null && getComputedStyle(b).backgroundColor !== "rgba(0, 0, 0, 0)").length)).toBe(1);
  });

  it.each(["admitted", "wrong-origin"])("accepts only plain heading fonts from the admitted parent (%s)", async parent => {
    const otherOrigin = origin.replace("localhost", "127.0.0.1"), framedUrl = `${origin}/wallet?intent=${intentId}`;
    await page.route(framedUrl, async route => {
      const response = await route.fetch(), headers = response.headers();
      // Admit both fixture parents at the HTTP layer to exercise the intent-bound message check independently.
      headers["content-security-policy"] = headers["content-security-policy"]!.replace("frame-ancestors 'none'", `frame-ancestors ${origin} ${otherOrigin}`);
      await route.fulfill({ response, headers });
    });
    await page.goto(`${parent === "admitted" ? origin : otherOrigin}/app/callback`);
    await page.evaluate(() => window.addEventListener('message', event => {
      if (event.data?.type === 'juicebox-center:page') document.documentElement.dataset.framePage = event.data.page;
    }));
    await page.evaluate(src => { const frame = document.createElement("iframe"); frame.src = src; document.body.append(frame); }, framedUrl);
    await expect.poll(() => page.frames().some(frame => frame.url() === framedUrl)).toBe(true);
    const frame = page.frames().find(frame => frame.url() === framedUrl)!;
    await expect.poll(() => frame.locator("#wallet-status").getAttribute("data-state")).toBe("brand");
    expect(await frame.locator('#wallet-status').textContent()).toBe('Powered by Signa');
    expect(await frame.locator('#wallet-status').evaluate(node => getComputedStyle(node, '::before').content)).toBe('none');
    const brandLink = frame.locator('#wallet-status a');
    expect(await brandLink.getAttribute('href')).toBe('https://signa.center');
    expect(await brandLink.getAttribute('target')).toBe('_blank');
    expect(await brandLink.getAttribute('rel')).toBe('noopener noreferrer');
    expect(await brandLink.evaluate(node => getComputedStyle(node).textDecorationLine)).toBe('none');
    if (parent === 'admitted') await expect.poll(() => page.locator('html').getAttribute('data-frame-page')).toBe('signin');
    else expect(await page.locator('html').getAttribute('data-frame-page')).toBeNull();
    expect(await frame.locator('#wallet-signin').textContent()).toBe('Signa in');
    const statusBox = await frame.locator('#wallet-status').boundingBox(), fullScreenBox = await frame.locator('#wallet-open').boundingBox();
    const linksBox = await frame.locator('#wallet-links').boundingBox();
    expect(statusBox && fullScreenBox && linksBox && statusBox.y > linksBox.y + linksBox.height && fullScreenBox.y < statusBox.y).toBe(true);
    expect(await frame.locator('#wallet-status').evaluate(node => getComputedStyle(node).fontWeight)).toBe('400');
    expect(await frame.locator('h1').evaluate(heading => getComputedStyle(heading).clipPath)).toBe('inset(50%)');
    const headingFont = () => frame.locator("h1").evaluate(heading => getComputedStyle(heading).fontFamily);
    const originalFont = await headingFont();
    await frame.evaluate(() => window.addEventListener("message", () => {
      document.documentElement.dataset.themeMessages = String(Number(document.documentElement.dataset.themeMessages ?? 0) + 1);
    }));
    let messages = 0;
    for (const theme of [{ headingFont: '"Courier New", monospace' }, { headingFont: 42 },
      { headingFont: "url(https://outside.invalid/font.woff2)" }, { headingFont: "serif; color: red" }, { font: "serif" }]) {
      await page.evaluate(({ origin, theme }) => {
        document.querySelector("iframe")!.contentWindow!.postMessage({ type: "juicebox-center:theme", theme }, origin);
      }, { origin, theme });
      // Observe actual delivery before checking rejection; a late message cannot make this pass.
      await expect.poll(() => frame.locator("html").getAttribute("data-theme-messages")).toBe(String(++messages));
      expect(await headingFont()).toBe(parent === "admitted" ? '"Courier New", monospace' : originalFont);
      expect(await frame.locator("body").evaluate(body => getComputedStyle(body).fontFamily)).toBe(parent === "admitted" && "font" in theme ? "serif" : originalFont);
    }
    expect(await frame.evaluate(() => JSON.parse(sessionStorage.getItem("center:frame-theme") ?? "{}")))
      .toEqual(parent === "admitted" ? { headingFont: '"Courier New", monospace', font: "serif" } : {});
    await frame.goto(framedUrl);
    await expect.poll(() => frame.locator("#wallet-status").getAttribute("data-state")).toBe("brand");
    expect(await headingFont()).toBe(parent === "admitted" ? '"Courier New", monospace' : originalFont);
    expect(await frame.locator("body").evaluate(body => getComputedStyle(body).fontFamily)).toBe(parent === "admitted" ? "serif" : originalFont);
    expect(errors).toEqual([]);
  });

  it("takes the app's corner radius and keeps a narrow frame's button compact beside the fullscreen mark", async () => {
    const framedUrl = `${origin}/wallet?intent=${intentId}`;
    await page.route(framedUrl, async route => {
      const response = await route.fetch(), headers = response.headers();
      headers["content-security-policy"] = headers["content-security-policy"]!.replace("frame-ancestors 'none'", `frame-ancestors ${origin}`);
      await route.fulfill({ response, headers });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/app/callback`);
    await page.evaluate(src => { const frame = document.createElement("iframe"); frame.src = src; frame.style.cssText = "width:350px;height:400px;border:0"; document.body.append(frame); }, framedUrl);
    await expect.poll(() => page.frames().some(frame => frame.url() === framedUrl)).toBe(true);
    const frame = page.frames().find(frame => frame.url() === framedUrl)!;
    await expect.poll(() => frame.locator("#wallet-status").getAttribute("data-state")).toBe("brand");
    await page.evaluate(origin => document.querySelector("iframe")!.contentWindow!.postMessage({ type: "juicebox-center:theme", theme: { radius: "8px", inset: "32px" } }, origin), origin);
    await expect.poll(() => frame.locator("#wallet-signin").evaluate(node => getComputedStyle(node).borderRadius)).toBe("8px");
    const signIn = (await frame.locator("#wallet-signin").boundingBox())!, mark = (await frame.locator("#wallet-open").boundingBox())!;
    expect(await frame.locator("#wallet-signin").evaluate(node => node.getBoundingClientRect().left)).toBe(32);
    expect(signIn.height).toBe(44);
    expect(signIn.x + signIn.width).toBeLessThan(mark.x);
    expect(await frame.locator("#wallet-signin").evaluate(node => getComputedStyle(node).padding)).toBe("10px 20px");
    expect(await frame.locator("#wallet-links a").first().evaluate(node => getComputedStyle(node).borderRadius)).toBe("0px");
    expect(errors).toEqual([]);
  });

  it("stretches the narrow unframed sign-in button with square corners", async () => {
    await page.goto(`${origin}/wallet`); await status("ready");
    const signIn = (await page.locator("#wallet-signin").boundingBox())!, actions = (await page.locator("#wallet-signin").locator("..").boundingBox())!;
    expect(signIn.width).toBe(actions.width);
    expect(await page.locator("#wallet-signin").evaluate(node => getComputedStyle(node).borderRadius)).toBe("0px");
  });

  it("signs in only on a real click, sends canonical assertion bytes with CSRF, and logs out", async () => {
    await loadAndEnroll();
    expect(await page.evaluate(() => (window as any).passkeyRequests)).toBe(0);
    await page.locator("#wallet-signin").click(); await status("signed-in");
    expect(await page.locator("#wallet-address").textContent()).toBe(walletAddress);
    expect(begins).toBe(1); expect(completions).toBe(1);
    const completion = requests.find(item => item.path === "/wallet/login/complete")!;
    expect(completion.headers["x-center-wallet-request"]).toBe("1");
    expect(completion.headers["x-center-wallet-csrf"]).toBe(csrf);
    expect(completion.headers.cookie).toContain("test-flow=opaque");
    expect(completion.body.assertion.userHandle).toBe(handle);
    for (const value of Object.values(completion.body.assertion) as string[]) expect(encode(decode(value))).toBe(value);
    const clientData = JSON.parse(decode(completion.body.assertion.clientDataJSON).toString());
    expect(clientData).toMatchObject({ type: "webauthn.get", origin, challenge });
    expect(decode(completion.body.assertion.authenticatorData)[32]! & 4).toBe(4);
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
    expect(await page.locator("body").textContent()).not.toContain(csrf);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator("#wallet-logout").click(); await status("ready");
    expect(requests.find(item => item.path === "/wallet/logout")!.headers["x-center-wallet-csrf"]).toBe(csrf);
    expect(errors).toEqual([]);
  });

  it("shows the balance total and opens the per-network breakdown on click", async () => {
    onramp = true;
    await loadAndEnroll(); await page.locator("#wallet-signin").click(); await status("signed-in");
    await expect.poll(() => page.locator("#wallet-balance-total").textContent()).toBe("$2,512.34");
    expect(await page.locator("#wallet-balance-chains").isVisible()).toBe(false);
    await page.locator("#wallet-balance-total").click();
    expect(await page.locator("#wallet-balance-chains li").allTextContents()).toEqual([
      "Base: 1 ETH", "Optimism: 12.34 USDC", "Base Sepolia (testnet): 5 USDC", "Couldn't check Arbitrum."]);
    expect(await page.locator("#wallet-funds-open").isVisible()).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });

  it("adds funds with Apple Pay: codes once, kept only on this device, Coinbase's button embedded here", async () => {
    onramp = true;
    // The stand-in pay page reports an approved payment the way Coinbase's frame does.
    await page.context().route("https://pay.coinbase.com/**", route => route.fulfill({ contentType: "text/html",
      body: route.request().url().includes("apple-pay") ? `<script>parent.postMessage({ eventName: "onramp_api.commit_success" }, "*")</script>` : "<p>Coinbase</p>" }));
    await loadAndEnroll(); await page.locator("#wallet-signin").click(); await status("signed-in");
    await page.locator("#wallet-funds-open").click();
    await page.locator("#wallet-funds-amount").fill("25");
    await page.locator("#wallet-funds-applepay").click();
    await page.locator("#wallet-funds-email").fill("a@b.co"); await page.locator("#wallet-funds-phone").fill("(212) 555-1234");
    await page.locator("#wallet-funds-applepay").click();
    await expect.poll(() => page.locator("#wallet-funds-codes").isVisible()).toBe(true);
    expect(requests.filter(item => item.path === "/wallet/onramp/verify").map(item => item.body)).toEqual([
      { channel: "sms", destination: "+12125551234" }, { channel: "email", destination: "a@b.co" }]);
    await page.locator("#wallet-funds-sms-code").fill("123456"); await page.locator("#wallet-funds-email-code").fill("654321");
    await page.locator("#wallet-funds-agree").check();
    await page.locator("#wallet-funds-applepay").click();
    await expect.poll(() => page.locator("#wallet-status").textContent()).toContain("wrong or expired");
    expect(requests.some(item => item.path === "/wallet/onramp/order")).toBe(false);
    await page.locator("#wallet-funds-email-code").fill("123456");
    await page.locator("#wallet-funds-applepay").click();
    const frame = page.locator("#wallet-funds-pay iframe");
    await expect.poll(() => frame.getAttribute("src")).toBe("https://pay.coinbase.com/apple-pay?order=1");
    expect(await frame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
    expect(await frame.getAttribute("allow")).toBe("payment");
    await expect.poll(() => page.locator("#wallet-status").textContent()).toContain("Payment approved");
    const order = requests.find(item => item.path === "/wallet/onramp/order")!;
    expect(order.headers["x-center-wallet-csrf"]).toBe(csrf);
    expect(order.body).toMatchObject({ amount: "25", asset: "USDC", email: "a@b.co", phoneNumber: "+12125551234", smsVerificationId: vid(1), emailVerificationId: vid(2), agreed: true, embed: true });
    expect(order.body).not.toHaveProperty("destinationAddress");
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), `signa-onramp:eip155:8453:${walletAddress}`))
      .toMatchObject({ smsVerificationId: vid(1), emailVerificationId: vid(2), userAuthToken: "auth-token" });
    // The next purchase skips the codes and reuses Coinbase's returning-user token.
    await page.locator("#wallet-funds-open").click(); await page.locator("#wallet-funds-amount").fill("10");
    await page.locator("input[name=asset][value=ETH]").check();
    await page.locator("#wallet-funds-agree").check();
    await page.locator("#wallet-funds-applepay").click();
    await expect.poll(() => requests.filter(item => item.path === "/wallet/onramp/order").length).toBe(2);
    await expect.poll(() => frame.isVisible()).toBe(true);
    expect(requests.filter(item => item.path === "/wallet/onramp/verify")).toHaveLength(2);
    expect(requests.filter(item => item.path === "/wallet/onramp/order").at(-1)!.body).toMatchObject({ amount: "10", asset: "ETH", userAuthToken: "auth-token" });
    // A Coinbase account opens the hosted checkout without any contact details.
    await page.locator("#wallet-funds-open").click();
    const [hosted] = await Promise.all([page.waitForEvent("popup"), page.locator("#wallet-funds-coinbase").click()]);
    await expect.poll(() => hosted.url()).toBe("https://pay.coinbase.com/buy?sessionToken=t");
    expect(requests.find(item => item.path === "/wallet/onramp/session")!.body).toEqual({ asset: "ETH", amount: "10" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });

  it("retries an interrupted completion with identical proof before allowing another passkey", async () => {
    await loadAndEnroll();
    let dropped = false;
    await page.route("**/wallet/login/complete", async route => {
      if (dropped) { await route.continue(); return; }
      dropped = true;
      // Forward outside the browser's cookie jar: the backend accepts, but neither
      // success headers nor response body reach this browser.
      const outgoing = route.request();
      await fetch(outgoing.url(), { method: "POST", headers: outgoing.headers(), body: outgoing.postData() });
      await route.abort("failed");
    });
    await page.locator("#wallet-signin").click(); await status("retry");
    expect(await page.locator("#wallet-signin").isVisible()).toBe(false);
    await page.locator("#wallet-retry").click(); await status("signed-in");
    const attempts = requests.filter(item => item.path === "/wallet/login/complete");
    expect(attempts).toHaveLength(2); expect(attempts[1]!.body).toEqual(attempts[0]!.body);
    expect(await page.evaluate(() => (window as any).passkeyRequests)).toBe(1);
    expect(begins).toBe(1); expect(errors).toEqual([]);
    expect(sessionReads).toBe(2);
  });

  it("recovers a lost completion body through the matching session after headers cleared the flow cookie", async () => {
    await loadAndEnroll(); droppedCompletion = true;
    await page.locator("#wallet-signin").click(); await status("retry");
    const cookies = await page.context().cookies();
    expect(cookies.some(cookie => cookie.name === "test-flow")).toBe(false);
    expect(cookies.some(cookie => cookie.name === "test-session")).toBe(true);
    await page.locator("#wallet-retry").click(); await status("signed-in");
    expect(completions).toBe(1); expect(sessionReads).toBe(2);
    expect(await page.evaluate(() => (window as any).passkeyRequests)).toBe(1);
  });

  it("does not silently recover another tab's session or replace the original proof CSRF", async () => {
    await loadAndEnroll(); unavailableCompletions = 3;
    await page.locator("#wallet-signin").click(); await status("retry");
    recoveredLoginId = "22222222-2222-4222-8222-222222222222";
    await page.locator("#wallet-retry").click(); await status("signed-in");
    expect(completions).toBe(4);
    const attempts = requests.filter(item => item.path === "/wallet/login/complete");
    expect(attempts.every(item => item.headers["x-center-wallet-csrf"] === csrf)).toBe(true);
    expect(attempts.every(item => JSON.stringify(item.body) === JSON.stringify(attempts[0]!.body))).toBe(true);
    expect(await page.evaluate(() => (window as any).passkeyRequests)).toBe(1);
  });

  it("bounds readiness retries and does not interpret unavailable session authority as sign-out", async () => {
    authenticated = true; unavailableSessions = 10;
    await page.goto(`${origin}/wallet`); await status("retry");
    expect(sessionReads).toBe(3); expect(await page.locator("#wallet-signin").isVisible()).toBe(false);
    expect(await page.locator("body").textContent()).not.toContain("private-provider-detail");
    unavailableSessions = 0;
    await page.locator("#wallet-retry").click(); await status("signed-in");
    expect(begins).toBe(0);
  });

  it("retries 503 completion readiness with one exact native assertion", async () => {
    await loadAndEnroll(); unavailableCompletions = 2;
    await page.locator("#wallet-signin").click(); await status("signed-in");
    expect(completions).toBe(3); expect(await page.evaluate(() => (window as any).passkeyRequests)).toBe(1);
    const attempts = requests.filter(item => item.path === "/wallet/login/complete");
    expect(attempts.every(item => JSON.stringify(item.body) === JSON.stringify(attempts[0]!.body))).toBe(true);
  });

  it("recovers from a native prompt cancelled in the OS without sending a completion and permits a new click", async () => {
    await loadAndEnroll();
    // The OS prompt owns cancellation; a cancelled prompt rejects with NotAllowedError.
    await page.evaluate(() => {
      const get = navigator.credentials.get.bind(navigator.credentials);
      navigator.credentials.get = () => new Promise((_, reject) => {
        (window as any).cancelOsPrompt = () => { navigator.credentials.get = get; reject(new DOMException("The operation either timed out or was not allowed.", "NotAllowedError")); };
      });
    });
    await page.locator("#wallet-signin").click(); await status("authenticating");
    expect(await page.locator("#wallet-status").textContent()).toMatch(/^Use (Face ID|Touch ID|Windows Hello|your device) to sign in\.$/);
    expect(await page.locator("#wallet-cancel").count()).toBe(0);
    await page.evaluate(() => (window as any).cancelOsPrompt()); await status("ready");
    expect(completions).toBe(0);
    await page.locator("#wallet-signin").click(); await status("signed-in");
    expect(begins).toBe(2); expect(completions).toBe(1);
  });

  it("waits through an authority check before issuing the handoff, without a retry click", async () => {
    authenticated = true; unavailableIssues = 3;
    await page.goto(`${origin}/wallet?intent=${intentId}`);
    await status("checking");
    // Leaving for the app, the page shows nothing it has not shown yet: no account block, no sign-out.
    expect(await page.locator("#wallet-account").count()).toBe(1);
    expect(await page.locator("#wallet-account").isHidden()).toBe(true);
    expect(await page.locator("#wallet-logout").isHidden()).toBe(true);
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 20_000 }).toBe("/app/callback");
    expect(issues).toBe(4); expect(begins).toBe(0);
    expect(await page.locator("body").textContent()).not.toContain("private-provider-detail");
  });

  it("automatically issues one allowlisted handoff and returns to the exact callback", async () => {
    authenticated = true;
    await page.goto(`${origin}/wallet?intent=${intentId}`);
    await expect.poll(() => new URL(page.url()).pathname).toBe("/app/callback");
    const result = new URL(page.url());
    expect(result.searchParams.get("state")).toBe(state); expect(result.searchParams.get("iss")).toBe(origin);
    expect(result.searchParams.get("code")).toBe(code); expect(issues).toBe(1); expect(begins).toBe(0);
    expect(requests.find(item => item.path === "/wallet/authorize/issue")!.body).toEqual({ intentId });
  });

  it("returns an existing session to only the fixed payment review without issuing a grant or prompting", async () => {
    authenticated = true;
    const review = "77777777-7777-4777-8777-777777777777";
    await page.goto(`${origin}/wallet?payment=${review}`);
    await expect.poll(() => page.url()).toBe(`${origin}/wallet/payment?review=${review}`);
    expect(issues).toBe(0); expect(begins).toBe(0);
    expect(await page.evaluate(() => (window as any).passkeyRequests)).toBe(0);
  });

  it("returns a fresh passkey sign-in to the same fixed payment review without approving payment", async () => {
    await loadAndEnroll();
    const review = "77777777-7777-4777-8777-777777777777";
    await page.goto(`${origin}/wallet?payment=${review}`); await status("ready");
    await page.locator("#wallet-signin").click();
    await expect.poll(() => page.url()).toBe(`${origin}/wallet/payment?review=${review}`);
    expect(begins).toBe(1); expect(completions).toBe(1); expect(issues).toBe(0);
    expect(requests.filter(item => item.path.endsWith("/approve"))).toHaveLength(0);
  });

  it.each(["https://outside.invalid", "../outside", "77777777-7777-4777-8777-777777777777&payment=77777777-7777-4777-8777-777777777777"])("rejects unsafe payment continuation %s", async payment => {
    authenticated = true;
    await page.goto(`${origin}/wallet?payment=${payment}`); await status("error");
    expect(new URL(page.url()).pathname).toBe("/wallet"); expect(issues).toBe(0); expect(begins).toBe(0);
  });

  it("rejects a payment continuation mixed with an app connection intent", async () => {
    authenticated = true;
    await page.goto(`${origin}/wallet?payment=77777777-7777-4777-8777-777777777777&intent=${intentId}`); await status("error");
    expect(issues).toBe(0); expect(begins).toBe(0);
  });

  it.each(["wrong-origin", "wrong-state", "duplicate-state", "fragment"])("refuses a %s redirect instead of leaking the handoff", async variant => {
    authenticated = true;
    const redirect = new URL(`${callback()}?${new URLSearchParams({ code, state, iss: origin })}`);
    if (variant === "wrong-origin") redirect.hostname = "outside.invalid";
    if (variant === "wrong-state") redirect.searchParams.set("state", code);
    if (variant === "duplicate-state") redirect.searchParams.append("state", state);
    if (variant === "fragment") redirect.hash = "leak";
    redirectOverride = redirect.href;
    await page.goto(`${origin}/wallet?intent=${intentId}`); await status("error");
    expect(new URL(page.url()).pathname).toBe("/wallet"); expect(issues).toBe(1);
    expect(await page.locator("body").textContent()).not.toContain(code);
  });

  it("sends an expired app request back to the app instead of offering a retry", async () => {
    intentExpired = true;
    try {
      await page.goto(`${origin}/wallet?intent=${intentId}`); await status("error");
      const text = (await page.locator("#wallet-status").textContent())!;
      expect(text).toContain("timed out"); expect(text).toContain("beep.example");
      expect(await page.locator("#wallet-retry").isHidden()).toBe(true);
      expect(await page.locator("#wallet-signin").isHidden()).toBe(true);
      expect(await page.locator("#wallet-status a").getAttribute("href")).toBe("https://beep.example/");
    } finally { intentExpired = false; }
  });
  it("lands on sign-in, stays there after a failed passkey, and shows signup only when chosen", async () => {
    landingWays = true;
    await page.context().addInitScript(() => { navigator.credentials.get = async () => { throw new DOMException("See https://www.w3.org/TR/webauthn-2/", "NotAllowedError"); }; });
    await page.goto(`${origin}/wallet`); await status("ready");
    expect(page.url()).toBe(`${origin}/wallet`);
    expect(await page.locator("#wallet-signin").isVisible()).toBe(true);
    expect(await page.locator("#wallet-create").textContent()).toBe("Signa up");
    expect(await page.locator("#signup-form").count()).toBe(0);
    await page.locator("#wallet-signin").click();
    await expect.poll(() => page.locator("#wallet-status").textContent()).toBe("The device prompt didn’t finish. Try again.");
    expect(await page.locator("#wallet-status").getAttribute("data-state")).toBe("ready");
    expect(page.url()).toBe(`${origin}/wallet`);
    expect(await page.locator("#wallet-signin").isVisible()).toBe(true);
    expect(await page.locator("#wallet-create").isVisible()).toBe(true);
    await page.locator("#wallet-create").click();
    await expect.poll(() => page.locator("#signup-form").isVisible()).toBe(true);
    expect(new URL(page.url()).pathname).toBe("/wallet/create");
    // A failed sign-in from the signup page goes back to the sign-in page with its message.
    await page.locator("#signup-resume").click();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/wallet");
    await expect.poll(() => page.locator("#wallet-status").textContent()).toBe("The device prompt didn’t finish. Try again.");
    expect(await page.locator("#wallet-signin").isVisible()).toBe(true);
    expect(await page.locator("#signup-form").count()).toBe(0);
    expect(errors).toEqual([]);
  });

  it("keeps a framed failed sign-in on the sign-in view, including one started from the framed signup", async () => {
    landingWays = true;
    const framedUrl = `${origin}/wallet?intent=${intentId}`;
    await page.route(framedUrl, async route => {
      const response = await route.fetch(), headers = response.headers();
      headers["content-security-policy"] = headers["content-security-policy"]!.replace("frame-ancestors 'none'", `frame-ancestors ${origin}`);
      await route.fulfill({ response, headers });
    });
    await page.context().addInitScript(() => { navigator.credentials.get = async () => { throw new DOMException("denied", "NotAllowedError"); }; });
    await page.setViewportSize({ width: 800, height: 900 });
    await page.goto(`${origin}/app/callback`);
    await page.evaluate(src => { const frame = document.createElement("iframe"); frame.src = src; frame.style.cssText = "width:420px;height:640px;border:0"; document.body.append(frame); }, framedUrl);
    const frame = page.frameLocator("iframe");
    await expect.poll(() => frame.locator("#wallet-status").getAttribute("data-state")).toBe("brand");
    await frame.locator("#wallet-signin").click();
    await expect.poll(() => frame.locator("#wallet-status").textContent()).toBe("The device prompt didn’t finish. Try again.");
    expect(await frame.locator("#wallet-signin").isVisible()).toBe(true);
    expect(await frame.locator("#wallet-create").isVisible()).toBe(true);
    expect(await frame.locator("#signup-form").count()).toBe(0);
    await frame.locator("#wallet-create").click();
    await expect.poll(() => frame.locator("#signup-form").isVisible()).toBe(true);
    await frame.locator("#signup-resume").click();
    await expect.poll(() => frame.locator("#wallet-signin").isVisible()).toBe(true);
    await expect.poll(() => frame.locator("#wallet-status").textContent()).toBe("The device prompt didn’t finish. Try again.");
    expect(await frame.locator("#signup-form").count()).toBe(0);
    expect(page.frames().some(item => item.url() === framedUrl)).toBe(true);
    expect(errors).toEqual([]);
  });
});
