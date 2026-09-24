import type { HttpBindings } from '@hono/node-server';
import { Hono } from 'hono';

interface FetchApp {
  fetch(request: Request, bindings?: HttpBindings): Response | Promise<Response>;
}

export interface SignaHttpRuntime {
  /** The REST site already mounted at /api/v1, /api and /accounts. */
  api: FetchApp;
  wallet: FetchApp;
  ready(): void | Promise<void>;
}

export interface SignaAppOptions {
  apiAudience: string;
  walletOrigin: string;
  /** Undefined until every runtime factory has completed; dormant processes never construct it. */
  currentRuntime(): SignaHttpRuntime | undefined;
}

function exactOrigin(value: string): URL {
  const url = new URL(value);
  if (url.origin !== value || !['https:', 'http:'].includes(url.protocol))
    throw new Error('Signa origins must be exact HTTP origins');
  return url;
}

const apiAssets = new Set(['/assets/accounts.css', '/assets/accounts.js', '/assets/accounts-icon.svg', '/assets/docs.js', '/assets/api.css']);
const apiPath = (path: string) => path === '/api' || path.startsWith('/api/') || path === '/accounts' || apiAssets.has(path);

/** Credential pages and the public signed API have separate, exact HTTP hosts. */
export function createSignaApp(options: SignaAppOptions) {
  const audience = exactOrigin(options.apiAudience);
  const wallet = exactOrigin(options.walletOrigin);
  if (wallet.host === audience.host)
    throw new Error('Signa wallet host must be distinct from the API audience');
  const app = new Hono<{ Bindings: HttpBindings }>();
  app.onError((_error, c) => c.json({ error: { code: 'SIGNA_UNAVAILABLE', message: 'Signa is temporarily unavailable' } }, 503));
  app.use('*', async c => {
    c.header('Cache-Control', 'no-store');
    const request = c.req.raw;
    // Exact authority comparison includes a configured non-default port. Neither
    // X-Forwarded-Host nor browser Origin can choose a credential or API host.
    const host = request.headers.get('host') ?? new URL(request.url).host;
    const walletHost = host === wallet.host;
    if (!walletHost && c.req.method === 'GET' && c.req.path === '/healthz') return c.json({ ok: true });
    const runtime = options.currentRuntime();
    if (!walletHost && c.req.method === 'GET' && c.req.path === '/readyz') {
      if (!runtime) return c.json({ ok: false }, 503);
      await runtime.ready();
      return c.json({ ok: true });
    }
    const target = c.env?.incoming?.url ?? new URL(request.url).pathname + new URL(request.url).search;
    const path = target.split('?', 1)[0]!;
    if (!walletHost && (host !== audience.host || !apiPath(path) || !apiPath(c.req.path))) return c.notFound();
    if (!runtime) return c.json({ error: { code: 'SIGNA_UNAVAILABLE', message: 'Signa is temporarily unavailable' } }, 503);
    if (!/^\/(?![\/\\])/.test(target) || /[\s\\#\u0000-\u001f]/.test(target))
      return c.json({ error: { code: 'INVALID_REQUEST_TARGET', message: 'Invalid request target' } }, 400);
    // Retain IncomingMessage.url for byte-exact signed targets, including any
    // noncanonical target that REST must reject rather than silently normalize.
    return (walletHost ? runtime.wallet : runtime.api).fetch(request, c.env);
  });
  return app;
}
