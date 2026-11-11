# Optional transaction wallets

Start with **Sign in** and **API access** on [Accounts](/accounts). Add a
transaction wallet when you want to:

- Keep funds for transactions in a separate account that you choose how much to fund.
- Use sponsored transaction fees on supported chains when sponsorship is available.
- Share approvals with other owners, requiring a chosen number of their signatures.
- Give a bot narrowly limited wallet permissions, only when the required contracts
  are deployed, supported and verified, and you approve activation onchain.

Signa supports verified **Safe7579** wallets with the configured contract and
module setup. It cannot link an arbitrary Safe. A supported Safe can have one
owner and require one signature; a **multisig** has multiple owners and a chosen
approval threshold. Shared approval is optional. Creating or funding a wallet
requires its own reviewed transaction; sponsored execution does not imply free
wallet creation or funding.

Read [capabilities](/api/v1/capabilities) before setup. `userOperations` reports
current sponsored-execution availability; `sessions` reports whether recurring
bot permissions can be activated. An API grant alone authorizes no spending.

A **smart wallet** is an account controlled by code and its owners. A **binding**
links a verified wallet to a Signa API account. A **session** permits a bot to
repeat specific wallet actions within owner-approved limits and an expiry.
Linking a wallet grants no permission to spend. See the
[glossary](https://api.signa.center/api#glossary).

## Set up and use several networks

On [Accounts](/accounts), select the networks where your wallet should be
available. Signa prepares the same owners, approval threshold and wallet address
across compatible networks. Review the combined setup, then approve each network's
creation. The page keeps each network's transaction hash and confirmation status
separate. A submitted transaction is not yet a connected wallet: Signa checks
the deployed code and ownership before you approve its connection.

Your Signa API account and registered bots stay the same when execution switches
networks. Previously connected wallets are listed by address and network. Choose
one to prepare an action, then add its reviewed operation to the transaction list.
You can review and send operations for several networks together and follow each
result independently. An unknown submission must be checked using its saved
operation ID before attempting a replacement.

Matching addresses have separate balances, transaction histories and permissions
on each network. Setup fees are paid on each network. A transaction that confirms
on one network is not undone by a failure on another, and this workflow does not
bridge funds between networks.

For unattended spending, activate a bot permission on each wallet you want it to
use. Specify the allowed action and recipient, per-payment and total limits, call
count and expiry. Once activation confirms, the bot signs payments within those
limits using its own key, without further owner prompts. API relay access alone
does not activate that permission. See the [worker example](./CLIENT.md#run-payments-without-another-owner-prompt)
and [session lifecycle](./SESSIONS.md).

Signa prepares exact session policies and owner-approved activation or
revocation plans, then independently checks the installed policy. Sessions
require verified deployed contracts, a configured submission service
(**bundler**) and gas sponsor (**paymaster**), and verified owner-approved
activation onchain. Direct and prepaid transactions retain their own approval
rules. Signa never silently replaces a linked wallet with its owner's directly
controlled account (**EOA**).

`createSmartAccountService`, `createSessionPolicyReviewer`, `createLegacySessionCompiler`, and `createInstalledSessionVerifier` are exported from `src/rest/smartAccounts/index.ts`. Runtime configuration owns deployment manifests, module inspectors, reviewed targets/assets and paymasters. HTTP callers cannot supply those trust inputs. Missing configuration fails explicitly; source artifacts do not constitute a live deployment.

## Owner identity and wallet binding

The API account remains `eip155:<authorityChainId>:<ownerEOA>`. Each wallet has its own `(executionChainId, Safe address)` binding. Binding requires the API owner to be a current Safe owner and enough current owners to satisfy the actual threshold. Merely controlling one signer of a multisig is insufficient.

Every inspection validates `eth_chainId`, pins one mined block, and uses EIP-1898 `{blockHash, requireCanonical:true}` for code, storage and calls. It checks the exact Safe proxy runtime, slot-zero singleton, version, owners, threshold, fallback handler, zero guard and complete Safe module list. Only the configured Safe7579 adapter may be enabled as a Safe module. All configured dependencies have expected runtime hashes and source/artifact identities. Missing code, changed code, unexpected modules or unsupported RPC block references fail.

The first implementation supports EOA owners and direct EIP-712 owner signatures. It rejects contract/delegated owners, preapproved-hash signature forms and session signatures. Signatures are packed in increasing owner-address order and must exactly meet the observed threshold. This deliberately proves current owner authority directly: an ERC-1271 response from an account's installed validator is not automatically proof that its owners approved a new binding. Contract-owner threshold support requires another reviewed signature adapter.

A binding challenge commits to service audience, execution chain, wallet, API account, owner, complete observed account state hash, random nonce and an expiry within fifteen minutes. Ownership or module-state changes require a fresh challenge. The authorization expiry limits admission of the link; it is not an onchain session expiry. Before using a stored binding, `current()` rechecks the live state. List responses explicitly identify their stored snapshot.

`PostgresSmartAccountRegistry` and migration `007_rest_smart_accounts.sql` persist links under the API account. Account row locks serialize nonce claims, renewals and unlinking. A revoked or superseded authorization cannot restore a link. The database checks its own clock, isolates accounts, bounds documents and limits each account to sixteen wallet records and 256 live binding nonces. The memory registry is for tests/development. API unlinking does not revoke any installed onchain session.

## Minimal checkout setup on Base

A checkout can combine API enrollment, wallet binding and one hour of browser API
access into one owner approval **after canonical deployment**. The intended new
wallet journey has two setup approvals: the separate exact deployment approval,
then this finalization approval. An existing supported wallet needs only
finalization; an already connected wallet with valid browser access can reuse that
access. Each payment still requires its own exact owner signature. These are
logical approvals; phone/email authentication and any credential review required
by the wallet provider remain separate.

This path supports only Base (`8453`), a current sole EOA owner with threshold one,
and a configured Safe7579 wallet with complete canonical dependency and module
evidence and no spending sessions. Setup rejects evidence more than five minutes
old or more than 30 seconds ahead of server time with `409 SMART_EVIDENCE_STALE`.
It cannot deploy or fund the wallet, authorize
a transaction, install an onchain session or change its owners. API `read`, `plan`
and `relay` scopes permit API requests and submission of separately authorized
transactions; they give the browser no owner signing authority.

1. In the browser, choose a lowercase grant UUID v4, generate a distinct API key and select a
   nonzero random setup nonce. Send `owner`, wallet `address`, `manifestId`,
   `nonce`, integer Unix-second `issuedAt` and `expiresAt`, and
   `grant:{id,botAddress,scopes,expiresAt,label}` to
   `POST /api/v1/smart-accounts/onboarding-challenges`. Every field is required;
   the grant scopes must be exactly `["read","plan","relay"]` in that order.
   The setup expires within five minutes of `issuedAt`; the grant expires after
   setup and within one hour of `issuedAt`. Owner, wallet and API key addresses
   must all be distinct. Labels have a 120 UTF-8-byte limit and no control
   characters. This bounded public read neither enrolls an account nor consumes
   the nonce.
2. Review and sign the returned `SetupAccount` EIP-712 document with the current
   sole owner. Its domain is `Juicebox Signa Account Setup`, version `1`, chain
   `8453`, the wallet as `verifyingContract`, and
   `keccak256(UTF8(service audience))` as salt. It binds the API account, owner,
   manifest ID/revision, initializer hash, current state hash, nonce, times and
   every selected grant field. Typed-data `issuedAt`, `expiresAt` and
   `grantExpiresAt` are decimal strings in the JSON response; request timestamps
   are JSON integers. The browser key separately signs the same domain with
   `primaryType:"CenterSetupProof"`,
   `types:{CenterSetupProof:[{name:"setupDigest",type:"bytes32"}]}` and
   `message:{setupDigest:challenge.digest}`. Both signatures are direct 65-byte
   EOA signatures with `v=27` or `v=28`.
3. Persist the grant UUID, browser key, exact reviewed document and both signatures
   locally before dispatch. POST the original input plus `manifestRevision`,
   `initializerHash`, `stateHash`, owner `signature` and browser `proofSignature`
   to `/api/v1/smart-accounts/onboarding`. No generic `CenterRequest` signature
   or signed-request headers are needed on either onboarding endpoint. The body
   approval is required for finalization. Signa freshly verifies canonical state
   and signatures, then atomically enrolls the API identity if absent, claims the
   binding nonce, saves the binding and inserts the exact signed grant UUID.
   HTTP `201` returns `{account,binding,grant}`. Existing account profiles are
   preserved.

The new binding authorization method is
`safe-current-owner-threshold-and-api-grant`; its required `setup` fields retain
the manifest revision, initializer hash, issuance time and exact grant fields.
The existing `safe-current-owner-threshold` method and threshold binding route
remain available. Neither method grants spending permission.

Keep the API private key in browser-controlled storage appropriate to the
checkout's recovery lifetime. Signa receives only its address and proof, never
the private key, wallet credentials or signing session. Do not put keys,
credentials or signatures in URLs, logs or analytics. A checkout must retain
enough local state to recover after switching apps without asking for the same
approval again.

If the finalization response is lost, use the saved grant UUID/key to make an
ordinary grant-signed `GET /api/v1/smart-accounts/bindings/:id`; the binding ID is
deterministic for the API account and wallet. A grant-signed binding list can
recover the ID if it was not saved. A successfully committed result remains
recoverable after the five-minute setup approval expires, while its grant is
still active and its binding is current. Replaying the same unexpired
nonce/digest can return the existing result, but cannot restore a revoked grant
or an unlinked, changed or superseded binding. If nothing committed before
expiry, fresh owner approval is required. Unknown network status is not proof of
failure or permission to replace a grant or submit a payment again.

## HTTP interfaces

Routes are mounted under `/api/v1` and share request bounds. Capabilities and the
onboarding challenge are public. Onboarding finalization requires the dedicated
body signatures above; other routes use normal signed-request authentication.

| Method and path                           | Input / result                                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `GET /smart-accounts/capabilities`        | Configured manifests, observed deployment research, inspector/provider requirements and explicit execution status.  |
| `POST /smart-accounts/onboarding-challenges` | Public canonical review for a sole-owner Base wallet and exact one-hour browser API grant; returns `{state,typedData,digest}`. |
| `POST /smart-accounts/onboarding`        | Purpose-signed finalization; atomically enrolls, binds and creates the exact API grant. HTTP `201`: `{account,binding,grant}`. |
| `POST /smart-accounts/binding-challenges` | Owner-only `{manifestId,address,nonce,expiresAt}`; returns observed state, EIP-712 typed data and digest.           |
| `POST /smart-accounts/bindings`           | Owner-only challenge fields plus `{stateHash,signature}`; rechecks state and verifies the owner threshold.          |
| `GET /smart-accounts/bindings`            | Account-isolated stored binding summaries.                                                                          |
| `GET /smart-accounts/bindings/:id`        | Revalidated current binding; changed authority fails.                                                               |
| `DELETE /smart-accounts/bindings/:id`     | Owner-only API unlink; explicitly reports `onchainSessionRevoked:false`.                                            |
| `POST /smart-accounts/session-reviews`    | Typed policy review with `plan` scope; produces a policy hash and activation requirements, not installed authority. |

The session review input contains `bindingId`, `grantId`, positive decimal-string `generation`, nonzero random `nonce`, integer Unix-second `validAfter`, `durationDays:7|30`, decimal-string `maximumCalls`, allocation groups and typed actions. The service loads the active bot grant itself; callers cannot substitute a session key. A bot can review only its own grant. The whole validity interval must fit the grant's expiration, and the grant must have `plan` and `relay` scopes.

## Policy and budget constraints

Every review binds the API account, wallet, bot grant/key, execution chain, generation, nonce, validity window, distinct salt, full policy hash and deployment revision. It forces restricted actions, disables arbitrary signing and excludes wildcard, Orchestrator, claim and crosschain-permit fallback. Empty/general transaction permissions are not an accepted policy. These choices are required because the SDK's permissive defaults otherwise allow substantially broader execution. [Session contract overview](https://docs.rhinestone.dev/smart-wallet/smart-sessions/overview).

Allocation groups state an explicit total and concrete `(allocationId,chainId,asset,limit)` entries. Amounts are exact base-unit decimal strings. Every entry must match server-reviewed asset identity and decimals on its chain; a group mixing identities or decimals fails. These values cannot come from caller symbols or decimal claims. Entries then sum within the owner-approved total; duplicate asset/chain allocations fail. An action uses the bound wallet's chain, and independent action caps sharing an allocation must also sum within that allocation. The service does not infer crosschain asset equivalence, reuse pending revoked allocations, or reset previously consumed limits.

The compiler supports three closed action models:

- `v6-project-uri`: fixed reviewed controller and project ID, editable URI, zero native value. The smart account must itself own the project or hold the corresponding V6 permission. No permanent permission is granted to the bot EOA.
- `erc20-transfer`: reviewed exact-transfer token, fixed beneficiary, per-call amount and cumulative amount. Native value, account self-calls and duplicate target/selector policies are excluded.
- `v6-pay`: reviewed core terminal, fixed project, asset, beneficiary and minimum project-token output, with fixed empty memo/metadata. Compilation must prove canonical empty dynamic tails, exclude Permit2 and enforce the actual native-value cap independently of the `amount` argument. ERC20 terminal allowances need their own fresh owner approval.

These models exclude arbitrary selectors, delegatecall, nested calls, permit, approvals, account administration and additional raw policy fields. The current onchain guard allows exactly one canonical default CALL per UserOperation, so `maximumCalls` counts actual permitted calls. A session may authorize multiple alternative actions. Reviewed target configuration is separate from activation: the actual target and all policy enforcement must be checked again before owner approval and execution. Only reviewed exact-transfer ERC20 assets are supported; fee or rebasing behavior cannot be inferred from a token symbol or ABI.

ABI sugar for Call policies only supports static parameters. A selector and amount limit do not constrain dynamic V6 payment metadata. The lower-level UniversalActionPolicy can express word constraints, but its deployed offset semantics and init format must match the compiler. [Call policy documentation](https://docs.rhinestone.dev/smart-wallet/smart-sessions/policies/call).

Permission IDs are not policy digests. The inspected SDK resolver uses a zero salt, while the permission identity excludes action rules, limits and expiry. The low-level compiler derives a distinct nonzero salt and binds both the full reviewed policy hash and exact compiled document hash. The legacy USE permission ID is also outside the signed UserOperation hash, so different live sessions sharing a key could combine authority. This implementation accepts one enabled session per wallet/chain, with multiple actions in that session. ERC4337 validation can consume limits even if execution later fails; counter observations preserve that consumption and reject resets.

Executable policies include `gasBudget:{paymaster,maxGasPerOperation,maxFeePerGas,maxPriorityFeePerGas,totalGasLimit,totalSponsoredCostLimit,maxPaymasterDataLength}`. Every amount is a canonical decimal integer string; the paymaster address must resolve to a server-reviewed runtime. `maxPaymasterDataLength` is exactly 130 for either reviewed verifying-only wire format. The selected `CenterSessionGuard` (`legacy-v1`) or `CenterSessionGuardV2` (`current-v2`) requires its exact paymaster/runtime and verifying mode, excludes ERC20 charging, bounds gas and fees, and charges cumulative conservative `maxFeePerGas × requestedGas` and call quotas during validation. The legacy format accepts raw mode `0x00`; the current format accepts flags `0x00` and `0x01`, where `flags >> 1` is verifying mode zero and the low bit controls bundler eligibility. Mandatory sponsorship prevents account prefunding on the same verified EntryPoint v0.7 path. A backend gas limit or the existing effective-cost SimpleGasPolicy alone would not provide that boundary.

## Deployment evidence and the execution path

`SMART_ACCOUNT_RESEARCH` records observed canonical block hashes and runtime hashes for eight chains: Ethereum, Optimism, Base, Arbitrum and their four listed Sepolia networks. Code observations are not an audit, installation proof, module-state proof, or provider configuration. Candidate addresses never become active manifests automatically.

`createConfiguredSmartAccountStack({chainId,paymasterProfile?,sessionGuard?})` in `stack/config.ts` validates the pinned manifest hash and every artifact's file hash, runtime and source identity. It maps the reviewed base stack across all eight supported chains, including EntryPoint v0.7, SafeL2/factory/proxy, Safe7579/launchpad/delegate utility, legacy Ownable validator and policy contracts. `paymasterProfile` defaults to `pimlico-v7-legacy-mode`; explicit `pimlico-v7-current-flags` selects the separately verified `stack/current-pimlico/` package on Ethereum, Optimism, Base and Arbitrum only. The legacy manifest and base ownership identity remain unchanged. The optional `sessionGuard` supplies its address, runtime hash and `version`; `legacy-v1` is the default and `current-v2` requires the current paymaster profile. The older `CHECKED_SMART_ACCOUNT_BINDING_MANIFESTS` export remains an ownership-only compatibility manifest. Without an operator-supplied verified guard deployment, the factory supplies account configuration but refuses to create an executable session compiler. Guard addresses are never invented; both guards' local sources use content hashes rather than fabricated Git commits.

The deployed legacy SmartSession runtime was matched to the artifact at commit `f24dddfcbf7269e10dcd4da90dae0a6ae6ccf188`. Its ERC4337 validation path propagates intersected policy validity to EntryPoint. The observed TimeFrame, UniversalAction and ValueLimit policy artifacts match commit `75279a6c80ad50ea623d06954e9d71ab753e8a52`; their initialization layouts must be taken from that exact revision. [Legacy validator artifact](https://github.com/rhinestonewtf/smartsessions/blob/f24dddfcbf7269e10dcd4da90dae0a6ae6ccf188/artifacts/SmartSession/SmartSession.json), [policy source revision](https://github.com/rhinestonewtf/smartsessions/tree/75279a6c80ad50ea623d06954e9d71ab753e8a52).

Current SDK and Emissary deployments are a different generation and are not accepted by this compiler. The compiler checks the exact supported runtime for every role; it does not mix their signature envelopes, initialization layouts or expiry semantics.

Safe7579 is both an enabled Safe module and its fallback handler. Complete inspection covers internal validators, executors, hooks and selector fallbacks through current state plus complete canonical creation/lifecycle traces. Unknown history is rejected because fallback selectors are not enumerable. Registry/attester enforcement is disabled in the matched adapter source and is not treated as a security guarantee. The stable binding hash covers account/module authority; the installed verifier checks live sessions and counters separately. [Safe7579 architecture](https://docs.safe.global/advanced/erc-7579/7579-safe).

Owner setup uses exact pinned `UNSAFE_ENABLE` initialization only after independent runtime/configuration verification, with zero existing sessions. This bypasses registry attestation explicitly; it does not enable a caller-selectable unsafe mode. Creation installs the empty validator before wallet binding. Renewal requires owner-approved atomic `removeSession` and `revokeEnableSignature`, then verified/finalized retirement before reusing its allocation. Session signatures use the matched legacy Ownable validator's EIP-191 prefix, and the Safe nonce is `validator20 || lane4 || sequence8`. The service never holds owner or bot private keys.

`createInstalledSessionVerifier` checks exact enabled IDs, signer configuration, action/policy lists, zero ERC1271 policies/content, paymaster permission and runtime, TimeFrame/guard limits and counters, native-value limits, and every active UAP rule from its source-bound storage layout. Reads share one canonical EIP-1898 block. Local Anvil tests execute compiler-generated bytes against the actual pinned validator/policies and guard; they also verify the reader detects changed permission flags/limits and requires nonce advancement for revocation. These policy-boundary tests do not by themselves prove a live hosted paymaster or deployed owner activation.

The lifecycle service additionally binds the inspector's complete session-administration trace history. Preparation captures its epoch/hash; first activation requires exactly one subsequent initialization of the compiled permission, and later active observations require the same administration epoch/hash. This detects counter reset followed by additional spending between observations, which merely comparing sampled counters would miss. The policy reader does not invent an administration certificate from storage values.

## Production activation requirements

Deploy the exact reviewed guard artifact matching the selected paymaster, configure and verify its address, and configure the hosted bundler/paymaster URL, credentials, provider billing and sponsorship policy for each selected chain. Both guard artifacts are undeployed in the repository. Preserve the matching gas-only paymaster runtime/profile; another contract or charging mode is not equivalent. The operator RPC must support canonical reads and the required complete account-history traces. A wallet owner then reviews and signs the exact creation/binding/activation steps. Canonical installed-state verification is required before delegation, and financial actions outside the approved budget retain fresh owner approval. Selecting a different provider profile does not migrate existing onchain sessions.

`readRestExecutionConfiguration` reads the optional server-only `REST_ERC4337_CONFIG` JSON. Its shape is `{chains:[{chainId,bundlerUrl,paymasterUrl,paymasterPolicyId,paymasterProfile?,simulationBundlerAddress?,sessionGuardAddress?,sessionGuardVersion?,confirmations?,gas}]}`. URLs must be fixed HTTPS endpoints without userinfo or fragments; query-string API keys remain private server configuration. `paymasterPolicyId` is passed to the configured sponsor as `context.sponsorshipPolicyId`. The profile and guard version default to the legacy pair. Current sessions require explicit `paymasterProfile:"pimlico-v7-current-flags"`, `sessionGuardVersion:"current-v2"` and the verified guard address; a version without an address or a mismatched profile fails startup. Each `gas` object must explicitly supply decimal-string `maximumCallGas`, `maximumVerificationGas`, `maximumPreVerificationGas`, `maximumPaymasterVerificationGas`, `maximumPaymasterPostOpGas`, `maximumFeePerGas`, `maximumPriorityFeePerGas`, and `maximumCost`. These admission ceilings for individual operations are separate from provider policy caps and owner-approved onchain budgets. Hosted operations require sponsorship; confirmations default to one and may be configured from one through 1024. Unknown fields, unsupported/duplicate chains, missing ceilings, malformed integers and invalid URLs fail startup without echoing credentials. See [execution operations](EXECUTION_OPERATIONS.md) for the four-chain example, provider billing, policy caps and versioned deployment verification.

`simulationBundlerAddress` is an optional nonzero address accepted only for the current paymaster profile, and becomes required for exact signed preflight when final sponsor flags are `0x00`. At the same canonical block, the service rechecks the pinned paymaster runtime, empty code at that EOA and its paymaster allowlist membership, authenticates the exact sponsor signature through `getHash(0, ...)`, EIP-191 recovery and `signers`, then simulates unchanged `handleOps` from that origin without state overrides. This address is server configuration used only for simulation; its allowance does not establish that the hosted bundler currently uses it. Current unsigned preparation estimates each final sponsor quote and permits at most three quotes to fit gas within operator and session ceilings, with a 5% margin only on underestimated fields. Once accepted, the quoted operation stays unchanged for wallet signing and exact preflight.

With no execution configuration, the loader supplies all eight verified base stacks and no provider or sponsor credentials. The base stack can support separately approved owner operations once a provider is configured; absence of the session guard does not disable owner authority. Delegated compilation still fails until a verified guard address is supplied.

No live deployment, fund movement or private-key use was performed while building these compiler and verification modules. Local source, deployment bytecode, tests and provenance are available under `src/rest/smartAccounts/stack/` for review.
