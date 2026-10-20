import type { Hono } from "hono";
import { FAVICON_SVG } from "../branding.js";
import type { JbcenterEnv } from "../types.js";
import { validateAudience } from "./auth/signatures.js";
import { REST_PAGE_HEADERS } from "./pageHeaders.js";
import { accountsCss, accountsPage } from "./web/page.js";
import { assetHref, mountAssets } from "./web/assets.js";

/** Account management can be hosted separately while signing requests for the same API audience. */
export function mountAccountsSite(app: Hono<JbcenterEnv>, options: { audience: string; accountsScript: string }): void {
  const audience = validateAudience(options.audience);
  if (audience !== options.audience || new URL(audience).origin !== audience || /[*,;'"\s]/.test(audience))
    throw new Error("Accounts requires an exact API origin.");
  const headers = { ...REST_PAGE_HEADERS, "Content-Security-Policy": REST_PAGE_HEADERS["Content-Security-Policy"]
    .replace("connect-src 'self'", `connect-src 'self' ${audience}`) };
  const assets = mountAssets(app, "", { "accounts.js": options.accountsScript, "accounts.css": accountsCss() });
  app.get("/accounts", context => context.html(accountsPage({ audience, faviconPath: "/assets/accounts-icon.svg?v=signa",
    scriptPath: assetHref("", "accounts.js", assets), stylePath: assetHref("", "accounts.css", assets) }), 200, headers));
  app.get("/assets/accounts-icon.svg", context => context.body(FAVICON_SVG, 200, {
    ...REST_PAGE_HEADERS, "Content-Type": "image/svg+xml; charset=utf-8",
  }));
}
