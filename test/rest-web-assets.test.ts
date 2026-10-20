import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { mountAccountsSite } from "../src/rest/accountsSite.js";
import { hashedAssetName, IMMUTABLE_CACHE, mountAssets } from "../src/rest/web/assets.js";
import { createSignaApp } from "../src/signaApp.js";
import type { JbcenterEnv } from "../src/types.js";

const walletOrigin = "https://signa.example.test", audience = "https://api.signa.example.test";

/** A wallet app whose page middleware marks everything no-store, as the real wallet site does. */
function signa(files: Record<string, string>) {
  const wallet = new Hono();
  wallet.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  const names = mountAssets(wallet, "", files);
  const api = new Hono<JbcenterEnv>();
  mountAccountsSite(api, { audience, accountsScript: "/* accounts */", accountsSignedInScript: "/* signed in */" });
  const app = createSignaApp({ apiAudience: audience, walletOrigin, currentRuntime: () => ({ api, wallet, ready() {} }) });
  return { app, names };
}

describe("static assets", () => {
  it("serves JS and CSS under content-hashed names with immutable caching through the host router", async () => {
    const { app, names } = signa({ "wallet.js": "/* v2 */", "wallet.css": "main{}" });
    expect(names["wallet.js"]).toMatch(/^wallet\.[0-9a-f]{12}\.js$/);
    expect(names["wallet.js"]).not.toBe(hashedAssetName("wallet.js", "/* v1 */"));
    for (const [file, type] of [["wallet.js", "application/javascript"], ["wallet.css", "text/css"]] as const) {
      const response = await app.request(`${walletOrigin}/assets/${names[file]}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe(IMMUTABLE_CACHE);
      expect(response.headers.get("content-type")).toContain(type);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  it("answers a plain or previous-deploy name with the current body, never cached, so a deploy cannot strand a page", async () => {
    const { app } = signa({ "wallet.js": "/* v2 */" });
    for (const path of ["/assets/wallet.js", `/assets/${hashedAssetName("wallet.js", "/* v1 */")}`]) {
      const response = await app.request(walletOrigin + path);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("/* v2 */");
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    for (const path of ["/assets/wallet.0123.js", "/assets/wallet.css", "/assets/walletxjs", "/assets/other.js"])
      expect((await app.request(walletOrigin + path)).status).toBe(404);
  });

  it("references the hashed names from the HTML, which itself stays no-store", async () => {
    const { app } = signa({});
    const page = await app.request(audience + "/accounts"), html = await page.text();
    expect(page.headers.get("cache-control")).toBe("no-store");
    const refs = [...html.matchAll(/(?:src|href|content)="(\/assets\/accounts(?:-signed-in)?\.[0-9a-f]{12}\.(?:js|css))"/g)].map(match => match[1]!);
    expect(refs).toHaveLength(3);
    for (const ref of refs) expect((await app.request(audience + ref)).headers.get("cache-control")).toBe(IMMUTABLE_CACHE);
    expect((await app.request(audience + "/assets/accounts.0123456789ab.html")).status).toBe(404);
  });
});
