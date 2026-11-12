// Preload for the built CLI regression: only fetch is replaced; all catalog, RPC,
// provenance, ABI and Center-draft validation code runs from the actual build.
import assert from "node:assert/strict";
import { encodeFunctionData, encodeAbiParameters, decodeFunctionData } from "viem";
import { jbPermissionsAbi } from "@bananapus/nana-sdk-core";
import { ContractCatalog } from "../../dist/src/rest/contracts/catalog.js";

const catalog = await ContractCatalog.load();
const contractId = "@bananapus/core-v6:src/JBPermissions.sol:JBPermissions";
const deployment = catalog.get(contractId).deployments.find(item => item.chainId === 8453).instances.find(item => !item.retired);
const runtime = catalog.code(deployment.codeId).runtimeTemplate;
const wallet = "0x1111111111111111111111111111111111111111";
const blockHash = `0x${"22".repeat(32)}`;
const at = { blockHash, requireCanonical: true };
let permissionRead = false, walletRead = false, planPrepared = false;
const envelope = (request, result) => ({ jsonrpc: "2.0", id: request.id, result });

globalThis.fetch = async (url, init) => {
  assert.equal(init.method, "POST");
  const body = JSON.parse(init.body);
  if (String(url) === "https://juicebox.center/api/v1/plans") {
    assert(permissionRead && walletRead);
    assert.equal(init.redirect, "error");
    assert.equal(init.credentials, "omit");
    assert.equal(new Headers(init.headers).has("authorization"), false);
    assert.equal(body.operation, "contract_calls");
    assert.equal(body.input.account, wallet);
    assert.equal(body.input.calls.length, 1);
    const call = body.input.calls[0];
    assert.equal(call.address.toLowerCase(), deployment.address.toLowerCase());
    assert.equal(call.chainId, 8453);
    assert.equal(call.value, "0");
    assert.equal(call.contractId, contractId);
    assert.equal(call.function, "setPermissionsFor(address,(address,uint64,uint8[]))");
    assert.deepEqual(call.args, [wallet, { operator: wallet, projectId: "0", permissionIds: [] }]);
    planPrepared = true;
    return Response.json({ data: {
      operation: "protocol-contract-calls", account: wallet,
      calls: [{ chainId: 8453, to: deployment.address, value: "0", label: "Execution check", dependsOn: [],
        data: encodeFunctionData({ abi: jbPermissionsAbi, functionName: "setPermissionsFor", args: [wallet, { operator: wallet, projectId: 0n, permissionIds: [] }] }),
        decoded: { contractId, abiHash: deployment.abiHash } }],
      evidence: [{ chainId: 8453, blockNumber: "100", blockHash, timestamp: "1000", source: "onchain" }],
      summary: {}, warnings: [],
    } });
  }
  assert.equal(String(url), "https://juicebox.center/v1/rpc/8453");
  function rpc(request) {
    switch (request.method) {
      case "eth_chainId": return envelope(request, "0x2105");
      case "eth_getBlockByNumber":
        assert.equal(request.params[0], "latest");
        return envelope(request, { number: "0x64", hash: blockHash, timestamp: "0x3e8" });
      case "eth_getCode":
        assert.deepEqual(request.params[1], at);
        if (request.params[0].toLowerCase() === deployment.address.toLowerCase()) return envelope(request, runtime);
        assert.equal(request.params[0], wallet);
        walletRead = true;
        return envelope(request, "0x6000");
      case "eth_call":
        assert.deepEqual(request.params[1], at);
        assert.equal(request.params[0].to.toLowerCase(), deployment.address.toLowerCase());
        assert.deepEqual(decodeFunctionData({ abi: jbPermissionsAbi, data: request.params[0].data }), { functionName: "permissionsOf", args: [wallet, wallet, 0n] });
        permissionRead = true;
        return envelope(request, encodeAbiParameters([{ type: "uint256" }], [0n]));
      default: assert.fail(`Unexpected RPC method: ${request.method}`);
    }
  }
  return Response.json(Array.isArray(body) ? body.map(rpc) : rpc(body));
};
process.on("exit", () => { assert(permissionRead && walletRead && planPrepared, "CLI must complete canonical reads and validated preparation"); });
