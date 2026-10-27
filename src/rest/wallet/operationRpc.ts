import { isProxy } from "node:util/types";
import type { Hex } from "viem";
import { RestError, type RestRpc } from "../core.js";
import { stable } from "../smartAccounts/service.js";
import { SIGNA_HOME_CHAIN_ID, signaChain } from "./chains.js";

export const walletPreflightRpcBounds = Object.freeze({ rpcCalls: 64, rpcTimeoutMs: 3000, totalTimeoutMs: 15_000, responseBytes: 2 * 1024 * 1024 });
export const walletObservationRpcBounds = Object.freeze({ rpcCalls: 256, rpcTimeoutMs: 3000, totalTimeoutMs: 30_000, responseBytes: 8 * 1024 * 1024 });

function fail(code: string, message: string, status = 422): never { throw new RestError(status, code, message); }
function word(value: unknown): value is Hex { return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) && BigInt(value) !== 0n; }

/** A single read-only operation owns all calls, response bytes and cancellation, including helper
 * reads. Promise races also bound transports that fail to honor their AbortSignal. */
export function operationRpc(rpc: RestRpc, limits: Record<keyof typeof walletPreflightRpcBounds, number>, signal?: AbortSignal, observation = false, chainId: number = SIGNA_HOME_CHAIN_ID) {
  // Existing wallet authority callers remain bound to Base. Operator dependency
  // observations may explicitly read one of Center's other configured EVM chains.
  if (!signaChain(chainId))
    fail('WALLET_DEPLOYMENT_CHAIN_UNSUPPORTED', 'Unsupported dependency observation chain.', 500);
  const controller = new AbortController();
  const operationDeadline = performance.now() + limits.totalTimeoutMs;
  let failure: RestError | undefined, remaining = limits.rpcCalls, remainingBytes = limits.responseBytes;
  const stop = (error: RestError) => { failure ??= error; controller.abort(); };
  const cancel = () => stop(new RestError(499, "WALLET_DEPLOYMENT_CANCELLED", "Deployment observation was cancelled."));
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const deadline = setTimeout(() => stop(new RestError(504, "WALLET_DEPLOYMENT_DEADLINE", "Deployment observation exceeded its total deadline.")), limits.totalTimeoutMs);
  const check = (callDeadline?: number) => {
    const current = performance.now();
    // Timers cannot interrupt synchronous work or a continuously resolving microtask chain.
    if (!failure && current >= operationDeadline)
      stop(new RestError(504, "WALLET_DEPLOYMENT_DEADLINE", "Deployment observation exceeded its total deadline."));
    if (!failure && callDeadline !== undefined && current >= callDeadline)
      stop(new RestError(504, "WALLET_DEPLOYMENT_RPC_TIMEOUT", "The configured RPC did not answer within its deadline."));
    if (failure) throw failure;
  };
  function checkedResponse(value: unknown, trace: boolean, hashBlock: boolean): unknown {
    // Build only the bounded sanitized copy. Do not clone sparse arrays, invoke proxies/accessors,
    // allocate every descriptor, or serialize an unbounded property name before admission.
    let nodes = 0, bytes = 0;
    // A supported 4096-hash block also contains header fields. Leave bounded structural
    // room for that envelope; response-byte, depth, deadline and call budgets stay unchanged.
    const maxNodes = trace ? 32_768 : hashBlock ? 8192 : 4096, maxDepth = trace ? 64 : 8, maxBytes = trace ? 1_048_576 : 524_288;
    const stringBytes = (value: string) => {
      if (value.length > maxBytes || Buffer.byteLength(value, "utf8") > remainingBytes)
        fail("WALLET_DEPLOYMENT_RPC_BYTES", "Deployment observation exhausted its response-byte budget.", 429);
      return Buffer.byteLength(JSON.stringify(value), "utf8");
    };
    function visit(item: unknown, depth: number): unknown {
      if (++nodes > maxNodes || depth > maxDepth) fail("WALLET_DEPLOYMENT_RPC_BYTES", "The provider response exceeds its structural bound.", 429);
      let result: unknown = item;
      if (typeof item === "string") {
        bytes += stringBytes(item);
      }
      else if (item === null || typeof item === "boolean") bytes += 5;
      else if (typeof item === "number" && Number.isSafeInteger(item)) bytes += 24;
      else if (item && typeof item === "object" && !isProxy(item) &&
        (Array.isArray(item) || Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)) {
        const array = Array.isArray(item);
        if (array && item.length > maxNodes) fail("WALLET_DEPLOYMENT_RPC_BYTES", "The provider array exceeds its structural bound.", 429);
        const keys = Reflect.ownKeys(item);
        if (keys.length > maxNodes || (array && keys.length !== item.length + 1))
          fail("WALLET_DEPLOYMENT_RPC_BYTES", "The provider object exceeds its structural bound.", 429);
        const copy: Record<string, unknown> | unknown[] = array ? [] : Object.create(null) as Record<string, unknown>;
        bytes += 2;
        for (const key of keys) {
          if (typeof key !== "string" || (array && key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)))
            fail("WALLET_DEPLOYMENT_RPC_INVALID", "Expected ordinary provider JSON.", 502);
          if (array && key === "length") continue;
          bytes += stringBytes(key) + 2;
          const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
          if (!("value" in descriptor) || !descriptor.enumerable) fail("WALLET_DEPLOYMENT_RPC_INVALID", "Expected ordinary provider JSON.", 502);
          (copy as Record<string, unknown>)[key] = visit(descriptor.value, depth + 1);
        }
        result = copy;
      } else fail("WALLET_DEPLOYMENT_RPC_INVALID", "Expected ordinary provider JSON.", 502);
      if (bytes > remainingBytes || bytes > maxBytes) fail("WALLET_DEPLOYMENT_RPC_BYTES", "Deployment observation exhausted its response-byte budget.", 429);
      return result;
    }
    const result = visit(value, 0); remainingBytes -= bytes;
    return result;
  }
  return {
    check,
    close() { clearTimeout(deadline); signal?.removeEventListener("abort", cancel); cancel(); },
    async request(method: string, params: readonly unknown[]): Promise<unknown> {
      check();
      const trace = observation && method === "debug_traceTransaction";
      if (trace && (params.length !== 2 || !word(params[0]) || stable(params[1]) !== stable({
        tracer: "callTracer", timeout: "10s", tracerConfig: { onlyTopCall: false },
      }))) fail("WALLET_DEPLOYMENT_RPC_INVALID", "Only the fixed complete transaction tracer is allowed.", 500);
      const timeoutMs = trace ? Math.min(12_000, limits.totalTimeoutMs) : limits.rpcTimeoutMs;
      if (--remaining < 0) {
        stop(new RestError(429, "WALLET_DEPLOYMENT_RPC_BUDGET", "Deployment observation exhausted its RPC call budget.")); check();
      }
      const call = new AbortController();
      const callDeadline = performance.now() + timeoutMs;
      const abort = () => call.abort();
      controller.signal.addEventListener("abort", abort, { once: true });
      const interrupted = new Promise<never>((_, reject) => call.signal.addEventListener("abort", () => reject(failure), { once: true }));
      const timer = setTimeout(() => stop(new RestError(504, "WALLET_DEPLOYMENT_RPC_TIMEOUT", "The configured RPC did not answer within its deadline.")), timeoutMs);
      try {
        // Attach both race handlers before invoking a transport that may throw synchronously.
        const response = Promise.resolve().then(() => {
          check(callDeadline); return rpc.request(chainId, method, structuredClone(params), call.signal);
        });
        const result = await Promise.race([response, interrupted]);
        const hashBlock = (method === "eth_getBlockByNumber" || method === "eth_getBlockByHash") && params.length === 2 && params[1] === false;
        check(callDeadline); const checked = checkedResponse(result, trace, hashBlock); check(callDeadline); return checked;
      } catch (error) {
        stop(error instanceof RestError ? error : new RestError(502, "WALLET_DEPLOYMENT_RPC_UNAVAILABLE", "The configured RPC could not verify the exact deployment."));
        check(); throw error;
      } finally { clearTimeout(timer); controller.signal.removeEventListener("abort", abort); call.abort(); }
    },
  };
}
