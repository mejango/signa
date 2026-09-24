import { readFile } from "node:fs/promises";
import type { Hono } from "hono";
import type { JbcenterEnv } from "../types.js";
import type { createRestApp } from "./app.js";
import { guidePage } from "./docs/guide.js";
import { mountAccountsSite } from "./accountsSite.js";
import { createWalletHostMatcher } from "../walletHosts.js";
import { REST_PAGE_HEADERS } from "./pageHeaders.js";

export { REST_PAGE_HEADERS } from "./pageHeaders.js";

export const REST_DOCUMENTS = [
  "ARCHITECTURE",
  "QUICKSTART",
  "CLIENT",
  "USER_JOURNEYS",
  "AUTHENTICATION",
  "API",
  "AI_GUIDE",
  "PROJECT_INTENTS",
  "CONTRACTS",
  "INDEXER",
  "TRANSACTIONS",
  "OMNICHAIN",
  "SPONSORSHIP",
  "SMART_ACCOUNTS",
  "SESSIONS",
  "EXECUTION_OPERATIONS",
  "PRODUCTION_CHECK",
  "PRODUCTION_OPERATIONS",
  "SIGNA_MIGRATION",
] as const;

export interface RestSite {
  app: ReturnType<typeof createRestApp>;
  surface?: "wallet";
  wallet?: Hono;
  /** Origins served entirely by the wallet app (its own and retired ones). */
  walletOrigins?: readonly string[];
  audience: string;
  accountsScript: string;
  docsScript?: string;
  clientPackage?: Uint8Array;
  docsHtml: string;
  docsCss: string;
  documents: ReadonlyMap<string, string>;
}

export async function readRestAssets() {
  const accountsScript = await readFile(
    new URL("../../.generated/rest/accounts.js", import.meta.url),
    "utf8",
  );
  const documents = new Map<string, string>();
  for (const name of REST_DOCUMENTS) {
    const content = await readFile(
      new URL(`../../docs/rest/${name}.md`, import.meta.url),
      "utf8",
    );
    documents.set(name.toLowerCase(), content);
    documents.set(name.toLowerCase().replaceAll("_", "-"), content);
  }
  const walletScript = await readFile(new URL("../../.generated/rest/wallet.js", import.meta.url), "utf8");
  const walletPaymentScript = await readFile(new URL("../../.generated/rest/wallet-payment.js", import.meta.url), "utf8");
  const walletSignupScript = await readFile(new URL("../../.generated/rest/wallet-signup.js", import.meta.url), "utf8");
  const walletRecoveryScript = await readFile(new URL("../../.generated/rest/wallet-recovery.js", import.meta.url), "utf8");
  const walletDeviceScript = await readFile(new URL("../../.generated/rest/wallet-device.js", import.meta.url), "utf8");
  const docsScript = await readFile(new URL("../../.generated/rest/docs.js", import.meta.url), "utf8");
  const clientPackage = new Uint8Array(await readFile(new URL("../../.generated/rest/juicebox-center-client-0.1.0.tgz", import.meta.url)));
  return { accountsScript, walletScript, walletPaymentScript, walletSignupScript, walletRecoveryScript, walletDeviceScript, documents, docsScript, clientPackage };
}

export function mountRestSite(app: Hono<JbcenterEnv>, site: RestSite): void {
  if (site.wallet && site.walletOrigins?.length) {
    const walletHost = createWalletHostMatcher(site.walletOrigins);
    app.use("*", async (c, next) => walletHost(c.req.header("host")) || walletHost(new URL(c.req.url).host) ? site.wallet!.fetch(c.req.raw, c.env) : next());
  } else if (site.wallet) app.route("/", site.wallet);
  app.route("/api/v1", site.app);
  mountAccountsSite(app, { audience: site.audience, accountsScript: site.accountsScript });
  app.get("/assets/docs.js", (context) => context.body(site.docsScript ?? "", 200, { ...REST_PAGE_HEADERS, "Content-Type": "application/javascript; charset=utf-8" }));
  app.get("/api/client/juicebox-center-client-0.1.0.tgz", (context) => {
    if (!site.clientPackage) return context.notFound();
    return new Response(site.clientPackage as BodyInit, { headers: { "Content-Type": "application/gzip", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-cache", "Content-Disposition": 'attachment; filename="juicebox-center-client-0.1.0.tgz"' } });
  });
  app.get("/api", (context) =>
    context.html(site.docsHtml, 200, REST_PAGE_HEADERS),
  );
  app.get("/assets/api.css", (context) =>
    context.body(site.docsCss, 200, {
      ...REST_PAGE_HEADERS,
      "Content-Type": "text/css; charset=utf-8",
    }),
  );
  app.get("/api/docs/:name", (context) => {
    const name = context.req.param("name").replace(/\.md$/i, "").toLowerCase();
    const document = site.documents.get(name);
    if (!document)
      return context.json(
        {
          error: {
            code: "DOCUMENT_NOT_FOUND",
            message: "Choose a document linked from /api",
          },
        },
        404,
      );
    if (site.surface === "wallet")
      return context.redirect(`https://juicebox.center/api/docs/${name.replaceAll("_", "-")}${context.req.param("name").toLowerCase().endsWith(".md") ? ".md" : ""}`, 302);
    if (!context.req.param("name").endsWith(".md") && !context.req.header("Accept")?.includes("text/markdown"))
      return context.html(guidePage(name, document), 200, REST_PAGE_HEADERS);
    return context.text(document, 200, {
      ...REST_PAGE_HEADERS,
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    });
  });
}
