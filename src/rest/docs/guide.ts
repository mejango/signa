import { assetHref, type AssetNames } from "../web/assets.js";
import { BRAND_ICON, FAVICON_LINK } from "../../branding.js";
import { Marked, type Tokens } from "marked";

const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const navigation = [
  ["quickstart", "Get started"], ["client", "Client workflows"], ["authentication", "Authentication"],
  ["transactions", "Transactions"], ["project-intents", "Project intents"],
  ["sponsorship", "Prepaid execution"], ["smart-accounts", "Smart wallets"],
  ["client#run-payments-without-another-owner-prompt", "Unattended payments"],
  ["contracts", "Contract calls"], ["indexer", "Indexed data"], ["api", "Full reference"],
];
function destination(href: string): string | undefined {
  if (/^(?:#|\/(?!\/))/.test(href)) return href;
  if (/^(?:https:|http:)/i.test(href)) {
    try { const url = new URL(href); return url.username || url.password ? undefined : url.href; } catch { return; }
  }
  if (/^(?:\.\/)?[A-Z_\-]+\.md(?:#.*)?$/i.test(href)) {
    const [name, fragment] = href.replace(/^\.\//, "").split("#");
    return `/api/docs/${name!.replace(/\.md$/i, "").toLowerCase().replaceAll("_", "-")}${fragment ? `#${fragment}` : ""}`;
  }
  if (href.startsWith("../../src/") || href.startsWith("../../scripts/"))
    return `https://github.com/mejango/jbcenter/blob/main/${href.slice(6)}`;
}
/** Only repository-owned Markdown is accepted. Raw HTML and unsafe URLs remain text. */
export function guidePage(name: string, markdown: string, assets?: AssetNames): string {
  const headings: { id: string; title: string; depth: number }[] = [];
  const used = new Map<string, number>();
  const parser = new Marked({ gfm: true, renderer: {
    html(token) { return escape(token.text); },
    image(token) { return escape(token.text); },
    heading(token: Tokens.Heading) {
      const title = token.text.replace(/[`*_]/g, "");
      const base = title.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-");
      const count = used.get(base) ?? 0; used.set(base, count + 1);
      const id = base + (count ? `-${count}` : "");
      headings.push({ id, title, depth: token.depth });
      return `<h${token.depth} id="${escape(id)}">${this.parser.parseInline(token.tokens)}</h${token.depth}>`;
    },
    link(token) {
      const href = destination(token.href);
      const text = this.parser.parseInline(token.tokens);
      return href ? `<a href="${escape(href)}">${text}</a>` : text;
    },
    code(token) { return `<div class="code-example"><button type="button" class="copy-code" hidden>Copy</button><pre tabindex="0"><code>${escape(token.text)}</code></pre></div>`; },
  } });
  const content = parser.parse(markdown) as string;
  const title = headings.find(item => item.depth === 1)?.title ?? "API guide";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} | Juicebox Center</title>${FAVICON_LINK}<link rel="stylesheet" href="${assetHref("", "api.css", assets)}"><script type="module" src="${assetHref("", "docs.js", assets)}"></script></head>
<body><a class="skip" href="#guide-content">Skip to content</a><div class="guide-shell"><aside class="guide-nav"><a href="/api"><strong>${BRAND_ICON} JUICEBOX CENTER</strong><br>Developer docs</a><nav aria-label="Documentation">${navigation.map(([slug, label]) => `<a href="/api/docs/${slug}"${slug === name ? ' aria-current="page"' : ""}>${label}</a>`).join("")}<a href="/api#reference">Endpoints</a><a href="/accounts">Create API connection →</a></nav></aside><main id="guide-content"><nav aria-label="Page resources"><a href="/api">API home</a><a href="/api/docs/${escape(name)}.md">Markdown</a><a href="/api/v1/openapi.json">OpenAPI</a></nav>${headings.filter(item => item.depth === 2).length ? `<details class="guide-toc"><summary>On this page</summary><nav aria-label="On this page">${headings.filter(item => item.depth === 2).map(item => `<a href="#${escape(item.id)}">${escape(item.title)}</a>`).join("")}</nav></details>` : ""}<article>${content}</article><footer><a href="/api/docs/client">Client workflows</a> / <a href="/api#reference">Endpoint reference</a></footer></main></div><p id="copy-status" role="status" aria-live="polite" class="sr-only"></p></body></html>`;
}
