// A bundle the page loads on demand, from the URL its HTML names in <meta name="module:NAME"> (the content-hashed
// asset, src/rest/web/assets.ts). HTML from before a deploy has no such tag; then the plain name beside this bundle,
// which the server answers with the current body. The browser remembers a failed import per URL, so a retry asks
// under a new query.
const loads = new Map<string, Promise<unknown>>();
let retries = 0;

export function lazyModule<T>(name: string): Promise<T> {
  let load = loads.get(name) as Promise<T> | undefined;
  if (!load) {
    const href = document.querySelector<HTMLMetaElement>(`meta[name="module:${name}"]`)?.content
      ?? new URL(`./${name}.js`, import.meta.url).href;
    load = (import(retries ? `${href}?retry=${retries}` : href) as Promise<T>)
      .catch((error: unknown) => { loads.delete(name); retries++; throw error; });
    loads.set(name, load);
  }
  return load;
}

/** Starts a load most visitors will need once the page is idle; a failure is retried, and shown, on use. */
export function whenIdle(load: () => Promise<unknown>) {
  const idle = globalThis.requestIdleCallback ?? ((run: () => void) => setTimeout(run, 1));
  idle(() => { load().catch(() => {}); });
}
