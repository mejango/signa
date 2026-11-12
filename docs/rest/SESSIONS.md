# Smart accounts, sessions and explicit payment budgets

A **smart account**, or smart wallet, is controlled by code and its owners. A **session** lets a bot repeat specific actions within owner-approved limits and an expiry. The bot keeps its signing key. Signa supports exactly seven or thirty days after owner activation and verification against the accepted chain history (**canonical**). See the [glossary](https://api.signa.center/api#glossary).

The implementation uses Safe accounts with Safe7579, the pinned legacy ERC-4337 SmartSession validator, an exact policy compiler, stored lifecycle records, and a separate service for smart-wallet requests (**UserOperations**). A **guard** enforces limits onchain. Both checked guards, `CenterSessionGuard` (`legacy-v1`) and `CenterSessionGuardV2` (`current-v2`), are undeployed. Local implementation and tests do not establish a configured hosted provider, provider billing, an eligible sponsorship policy, an external audit, or authority on a user's wallet.

Check `/api/v1/capabilities` before use. `userOperations.providers` and preparation/relay flags describe configured hosted execution; `sessions.configuredChainIds` and `sessions.activationReady` identify configured session support. Each request still verifies current runtime, account, grant, policy and chain evidence. Configured Safe-owner execution can work without the session guard. Recurring bot execution additionally requires its reviewed deployed guard and exact owner-approved onchain policy. See [execution operations](EXECUTION_OPERATIONS.md) for deployment, provider configuration and verification.

The legacy paymaster and `legacy-v1` guard remain the defaults. The explicit `pimlico-v7-current-flags` profile supports Ethereum (`1`), Optimism (`10`), Base (`8453`) and Arbitrum (`42161`) with the same EntryPoint v0.7 and requires `current-v2` for sessions. Both formats require exactly 130 packed paymaster bytes; current flags `0x00` and `0x01` are gas-only verifying mode, while `0x02` and above are rejected. Legacy raw mode `0x01` remains rejected as token charging. Provider policy caps, server gas admission ceilings and the owner's onchain session budgets are separate limits. Changing a profile neither deploys a guard nor activates or migrates a session.

Current final sponsorship can require an allowed bundler origin even when its stub does not. Final flags `0x00` require an operator-configured `simulationBundlerAddress`; exact signed preflight verifies its empty code and paymaster allowance at the same canonical block, authenticates the sponsor signature and simulates the unchanged EntryPoint call from that origin. No backend private key is associated with this setting. Unsigned preparation permits at most three final quotes to fit exact gas estimates within the approved ceilings; accepted sponsor data and operation fields remain unchanged for wallet signing. See [execution operations](EXECUTION_OPERATIONS.md) for the origin checks and quote limits.

All fund movement requires fresh owner approval unless it spends an explicitly set-aside, onchain-bounded payment allocation. Session keys cannot install modules, change ownership or permissions, change allowances, issue permits, or redirect funds. The existing [API bot grants](AUTHENTICATION.md) and [transaction transport](TRANSACTIONS.md) remain separate authorities.

## Accounts and authority

The owner controls each linked smart account and separately approves any session
that may act for it. API grants authenticate requests; wallet policies enforce
financial authority, including permitted actions, budgets and expiry. Signa has
no bot-admin scope or session-created sessions. A weekly API grant alone never
authorizes an onchain operation.

## Select and verify one complete stack

[Safe7579](https://docs.safe.global/advanced/erc-7579/7579-safe) acts as both a Safe module and fallback handler; its launchpad initializes account modules and related configuration. Its version, validator selection, registry, guards, fallback handling and execution mode must be verified together. Do not combine a current SDK with addresses and ABIs copied from an older tutorial.

The inspected official SDK source is [`rhinestonewtf/sdk@91f8f1e`](https://github.com/rhinestonewtf/sdk/tree/91f8f1edc80aa38e698033b5287b6aa7537bb641), whose [`src/package.json`](https://github.com/rhinestonewtf/sdk/blob/91f8f1edc80aa38e698033b5287b6aa7537bb641/src/package.json) reports `2.8.0`. This is a source revision, not a verified installed package or production deployment. Pin the actual package version, lockfile integrity and matching contract artifacts before using it. No active local Rhinestone SDK installation was found during this research.

The [official address book](https://docs.rhinestone.dev/home/resources/address-book) and pinned SDK publish these candidate identities. An address constant is not chain-specific runtime or account-installation proof:

| Component                      | Published current candidate address          |
| ------------------------------ | -------------------------------------------- |
| SafeL2 v1.4.1 singleton        | `0x29fcb43b46531bca003ddc8fcb67ffe91900c762` |
| Safe proxy factory             | `0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67` |
| Safe7579 adapter               | `0x7579f2ad53b01c3d8779fe17928e0d48885b0003` |
| Safe7579 launchpad             | `0x75798463024bda64d83c94a64bc7d7eab41300ef` |
| Smart Session Emissary         | `0xad568b3f825a8d5ffc06dd3253526b64d810ae89` |
| Session compatibility fallback | `0x000000000052e9685932845660777df43c2dc496` |
| Universal Action policy        | `0x0000000000714cf48fcf88a0bfba70d313415032` |
| Time-Frame policy              | `0x0000000000d30f611fa3bf652ac6879428586930` |
| Value Limit policy             | `0x000000000021dc45451291bcdfc9f0b46d6f0278` |
| Usage Limit policy             | `0x00000000001d4479fa2a947026204d0283cede4b` |

The legacy adapter is `0x7579ee8307284f293b1927136486880611f20002`, with launchpad `0x7579011ab74c46090561ea277ba79d510c6c00ff` and Smart Sessions Validator `0x00000000002b0ecfbd0496ee71e01257da0e37de`. They are different components, not aliases. The old TimeFrame `0x8177451511de0577b911c254e9551d981c26dc72` and ValueLimit `0x730da93267e7e513e932301b47f2ac7d062abc83` constants had no Ethereum bytecode at block `25923286`; copying a legacy address bundle is insufficient.

The current SDK selects the Emissary, so it is not the selected legacy-validator encoder. Source inspection of [PolicyLibV2](https://github.com/rhinestonewtf/smart-sessions-v2/blob/bcf7ce653921a9dab5a79e30e4a85e403cdf24fe/src/lib/PolicyLibV2.sol#L125) found that its action path discards returned validity data, raising an expiry-enforcement question. The deployed Emissary runtime did not match that HEAD artifact after declared immutable masking; this is an unresolved source/deployment issue, not a demonstrated deployed exploit. Emissary execution remains unavailable.

### Historical source observations and current integration

Read-only RPC observations on 2026-09-07 matched the legacy validator's runtime to [SmartSession artifact `f24dddf`](https://github.com/rhinestonewtf/smartsessions/blob/f24dddfcbf7269e10dcd4da90dae0a6ae6ccf188/artifacts/SmartSession/SmartSession.json). Its [validation path](https://github.com/erc7579/smartsessions/blob/f24dddfcbf7269e10dcd4da90dae0a6ae6ccf188/contracts/SmartSession.sol#L224) intersects action validity and returns it through `validateUserOp`; this permits an ERC-4337 EntryPoint to enforce timeframe bounds. It rejects delegatecall modes and requires an action policy for each execution. Current local contract tests also execute the pinned EntryPoint/Safe/SmartSession/paymaster stack; live hosted readiness remains an operator and account verification requirement.

The current [TimeFrame](https://github.com/rhinestonewtf/smartsessions/blob/75279a6c80ad50ea623d06954e9d71ab753e8a52/artifacts/TimeFramePolicy/verify.json), [UniAction](https://github.com/rhinestonewtf/smartsessions/blob/75279a6c80ad50ea623d06954e9d71ab753e8a52/artifacts/UniActionPolicy/verify.json) and [ValueLimit](https://github.com/rhinestonewtf/smartsessions/blob/75279a6c80ad50ea623d06954e9d71ab753e8a52/artifacts/ValueLimitPolicy/verify.json) compiled sources are independently bound to exact deployed artifacts at commit `75279a6c80ad50ea623d06954e9d71ab753e8a52`. The four runtime hashes below matched on all eight listed chains:

| Component                     | Exact runtime Keccak-256                                             |
| ----------------------------- | -------------------------------------------------------------------- |
| Legacy SmartSession validator | `0xf2817b8943b9fc813ad3602de2f0b973dc6b7e190f1b77dc9eb02b8d3022ab0c` |
| Current TimeFrame policy      | `0xa8c18f7a974673552d03d7325bbc33a102a5aaab5bc5a3c11ecae1648ca4e026` |
| Current UniAction policy      | `0xc58f13d259c69d0db90f611347535e2d5642f3352740b7d58fbf6e6b939670dd` |
| Current ValueLimit policy     | `0x086e8421c6c9daab4a93e63366c83e8f20cc3f736b7be5a97e0e81633581e4ed` |

Cross-version composition requires explicit proof. The legacy validator calls `initializeWithMultiplexer(address,bytes32,bytes)` (`0x989c9e46`) and `checkAction(bytes32,address,address,uint256,bytes)` (`0x05c00895`); those signatures and the current policies' ERC-165 declarations match. Both use the supplied `bytes32` config ID and isolate policy storage by config ID, multiplexer address and smart-account address. The current TimeFrame initializer is exactly packed `uint48 validUntil,uint48 validAfter` (12 bytes); older mock sources use different encoding and must not be substituted. ValueLimit takes one `uint256`, accumulates actual value, and resets usage on initialization. UniAction takes its exact 16-slot tuple and accumulates configured calldata words. The checked compiler and installed verifier use these exact layouts, with local contract tests in addition to source inspection.

The current [Safe7579 adapter](https://github.com/rhinestonewtf/safe7579/blob/f22a194148ff087f0c16125e530512e59794e188/artifacts/Safe7579/Safe7579.json) and [launchpad](https://github.com/rhinestonewtf/safe7579/blob/f22a194148ff087f0c16125e530512e59794e188/artifacts/Safe7579Launchpad/Safe7579Launchpad.json) matched official artifacts after declared immutable substitution on Ethereum and Sepolia. The adapter's [validation method](https://github.com/rhinestonewtf/safe7579/blob/f22a194148ff087f0c16125e530512e59794e188/src/Safe7579.sol#L253) preserves the installed validator's returned validity data. The singleton is SafeL2 v1.4.1, with factory/runtime evidence matching [official Safe deployment manifests](https://github.com/safe-global/safe-deployments/tree/1c3aad8cf686157272d7e5de05dae8cf5594e0bc/src/assets/v1.4.1) for all eight chains. The checked stack now pins EntryPoint, SafeProxy, the Ownable session validator and delegated utility too. Complete owner/module/history inspection remains mandatory on each actual account; historical address observations cannot replace it.

The disabled registry checks belong specifically to this Safe7579 revision's `RegistryAdapter`. Legacy SmartSession's ordinary `ENABLE` path retains ERC-7484 checks. Signa's separately owner-authorized setup uses the exact pinned `onInstall` `UNSAFE_ENABLE` mode after independent verification; bot operation signatures use only `USE`. Callers cannot select an alternate enable mode or bypass the owner lifecycle plan.

## Verified smart-account registry

Register a `SmartAccountRef` under the existing API owner; never replace that owner's API identity with the smart-account address. A registry entry binds chain, account address, owner set and threshold, supported owner-verification method, factory/setup hash if relevant, implementation/runtime hashes, adapter, validators, session module, policy contracts, guards, fallbacks, registry/attesters, execution mode, and verification block hash.

Registration requires an owner-signed exact account claim plus independent onchain verification. An API EIP-1271 check on the authority chain does not establish ownership of a contract on another chain. The current binding adapter requires the API owner to be a current Safe owner and verifies exactly the current threshold of direct EIP-712 EOA-owner signatures, sorted by owner address. A body-supplied owner address or mere Safe membership is insufficient; contract/delegated owner signature forms remain unsupported.

Predicted accounts remain `counterfactual` until the exact factory/initializer has executed and the final singleton, ownership and modules are verified. Recompute the address from pinned factory data; reject extra setup calls, unknown modules and substituted salt/init code. The owner retains a normal owner-authorized recovery path independent of the session module or Signa.

Reverify account configuration before plans and admission. Owner rotation, threshold changes, module/fallback changes and unknown code invalidate Signa's cached verification. They do not necessarily revoke an already installed onchain session: the wallet owner must disable it onchain. The current [Juicebox Money Safe safety path](https://github.com/mejango/juicebox-money/blob/c262a2fa7365af963ffb928b17deb45758235b57/src/lib/safe.ts#L416) rejects enabled modules; add a separate verified adapter, rather than weakening that existing check.

## Compile a closed session policy

[Rhinestone's current session documentation](https://docs.rhinestone.dev/smart-wallet/smart-sessions/overview) requires `restrictToActions: true` to remove unmatched-call Orchestrator fallback. Set `signing: { mode: 'disabled' }` explicitly. Empty permissions or absent policies can confer broad authority. Reject `sudo`, wildcard actions, crosschain permits and claim policies. The documented restriction flag requires SDK `2.6.0` or later; this minimum alone does not prove the chosen package safe.

Decode and inspect the compiled configuration, not just the input object. Require exact target/selector/arguments, value bounds, timeframe and usage policies on every allowed path. A caller cannot provide arbitrary policy addresses, SDK environment, RPC URLs, validators, raw account calls or opaque signing payloads. Internal raw-action compilation is permitted only for reviewed V6 operation definitions.

The [pinned resolver](https://github.com/rhinestonewtf/sdk/blob/91f8f1edc80aa38e698033b5287b6aa7537bb641/src/modules/validators/smart-sessions/resolve.ts) distinguishes execution-checked sessions from a pure ERC-1271 mode. Verify the actual signature/execution path reaches the action policies. Disabling generic ERC-1271 signing must not disable the verified execution proof or silently switch to a broader signing mode.

Bind API account ID, immutable bot grant ID, registered smart account, client key, chain, full policy digest, module version, generation, explicit validity, execution nonces and any budget allocation. Resolve the key and expiry from authenticated records; request-body identifiers do not grant authority. The session cannot outlast its bound bot grant's approved expiry. Display the exact UTC interval before owner signing. Test the deployed timeframe policy's inclusive/exclusive boundaries and encode the requested interval accordingly. Renewal requires fresh owner approval; a 30-day preset must be labeled explicitly rather than implying every calendar month has 30 days.

Encode project IDs and amounts from exact decimal strings into checked Solidity integers. Registry permission grants require project IDs that fit `uint64`; payment amounts and policy counters use exact base units without floating-point conversion.

The [SDK permission ID](https://github.com/rhinestonewtf/sdk/blob/91f8f1edc80aa38e698033b5287b6aa7537bb641/src/modules/validators/smart-sessions/digest.ts) hashes validator, validator configuration and salt, excluding actions, limits and expiry. The inspected resolver supplies zero salt. A permission ID therefore cannot stand in for a full policy digest or generation. Reusing the same key may overwrite policy configuration or reset counters. Use verified distinct salts through a supported encoding path, or new client-generated session keys; reject collisions and verify the installed full configuration after every change.

A generation label in Signa's database is not onchain replay protection. The selected legacy validator exposes `removeSession(bytes32)` and a separate [`revokeEnableSignature(bytes32)`](https://github.com/erc7579/smartsessions/blob/f24dddfcbf7269e10dcd4da90dae0a6ae6ccf188/contracts/core/NonceManager.sol#L28). Removal alone does not increment the enable nonce. Owner revocation plans must perform both, verify the new nonce and disabled permission, and reject reuse of old owner authorizations. Encode `enableSessions` from the matched ABI with a fresh explicit salt and full reviewed policy; no high-level SDK default may choose that salt.

### Action coverage and V6 caller semantics

The action catalog can grow through verified module policy definitions without deploying a new Signa executor. The implemented session action kinds are `v6-project-uri`, `erc20-transfer`, and closed `v6-pay`. Financial session actions additionally require an explicit approved allocation. Other operations retain fresh-owner authority. Reads, simulations, transaction preparation and metadata preparation do not acquire financial authority merely because they occur in a session.

| Operation                                                    | V6 method and authority                                                                           | Policy requirement                                                                                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Project presentation                                         | `setUriOf(uint256,string)`, `0x702a3977`, permission `7`                                          | Fixed current canonical controller/project, zero value; owner explicitly permits the metadata change.                                          |
| NFT presentation                                             | `setMetadata(string,string,string,string,address,uint256,bytes32)`, `0x2c6bdd55`, permission `25` | Candidate: exact canonical hook/project, resolver equal to hook sentinel, tier ID zero and encoded URI zero; verify every required constraint. |
| Token presentation                                           | `setTokenMetadataOf(uint256,string,string)`, `0xfac3a6a2`, permission `22`                        | Candidate: canonical controller and canonical `JBERC20` clone/implementation/binding; reject custom tokens.                                    |
| Pay/add balance/cash-out/loans/distributions/bridges         | Their existing V6 plans                                                                           | Fresh owner approval; only a verified explicit payment allocation permits repeat pay.                                                          |
| Fixed-recipient ERC-20 payment                               | `transfer(address,uint256)`                                                                       | Only a dedicated, explicitly funded allocation with exact asset/beneficiary and proven cumulative limits; otherwise fresh owner approval.      |
| Rulesets/splits/controllers/terminals/permissions/ownership  | Their existing V6 plans                                                                           | Fresh owner approval, even if the call has zero native value.                                                                                  |
| Approvals/permits/module installation/recovery configuration | Wallet or token authority changes                                                                 | Fresh owner approval; never a bot-session action.                                                                                              |

The [controller](https://github.com/Bananapus/nana-core-v6/blob/898f08b96194391d545df31a62f9d89ef6759f9a/src/JBController.sol#L766), [721 hook](https://github.com/Bananapus/nana-721-hook-v6/blob/1ec28e68a550cc0c09428416fb9d7698959591f8/src/JB721TiersHook.sol#L467), and [JBERC20](https://github.com/Bananapus/nana-core-v6/blob/898f08b96194391d545df31a62f9d89ef6759f9a/src/JBERC20.sol#L122) establish the constrained presentation paths. The first compiler should enable only the paths whose complete policies it proves; unsupported paths retain fresh-owner planning.

The smart account calls V6 directly, so protocol `_msgSender()` is the smart-account address, not the API owner or bot. If the original wallet owns the project, it may freshly grant that smart account exact project-specific JBPermissions. Do not grant ROOT/wildcard permissions or grant the bot EOA directly. [JBPermissions](https://github.com/Bananapus/nana-core-v6/blob/898f08b96194391d545df31a62f9d89ef6759f9a/src/JBPermissions.sol#L41) itself has no expiry or target scope; the smart-account module enforces the session restrictions. Transferring the project NFT into the account is a separate fresh-approved ownership change.

Check current project owner, `DIRECTORY.controllerOf(projectId)`, hook ownership where applicable and canonical code/bindings. Static calldata policies do not automatically perform those state checks onchain. Any required invariant that depends on mutable external state needs an existing verified policy capable of enforcing it, or the action remains fresh-owner-only. Live checks cannot prove unseen transfer history: V6 has no ownership epoch, and transfer away/back may restore old grants. Metadata remains untrusted presentation, not proof of identity or safe external links.

## Explicit set-aside payment accounts

Use a separate registered owner-controlled smart account for a recurring-payment allocation. Fund only the approved asset/principal and install only its reviewed payment policy. This reuses the selected account/module stack; no new Signa vault or executor contract is proposed. The owner's other wallets and spending accounts remain outside this session's authority.

The owner approves the exact chain/account, asset in integer base units, funding transaction, project ID, terminal, beneficiary, empty memo/metadata, per-call and lifetime caps, minimum output, expiry and recovery path. The seven/thirty-day interval has one cumulative lifetime allocation; it is not a rolling daily/weekly reset policy. Funding and every allowance increase require fresh approval. The payment session cannot pull from the owner's other wallet, top itself up, change a spender, transfer to the bot or pay its own sponsor fees from the payment allocation.

Direct `JBMultiTerminal.pay(uint256,address,uint256,address,uint256,string,bytes)` records the smart account as payer. Its [funding implementation](https://github.com/Bananapus/nana-core-v6/blob/898f08b96194391d545df31a62f9d89ef6759f9a/src/JBMultiTerminal.sol#L1053) uses actual `msg.value` for native payments and pulls ERC-20 from that account. A finite, owner-approved smart-account-to-terminal allowance can support ERC-20 repeats; permit metadata and session-created approval changes remain forbidden.

| Budget property | Required proof before recurring execution                                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Isolated funds  | Dedicated verified account, explicit funded allocation, no other bot spend paths, independently usable owner withdrawal/revocation.                                   |
| Fixed route     | For V6 pay, exact canonical terminal/project/asset/beneficiary; for a direct payment, exact token and beneficiary. No session authority over routing/admin functions. |
| Fixed payload   | Start with empty memo and metadata. Prove their dynamic ABI offsets and zero lengths onchain; SDK input validation alone is insufficient.                             |
| Native cap      | Accumulate actual call value, not the ignored `amount` argument. A per-use maximum alone is not a lifetime cap.                                                       |
| ERC-20 cap      | Verify the policy accounts for the actual allowed terminal-payment amount and cannot be bypassed through token behavior, other selectors or existing allowances.      |
| All sessions    | One active/admitted generation per physical wallet and chain, with action caps checked against explicit local allocations; alternate keys cannot duplicate the budget.                              |
| Periods         | Immutable seven/thirty-day window; no overlap admission even for adjacent windows until finalized retirement. No periodic reset or automatic top-up.                |
| Terms/output    | Enforce approved minimum returned tokens and any required mutable economic constraints through verified onchain policy; otherwise require fresh approval.             |

The [Call policy](https://docs.rhinestone.dev/smart-wallet/smart-sessions/policies/call) documents static ABI argument constraints, cumulative argument usage and per-use value limits. The [Spending Limit policy](https://docs.rhinestone.dev/smart-wallet/smart-sessions/policies/spending-limit) documents cumulative ERC-20 transfer limits. Neither description alone proves terminal `transferFrom` accounting, dynamic metadata restrictions, or periodic reset semantics.

The verified UniAction source reads a 32-byte word at `data[4 + offset:4 + offset + 32]`, so offsets exclude the selector. For canonical empty `pay` tails, constrain memo offset `160` to `224`, metadata offset `192` to `256`, and lengths at offsets `224` and `256` to zero, alongside fixed project/token/beneficiary/output rules and amount caps. Malformed offsets, truncation and alternate encodings need contract tests. The ERC-20 SpendingLimit policy handles token transfer/approve selectors, not terminal `pay`; use verified UniAction amount accumulation for that route. Native `pay` instead needs actual-value accumulation. The [SDK encoder](https://github.com/rhinestonewtf/sdk/blob/91f8f1edc80aa38e698033b5287b6aa7537bb641/src/modules/validators/smart-sessions/policies/encode.ts) is useful reference material but is not the authoritative legacy-session encoding.

Reject unsupported fee-on-transfer, rebasing, callback or upgradeable tokens until exact behavior is proven. Native payment caps must cover actual value; output floors must not be weakened by the bot. Full derived ruleset identity includes cycle/start/weight/metadata: [`JBRuleset.id` survives auto-cycles](https://github.com/Bananapus/nana-core-v6/blob/898f08b96194391d545df31a62f9d89ef6759f9a/src/structs/JBRuleset.sol#L10). A policy that only compares calldata cannot pin changing ruleset state. Do not claim that an offchain preflight enforces this against direct session submission.

Smart-session counters may be updated during validation before execution. Verify failure behavior; a reverted UserOperation can still consume gas or policy allowance. Never refund/reset a budget counter in Signa based on a failed receipt without matching canonical onchain state. Donations and later deposits must not silently increase the approved spend cap; replenishment is fresh-approved funding, and an account balance is not an authorization ledger.

Buyback hooks, 721 hooks, router terminals and revnets keep full read and fresh-owner plan support. Their recurring payment profiles require separate proof of closed calldata, all dependencies, refunds, asset/output accounting and allowed economic changes. A smart-account SDK does not automatically make every V6 operation session-safe.

### Omnichain allocations

Represent each `(chainId, smartAccountAddress, projectId, asset)` allocation separately. At most eight members per group; never sum incompatible assets or promise a shared atomic remaining balance across chains. An owner-signed manifest binds every local account, policy digest, generation, allocation and exact-unit cap; compatible-asset allocations must sum to the approved total.

Each chain enforces only its own verified policy. The compiler and owner review must reject duplicate allocations and overlapping independently spendable sessions. A module without crosschain accounting cannot enforce a global manifest merely because Signa records it. Reusing a retired allocation requires fresh approval, confirmed revocation and reconciliation of old spending. A pending revocation or source bridge receipt never establishes freed capacity or destination credit.

## Interfaces and lifecycle

All paths below are mounted under `/api/v1`. The [OpenAPI document](/api/v1/openapi.json) gives exact body and response schemas. Providers, credentials, deployment manifests and trusted policy targets come from server configuration.

| Resource | Authority and result |
| --- | --- |
| `GET /capabilities`, `/smart-accounts/capabilities` | Public configured execution and account-stack discovery. |
| `POST /smart-accounts/creation-plans` | Owner-only stateless `{creation}` with exact factory calldata and predicted address; the wallet signs and funds deployment separately. |
| `POST /smart-accounts/binding-challenges`, `/smart-accounts/bindings` | Exact current Safe-owner threshold authorization plus independent canonical account verification. |
| `GET /smart-accounts/bindings`, `/smart-accounts/bindings/:id` | Stored association list or current verified account state; `DELETE` of the binding is owner-only API unlink. |
| `POST /smart-accounts/session-reviews` | Optional policy review without installation; executable preparation additionally requires `gasBudget`. |
| `POST /smart-accounts/sessions`, `GET /smart-accounts/sessions` | Compile and persist an immutable generation; list owner-visible or exact bound-bot sessions. |
| `GET /smart-accounts/sessions/:id`, `/:id/quota` | Canonical installed-policy/administration/counter evidence and approved allocations; `refresh=false` is available on the session read. |
| `POST /smart-accounts/sessions/:id/activation-plans`, `/:id/revocation-plans` | Owner acknowledges `{compiledHash}` and receives a durable lifecycle plan. |
| `POST /smart-accounts/bindings/:id/plans` | Durable exact V6 or ABI action plan using the verified Safe and chain. |
| `POST /user-operations` | `{planId,stepIndexes,sessionId?}` returns exact EntryPoint v0.7 bytes and external signing payload. |
| `POST /user-operations/:id/submissions`, `GET /user-operations/:id` | Submit only `{signature}` and reconcile canonical execution; API request signing remains separate. |

Transaction preparations and submissions require a signed idempotency key. Bot grants use cumulative scopes; a session binds the exact active `read+plan+relay` grant and its client-held key. Owners can inspect their account's bot records; bots see only their own bound records. Mutations retain the original preparation principal.

The durable session states are `prepared`, `installing`, `active`, `revoking`, `revoked`, `expired`, and `stale`. Preparation records the immutable full policy, compiled hash, generation, salt, key, grant, and canonical administration baseline. Owner activation planning alone does not install authority: execute its returned plan with the current Safe-owner threshold signatures, then refresh and require `active` with fresh canonical evidence. First activation requires exactly one subsequent initialization of only this permission. Changed administration or reset counters permanently invalidate the generation.

Session UserOperations select exactly one approved action and return the legacy Ownable validator's EIP-191 signing payload. Without `sessionId`, up to sixteen ordered calls use finite-validity SafeOp signatures from the current Safe-owner threshold. These broader owner-authorized plans can cover financial or administrative actions excluded from session policy. An API request signature cannot replace either wallet signature mode.

Only the current admitted activation/revocation plan can execute. An expired plan with no transport admission or attempt can be replaced with fresh owner consent and a new idempotency key; up to 32 superseded approvals remain recorded. A superseded plan cannot execute or reinitialize an observed active generation. Replaying the original admitted request returns its original plan, with `installationConfirmed:true` if the stored session is already active; that replay does not refresh the chain or install it again.

One admitted or observed-enabled generation reserves the whole physical wallet on its chain across API aliases, keys, assets and time windows, including URI-only policies. Expiry alone never releases it. The owner revocation plan atomically removes the permission and advances its enable nonce. Only finalized canonical disabled state with the advanced nonce releases the reservation; identity tombstones remain. There are no `/budgets` resources, automatic deposits, periodic counter resets or automatic renewals. Funding, allowances and recovery use separately approved ordinary wallet plans.

API grant revocation, unlinking and Safe owner rotation stop applicable Signa admissions but do not remove an otherwise active legacy onchain session. An owner must revoke it onchain; new owners should explicitly remove old permissions and revoke their enable signatures. Chain ordering determines whether an already submitted operation executes before revocation. Reorganizations invalidate affected observations until canonical evidence is available.

Receipt proof binds the exact registered account, EntryPoint version, operation hash, validator/session, full policy digest, generation and nonce. Reconciliation verifies the account's scoped inner execution and modeled V6 effects with the smart account as caller/payer. A provider response or successful outer transaction alone cannot prove payment completion. `submission_unknown` retains reservations and never permits automatic republication; bridge settlement remains separate.

## Execution and gas

Choose a transport only after verifying that the chosen account/module stack supports it. ERC-4337 requires a pinned EntryPoint version, correct UserOperation encoding/nonce namespace, compatible bundler, paymaster rules and receipt proof. A module's alternative execution or intent route is a separate adapter; no unmatched-call fallback may broaden the owner-approved actions.

The stock V6 [ERC-2771 forwarder](https://github.com/Bananapus/nana-core-v6/blob/898f08b96194391d545df31a62f9d89ef6759f9a/script/Deploy.s.sol#L63) authenticates one ECDSA request; it is not a general Safe/Smart Sessions execution adapter. Existing Relayr forwarding must not be relabeled as smart-account session support. The direct EOA, Relayr and EntryPoint v0.7 services remain distinct transports with separate configured authority and receipt checks.

Relayr gas funding, ERC-4337 provider billing and project-payment allocations are distinct. The existing [Relayr client](https://github.com/mejango/juicebox-money/blob/c262a2fa7365af963ffb928b17deb45758235b57/src/lib/relayr.ts#L42) pins its own payment code and four mainnets; that proves neither account-abstraction compatibility nor user spending balance. Owner-funded gas needs explicit approval; a sponsor may fund its own quota. Safe7579 can pay `missingAccountFunds` from the Safe during validation, outside action value limits. Executable sessions therefore require the verified guard version matching their exact 130-byte verifying-only paymaster profile. Onchain gas/fee/cumulative-cost limits and mandatory sponsorship close the prefunding path; an offchain sponsor preference alone would not provide that protection.

## Chain evidence and live operation

The source-bound legacy validator and three current policies above were observed at the following blocks on 2026-09-07; their block hashes were rechecked after the reads. These are historical deployment observations, not proof that a current hosted provider or user's session is ready.

| Chain | Observed block |
| --- | --- |
| Ethereum `1` | `25923286` |
| Optimism `10` | `156579447` |
| Base `8453` | `50984162` |
| Arbitrum `42161` | `502573441` |
| Ethereum Sepolia `11155111` | `11652036` |
| Optimism Sepolia `11155420` | `48477566` |
| Base Sepolia `84532` | `46494692` |
| Arbitrum Sepolia `421614` | `306272332` |

The current repository supplies pinned stack artifacts, a closed compiler, complete account-history inspector, installed-policy verifier, durable session/UserOperation stores, owner lifecycle plans, and external client signing. It also implements the two versioned guard policies needed for one-call execution, cumulative gas/cost limits and mandatory gas-only sponsorship. Each guard is a reviewed Solidity deployment requirement; neither is a vault or a deployed service inferred from existing Rhinestone addresses.

The remaining live setup is concrete: deploy and verify the exact matching guard, configure an eligible hosted bundler/paymaster, provider billing and sponsorship policy, supply canonical RPC and complete trace history, and obtain actual wallet creation/binding/activation signatures. Review the per-chain [execution operations procedure](EXECUTION_OPERATIONS.md). Without execution configuration, the runtime exposes base account stacks and unavailable hosted execution/session readiness; it does not invent provider credentials or guard addresses.

Local verification includes exact artifact and source checks, compiled policy execution against the pinned EntryPoint/Safe/SmartSession/paymaster stack, direct session submissions, expiry/revocation, failed-execution counter consumption, authority-history reset detection, and concurrent PostgreSQL admission/recovery. `npm run check:execution` validates the required contract suites and reviewed artifacts. Passing local tests does not install a session, establish provider billing, or establish a production payment.
