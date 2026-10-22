import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import type { ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { concatHex, decodeFunctionData, encodeFunctionData, encodeFunctionResult, getAddress, padHex, parseAbi, toHex, type Address, type Hex } from "viem";
import type { RestRpc } from "../src/rest/core.js";
import { safeAbi } from "../src/rest/smartAccounts/service.js";
import { assertOwnersConsistent, observeWalletOwners, type WalletOwnerObservation, type WalletOwnerStateStore } from "../src/rest/wallet/ownerState.js";
import { anvilAvailable, spawnAnvil } from "./support/anvil.js";

const account = "0x1111111111111111111111111111111111111111" as Address;
const passkey = "0x2222222222222222222222222222222222222222" as Address, recovery = "0x3333333333333333333333333333333333333333" as Address;
const rotated = "0x4444444444444444444444444444444444444444" as Address;
const hash = (n: number) => padHex(toHex(n), { size: 32 });

/** One synthetic node per chain: a head and the Safe's owners and threshold at it. */
function chains(initial: Record<number, { owners: Address[]; threshold?: bigint; head?: number; down?: boolean }>) {
  const state = structuredClone(initial), calls: { chainId: number; method: string; functionName?: string }[] = [];
  const rpc: RestRpc = { async request(chainId, method, params) {
    const chain = state[chainId];
    if (!chain || chain.down) throw Error("unavailable");
    const head = chain.head ?? 100;
    if (method === "eth_chainId") { calls.push({ chainId, method }); return toHex(chainId); }
    if (method === "eth_getBlockByNumber") { calls.push({ chainId, method }); return { number: toHex(head), hash: hash(chainId * 1000 + head), timestamp: toHex(1_800_000_000 + head) }; }
    if (method === "eth_call") {
      const [call, at] = params as [{ to: Address; data: Hex }, { blockHash: Hex; requireCanonical: boolean }];
      expect(at).toEqual({ blockHash: hash(chainId * 1000 + head), requireCanonical: true });
      expect(call.to).toBe(account);
      const { functionName } = decodeFunctionData({ abi: safeAbi, data: call.data });
      calls.push({ chainId, method, functionName });
      if (functionName === "getOwners") return encodeFunctionResult({ abi: safeAbi, functionName, result: chain.owners });
      if (functionName === "getThreshold") return encodeFunctionResult({ abi: safeAbi, functionName, result: chain.threshold ?? 1n });
    }
    throw Error(`unexpected ${method}`);
  } };
  return { rpc, state, calls, ownerReads: (chainId: number) => calls.filter(call => call.chainId === chainId && call.functionName === "getOwners").length };
}
function memoryStore(): WalletOwnerStateStore & { rows: Map<string, WalletOwnerObservation> } {
  const rows = new Map<string, WalletOwnerObservation>();
  return { rows, async get(owner, chainId) { return structuredClone(rows.get(`${owner}:${chainId}`) ?? null); },
    async put(owner, observation) { rows.set(`${owner}:${observation.block.chainId}`, structuredClone(observation)); } };
}

describe("wallet owner state", () => {
  it("reports consistent when every chain's owners equal Base's", async () => {
    // Order does not matter; the set and threshold one do.
    const { rpc } = chains({ 8453: { owners: [passkey, recovery] }, 10: { owners: [recovery, passkey] }, 42161: { owners: [passkey, recovery] } });
    const states = await observeWalletOwners({ account, chains: [8453, 10, 42161], rpc });
    expect(states.map(state => [state.chainId, state.status])).toEqual([[8453, "consistent"], [10, "consistent"], [42161, "consistent"]]);
    expect(states[1]).toMatchObject({ owners: [recovery, passkey], threshold: 1n, block: { chainId: 10, blockNumber: "100", blockHash: hash(10_100), source: "onchain" } });
    for (const chainId of [8453, 10, 42161]) expect(() => assertOwnersConsistent(states, chainId)).not.toThrow();
  });

  it("marks a chain diverged when its owners or threshold differ from Base", async () => {
    const { rpc } = chains({ 8453: { owners: [rotated, recovery] }, 10: { owners: [passkey, recovery] }, 42161: { owners: [rotated, recovery], threshold: 2n } });
    const states = await observeWalletOwners({ account, chains: [10, 42161], rpc });
    expect(states).toMatchObject([{ chainId: 10, status: "diverged", owners: [passkey, recovery], expected: [rotated, recovery] },
      { chainId: 42161, status: "diverged", threshold: 2n }]);
    expect(() => assertOwnersConsistent(states, 10)).toThrow(expect.objectContaining({ status: 409, code: "WALLET_OWNERS_DIVERGED" }));
    // A chain that was not observed is never admitted.
    expect(() => assertOwnersConsistent(states, 8453)).toThrow(expect.objectContaining({ status: 503, code: "WALLET_OWNERS_UNKNOWN" }));
  });

  it("an RPC failure refuses, never admits", async () => {
    const world = chains({ 8453: { owners: [passkey, recovery] }, 10: { owners: [passkey, recovery], down: true } });
    let states = await observeWalletOwners({ account, chains: [8453, 10], rpc: world.rpc });
    expect(states).toMatchObject([{ chainId: 8453, status: "consistent" }, { chainId: 10, status: "unknown" }]);
    expect(() => assertOwnersConsistent(states, 10)).toThrow(expect.objectContaining({ status: 503, code: "WALLET_OWNERS_UNKNOWN" }));
    // Without Base there is nothing to compare against: every chain is unknown.
    world.state[8453]!.down = true; world.state[10]!.down = false;
    states = await observeWalletOwners({ account, chains: [10], rpc: world.rpc });
    expect(states).toEqual([{ chainId: 10, status: "unknown", reason: "The owners on Base could not be read." }]);
    expect(() => assertOwnersConsistent(states, 10)).toThrow(expect.objectContaining({ status: 503 }));
    // An account with no code there decodes nothing: unknown, not consistent.
    world.state[8453]!.down = false;
    const empty: RestRpc = { request: (chainId, method, params, signal) => method === "eth_call" && chainId === 10 ? Promise.resolve("0x") : world.rpc.request(chainId, method, params, signal) };
    expect(await observeWalletOwners({ account, chains: [10], rpc: empty })).toMatchObject([{ chainId: 10, status: "unknown" }]);
  });

  it("owner reads run beside the prepare reads and Base state is re-read only on a new block or owner event", async () => {
    const world = chains({ 8453: { owners: [passkey, recovery] }, 10: { owners: [passkey, recovery] } }), store = memoryStore();
    await observeWalletOwners({ account, chains: [10], rpc: world.rpc, store });
    expect([world.ownerReads(8453), world.ownerReads(10)]).toEqual([1, 1]);
    // Same heads: the stored observations are the answer.
    await observeWalletOwners({ account, chains: [10], rpc: world.rpc, store });
    expect([world.ownerReads(8453), world.ownerReads(10)]).toEqual([1, 1]);
    // An owner change on Base lands in a new Base block: Base is read again, the other chain is not.
    world.state[8453] = { owners: [rotated, recovery], head: 101 };
    const states = await observeWalletOwners({ account, chains: [10], rpc: world.rpc, store });
    expect([world.ownerReads(8453), world.ownerReads(10)]).toEqual([2, 1]);
    expect(states).toMatchObject([{ chainId: 10, status: "diverged", expected: [rotated, recovery] }]);
    expect(store.rows.get(`${account}:8453`)).toMatchObject({ owners: [rotated, recovery], block: { blockHash: hash(8_453_101) } });
  });
});

const proxy = JSON.parse(readFileSync(new URL("../src/rest/smartAccounts/stack/artifacts/SafeProxy.json", import.meta.url), "utf8")) as { deployedBytecode: Hex };
const singleton = JSON.parse(readFileSync(new URL("../src/rest/smartAccounts/stack/artifacts/SafeL2.json", import.meta.url), "utf8")) as { deployedBytecode: Hex; address: Address };
const safeWrite = parseAbi([
  "function setup(address[] owners,uint256 threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)",
  "function swapOwner(address prevOwner,address oldOwner,address newOwner)",
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns(bool)",
]);
describe.skipIf(!anvilAvailable())("wallet owner state on two chains", () => {
  const nodes: { chainId: number; url: string; child: ChildProcess }[] = [];
  const owner = getAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"), safe = getAddress("0x5afe00000000000000000000000000000000c0de");
  const call = async (url: string, method: string, params: unknown[] = []) => {
    const body = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json() as { result?: unknown; error?: { message: string } };
    if (body.error) throw Error(body.error.message);
    return body.result;
  };
  const send = async (url: string, data: Hex) => {
    const txHash = await call(url, "eth_sendTransaction", [{ from: owner, to: safe, data }]);
    // Automine can answer before the block exists; the receipt decides.
    for (let i = 0; i < 100; i++) {
      const receipt = await call(url, "eth_getTransactionReceipt", [txHash]) as { status?: string } | null;
      if (receipt) { expect(receipt.status).toBe("0x1"); return; }
      await new Promise(done => setTimeout(done, 20));
    }
    throw Error("no receipt");
  };
  const rpc: RestRpc = { request: (chainId, method, params) => call(nodes.find(node => node.chainId === chainId)!.url, method, [...params]) };
  beforeAll(async () => {
    for (const chainId of [8453, 10]) {
      const server = createServer();
      await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
      const port = (server.address() as { port: number }).port;
      await new Promise<void>(done => server.close(() => done()));
      const url = `http://127.0.0.1:${port}`, child = spawnAnvil(["--host", "127.0.0.1", "--port", String(port), "--chain-id", String(chainId), "--silent"]);
      nodes.push({ chainId, url, child });
      for (let i = 0; i < 200; i++) { try { await call(url, "eth_chainId"); break; } catch { await new Promise(done => setTimeout(done, 30)); } }
      // The same Safe at the same address on both chains, created with the same owners.
      await call(url, "anvil_setCode", [singleton.address, singleton.deployedBytecode]);
      await call(url, "anvil_setCode", [safe, proxy.deployedBytecode]);
      await call(url, "anvil_setStorageAt", [safe, hash(0), padHex(singleton.address, { size: 32 })]);
      await send(url, encodeFunctionData({ abi: safeWrite, functionName: "setup",
        args: [[owner, passkey], 1n, "0x0000000000000000000000000000000000000000", "0x", "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", 0n, "0x0000000000000000000000000000000000000000"] }));
    }
  }, 30_000);
  afterAll(() => { for (const node of nodes) node.child.kill("SIGKILL"); });

  it("refuses an operation on a chain whose owners diverge from Base", async () => {
    let states = await observeWalletOwners({ account: safe, chains: [10], rpc });
    expect(states).toMatchObject([{ chainId: 10, status: "consistent", owners: [owner, passkey] }]);
    // The passkey is replaced on Base only: the recovery owner executes swapOwner as the Safe itself.
    const base = nodes.find(node => node.chainId === 8453)!.url;
    const approved = concatHex([padHex(owner, { size: 32 }), hash(0), "0x01"]);
    await send(base, encodeFunctionData({ abi: safeWrite, functionName: "execTransaction", args: [safe, 0n,
      encodeFunctionData({ abi: safeWrite, functionName: "swapOwner", args: [owner, passkey, rotated] }), 0, 0n, 0n, 0n,
      "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", approved] }));
    states = await observeWalletOwners({ account: safe, chains: [8453, 10], rpc });
    expect(states).toMatchObject([{ chainId: 8453, status: "consistent", owners: [owner, rotated] },
      { chainId: 10, status: "diverged", owners: [owner, passkey], expected: [owner, rotated] }]);
    expect(() => assertOwnersConsistent(states, 8453)).not.toThrow();
    expect(() => assertOwnersConsistent(states, 10)).toThrow(expect.objectContaining({ status: 409, code: "WALLET_OWNERS_DIVERGED" }));
  });
});
