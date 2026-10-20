import { decodePayFailure } from "@bananapus/nana-sdk-core/v6";
import { decodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { RestError } from "../core.js";
import { decodeSafe7579Execution } from "../smartAccounts/accountExecution.js";
import type { UserOperationChain } from "./chain.js";
import type { PayFailure } from "./types.js";

const payAbi = parseAbi(["function pay(uint256 projectId,address token,uint256 amount,address beneficiary,uint256 minReturnedTokens,string memo,bytes metadata) payable returns (uint256)"]);
/** Whether an account execution includes a terminal `pay`. */
function pays(callData: Hex): boolean {
  return decodeSafe7579Execution(callData).some(call => {
    try { return decodeFunctionData({ abi: payAbi, data: call.callData }).functionName === "pay"; } catch { return false; }
  });
}

/** Why revert data reverted a payment, from the SDK's table: a fixed reason and sentence, with the
 * amounts as decimal strings. Only raw revert data is read, never node text, so the SDK takes amounts
 * from the custom error's own bytes and an `Error(string)` naming one decodes to nothing. */
export function payFailureOf(revertData: unknown): PayFailure | undefined {
  if (typeof revertData !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(revertData)) return undefined;
  const failure = decodePayFailure(revertData);
  if (!failure) return undefined;
  return { reason: failure.reason, message: failure.message,
    ...(failure.received === undefined ? {} : { received: failure.received.toString() }),
    ...(failure.minimum === undefined ? {} : { minimum: failure.minimum.toString() }) };
}

/** The account turns any failed call into `ExecutionFailed()`, so the reason is read from the calls
 * themselves: each simulated from the account, in order, at the latest block. Only for an operation
 * that pays; a node without `eth_simulateV1` or any other failure gives no reason. */
export async function simulatedPayFailure(chain: UserOperationChain, chainId: number, sender: Address,
  callData: Hex): Promise<PayFailure | undefined> {
  try {
    if (!pays(callData)) return undefined;
    const calls = decodeSafe7579Execution(callData);
    const result = await chain.request(chainId, "eth_simulateV1", [{ blockStateCalls: [{ calls: calls.map(call => ({
      from: sender, to: call.target, data: call.callData, value: `0x${BigInt(call.value).toString(16)}` })) }] },
      "latest"]);
    const simulated = (result as { calls?: unknown }[] | undefined)?.[0]?.calls;
    const failed = Array.isArray(simulated) ? simulated.find(call => (call as { status?: unknown })?.status === "0x0") as
      { returnData?: unknown; error?: { data?: unknown } } | undefined : undefined;
    return failed && (payFailureOf(failed.returnData) ?? payFailureOf(failed.error?.data));
  } catch { return undefined; }
}

type Frame = { from?: unknown; to?: unknown; input?: unknown; output?: unknown; error?: unknown; calls?: unknown };
const framesOf = (root: Frame) => {
  const frames: Frame[] = [];
  for (const queue = [root]; queue.length;) {
    const frame = queue.shift()!;
    frames.push(frame);
    if (Array.isArray(frame.calls)) queue.push(...(frame.calls as Frame[]));
  }
  return frames;
};
const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
/** Why a mined operation's payment reverted: the first reverted call the account made inside this
 * operation's own execution (the EntryPoint's call of the account with exactly its calldata), read from
 * the transaction's call trace. A bundle can carry other operations of the same account, so an
 * execution that is not found exactly once gives no reason, as does a missing trace. */
export async function tracedPayFailure(chain: UserOperationChain, chainId: number, transactionHash: Hex,
  sender: Address, callData: Hex): Promise<PayFailure | undefined> {
  try {
    if (!pays(callData)) return undefined;
    const root = await chain.request(chainId, "debug_traceTransaction",
      [transactionHash, { tracer: "callTracer", timeout: "10s", tracerConfig: { onlyTopCall: false } }]);
    const executions = framesOf(root as Frame).filter(frame => same(frame.to, sender) && same(frame.input, callData));
    if (executions.length !== 1) return undefined;
    for (const frame of framesOf(executions[0]!)) {
      if (!same(frame.from, sender) || frame.error === undefined) continue;
      const failure = payFailureOf(frame.output);
      if (failure) return failure;
    }
  } catch { /* No trace, no reason. */ }
  return undefined;
}

const simulationRefusals = new Set(["USER_OPERATION_PROVIDER_REJECTED", "USER_OPERATION_RPC_UNAVAILABLE"]);
/** A bundler's or the chain's refusal of an operation, carrying why its payment reverts (for the
 * problem body) when the calls say. Any other error comes back as it is. */
export async function explainedRefusal(error: unknown, chain: UserOperationChain, chainId: number, sender: Address,
  callData: Hex): Promise<unknown> {
  if (!(error instanceof RestError) || !simulationRefusals.has(error.code)) return error;
  const payFailure = await simulatedPayFailure(chain, chainId, sender, callData);
  return payFailure ? new RestError(error.status, error.code, error.message, { payFailure }) : error;
}
