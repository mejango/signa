/** The wallet pages inside an admitted app's frame: the frame is sized to the page (its height is
 * told to the page framing it whenever it changes, a number only), and the app that frames it may
 * hand it its own colours, font and corner radius so the page reads as part of that app. Only the
 * framing page (the intent's app, admitted by frame-ancestors) is heard, and only plain values:
 * colours, a font-family list, a radius, the inset the app's dialog keeps (so the page can set its
 * content on that edge and its mark in the margin). Nothing else about the page is the app's to change.
 * The page stays unpainted until the theme is on it, so it never flashes Center's own face first; the
 * last theme applied in this frame paints the next page in it at once, and an app that never answers
 * still gets its page shortly after load. */
export const framed = window.self !== window.top;
export function signaBrandLink(status: HTMLElement) {
  const link = document.createElement('a');
  link.href = 'https://signa.center';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'Signa';
  status.replaceChildren(link);
}
const themeTokens: Record<string, RegExp> = {
  background: /^#[0-9a-f]{3,8}$/i, foreground: /^#[0-9a-f]{3,8}$/i, muted: /^#[0-9a-f]{3,8}$/i, line: /^#[0-9a-f]{3,8}$/i,
  accent: /^#[0-9a-f]{3,8}$/i, accentForeground: /^#[0-9a-f]{3,8}$/i,
  font: /^[\w\s,'"-]{1,200}$/, headingFont: /^[\w\s,'"-]{1,200}$/, radius: /^(?:\d{1,3}(?:\.\d+)?(?:px|rem|em)\s*){1,4}$/,
  inset: /^\d{1,3}(?:\.\d+)?(?:px|rem|em)$/,
};
const themeVariables: Record<string, string> = { background: "--wallet-bg", foreground: "--wallet-fg", muted: "--wallet-muted", line: "--wallet-line",
  accent: "--wallet-accent", accentForeground: "--wallet-accent-fg", font: "--wallet-font", headingFont: "--wallet-heading-font", radius: "--wallet-radius", inset: "--wallet-inset" };
const themeKey = "center:frame-theme";
const themed = () => document.documentElement.classList.add("themed");
const appliedTheme: Record<string, string> = {};
/** Keep the cached theme in step with CSS: omitted tokens retain their previous valid value. */
function applyTheme(theme: Record<string, unknown>): Record<string, string> {
  for (const [key, value] of Object.entries(theme)) {
    const pattern = themeTokens[key];
    if (pattern && typeof value === "string" && pattern.test(value.trim())) { document.documentElement.style.setProperty(themeVariables[key]!, value.trim()); appliedTheme[key] = value.trim(); }
  }
  themed();
  return appliedTheme;
}
let reportSize: (() => void) | null = null;
if (framed) {
  document.documentElement.classList.add("framed");
  const content = document.querySelector("main") ?? document.body;
  const report = () => window.parent.postMessage({ type: "juicebox-center:size", height: Math.ceil(content.getBoundingClientRect().bottom + window.scrollY) }, "*");
  reportSize = report;
  try { new ResizeObserver(report).observe(content); } catch { /* No observer: the frame keeps its default height. */ }
  window.addEventListener("load", report);
  // Design tokens only, from this frame's last page; storage may be refused to a cross-site frame.
  try { const stored = sessionStorage.getItem(themeKey); if (stored) applyTheme(JSON.parse(stored) as Record<string, unknown>); } catch { /* not kept */ }
  window.addEventListener("load", () => setTimeout(themed, 600));
}
export function listenForTheme(framer: string) {
  window.addEventListener("message", event => {
    const data = event.data as { type?: unknown; theme?: unknown } | null;
    if (event.source !== window.parent || event.origin !== framer || data?.type !== "juicebox-center:theme" || !data.theme || typeof data.theme !== "object") return;
    const kept = applyTheme(data.theme as Record<string, unknown>);
    try { sessionStorage.setItem(themeKey, JSON.stringify(kept)); } catch { /* not kept */ }
  });
  // The app answers a size report with its theme; ask once the listener is in place.
  reportSize?.();
}
/** The redirect the app's callback expects: exactly code, state and iss, on the intent's callback URI. */
export function checkedRedirect(result: { redirectUri?: unknown }, intent: { callbackUri: string; state: string }, issuer: string): string {
  const redirectUri = result.redirectUri;
  if (typeof redirectUri !== "string" || !redirectUri || redirectUri.length > 4096) throw new Error("The app return could not be verified.");
  const redirect = new URL(redirectUri), keys = [...redirect.searchParams.keys()];
  if (redirectUri.split("?")[0] !== intent.callbackUri || redirect.hash || keys.length !== 3
    || new Set(keys).size !== 3 || keys.some(key => !["code", "state", "iss"].includes(key))
    || redirect.searchParams.get("state") !== intent.state || redirect.searchParams.get("iss") !== issuer
    || !/^[A-Za-z0-9_-]{43}$/.test(redirect.searchParams.get("code") ?? "")) throw new Error("The app return could not be verified.");
  return redirectUri;
}
