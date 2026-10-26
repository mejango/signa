/** One JSON-RPC batch sent from the page straight to a chain's public RPC, never through Signa's server.
 * Each call's result in order; undefined where the RPC gave none. */
export async function chainRpcBatch(rpc: string, calls: readonly (readonly [string, readonly unknown[]])[], signal: AbortSignal): Promise<unknown[]> {
  const response = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer',
    signal, body: JSON.stringify(calls.map(([method, params], id) => ({ jsonrpc: '2.0', id, method, params }))) });
  const replies = await response.json() as { id: number; result?: unknown }[];
  return calls.map((_, id) => Array.isArray(replies) ? replies.find(reply => reply?.id === id)?.result : undefined);
}
