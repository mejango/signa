import { getRequestListener } from '@hono/node-server';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface SignaServerOptions {
  port: number;
  hostname?: string;
  shutdownGraceMs?: number;
}

export interface SignaServer {
  server: Server;
  listen(): Promise<AddressInfo>;
  close(): Promise<void>;
}

/** Native HTTP only: no Center site, IPFS gateway, or MCP transport. */
export function createSignaServer(fetch: Parameters<typeof getRequestListener>[0], options: SignaServerOptions): SignaServer {
  const grace = options.shutdownGraceMs ?? 25_000;
  if (!Number.isSafeInteger(grace) || grace < 1 || grace > 300_000)
    throw new Error('Shutdown grace must be a positive bounded integer');
  const listener = getRequestListener(fetch, { overrideGlobalObjects: false });
  let draining = false, closing: Promise<void> | undefined;
  const server = createServer({ maxHeaderSize: 16 * 1024, headersTimeout: 10_000,
    requestTimeout: 300_000, keepAliveTimeout: 5_000 }, (request, response) => {
    response.once('finish', () => { if (draining) setImmediate(() => server.closeIdleConnections()); });
    if (draining) {
      response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close', 'Retry-After': '1' });
      response.end(JSON.stringify({ error: { code: 'draining', message: 'Server is shutting down' } }));
      return;
    }
    void listener(request, response);
  });
  server.maxHeadersCount = 100;
  return {
    server,
    listen: () => new Promise((resolve, reject) => {
      if (draining) return reject(new Error('A closed server cannot be restarted'));
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      server.listen(options.port, options.hostname ?? '0.0.0.0', () => {
        server.off('error', onError);
        resolve(server.address() as AddressInfo);
      });
    }),
    close: () => {
      if (closing) return closing;
      draining = true;
      closing = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => server.closeAllConnections(), grace);
        timeout.unref();
        server.close(error => {
          clearTimeout(timeout);
          if (error && 'code' in error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
          else resolve();
        });
        server.closeIdleConnections();
      });
      return closing;
    },
  };
}
