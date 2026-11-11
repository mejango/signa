#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { getAddress, isAddress } from "viem";

const CONTRACT = "@bananapus/core-v6:src/JBPermissions.sol:JBPermissions";
const HELP = `Prepare a zero-value V6 execution check without keys or transactions.

  npm run build
  node scripts/rest/production-check.mjs CHAIN_ID SMART_WALLET_ADDRESS > check.json

Chains: Ethereum 1, Optimism 10, Base 8453, Arbitrum 42161.
Use a wallet already verified and bound at https://api.signa.center/accounts.
Paste check.json as the contract_calls operation input, then review in your wallet.
The command verifies that the wallet's self-permission bitmap is already zero.
It grants no permissions and moves no funds. Sponsorship still consumes policy quota.
`;

export async function prepareCheck(chainId, wallet, protocol, rpc) {
  if (![1, 10, 8453, 42161].includes(chainId)) throw new Error("Choose one of the four supported mainnets.");
  if (!isAddress(wallet, { strict: true }) || BigInt(wallet) === 0n) throw new Error("Supply the bound smart-wallet address.");
  wallet = getAddress(wallet);
  const signal = AbortSignal.timeout(60_000);
  const before = await protocol.read({
    chainId, contractId: CONTRACT, function: "permissionsOf(address,address,uint256)", args: [wallet, wallet, "0"],
  }, signal);
  if (before.outputs.length !== 1 || before.outputs[0].value !== "0") {
    throw new Error("Self permissions are not zero. No check was prepared; choose another wallet or an intended action.");
  }
  const block = before.evidence[0];
  const code = await rpc.request(chainId, "eth_getCode", [wallet, { blockHash: block.blockHash, requireCanonical: true }], signal);
  if (typeof code !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code)) throw new Error("The smart wallet is not deployed at the observed block.");
  const input = {
    account: wallet,
    calls: [{
      chainId, contractId: CONTRACT, address: before.address,
      function: "setPermissionsFor(address,(address,uint64,uint8[]))",
      args: [wallet, { operator: wallet, projectId: "0", permissionIds: [] }], value: "0",
    }],
    label: "V6 execution check: keep self permissions empty",
  };
  // Reuse the protocol's catalog, runtime and ABI checks; only /accounts can authorize execution.
  const draft = await protocol.prepare(input, signal);
  return { input, draft, before };
}

async function main(argv) {
  if (!argv.length || argv[0] === "--help") { process.stdout.write(HELP); return; }
  if (argv.length !== 2 || !/^(1|10|8453|42161)$/.test(argv[0])) throw new Error("Use CHAIN_ID SMART_WALLET_ADDRESS. Run with --help for details.");
  const chainId = Number(argv[0]);
  const [{ ContractCatalog }, { createProtocolReadService }, { createRestRpc }] = await Promise.all([
    import("../../dist/src/rest/contracts/catalog.js"),
    import("../../dist/src/rest/protocol/index.js"),
    import("../../dist/src/rest/rpc.js"),
  ]);
  const rpc = createRestRpc({ upstreams: new Map([[chainId, [`https://juicebox.center/v1/rpc/${chainId}`]]]) });
  const protocol = createProtocolReadService({ rpc, catalog: await ContractCatalog.load() });
  const result = await prepareCheck(chainId, argv[1], protocol, rpc);
  process.stderr.write(`Verified empty self permissions on chain ${chainId}, block ${result.before.evidence[0].blockNumber} (${result.before.evidence[0].blockHash}).\nTarget: ${result.before.address}. Native value: 0. Permission IDs: none.\nNo transaction was signed or sent. Review and execute through /accounts.\n`);
  process.stdout.write(JSON.stringify(result.input, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write("Check preparation failed. Build first, verify the bound wallet/chain, and retry the read. A nonzero bitmap, unavailable canonical RPC evidence, or missing deployment produces no plan.\n");
    process.exitCode = 1;
  });
}
