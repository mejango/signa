# Signa risks and invariants

Signa is a passkey smart-account wallet. Each account is a threshold-one Safe on Base with two owners: the user's passkey signer and a recovery EOA the user holds. Server keys pay gas only and own nothing. This file states what production runs today; [README.md](README.md) covers configuration.

## Production boundary

- **Only the hosted Base path runs.** `src/index.ts` builds the wallet stack with `createBaseWalletProductionStack` and mounts creation, recovery and device addition only through the hosted Base hosts in `src/rest/wallet/baseHost.ts`. It mounts nothing when the matching `WALLET_CREATION_*` or `WALLET_RECOVERY_*` group is absent, and constructs no account runtime unless `SIGNA_RUNTIME_ENABLED=true`. The Anvil producers exist for tests only.
- **Account creation, recovery and device addition are Base only.** The recovery kit declares `network: 'base'` and `chainId: 8453`, and a kit for another network is rejected. Recovery proofs and device additions are anchored to chain 8453.
- **Payments are Base USDC only.** Payment reviews recognize USDC on Base and the JBMultiTerminal that the verified V6 catalog pins for Base. Reviews carry `chainId: 8453`; a request cannot supply the token or terminal.
- **Execution and recovery state is Signa's own.** Signa does not import Center accounts or credentials and does not serve Center's protocol read routes or MCP.

## Owner state across chains

- **The same address on another network is not the same owner state.** Additional networks (Optimism, Arbitrum and the testnets in `networks.ts`, when `WALLET_NETWORKS_PAYER_KEY` is set) replay the exact Base creation call, which reaches the same CREATE2 address. The account on those chains starts with the owners it was created with.
- **Recovery and device addition change owners on Base only.** Nothing in Signa applies a Base owner rotation or added device to another chain. After a lost-passkey recovery, the old passkey signer can remain an owner of the account on every network where the account was deployed. Treat a network's owner set as unknown until it is read from that chain.
- **A kit restores the Base account.** The kit holds the recovery phrase and identity, not the Safe address's state on other chains. Keep the original Safe address with it.

## Approval page

- **The passkey signature is the approval.** The page at `signa.center` shows the review of one Base USDC payment and asks for a passkey assertion with user verification required. The page recomputes the signing digest from the returned operation and refuses a passkey challenge that differs from it.
- **A review is a fixed operation.** It binds the plan commitment, the operation commitment and hash, the Safe and the app origin and callback. A review is `pending`, `approved` or `cancelled` and has an expiry.
- **The page runs inside app frames and popups.** Only origins in `WALLET_FRAMEABLE_APP_ORIGINS` may frame it. Assertions and CSRF values stay in page memory and are not stored.

## Gas sponsorship

- **Pimlico is the paymaster for now.** Wallet user operations use the ERC-4337 paymaster and bundler configured in `REST_ERC4337_CONFIG` under a hosted Pimlico sponsorship policy. Signa signs no paymaster data itself.
- **Signa has no per-account spending cap yet.** The only Signa-side bound is a record limit per account. Per-account daily caps on sponsored gas are planned. Until they exist, the sponsor policy configured at Pimlico is the cap on what one account can spend.
- **Own sponsor lanes are deferred.** `REST_ERC4337_SPONSOR_ROUTES` can select separately budgeted policies by server-issued voucher, but Signa runs no paymaster of its own. That waits for the move off Railway to GCP and KMS.
- A sponsored operation signed once can stay executable until its paymaster window ends. Signa treats a nonce as held until the chain settles it.

## Server keys

- **Server keys pay gas only.** `WALLET_CREATION_SIGNER_KEY` pays Safe creation, `WALLET_RECOVERY_SIGNER_KEY` pays recovery and device-addition transactions, and `WALLET_NETWORKS_PAYER_KEY` funds additional-network bundles. None of them is an owner of a user's Safe, and none can approve a payment.
- **Keep the lanes separate.** Use a different key for each lane; the sender nonce and spend accounting are per lane. The code does not stop an operator from reusing one key.
- **Keys sit in the hosting environment today.** The Railway service holds them as environment variables. Moving them to KMS is part of the planned move to GCP.
- Bounds: creation checks a reviewed allocation and initial nonce at startup and fences the pool as `allocation-exceeded` if a finalized debit exceeds it; recovery is bounded by `WALLET_RECOVERY_MAX_OPERATIONS` and `WALLET_RECOVERY_MAX_COST_WEI`.

## Priority risks

- **Gateway custody is pending until its outcome is proved.** `JBRouterTerminalGateway_QueuePendingCall` records retained input. A successful retry transaction can record another failure and leave custody pending. Establish settlement from `JBRouterTerminalGateway_ProcessPendingCall`, or an accounted refund from `JBRouterTerminalGateway_RefundPendingCall`, with the correct emitter, ID and arguments. `pendingCallCount` counts issued IDs; a zero commitment does not distinguish settlement, refund and an ID that never existed. Refunded fees do not restore core `feeFreeSurplusOf`.
- **Receipt outcomes depend on the deployed generation.** Recognize buyback sell failures from every recorded current and retired hook; an outer cash-out receipt can succeed while project tokens are returned. A routed payment's terminal event names the immediate forwarding contract as payer, so bind its emitter, caller, project and beneficiary to the reviewed route. Arbitrary emitters cannot establish settlement.
- **Previews depend on the selected implementation and observed state.** Buyback 1.4.0 pay metadata contains `(amountToSwapWith, minimumSwapAmountOut, skipSplits)` under the resolved hook's metadata ID. Pool availability, rulesets and hook configuration can change before execution. Preserve the actual outer terminal for approvals and payment bytes.
- **Unavailable observations remain unknown.** RPC failures, missing deployments, failed previews and unavailable indexer state cannot establish zero balances, permission, settlement or a usable route. A signed operation with an unreadable sponsor window holds its wallet to its nonce until settlement evidence exists. Preserve chain, version, project, token, currency, decimals and integer strings; verify current financial state at a canonical block hash.
- **Reverted and submitted operations stay live.** A reverted EntryPoint `handleOps` rolls back nonce increments, but the signed bytes remain executable until their deadline. Signa releases a nonce only on settlement evidence.
- **Existing authorization boundaries remain necessary.** Reviewed operations are immutable; execution progress is tracked separately. API read, plan and relay grants are separate from onchain authority. Fund movement requires a fresh passkey approval or an explicitly installed session within its limits.
- **Source references have explicit trust assumptions.** Protocol sources keep their reviewed revisions and hashes. Package versions and ABI decoding alone do not prove deployed bytecode. The wallet client for apps is `@me.jango/signa`; its sign-in code and Signa's page must agree on the protocol strings.

## Invariants to Verify

- No path outside the hosted Base hosts creates, recovers or adds a device to a production account.
- A payment review's token, terminal, chain and Safe come from host configuration and the verified catalog, never from a request.
- The passkey challenge equals the digest recomputed from the reviewed operation.
- A server key never signs on behalf of a Safe owner and never shares a lane with another key.
- Pending custody, retry failure, settlement and refund remain distinct outcomes backed by canonical event evidence.
- Payment metadata, output floors, recipients, calldata and value match the exact reviewed operation; unsupported settlement formats fail closed.
- Every privileged request retains its authorization, replay, expiry and scope checks; read capabilities do not confer wallet authority.
- A failed read never becomes success, zero or permission.

Run `npm run check` for the release gate.
