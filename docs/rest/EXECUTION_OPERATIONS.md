# Operating hosted smart-account execution

The repository contains the session compiler, installed-policy verifier, owner activation/revocation preparation, durable execution tracking, and the hosted ERC4337 transport. Production recurring execution requires the deployed and verified guard matching the selected paymaster profile, an eligible sponsorship policy and provider billing, working archive traces, and an owner-approved session. Both checked guards, `CenterSessionGuard` (`legacy-v1`) and `CenterSessionGuardV2` (`current-v2`), are **undeployed**. Local tests create disposable contracts and use test signers; they do not provision provider billing or install modules on a user's wallet. Source verification and local tests do not establish an external audit or production readiness.

All commands below run from the `jbcenter` repository root. The deployment command is provided for an operator to review and execute; it has not been broadcast as part of implementation.

## Required release checks

Use Node.js 22 and Foundry **v1.7.0**, release commit `f83bad912a9dba7bf0371def1e70bb1896048356`. The official binaries may print `1.6.0-v1.7.0`; the check verifies their exact commit. CI pins both the [official installation action](https://github.com/foundry-rs/foundry-toolchain/tree/908c540300062bd5a7e473851cdb4282204cee09) and the [Foundry release](https://github.com/foundry-rs/foundry/releases/tag/v1.7.0). With Foundry's installer already installed, select that release with `foundryup --install v1.7.0`.

```sh
npm ci --ignore-scripts
npm --prefix mcp ci --ignore-scripts
npm run check:execution
# Supply TEST_DATABASE_URL for the disposable integration-test database.
npm run check
```

`check:execution` requires both Forge and Anvil. It preserves verification of all 17 legacy artifacts and the aggregate manifest, forces fresh guard compilation, compares ABI/creation/runtime bytecode and compiler settings, and runs the required Foundry suites. The legacy minimum suites contain 12 guard tests and six actual EntryPoint/Safe/SmartSession/Pimlico tests, including direct submissions, expiry, revocation, sponsorship, budget consumption and failed execution. The separate `src/rest/smartAccounts/stack/current-pimlico/` package adds independently checked paymaster source, guard and storage evidence, plus tests of the current flags format. Skipped tests and fewer than 256 runs of an included fuzz test fail the command. Both guard packages pin Solidity **0.8.28**, Cancun, optimizer 200 runs, and metadata bytecode hash `none` in their respective `foundry.toml` files. The current Pimlico paymaster is reproduced separately with its verified **0.8.26**, London settings; those are not the guard deployment settings.

The same required check recompiles the bundled V6 controller/terminal source closure, verifies compiler-declared masks and catalog identities, executes library constructors on an isolated Anvil instance, and checks all 32 recorded deployment observations plus negative runtime mutations. It reuses the compiler installed by Forge, verifies its official Linux/macOS binary hash, and needs no sibling workspace or live RPC credentials. An explicitly selected compiler path may be supplied through `CENTER_TARGET_SOLC`; it must pass the same binary hash check. Once the pinned tools/compiler are installed, these verification steps use local files and a disposable local EVM only.

The guard's gas-estimation storage proof is also compared with the complete fresh compiler storage layout, bound to the same source, runtime and compiler version. An invented or stale field offset cannot pass the release check.

`npm run check` starts with that execution check and then runs the application/MCP checks, including the Anvil suites. CI installs Forge and Anvil before running it and supplies a disposable PostgreSQL service. Missing binaries fail before Vitest can conditionally skip an Anvil suite. `npm test` alone is not the release gate. Configure the repository's branch protection to require the `CI / test` job; the workflow cannot configure branch protection itself.

`npm run verify:execution-artifacts` is the smaller read-only legacy provenance check. The current package has independent `current-pimlico/verify-paymaster.mjs` and `current-pimlico/verify-guard.mjs` checks, included in `check:execution`. Verification does not regenerate reviewed artifacts or update a manifest. A deliberate guard source change requires a new reviewed build, source/runtime pins, tests and deployment; do not use `--write-manifest` to make a verification failure disappear.

## Operator configuration

The normal application environment still requires `DATABASE_URL`, `METRICS_TOKEN`, `DWELLIR_API_KEY` and the intended `REST_PUBLIC_ORIGIN`; see the repository's deployment instructions. Startup applies the database migrations. `npm run migrate` applies them explicitly when the deployment process runs migrations separately.

`REST_ERC4337_CONFIG` is optional, server-only JSON. When it is set, it must list every chain Signa accounts operate on (`operates` in `src/rest/wallet/chains.ts`, Base today), or startup fails. This example explicitly selects the current Pimlico profile for Ethereum (`1`), Optimism (`10`), Base (`8453`) and Arbitrum (`42161`). Require checked deployment evidence for each configured chain, and replace the endpoint credentials and policy placeholder in private configuration. Every `simulationBundlerAddress` below is a syntactically valid placeholder: replace it with an independently reviewed, chain-verified allowed bundler EOA before use. The gas ceilings retain the existing illustrative values as conservative admission placeholders; they are **not recommended production limits or spending budgets**. Review them against each chain and the operations being admitted, including Ethereum's own gas requirements.

```json
{
  "chains": [
    {
      "chainId": 1,
      "bundlerUrl": "https://api.pimlico.io/v2/1/rpc?apikey=YOUR_SERVER_API_KEY",
      "paymasterUrl": "https://api.pimlico.io/v2/1/rpc?apikey=YOUR_SERVER_API_KEY",
      "paymasterPolicyId": "YOUR_SPONSORSHIP_POLICY_ID",
      "paymasterProfile": "pimlico-v7-current-flags",
      "simulationBundlerAddress": "0x4444444444444444444444444444444444444444",
      "confirmations": 2,
      "gas": {
        "maximumCallGas": "1000000",
        "maximumVerificationGas": "1500000",
        "maximumPreVerificationGas": "200000",
        "maximumPaymasterVerificationGas": "200000",
        "maximumPaymasterPostOpGas": "100000",
        "maximumFeePerGas": "30000000000",
        "maximumPriorityFeePerGas": "2000000000",
        "maximumCost": "90000000000000000"
      }
    },
    {
      "chainId": 10,
      "bundlerUrl": "https://api.pimlico.io/v2/10/rpc?apikey=YOUR_SERVER_API_KEY",
      "paymasterUrl": "https://api.pimlico.io/v2/10/rpc?apikey=YOUR_SERVER_API_KEY",
      "paymasterPolicyId": "YOUR_SPONSORSHIP_POLICY_ID",
      "paymasterProfile": "pimlico-v7-current-flags",
      "simulationBundlerAddress": "0x1111111111111111111111111111111111111111",
      "confirmations": 2,
      "gas": {
        "maximumCallGas": "1000000",
        "maximumVerificationGas": "1500000",
        "maximumPreVerificationGas": "200000",
        "maximumPaymasterVerificationGas": "200000",
        "maximumPaymasterPostOpGas": "100000",
        "maximumFeePerGas": "30000000000",
        "maximumPriorityFeePerGas": "2000000000",
        "maximumCost": "90000000000000000"
      }
    },
    {
      "chainId": 8453,
      "bundlerUrl": "https://api.pimlico.io/v2/8453/rpc?apikey=YOUR_SERVER_API_KEY",
      "paymasterUrl": "https://api.pimlico.io/v2/8453/rpc?apikey=YOUR_SERVER_API_KEY",
      "paymasterPolicyId": "YOUR_SPONSORSHIP_POLICY_ID",
      "paymasterProfile": "pimlico-v7-current-flags",
      "simulationBundlerAddress": "0x2222222222222222222222222222222222222222",
      "confirmations": 2,
      "gas": {
        "maximumCallGas": "1000000",
        "maximumVerificationGas": "1500000",
        "maximumPreVerificationGas": "200000",
        "maximumPaymasterVerificationGas": "200000",
        "maximumPaymasterPostOpGas": "100000",
        "maximumFeePerGas": "30000000000",
        "maximumPriorityFeePerGas": "2000000000",
        "maximumCost": "90000000000000000"
      }
    },
    {
      "chainId": 42161,
      "bundlerUrl": "https://api.pimlico.io/v2/42161/rpc?apikey=YOUR_SERVER_API_KEY",
      "paymasterUrl": "https://api.pimlico.io/v2/42161/rpc?apikey=YOUR_SERVER_API_KEY",
      "paymasterPolicyId": "YOUR_SPONSORSHIP_POLICY_ID",
      "paymasterProfile": "pimlico-v7-current-flags",
      "simulationBundlerAddress": "0x3333333333333333333333333333333333333333",
      "confirmations": 2,
      "gas": {
        "maximumCallGas": "1000000",
        "maximumVerificationGas": "1500000",
        "maximumPreVerificationGas": "200000",
        "maximumPaymasterVerificationGas": "200000",
        "maximumPaymasterPostOpGas": "100000",
        "maximumFeePerGas": "30000000000",
        "maximumPriorityFeePerGas": "2000000000",
        "maximumCost": "90000000000000000"
      }
    }
  ]
}
```

The example omits guards because both artifacts are undeployed. After deploying and verifying `CenterSessionGuardV2` on each selected chain, add both `"sessionGuardAddress": "<the verified address on this chain>"` and `"sessionGuardVersion": "current-v2"` to that chain object. The loader selects the reviewed runtime hash itself; there is no client-supplied hash override. A version without an address, or a guard/profile mismatch, fails startup. Omitting the guard still permits configured, verified owner execution, but session compilation requires the matching guard and owner activation.

| Field | Contract |
| --- | --- |
| `chains` | Required array when JSON is supplied; at most eight entries, each chain at most once. An empty array configures no hosted providers. |
| `chainId` | JSON integer: `1`, `10`, `8453`, `42161`, `84532`, `421614`, `11155111` or `11155420`. |
| `bundlerUrl`, `paymasterUrl` | Required fixed HTTPS endpoints, at most 4096 characters each; no userinfo, fragments, whitespace or control characters. Query-string API keys are private server configuration. |
| `paymasterPolicyId` | Required 1–128 character identifier using letters, digits, `.`, `_` or `-`; sent as `context.sponsorshipPolicyId`. |
| `paymasterProfile` | Optional `pimlico-v7-legacy-mode` (default) or explicit `pimlico-v7-current-flags`. The current profile is restricted to chains `1`, `10`, `8453` and `42161`. |
| `simulationBundlerAddress` | Optional server-only nonzero address, accepted only with `pimlico-v7-current-flags`. Required for exact signed preflight when final sponsor flags are `0x00`; optional for `0x01`. Must be an EOA allowed by the paymaster at the verified block. Supplies only the simulation origin; no private key is needed. |
| `sessionGuardAddress` | Optional nonzero contract address on this chain; live code must match the reviewed artifact before use. |
| `sessionGuardVersion` | Optional `legacy-v1` (default) or `current-v2`; requires `sessionGuardAddress`. Legacy guard pairs with the legacy paymaster, and current guard pairs with the current paymaster. |
| `confirmations` | Optional JSON integer from 1 to 1024; default 1. This does not replace the finalized proof required to release a revoked session's allocation reservation. |
| `gas` | All eight fields in the example are required canonical unsigned decimal **strings**, without leading zeroes. Gas quantities are gas units, fee fields are wei per gas, and `maximumCost` is wei. |

Gas values must fit `uint128`, except `maximumCost`, which fits `uint256`. All are positive except `maximumPaymasterPostOpGas` and `maximumPriorityFeePerGas`, which may be zero. Priority fee cannot exceed total fee. Unknown keys, duplicate/unsupported chains, empty or oversized JSON (over 65,536 bytes), malformed endpoints and missing limits fail startup. Hosted execution always requires the reviewed paymaster. There is no switch to silently charge the wallet for gas.

Store the complete JSON in the deployment's secret store or a private environment file. A local private JSON file can be loaded without printing it:

```sh
export REST_ERC4337_CONFIG="$(cat /path/to/private/erc4337.json)"
npm run start
```

Never place that file in the website assets, a browser environment, a policy request, or a public repository. Startup errors deliberately omit provider URLs and credentials. The server accepts externally signed requests and operations; this configuration contains no owner/session private key.

Select a provider plan, complete its billing setup, enable sponsorship for each chain, and obtain private endpoint credentials and a policy identifier. Pimlico's [official pricing](https://www.pimlico.io/pricing), checked on 2026-09-07, describes pay-as-you-go with a card on file: Pimlico fronts sponsored mainnet gas and bills its actual cost plus a 10% surcharge. Confirm the selected plan and its managed paymaster funding arrangements in the provider dashboard. Creating a policy does not itself fund an account, establish billing or buy credits. Provider charges and policy gas limits are separate controls.

For a shared four-chain policy capped at **$100 USD and 1,000 lifetime operations**, set `chain_ids.allowlist` to `[1,10,8453,42161]`, `limits.global.user_operation_spending` to `{"amount":10000,"currency":"USD"}`, `limits.global.maximum_user_operation_count` to `1000`, and `limits.global.reset_interval` to `"never"`. The provider API expresses USD amounts in cents. These global limits apply across the shared policy on all four chains; they are not a separate $100 allowance on each chain. Keep the actual policy identifier private and verify the saved policy's status and limits. See the [Pimlico policy object](https://docs.pimlico.io/references/platform/api/sponsorship-policies/object). These fields belong in Pimlico's policy configuration, not in `REST_ERC4337_CONFIG`; they do not represent an invoice cap covering every provider fee.

Enable the key's Bundler and Paymaster methods for the hosted RPC calls. Account APIs permission is needed only when managing policies through Pimlico's account API, including creating, retrieving, listing or updating policies; it is not required just to use an existing policy through RPC. See [API key permissions](https://docs.pimlico.io/guides/how-to/security/protect-api-keys) and [policy management endpoints](https://docs.pimlico.io/references/platform/api/sponsorship-policies).

Sponsorship webhooks are optional provider configuration. `webhook_enabled` and `webhook_endpoint` are separate policy fields. A webhook signing secret alone neither enables a webhook nor supplies a receiver URL. Center's hosted RPC configuration does not install a webhook handler or consume that secret. Leave the webhook disabled unless a separately deployed receiver is configured and verifies incoming signatures. See [Pimlico webhook configuration and verification](https://docs.pimlico.io/guides/how-to/sponsorship-policies/webhook).

The provider response must match the selected source-bound profile:

| Profile | Paymaster and runtime hash | Accepted gas-only format |
| --- | --- | --- |
| `pimlico-v7-legacy-mode` | `0x0000000000000039cd5e8aE05257CE51C473ddd1`; `0x1cd962f550282d1e4eadd0db10a956db2338c40f69c8b07cb434486275e1c11a` | Exactly 130 packed bytes, with raw mode byte at offset 52 equal to `0x00`. In this source `0x01` means token charging and is rejected. |
| `pimlico-v7-current-flags` | `0x777777777777AeC03fd955926DbF81597e66834C`; `0x337b6e1b6c2167c0528c5240c028ead407c673595b2820029b69741b76d98fbc` | Exactly 130 packed bytes, including 78 bytes of `paymasterData`. Flags at offset 52 may be `0x00` or `0x01`: `flags >> 1` is verifying mode zero and the low bit is `allowAllBundlers`. Token modes (`0x02` and above) are rejected. |

Both profiles use the same pinned **EntryPoint v0.7**. The current paymaster's published source and build settings match commit `2f710c1cee1ae2d5f5bbf3c41aade9ff8e4d4c05` using solc `0.8.26` and London. Source-equivalent commits mean this match does not uniquely establish the original deployment checkout. The current package records independent source, bytecode and per-chain runtime evidence in `current-pimlico/paymaster-manifest.json`; the legacy `stack/manifest.json` and artifacts remain unchanged.

The observed current provider returned stub flags `0x01` and final flags `0x00`. Final `0x00` sponsorship restricts `tx.origin` through the paymaster's bundler allowlist, so a successful unrestricted stub does not establish final simulation eligibility. The operator must independently select `simulationBundlerAddress` on each chain. Recent EntryPoint transaction history can supply a candidate, but the address must have empty code and return true from the pinned paymaster's `isBundlerAllowed(address)` at one canonical block. These observations do not prove that the EOA is currently used by the hosted Pimlico bundler. The server does not discover or select this address from a request, browser input or provider response.

Before every exact signed preflight with final flags `0x00`, the runtime rechecks the current paymaster runtime, empty EOA code and bundler allowance at the same canonical block. It obtains the exact `getHash(0, packedUserOperation)` result, enforces canonical low-S ECDSA form, recovers the EIP-191 sponsor signer and checks the paymaster's `signers` getter and validity window. It then simulates the complete, unchanged `EntryPoint.handleOps` call from the verified origin, alongside the separate exact account-execution check, without account or state overrides. The origin exists only as the `eth_call` sender; it never becomes a backend signing key or transaction sender. Missing or revoked allowance blocks this preflight.

Omitting `paymasterProfile` preserves legacy selection; a provider response never selects a new profile automatically. Selecting the current paymaster for owner execution preserves the base account manifest identity. Deploying a current guard uses a separate guard version and session manifest identity, and does not migrate an existing session. Changing profiles requires fresh preparation and, for recurring authority, the matching verified guard and an exact new owner-approved activation. A different deployment, mode or signature layout is rejected even when supplied by the same provider brand. Sponsor eligibility, allowance or paymaster funding exhaustion fails execution; it does not authorize an owner-wallet debit.

The `gas` values above bound server admission for individual operations. Each owner-approved session additionally binds onchain cumulative gas, conservative maximum-fee cost, operation count, expiry and action limits. Those onchain counters protect against a bot submitting directly to another bundler. Validation can consume counters even when execution subsequently reverts; do not credit those counters back in the database.

During unsigned gas estimation, Alto may replace the operation's seed gas values. The server can supply an internally generated `stateDiff` for five compiler-proven guard ceiling fields: per-operation gas, maximum fee, maximum priority fee, cumulative gas and cumulative sponsored cost. This temporary estimator context binds the exact chain, wallet, nonce, calldata and fees; callers cannot supply overrides. It changes no guard code, counters, paymaster identity, operation count or action policy. Final estimated fields must fit the original owner's remaining gas/cost/fee limits. Exact signed chain preflight runs without these overrides; an estimator result does not weaken the onchain policy or authorize submission by itself.

Current stub and final timestamps, flags and signature bytes can also have different zero-byte counts. For this profile only, preparation permits that difference while retaining the exact length, address, format and paymaster gas-field checks. It estimates every final paymaster-signed payload, including its exact gas fields, with the temporary owner/session dummy signature before requesting the real wallet signature. Legacy profiles retain their existing zero-byte dominance check and single final quote.

Unsigned current preparation allows at most **three final sponsorship quotes in total**. If estimating a quote requires more gas, only the underestimated gas fields increase to the new estimate plus 5%, rounded up. The new operation must pass every operator gas/fee/cost ceiling and remaining session budget before a fresh paymaster signature is requested. An increase exceeding a ceiling fails; the retry does not relax owner limits or refit the session. Every new quote is estimated again, and the accepted quoted operation stays unchanged. The deadline is the earliest of the original preparation deadline and all quoted sponsor expiries. Failure to fit by the third quote fails preparation. These bounded retries neither sign financial actions nor submit or retry transactions; after owner/session signing, the accepted operation is immutable and exact signed preflight still runs.

## Deploy and verify the guard

Select the guard that matches the configured paymaster. Paths below are relative to `src/rest/smartAccounts/stack/`. Both contracts have no constructor arguments and both checked artifacts retain `address: null`.

| Guard version | Reviewed source, artifact and manifest | Runtime hash |
| --- | --- | --- |
| `legacy-v1` | `contracts/CenterSessionGuard.sol`, `artifacts/CenterSessionGuard.json`, `manifest.json` | `0x996eea0614de4cd5549d17464e0352745411666d42650b20b7a9252dfd1c328c` |
| `current-v2` | `current-pimlico/contracts/CenterSessionGuardV2.sol`, `current-pimlico/artifacts/CenterSessionGuardV2.json`, `current-pimlico/guard-manifest.json` | `0xb8787af1b7dad3b5fac11ec656824adbe575610ee467661be4acde928e3d7c04` |

Run the release checks first. Set the selected chain, archive RPC URL and an existing Foundry keystore name in a private shell environment (`CENTER_CHAIN_ID`, `CENTER_RPC_URL`, `CENTER_DEPLOYER_KEYSTORE`). These commands do not import a key into the API server. Select `current-v2` below for the current paymaster, or change only `CENTER_GUARD_VERSION` to `legacy-v1` for the preserved legacy deployment procedure. Both roots supply the reviewed guard compiler settings.

```sh
export CENTER_GUARD_VERSION=current-v2
case "$CENTER_GUARD_VERSION" in
  legacy-v1)
    CENTER_GUARD_ROOT=src/rest/smartAccounts/stack
    CENTER_GUARD_TARGET=contracts/CenterSessionGuard.sol:CenterSessionGuard
    ;;
  current-v2)
    CENTER_GUARD_ROOT=src/rest/smartAccounts/stack/current-pimlico
    CENTER_GUARD_TARGET=contracts/CenterSessionGuardV2.sol:CenterSessionGuardV2
    ;;
  *) exit 1 ;;
esac
```

Prepare and inspect the deployment without broadcasting:

```sh
forge create "$CENTER_GUARD_TARGET" \
  --root "$CENTER_GUARD_ROOT" \
  --chain "$CENTER_CHAIN_ID" --rpc-url "$CENTER_RPC_URL" \
  --account "$CENTER_DEPLOYER_KEYSTORE"
```

After the operator authorizes this exact deployment, the following command **spends deployment gas and writes to the selected chain**:

```sh
forge create "$CENTER_GUARD_TARGET" \
  --root "$CENTER_GUARD_ROOT" \
  --chain "$CENTER_CHAIN_ID" --rpc-url "$CENTER_RPC_URL" \
  --account "$CENTER_DEPLOYER_KEYSTORE" --broadcast --json
```

Record the returned transaction hash and address as `CENTER_GUARD_DEPLOYMENT_TX` and `CENTER_GUARD_ADDRESS`. Keep the receipt, selected chain, guard version, source content hash, repository revision and artifact/manifest hashes in the deployment record. The following read-only check selects the artifact by `CENTER_GUARD_VERSION` and verifies the chain, successful creation receipt, exact creation bytecode, and runtime at that receipt's canonical block. It does not print the RPC endpoint. It requires Node 22 and the installed `viem` dependency.

```sh
node --input-type=module <<'NODE'
import { readFile } from 'node:fs/promises';
import { isAddress, keccak256 } from 'viem';
const env = process.env;
const guardArtifacts = {
  'legacy-v1': 'src/rest/smartAccounts/stack/artifacts/CenterSessionGuard.json',
  'current-v2': 'src/rest/smartAccounts/stack/current-pimlico/artifacts/CenterSessionGuardV2.json'
};
const version = env.CENTER_GUARD_VERSION;
if (!Object.hasOwn(guardArtifacts, version ?? '')) throw new Error('Select legacy-v1 or current-v2 explicitly.');
const artifact = JSON.parse(await readFile(guardArtifacts[version], 'utf8'));
const chain = env.CENTER_CHAIN_ID;
const address = env.CENTER_GUARD_ADDRESS;
const transaction = env.CENTER_GUARD_DEPLOYMENT_TX;
if (!/^[1-9][0-9]*$/.test(chain ?? '') || !isAddress(address ?? '') ||
    !/^0x[0-9a-fA-F]{64}$/.test(transaction ?? '') || !env.CENTER_RPC_URL) {
  throw new Error('Set the exact chain, guard address, deployment transaction and private RPC URL.');
}
let id = 0;
async function rpc(method, params) {
  try {
    const response = await fetch(env.CENTER_RPC_URL, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({jsonrpc: '2.0', id: ++id, method, params}),
      signal: AbortSignal.timeout(15000)
    });
    const envelope = await response.json();
    if (!response.ok || envelope.error || !Object.hasOwn(envelope, 'result')) throw new Error();
    return envelope.result;
  } catch { throw new Error(`Verification RPC failed: ${method}`); }
}
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
if (BigInt(await rpc('eth_chainId', [])) !== BigInt(chain)) throw new Error('Wrong chain.');
const receipt = await rpc('eth_getTransactionReceipt', [transaction]);
const tx = await rpc('eth_getTransactionByHash', [transaction]);
if (!receipt || receipt.status !== '0x1' || !same(receipt.contractAddress, address) ||
    !same(receipt.transactionHash, transaction) || !tx || tx.to !== null ||
    !same(tx.blockHash, receipt.blockHash) || !same(tx.input, artifact.bytecode) || BigInt(tx.value) !== 0n) {
  throw new Error('Receipt or exact guard creation transaction does not match.');
}
const canonical = async () => {
  const block = await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]);
  if (!block || !same(block.hash, receipt.blockHash)) throw new Error('Deployment block is not canonical.');
};
await canonical();
const code = await rpc('eth_getCode', [address, {blockHash: receipt.blockHash, requireCanonical: true}]);
if (code === '0x' || !same(keccak256(code), artifact.runtimeCodeHash)) throw new Error('Runtime does not match reviewed guard.');
await canonical();
console.log(JSON.stringify({chainId: chain, guardVersion: version, address, transaction, blockNumber: receipt.blockNumber,
  blockHash: receipt.blockHash, runtimeCodeHash: artifact.runtimeCodeHash, canonical: true}));
NODE
```

Repeat verification after the chosen confirmation/finality policy is satisfied. This receipt check is canonical evidence at one block, not a finality assertion. Add the verified address and matching `sessionGuardVersion` to that chain's `REST_ERC4337_CONFIG`, with the corresponding `paymasterProfile`, and restart through the ordinary deployment process. Keep the checked source artifact's `address: null`: operator deployments belong in deployment records/configuration, not in a rewritten source provenance manifest. Runtime preparation and dispatch recheck live code; the JSON address alone never grants capability. Wallet creation, binding and session activation still require their respective owner signatures after deployment.

## Archive RPC and durable account history

The inspector needs `eth_chainId`, canonical block/transaction/receipt/log reads, EIP-1898 `eth_call`, `eth_getCode` and `eth_getStorageAt`, plus **`debug_traceTransaction` with `callTracer`, `onlyTopCall: false`**, for each source-proven transaction that can change account authority or session administration. The inspector checks canonical block membership, receipt identity and the complete nested trace against the transaction root. Unrelated transactions in the same block are not traced. Use an archive provider whose plan supports this method and historical range. A successful ordinary balance read or a provider's bundler endpoint does not prove trace support.

The trace path is private server infrastructure; do not enable arbitrary public debug RPC to make inspection work. Normal startup selects Dwellir chain endpoints through `DWELLIR_API_KEY`; an embedded host can supply reviewed fixed `upstreams`. Public fallback endpoints are not assumed to provide complete traces. Unsupported methods, partial traces, an unknown account initializer, unexpected modules/delegatecalls/fallbacks, exhausted history bounds, and reorgs fail inspection rather than weakening the proof.

Production uses `PostgresSafe7579CheckpointStore` and migration `010_rest_smart_account_checkpoints.sql`. Preserve checkpoints together with the account, session and UserOperation tables in backups. Checkpoints bind chain, wallet, manifest revision, utility hash, canonical creation, authority history and session-administration epoch. The inspector rechecks a retained checkpoint's canonical block and creation before reuse, falls back to retained earlier history where possible, and otherwise rebuilds or fails closed. Never insert a client-provided checkpoint or manually reset an administration epoch to resolve an activation error.

The default store retains 32 buckets of 128 blocks per wallet/manifest namespace and allows 10,000 namespaces. The inspector separately bounds relevant traced blocks, log requests, trace frames and request time. Monitor `SMART_TRACE_REQUIRED`, `SMART_HISTORY_LIMIT`, `SMART_HISTORY_INCOMPLETE`, `SMART_HISTORY_REORG` and checkpoint-capacity errors. Raising reviewed operator limits or providing complete historical data can restore availability; deleting proof state does not make a wallet safe to use.

## Bring-up and recovery

`GET /healthz` checks that the HTTP process responds; `GET /readyz` checks the database. Neither verifies a live sponsor. Inspect `GET /api/v1/capabilities` and `GET /api/v1/smart-accounts/capabilities` for configured chains, providers, manifests and execution requirements. Provider configuration appearing there is not a successful sponsorship quote. Preparation checks the bundler's chain and EntryPoint support, gets and estimates the exact sponsor data, and verifies the paymaster before asking a wallet to sign.

The default target resolver derives V6 controllers and terminals from the checked deployment catalog, verifies their exact source/runtime and canonical project association at the wallet binding's block, and rejects missing source proof. Native ETH uses the reviewed V6 sentinel and 18 decimals on all eight chains; mainnet ETH and testnet ETH have separate asset identities. Additional ERC20 support requires operator-reviewed immutable token targets and asset identities (`smartAccountSessionTargets` and `smartAccountAssets` in `createRestRuntime`). Target entries bind chain, address, runtime, action kind and review identity; asset entries bind chain/address to common asset identity and decimals. Arbitrary proxies, caller-supplied symbols, transfer-fee/rebasing behavior and unknown token implementations are not inferred to be safe. Cross-chain allocation groups must use reviewed equivalent units, with distinct per-chain allocations whose sum is within the owner's approved total.

Use the [smart-account guide](/api/docs/smart-accounts) and [session flow](/api/docs/sessions) for the owner/bot API sequence: create the verified wallet, bind its current owner to the API account, prepare a seven- or thirty-day policy, review and sign the exact owner activation, verify installed state, then prepare/sign/submit individual sponsored operations. A session allows one canonical inner call per operation; multiple authorized actions may belong to the session. Financial actions outside that policy require fresh owner approval. API grants must not be substituted for onchain expiry or budget enforcement.

To stop recurring authority durably, submit the prepared owner revocation containing both `removeSession` and `revokeEnableSignature`, then verify it canonically. API unlink or bot-grant revocation stops the API path but does not revoke a key's direct onchain authority. The service releases an overlapping allocation reservation only after the required finalized disabled/nonce-advanced proof. Renewal uses a new generation and salt after the permitted transition. A counter reset poisons the old session rather than restoring its allowance.

After a provider timeout, inspect the stored operation and canonical receipt before deciding what to submit next. Preserve exact signed operation identity; the service does not automatically resubmit, invent a replacement signature, or fall back to an EOA. Sponsor depletion or an unsupported provider profile requires operator repair and fresh preparation. No live deployment, sponsorship account, credential, or production payment is established by passing the local tests.

## Recovery monitoring

The existing protected `GET /metrics` endpoint includes receipt recovery metrics. Its operator credential is `METRICS_TOKEN`, supplied as `Authorization: Bearer ...`; keep it in the monitoring provider's secret store. Requests without the correct credential return 404. This credential is separate from wallet-signed user API authentication.

| Metric | Meaning |
| --- | --- |
| `jbcenter_rest_recovery_last_completed_timestamp_seconds{task}` | Unix time when the most recent bounded task returned or threw. Zero until its first completion. A hung task leaves the timestamp unchanged. |
| `jbcenter_rest_recovery_last_failures{task}` | Unavailable records in the most recent page, or 1 if the whole task threw. A clean next page resets this gauge to zero. |
| `jbcenter_rest_recovery_failures_total{task}` | Cumulative unavailable results and task exceptions since process start. |
| `jbcenter_rest_recovery_runs_total{task}` | Completed task invocations, including failures, since process start. |
| `jbcenter_rest_recovery_sample_oldest_pending_timestamp_seconds{task}` | Earliest submission start among still-pending records in the latest examined page. Zero when that page contains no pending submissions; a task exception retains the prior sample. |

The only `task` labels are `nonce_cleanup`, `transactions` and `user_operations`. Every 30 seconds the worker removes at most 1,000 expired nonces, examines at most five transaction plans, then examines at most five UserOperations. An unavailable task does not prevent the next task from running. Sweeps never overlap and recovery never submits transactions. Failure logs contain only the fixed service/code/task and aggregate count, with no wallet addresses, signed bytes, provider URLs or record IDs.

For a Prometheus-compatible monitor, alert on `time() - jbcenter_rest_recovery_last_completed_timestamp_seconds > 300` (allow startup grace), and on `increase(jbcenter_rest_recovery_failures_total[5m]) > 0`. Alert on a sampled pending submission older than 30 minutes with `(time() - jbcenter_rest_recovery_sample_oldest_pending_timestamp_seconds > 1800) and (jbcenter_rest_recovery_sample_oldest_pending_timestamp_seconds > 0)`. The nonzero condition avoids treating an empty page as a submission from 1970. An occasional snapshot monitor can also check `jbcenter_rest_recovery_last_failures > 0`; it can miss a failed or aged page if a later clean page replaces it before polling, so use counter differences for failures when retaining previous observations. Configure a separate alert for missing scrapes or a failing `/readyz` response. A working HTTP endpoint alone does not prove that recovery is progressing.

These are worker health and bounded-page observations, not a global backlog. Pending age uses existing EOA attempt reservation times and UserOperation submission start times after receipt refresh, including pending/unknown results during a provider outage. Confirmed and reverted executions are excluded. Merely prepared plans and operations have no submission age. Forwarded Relayr steps do not contain an EOA attempt timestamp and are not included in the age metric; ERC-4337 submissions are measured by the `user_operations` task. No additional database scan is performed.

Failure counts cover explicit `reconciliation-unavailable` / `verification-unavailable` results and thrown task errors. A successfully read operation can still be pending or have uncertain chain evidence; inspect the plan or UserOperation's authenticated refresh response for that state. A clean page does not prove every account's operations are settled. On alert, inspect canonical receipts and provider health before retrying; retain the existing signed hash and do not submit a replacement solely because monitoring reported a failure.
