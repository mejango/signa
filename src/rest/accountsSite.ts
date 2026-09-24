import type { Hono } from "hono";
import { FAVICON_SVG } from "../branding.js";
import type { JbcenterEnv } from "../types.js";
import { validateAudience } from "./auth/signatures.js";
import { REST_PAGE_HEADERS } from "./pageHeaders.js";
import { accountsCss, accountsPage } from "./web/page.js";

/** Account management can be hosted separately while signing requests for the same API audience. */
export function mountAccountsSite(app: Hono<JbcenterEnv>, options: { audience: string; accountsScript: string }): void {
  const audience = validateAudience(options.audience);
  if (audience !== options.audience || new URL(audience).origin !== audience || /[*,;'"\s]/.test(audience))
    throw new Error("Accounts requires an exact API origin.");
  const headers = { ...REST_PAGE_HEADERS, "Content-Security-Policy": REST_PAGE_HEADERS["Content-Security-Policy"]
    .replace("connect-src 'self'", `connect-src 'self' ${audience}`) };
  app.get("/accounts", context => context.html(accountsPage({ audience, faviconPath: "/assets/accounts-icon.svg?v=signa" }), 200, headers));
  app.get("/assets/accounts.css", context => context.body(accountsCss(), 200, {
    ...REST_PAGE_HEADERS, "Content-Type": "text/css; charset=utf-8",
  }));
  app.get("/assets/accounts.js", context => context.body(options.accountsScript, 200, {
    ...REST_PAGE_HEADERS, "Content-Type": "application/javascript; charset=utf-8",
  }));
  app.get("/assets/accounts-icon.svg", context => context.body(FAVICON_SVG, 200, {
    ...REST_PAGE_HEADERS, "Content-Type": "image/svg+xml; charset=utf-8",
  }));
}
