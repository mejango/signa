import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { encodeAbiParameters, encodeFunctionData, erc20Abi, keccak256, parseAbi, toFunctionSelector, type Address, type Hex } from "viem";
import { RestError, type RestRpc } from "../src/rest/core.js";
import { problem } from "../src/rest/http.js";
import { payFailureOf as clientPayFailureOf, RestClientError } from "../src/rest/client/index.js";
import { encodeSafe7579Execution } from "../src/rest/smartAccounts/accountExecution.js";
import { UserOperationChain } from "../src/rest/userOperations/chain.js";
import { explainedRefusal, payFailureOf, simulatedPayFailure, tracedPayFailure } from "../src/rest/userOperations/payFailure.js";

const sender = "0x1111111111111111111111111111111111111111" as Address;
const terminal = "0x2222222222222222222222222222222222222222" as Address;
const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const payAbi = parseAbi(["function pay(uint256 projectId,address token,uint256 amount,address beneficiary,uint256 minReturnedTokens,string memo,bytes metadata) payable returns (uint256)"]);
const pay = encodeFunctionData({ abi: payAbi, functionName: "pay", args: [1n, usdc, 100n, sender, 900n, "", "0x"] });
const approve = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [terminal, 100n] });
const payment = encodeSafe7579Execution([{ target: usdc, value: "0", callData: approve }, { target: terminal, value: "0", callData: pay }]);
const transfer = encodeSafe7579Execution([{ target: usdc, value: "0",
  callData: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [terminal, 1n] }) }]);
// JBMultiTerminal_UnderMin(812, 900): the terminal settled 812 tokens against a 900 minimum.
const underMin = `0x6b2bb382${encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [812n, 900n]).slice(2)}` as Hex;
const executionFailed = "0xacfdb444" as Hex;
const expected = { reason: "TERMINAL_UNDER_MIN", received: "812", minimum: "900", message: expect.any(String) };
const chainWith = (request: RestRpc["request"]) => new UserOperationChain({ request: vi.fn(request) });

describe("payment failure reasons", () => {
  it("decodes revert data only, with amounts as decimal strings", () => {
    expect(payFailureOf(underMin)).toEqual(expected);
    expect(payFailureOf(executionFailed)).toBeUndefined();
    // Node text quoting a revert is never read: only exact revert data counts.
    expect(payFailureOf(`execution reverted ${underMin} https://node.example/key`)).toBeUndefined();
    expect(payFailureOf({ data: underMin })).toBeUndefined();
    // An Error(string) that names or quotes the terminal's error is text, not the error.
    const said = (text: string) => encodeFunctionData({ abi: parseAbi(["function Error(string)"]), functionName: "Error", args: [text] });
    expect(payFailureOf(said(`JBMultiTerminal_UnderMin(812, 900) ${underMin}`))).toBeUndefined();
    // Nothing to receive is never a minimum to lower.
    const none = payFailureOf(`0x6b2bb382${encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [0n, 900n]).slice(2)}`);
    expect(none).toMatchObject({ reason: "TERMINAL_UNDER_MIN", received: "0", minimum: "900" });
    expect(none!.message).not.toMatch(/lower your minimum/i);
    expect(clientPayFailureOf(none)).toEqual(none);
  });

  it("simulates a refused payment's calls from the account and reads the failing one", async () => {
    let seen: readonly unknown[] = [];
    const chain = chainWith(async (_chainId, method, params) => {
      expect(method).toBe("eth_simulateV1");
      seen = params;
      return [{ calls: [{ status: "0x1", returnData: "0x" }, { status: "0x0", returnData: underMin,
        error: { code: 3, message: "execution reverted https://node.example/key" } }] }];
    });
    expect(await simulatedPayFailure(chain, 8453, sender, payment)).toEqual(expected);
    expect(seen).toEqual([{ blockStateCalls: [{ calls: [
      { from: sender, to: usdc, data: approve, value: "0x0" }, { from: sender, to: terminal, data: pay, value: "0x0" }] }] }, "latest"]);
    // An operation that pays nothing is never simulated for a payment reason.
    const idle = vi.fn<RestRpc["request"]>();
    expect(await simulatedPayFailure(new UserOperationChain({ request: idle }), 8453, sender, transfer)).toBeUndefined();
    expect(idle).not.toHaveBeenCalled();
    // A node without the method, or calls that pass now, give no reason.
    expect(await simulatedPayFailure(chainWith(async () => { throw new Error("method not found https://node.example/key"); }), 8453, sender, payment)).toBeUndefined();
    expect(await simulatedPayFailure(chainWith(async () => [{ calls: [{ status: "0x1" }, { status: "0x1" }] }]), 8453, sender, payment)).toBeUndefined();
  });

  it("explains only a bundler's or the chain's refusal, keeping its code and message", async () => {
    const chain = chainWith(async () => [{ calls: [{ status: "0x1" }, { status: "0x0", returnData: underMin }] }]);
    const refused = new RestError(502, "USER_OPERATION_PROVIDER_REJECTED", "The provider rejected the operation.");
    const explained = await explainedRefusal(refused, chain, 8453, sender, payment) as RestError;
    expect(explained).toBeInstanceOf(RestError);
    expect([explained.status, explained.code, explained.message]).toEqual([502, refused.code, refused.message]);
    expect(explained.details).toEqual({ payFailure: expected });
    const other = new RestError(409, "USER_OPERATION_NONCE_CHANGED", "Nonce changed.");
    expect(await explainedRefusal(other, chain, 8453, sender, payment)).toBe(other);
    const unexplained = chainWith(async () => [{ calls: [{ status: "0x1" }, { status: "0x1" }] }]);
    expect(await explainedRefusal(refused, unexplained, 8453, sender, payment)).toBe(refused);
  });

  it("reads a reverted payment from its own operation's failed call in the transaction trace", async () => {
    const hash = `0x${"ab".repeat(32)}` as Hex;
    let traced: readonly unknown[] = [];
    // EntryPoint runs the operation's calldata on the account; Safe7579 wraps the failing pay in ExecutionFailed.
    const operation = (callData: Hex, output: Hex) => ({ from: "0xentrypoint", to: sender.toUpperCase().replace("0X", "0x"), input: callData,
      error: "execution reverted", calls: [{ from: sender, to: "0x7579", error: "execution reverted", output: executionFailed, calls: [
        { from: "0x7579", to: sender, input: "0x468721a7", calls: [{ from: sender, to: usdc, output: "0x01" },
          { from: sender, to: terminal, error: "execution reverted", output }] }] }] });
    const other = `0x6b2bb382${encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [1n, 2n]).slice(2)}` as Hex;
    const trace = { from: "0xbundler", to: "0xentrypoint", calls: [operation(transfer, other), operation(payment, underMin)] };
    const chain = chainWith(async (_chainId, method, params) => { expect(method).toBe("debug_traceTransaction"); traced = params; return trace; });
    // Another operation from the same account in the bundle never lends its reason.
    expect(await tracedPayFailure(chain, 8453, hash, sender, payment)).toEqual(expected);
    expect(traced).toEqual([hash, { tracer: "callTracer", timeout: "10s", tracerConfig: { onlyTopCall: false } }]);
    expect(await tracedPayFailure(chainWith(async () => trace), 8453, hash, sender, transfer)).toBeUndefined();
    // The same calldata run twice is ambiguous, so no reason.
    const twice = { ...trace, calls: [operation(payment, other), operation(payment, underMin)] };
    expect(await tracedPayFailure(chainWith(async () => twice), 8453, hash, sender, payment)).toBeUndefined();
    expect(await tracedPayFailure(chainWith(async () => { throw new Error("trace unavailable"); }), 8453, hash, sender, payment)).toBeUndefined();
  });

  it("serves the reason in the problem body and nothing else from the error's details", async () => {
    const app = new Hono();
    app.onError(problem);
    app.get("/", () => { throw new RestError(502, "USER_OPERATION_RPC_UNAVAILABLE", "The configured chain could not verify or simulate this operation.",
      { payFailure: payFailureOf(underMin) }); });
    app.get("/raw", () => { throw new RestError(502, "RPC_REJECTED", "The configured RPC rejected the request", { revertData: underMin, rpcCode: 3 }); });
    const body = await (await app.request("/")).json() as Record<string, unknown>;
    expect(body.payFailure).toEqual(expected);
    const raw = JSON.stringify(await (await app.request("/raw")).json());
    expect(raw).not.toContain("payFailure");
    expect(raw).not.toContain(underMin.slice(2));
  });

  it("keeps every SDK reason and sentence on the client, amounts included", () => {
    const shortfalls = ["JBMultiTerminal_UnderMin", "JBBuybackHook_SpecifiedSlippageExceeded", "JBBuybackHook_DerivedFloorNotMet",
      "JBRouterTerminal_SlippageExceeded"].map(name => `${name}(uint256,uint256)`);
    const others = ["JBBuybackHook_InsufficientPayAmount(uint256,uint256)", "JBRouterTerminal_NoRouteFound(uint256,address)",
      "JBRouterTerminal_NoPoolFound(address,address)", "JBMultiTerminal_TokenNotAccepted(address)", "JBTerminalStore_RulesetPaymentPaused(uint256,uint256)",
      "JBTerminalStore_RulesetNotFound(uint256)", "JBMultiTerminal_PermitAllowanceNotEnough(uint256,uint256)",
      "JBRouterTerminalGateway_PermitAllowanceNotEnough(uint256,uint256)", "ERC20InsufficientAllowance(address,uint256,uint256)",
      "InsufficientAllowance(uint256)", "AllowanceExpired(uint256)", "ERC20InsufficientBalance(address,uint256,uint256)",
      "JBMultiTerminal_NoMsgValueAllowed(uint256)", "JBRouterTerminal_NoMsgValueAllowed(uint256)",
      "JB721TiersHookStore_InsufficientSupplyRemaining(uint256)", "JB721TiersHookStore_TierRemoved(uint256)",
      "JB721TiersHookStore_UnrecognizedTier(uint256)", "JB721TiersHookStore_PriceExceedsAmount(uint256,uint256)", "JB721TiersHook_Overspending(uint256)"];
    const revert = (signature: string, args: readonly unknown[]) => {
      const types = signature.slice(signature.indexOf("(") + 1, -1).split(",").map(type => ({ type }));
      return `${toFunctionSelector(signature)}${encodeAbiParameters(types, args).slice(2)}` as Hex;
    };
    const sample = (signature: string) => signature.slice(signature.indexOf("(") + 1, -1).split(",")
      .map(type => type === "address" ? sender : 1n);
    const reverts = [
      ...shortfalls.flatMap(signature => [revert(signature, [812n, 900n]), revert(signature, [0n, 900n]),
        // The router gateway keeps only the selector's hash: the reason without amounts.
        `0xa4ceb15e${keccak256(toFunctionSelector(signature)).slice(2)}` as Hex]),
      ...others.map(signature => revert(signature, sample(signature))),
    ];
    const reasons = new Set<string>();
    for (const data of reverts) {
      const served = payFailureOf(data);
      expect(served, data).toBeTruthy();
      reasons.add(served!.reason);
      expect(clientPayFailureOf(served), `${served!.reason} ${served!.message}`).toEqual(served);
    }
    expect(reasons.size).toBe(17);
  });

  it("keeps a served reason on the client only in its exact shape", () => {
    const served = payFailureOf(underMin)!;
    expect(clientPayFailureOf(served)).toEqual(served);
    expect(new RestClientError("USER_OPERATION_PROVIDER_REJECTED", "Refused.", 502, served).payFailure).toEqual(served);
    expect(new RestClientError("X", "Refused.").payFailure).toBeUndefined();
    for (const bad of [null, "TERMINAL_UNDER_MIN", { ...served, url: "https://node.example" }, { ...served, received: "8.5" },
      { ...served, minimum: 900 }, { ...served, reason: "not a reason" }, { reason: served.reason },
      { ...served, minimum: (2n ** 256n).toString() }, { ...served, message: "See https://node.example/key" },
      { ...served, message: "Reverted 0x6b2bb382" }, { ...served, message: "" },
      { ...served, reason: "INVENTED_REASON" }, { ...served, message: "Execution reverted. Visit evil.com." },
      { ...served, received: "901" }, { ...served, received: "900" }, { reason: "PAYMENTS_PAUSED", message: served.message, received: "1", minimum: "2" },
      { reason: served.reason, message: served.message, received: "812" }, { ...served, message: "Lower it by 100 tokens." }])
      expect(clientPayFailureOf(bad)).toBeUndefined();
  });
});
