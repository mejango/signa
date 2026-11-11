import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { JbcenterEnv } from "../src/types.js";
import { guidePage } from "../src/rest/docs/guide.js";
import { mountRestSite, REST_DOCUMENTS, type RestSite } from "../src/rest/site.js";

describe("readable developer guides", () => {
  it("renders navigation, code, tables and stable heading links without executing raw HTML", () => {
    const html = guidePage("quickstart", '# Get started\n\n## Connect\n\n[Client](./CLIENT.md#connect-from-node)\n\n```js\nconsole.log("hello");\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script>\n\n[x](javascript:alert%281%29)');
    expect(html).toContain('id="connect"');
    expect(html).toContain('href="/api/docs/client#connect-from-node"');
    expect(html).toContain('class="copy-code"');
    expect(html).toContain('<table>');
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('aria-current="page"');
  });
  it("keeps Markdown available while serving readable pages and the actual client archive", async () => {
    const app = new Hono<JbcenterEnv>();
    mountRestSite(app, { app: new Hono(), audience: "https://api.signa.center", accountsScript: "", docsScript: "", docsHtml: "", docsCss: "", clientPackage: new Uint8Array([1, 2, 3]), documents: new Map([["quickstart", "# Hello"]]) } as RestSite);
    const html = await app.request('/api/docs/quickstart');
    expect(html.headers.get('content-type')).toContain('text/html');
    expect(await html.text()).toContain('<h1 id="hello">Hello</h1>');
    expect(await (await app.request('/api/docs/quickstart.md')).text()).toBe('# Hello');
    expect(await (await app.request('/api/docs/quickstart', { headers: { accept: 'text/markdown' } })).text()).toBe('# Hello');
    const archive = await app.request('/api/client/juicebox-center-client-0.1.0.tgz');
    expect(archive.headers.get('content-type')).toBe('application/gzip');
    expect(new Uint8Array(await archive.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
  it("keeps only Signa-owned guides on disk", async () => {
    expect(REST_DOCUMENTS).not.toContain("PROJECT_INTENTS");
    expect(REST_DOCUMENTS).toContain("AUTHENTICATION");
    for (const name of REST_DOCUMENTS) {
      const text = await readFile(new URL(`../docs/rest/${name}.md`, import.meta.url), "utf8");
      expect(text.startsWith("# ")).toBe(true);
    }
  });

  it("redirects protocol guides to Center without loading inherited copies", async () => {
    const app = new Hono<JbcenterEnv>();
    mountRestSite(app, {
      app: new Hono(), audience: "https://api.signa.center", accountsScript: "", docsScript: "",
      docsHtml: "", docsCss: "", documents: new Map(),
    } as RestSite);
    for (const name of ["project-intents", "contracts", "indexer", "omnichain"]) {
      for (const extension of ["", ".md"]) {
        const response = await app.request(`/api/docs/${name}${extension}`);
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe(`https://juicebox.center/api/docs/${name}${extension}`);
      }
    }
  });
});
