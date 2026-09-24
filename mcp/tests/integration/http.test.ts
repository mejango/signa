import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { EventEmitter, once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadConfig, type Config } from '../../src/config.js';
import { MAX_PROJECT_LOGO_BYTES } from '../../src/services/metadata.js';
import { MAX_LOGO_REQUEST_BYTES } from '../../src/transport/limits.js';
import {
  createHttpHandler,
  createHttpServer,
  type HttpHandler,
  type HttpOptions,
  type HttpRuntime,
} from '../../src/transport/http.js';

const runtimes: HttpRuntime[] = [];
const mountedServers: Array<{ server: Server; runtime: HttpHandler }> = [];
const clients: Client[] = [];
const mcpHeaders = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};
const toolsList = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

function fixtureServer(): McpServer {
  const server = new McpServer({ name: 'transport-fixture', version: '1.0.0' });
  server.registerTool('echo', { inputSchema: { value: z.string() } }, async ({ value }) => ({
    content: [{ type: 'text', text: value }],
  }));
  server.registerPrompt(
    'explain',
    { argsSchema: { project: z.string() } },
    async ({ project }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: `Explain ${project}.` } }],
    }),
  );
  server.registerResource(
    'reference',
    'juicebox://reference',
    { mimeType: 'text/plain' },
    async (uri) => ({
      contents: [
        { uri: uri.toString(), mimeType: 'text/plain', text: 'Versioned reference fixture.' },
      ],
    }),
  );
  return server;
}

async function start(
  factory = fixtureServer,
  options: HttpOptions = {},
  config: Partial<Config> = {},
) {
  const runtime = createHttpServer({ ...loadConfig({ PORT: '0' }), ...config }, factory, {
    shutdownGraceMs: 100,
    ...options,
  });
  runtimes.push(runtime);
  const address = await runtime.listen();
  return {
    runtime,
    base: `http://127.0.0.1:${address.port}`,
    url: new URL(`http://127.0.0.1:${address.port}/mcp`),
  };
}

async function post(url: URL, body: unknown = toolsList, headers: Record<string, string> = {}) {
  // Node's fetch normalizes Host to the URL authority. Use the wire-level client
  // for Host injection tests so these assertions actually exercise our guard.
  if (headers.host !== undefined) {
    return new Promise<globalThis.Response>((resolve, reject) => {
      const req = request(
        url,
        { method: 'POST', headers: { ...mcpHeaders, ...headers } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          res.on('end', () => {
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(res.headers)) {
              if (value !== undefined)
                responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
            }
            resolve(
              new Response(Buffer.concat(chunks).toString(), {
                status: res.statusCode,
                headers: responseHeaders,
              }),
            );
          });
        },
      );
      req.once('error', reject);
      req.end(JSON.stringify(body));
    });
  }
  return fetch(url, {
    method: 'POST',
    headers: { ...mcpHeaders, ...headers },
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(
    mountedServers.splice(0).map(async ({ server, runtime }) => {
      await runtime.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }),
  );
});

describe('stateless Streamable HTTP transport', () => {
  it('supports initialize, tools, resources, and prompts using the official MCP client', async () => {
    const instances: ReturnType<typeof vi.spyOn>[] = [];
    const { url, runtime } = await start(() => {
      const server = fixtureServer();
      instances.push(vi.spyOn(server, 'close'));
      return server;
    });
    const client = new Client({ name: 'integration-client', version: '1.0.0' });
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(url);
    await client.connect(transport);
    expect(client.getServerVersion()?.name).toBe('transport-fixture');
    expect(transport.sessionId).toBeUndefined();
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['echo']);
    expect(
      (await client.callTool({ name: 'echo', arguments: { value: 'Juicebox' } })).content,
    ).toEqual([{ type: 'text', text: 'Juicebox' }]);
    expect((await client.listResources()).resources[0]?.uri).toBe('juicebox://reference');
    expect((await client.readResource({ uri: 'juicebox://reference' })).contents[0]).toMatchObject({
      text: 'Versioned reference fixture.',
    });
    expect((await client.listPrompts()).prompts[0]?.name).toBe('explain');
    expect(
      (await client.getPrompt({ name: 'explain', arguments: { project: '123' } })).messages[0]
        ?.content,
    ).toEqual({ type: 'text', text: 'Explain 123.' });
    await vi.waitFor(() => {
      expect(runtime.activeRequests()).toBe(0);
      expect(instances.length).toBe(8);
      expect(instances.every((spy) => spy.mock.calls.length === 1)).toBe(true);
    });
  });

  it('returns JSON responses without session IDs and does not share protocol servers', async () => {
    const factory = vi.fn(fixtureServer);
    const { url } = await start(factory);
    const responses = await Promise.all([post(url), post(url)]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(response.headers.get('mcp-session-id')).toBeNull();
      expect(await response.json()).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: { tools: [{ name: 'echo' }] },
      });
    }
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('distinguishes local readiness from unchecked upstream health', async () => {
    const { base } = await start();
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'alive' });
    const ready = await fetch(`${base}/readyz`);
    expect(await ready.json()).toEqual({
      status: 'ready',
      scope: 'local_configuration_and_services',
      upstreamHealth: 'not_checked',
    });
    expect(ready.headers.get('cache-control')).toBe('no-store');
    expect(ready.headers.get('x-powered-by')).toBeNull();
  });

  it.each(['GET', 'DELETE', 'PUT'])('rejects %s on the stateless endpoint', async (method) => {
    const { url } = await start();
    const response = await fetch(url, { method });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST, OPTIONS');
  });

  it('enforces the socket Host and ignores spoofed forwarded headers', async () => {
    const { url } = await start();
    for (const host of [
      'attacker.example',
      'localhost.attacker.example',
      'localhost:70000',
      'localhost@attacker.example',
    ]) {
      const response = await post(url, toolsList, {
        host,
        'x-forwarded-host': 'localhost',
        'x-forwarded-for': '127.0.0.1',
      });
      expect(response.status).toBe(403);
    }
    expect((await post(url, toolsList, { 'x-forwarded-host': 'attacker.example' })).status).toBe(
      200,
    );
  });

  it('supports explicitly configured production and reverse-proxy hostnames', async () => {
    const { url } = await start(
      fixtureServer,
      {},
      { allowedHosts: ['juicebox.diy', 'health.internal:444'] },
    );
    expect((await post(url, toolsList, { host: 'juicebox.diy' })).status).toBe(200);
    expect((await post(url, toolsList, { host: 'health.internal:444' })).status).toBe(200);
    expect((await post(url, toolsList, { host: 'health.internal:445' })).status).toBe(403);
    expect((await post(url)).status).toBe(403);
  });

  it('allows configured browser origins and rejects other origins even for preflight', async () => {
    const origin = 'https://juicebox.diy';
    const { url } = await start(fixtureServer, {}, { allowedOrigins: [origin] });
    const response = await post(url, toolsList, { origin });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    expect(response.headers.get('vary')).toBe('Origin');
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    const preflight = await fetch(url, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,mcp-protocol-version',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toBe('POST');
    for (const blocked of [
      'null',
      'https://juicebox.diy.attacker.example',
      `${origin}/`,
      'https://evil.example',
    ]) {
      expect((await post(url, toolsList, { origin: blocked })).status).toBe(403);
    }
    expect(
      (
        await fetch(url, {
          method: 'OPTIONS',
          headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(url, {
          method: 'OPTIONS',
          headers: {
            origin,
            'access-control-request-method': 'POST',
            'access-control-request-headers': 'authorization',
          },
        })
      ).status,
    ).toBe(403);
  });

  it('bounds body sizes and hides malformed payload contents in errors and logs', async () => {
    const logger = vi.fn();
    const { url, runtime } = await start(fixtureServer, { logger });
    const badJson = await fetch(url, {
      method: 'POST',
      headers: mcpHeaders,
      body: '{"private":"SECRET_DO_NOT_LOG"',
    });
    expect(badJson.status).toBe(400);
    expect(await badJson.text()).not.toContain('SECRET_DO_NOT_LOG');
    const oversized = await post(url, { padding: 'x'.repeat(256 * 1024) });
    expect(oversized.status).toBe(413);
    expect((await post(url, toolsList, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await post(url, toolsList, { 'content-encoding': 'gzip' })).status).toBe(415);
    expect(JSON.stringify(logger.mock.calls)).not.toContain('SECRET_DO_NOT_LOG');
    await vi.waitFor(() => expect(runtime.activeRequests()).toBe(0));
  });

  it('admits a complete 1 MiB logo while retaining the smaller limit for ordinary HTTP messages', async () => {
    const upload = vi.fn(async ({ imageBase64 }: { imageBase64: string }) => ({
      content: [{ type: 'text' as const, text: String(Buffer.from(imageBase64, 'base64').length) }],
    }));
    const factory = vi.fn(() => {
      const server = fixtureServer();
      server.registerTool(
        'jb_pin_project_logo',
        { inputSchema: { imageBase64: z.string() } },
        upload,
      );
      return server;
    });
    const { url } = await start(factory);
    const request = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'jb_pin_project_logo',
        arguments: { imageBase64: Buffer.alloc(MAX_PROJECT_LOGO_BYTES).toString('base64') },
      },
    };
    const response = await post(url, request);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: { content: [{ text: String(MAX_PROJECT_LOGO_BYTES) }] },
    });
    expect(upload).toHaveBeenCalledOnce();
    factory.mockClear();
    const ordinary = await post(url, { ...request, params: { ...request.params, name: 'echo' } });
    expect(ordinary.status).toBe(413);
    const overflow = await post(url, {
      ...request,
      padding: 'x'.repeat(MAX_LOGO_REQUEST_BYTES),
    });
    expect(overflow.status).toBe(413);
    expect(factory).not.toHaveBeenCalled();
    expect(upload).toHaveBeenCalledOnce();
  });

  it('delegates protocol and Accept-header validation to the official transport', async () => {
    const { url, runtime } = await start();
    expect((await post(url, toolsList, { accept: 'text/plain' })).status).toBe(406);
    expect((await post(url, toolsList, { 'mcp-protocol-version': '1900-01-01' })).status).toBe(400);
    await vi.waitFor(() => expect(runtime.activeRequests()).toBe(0));
  });

  it('rejects legacy JSON-RPC batches before constructing any protocol server', async () => {
    const factory = vi.fn(fixtureServer);
    const { url, runtime } = await start(factory);
    for (const batch of [[], [toolsList], [toolsList, { ...toolsList, id: 2 }]]) {
      const response = await post(url, batch);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: -32600 } });
    }
    expect(factory).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(runtime.activeRequests()).toBe(0));
  });

  it('cleans up failed server construction without exposing error details', async () => {
    const logger = vi.fn();
    const { url, runtime } = await start(
      () => {
        throw new Error('https://secret:credential@example.com');
      },
      { logger },
    );
    const response = await post(url);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('credential');
    expect(JSON.stringify(logger.mock.calls)).not.toContain('credential');
    await vi.waitFor(() => expect(runtime.activeRequests()).toBe(0));
  });

  it('limits concurrent requests and aborts the MCP handler when a client disconnects', async () => {
    let started = false;
    let cancelled = false;
    const { url, runtime } = await start(
      () => {
        const server = fixtureServer();
        server.registerTool('wait', {}, async (_extra) => {
          started = true;
          await new Promise<void>((resolve) => {
            _extra.signal.addEventListener(
              'abort',
              () => {
                cancelled = true;
                resolve();
              },
              { once: true },
            );
          });
          return { content: [] };
        });
        return server;
      },
      {},
      { maxConcurrentRequests: 1 },
    );
    const controller = new AbortController();
    const pending = fetch(url, {
      method: 'POST',
      headers: mcpHeaders,
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'wait', arguments: {} },
      }),
    }).catch((error) => error);
    await vi.waitFor(() => expect(started).toBe(true));
    expect((await post(url)).status).toBe(503);
    controller.abort();
    await pending;
    await vi.waitFor(() => {
      expect(cancelled).toBe(true);
      expect(runtime.activeRequests()).toBe(0);
    });
    expect((await post(url)).status).toBe(200);
  });

  it('cancels handlers when the request deadline expires', async () => {
    let cancelled = false;
    const { url, runtime } = await start(
      () => {
        const server = fixtureServer();
        server.registerTool('wait', {}, async (extra) => {
          await new Promise<void>((resolve) => {
            extra.signal.addEventListener(
              'abort',
              () => {
                cancelled = true;
                resolve();
              },
              { once: true },
            );
          });
          return { content: [] };
        });
        return server;
      },
      { requestTimeoutMs: 50 },
    );
    const response = await post(url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'wait', arguments: {} },
    });
    expect(response.status).toBe(504);
    await vi.waitFor(() => {
      expect(cancelled).toBe(true);
      expect(runtime.activeRequests()).toBe(0);
    });
  });

  it('applies a bounded IP quota without trusting X-Forwarded-For', async () => {
    const { url, base } = await start(fixtureServer, { rateLimitPerMinute: 2 });
    expect((await post(url)).status).toBe(200);
    expect((await post(url, toolsList, { 'x-forwarded-for': '198.51.100.20' })).status).toBe(200);
    const limited = await post(url, toolsList, { 'x-forwarded-for': '198.51.100.21' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it('bounds graceful shutdown, cancels active handlers, and allows repeated close calls', async () => {
    let started = false;
    let cancelled = false;
    const { url, runtime } = await start(
      () => {
        const server = fixtureServer();
        server.registerTool('wait', {}, async (extra) => {
          started = true;
          await new Promise<void>((resolve) => {
            extra.signal.addEventListener(
              'abort',
              () => {
                cancelled = true;
                resolve();
              },
              { once: true },
            );
          });
          return { content: [] };
        });
        return server;
      },
      { shutdownGraceMs: 20 },
    );
    const pending = post(url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'wait', arguments: {} },
    }).catch((error) => error);
    await vi.waitFor(() => expect(started).toBe(true));
    await Promise.all([runtime.close(), runtime.close()]);
    await pending;
    expect(cancelled).toBe(true);
    expect(runtime.activeRequests()).toBe(0);
  });

  it('allows an active response to complete within the shutdown grace period', async () => {
    const tool = new EventEmitter();
    let finishTool!: () => void;
    const completion = new Promise<void>((resolve) => {
      finishTool = resolve;
    });
    const { url, runtime } = await start(
      () => {
        const server = fixtureServer();
        server.registerTool('wait', {}, async () => {
          tool.emit('started');
          await completion;
          return { content: [{ type: 'text', text: 'Completed before shutdown.' }] };
        });
        return server;
      },
      { shutdownGraceMs: 1_000 },
    );
    // Tool admission precedes the shutdown deadline; allow suite scheduling time
    // without changing the grace period this test exercises.
    const started = once(tool, 'started', { signal: AbortSignal.timeout(5_000) });
    const pending = post(url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'wait', arguments: {} },
    });
    const settled = Promise.allSettled([pending]);
    try {
      await started;
      const closing = runtime.close();
      finishTool();
      const [response] = await Promise.all([pending, closing]);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        result: { content: [{ text: 'Completed before shutdown.' }] },
      });
      expect(runtime.activeRequests()).toBe(0);
      await expect(runtime.listen()).rejects.toThrow('cannot be restarted');
    } finally {
      finishTool();
      await Promise.all([runtime.close(), settled]);
    }
  }, 10_000);
});

async function startMounted(factory = fixtureServer, options: HttpOptions = {}) {
  const runtime = createHttpHandler(loadConfig({ PORT: '0' }), factory, {
    ...options,
    healthPath: '/mcp/healthz',
    readinessPath: '/mcp/readyz',
    indexPath: false,
  });
  const server = createServer({ requestTimeout: 300_000 }, (req, res) => {
    const path = req.url?.split('?')[0];
    if (path === '/mcp' || path?.startsWith('/mcp/')) {
      runtime.handler(req, res);
      return;
    }
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
    });
    req.once('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ owner: 'parent', path, bytes }));
    });
  });
  mountedServers.push({ server, runtime });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { runtime, server, base, url: new URL(`${base}/mcp`) };
}

describe('MCP handler embedded in a shared Node listener', () => {
  it('preserves sibling routes, request streams, and security policies', async () => {
    const { base, url } = await startMounted();
    const client = new Client({ name: 'mounted-client', version: '1.0.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(url));
    expect((await client.listTools()).tools[0]?.name).toBe('echo');
    expect(await (await fetch(`${base}/mcp/healthz`)).json()).toEqual({ status: 'alive' });
    expect(await (await fetch(`${base}/mcp/readyz`)).json()).toMatchObject({ status: 'ready' });
    expect(await (await fetch(`${base}/readyz`)).json()).toMatchObject({ owner: 'parent' });
    expect(await (await fetch(`${base}/`)).json()).toMatchObject({ owner: 'parent' });
    const largeBody = JSON.stringify({ payload: 'x'.repeat(300_000) });
    const sibling = await fetch(`${base}/v1/intents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://parent.example' },
      body: largeBody,
    });
    expect(await sibling.json()).toEqual({
      owner: 'parent',
      path: '/v1/intents',
      bytes: largeBody.length,
    });
    expect((await post(url, { payload: 'x'.repeat(300_000) })).status).toBe(413);
    expect((await post(url, toolsList, { origin: 'https://parent.example' })).status).toBe(403);
    expect((await post(url, toolsList, { host: 'parent.example' })).status).toBe(403);
    expect(
      (await post(new URL(`${base}/v1/intents`), toolsList, { host: 'parent.example' })).status,
    ).toBe(200);
    expect((await post(new URL(`${base}/mcp?client=test`))).status).toBe(200);
  });

  it.each([
    {
      name: 'body',
      options: { bodyTimeoutMs: 40 },
      status: 408,
      message: 'Request body deadline exceeded.',
    },
    {
      name: 'operation',
      options: { bodyTimeoutMs: 1000, requestTimeoutMs: 40 },
      status: 504,
      message: 'Request deadline exceeded.',
    },
  ])(
    'enforces the MCP $name deadline even when the parent allows long uploads',
    async ({ options, status, message }) => {
      const factory = vi.fn(fixtureServer);
      const { url, runtime, server } = await startMounted(factory, options);
      expect(server.requestTimeout).toBe(300_000);
      const response = await new Promise<{ status?: number; text: string; connection?: string }>(
        (resolve, reject) => {
          const req = request(
            url,
            {
              method: 'POST',
              headers: { ...mcpHeaders, 'content-length': '1000' },
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
              res.once('end', () => {
                resolve({
                  status: res.statusCode,
                  text: Buffer.concat(chunks).toString(),
                  connection: res.headers.connection,
                });
                req.destroy();
              });
            },
          );
          req.once('error', reject);
          // Deliberately leave this request incomplete; the owning listener permits 300 seconds.
          req.write('{"jsonrpc":');
        },
      );
      expect(response.status).toBe(status);
      expect(response.connection).toBe('close');
      expect(JSON.parse(response.text)).toMatchObject({
        error: { message },
      });
      expect(factory).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(runtime.activeRequests()).toBe(0));
      expect((await post(url)).status).toBe(200);
    },
  );

  it('clears the body timer while a completed request performs longer tool work', async () => {
    const { url } = await startMounted(
      () => {
        const server = fixtureServer();
        server.registerTool('slow', {}, async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return { content: [{ type: 'text', text: 'finished' }] };
        });
        return server;
      },
      { bodyTimeoutMs: 40, requestTimeoutMs: 1000 },
    );
    const response = await post(url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'slow', arguments: {} },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { content: [{ text: 'finished' }] } });
  });

  it('drains only MCP admission and allows existing work to finish before disposal', async () => {
    let finishTool: (() => void) | undefined;
    const { base, url, runtime } = await startMounted(() => {
      const server = fixtureServer();
      server.registerTool('wait', {}, async () => {
        await new Promise<void>((resolve) => {
          finishTool = resolve;
        });
        return { content: [{ type: 'text', text: 'finished' }] };
      });
      return server;
    });
    const pending = post(url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'wait', arguments: {} },
    });
    await vi.waitFor(() => expect(finishTool).toBeTypeOf('function'));
    runtime.beginDrain();
    expect(runtime.isDraining()).toBe(true);
    expect((await post(url)).status).toBe(503);
    expect((await fetch(`${base}/mcp/readyz`)).status).toBe(503);
    expect((await fetch(`${base}/mcp/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    finishTool!();
    expect((await pending).status).toBe(200);
    await Promise.all([runtime.close(), runtime.close()]);
    expect(runtime.activeRequests()).toBe(0);
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
  });

  it('disposes active protocols without closing the shared listener', async () => {
    let started = false;
    let cancelled = false;
    const { base, url, runtime } = await startMounted(() => {
      const server = fixtureServer();
      server.registerTool('wait', {}, async (extra) => {
        started = true;
        await new Promise<void>((resolve) => {
          extra.signal.addEventListener(
            'abort',
            () => {
              cancelled = true;
              resolve();
            },
            { once: true },
          );
        });
        return { content: [] };
      });
      return server;
    });
    const pending = post(url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'wait', arguments: {} },
    }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(started).toBe(true));
    await Promise.all([runtime.close(), runtime.close()]);
    await pending;
    expect(cancelled).toBe(true);
    expect(runtime.activeRequests()).toBe(0);
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
  });
});
