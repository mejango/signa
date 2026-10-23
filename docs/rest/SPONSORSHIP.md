# Prepaid transactions

Center lets you or a sponsor prepay the network cost of wallet-approved calls. Center prepares the exact calls, the owner signs them, and Center publishes them using wallet-approved forwarding. A wallet separately pays for the group of calls (**bundle**). Center never holds a signing key, pays for a bundle, or gives a bot permission to spend from a wallet. See the [glossary](https://juicebox.center/api#glossary).

Check `capabilities.sponsorship` for availability. Prepaid execution supports Ethereum (`1`), Optimism (`10`), Base (`8453`), and Arbitrum (`42161`) mainnets when the host enables them and verifies their deployed contracts. Testnets, ERC-4337 paymasters, Safe module execution, and reusable session keys are not supported by this adapter. Capability configuration is not a claim that a provider is currently healthy or a particular target is eligible.

## User journey

1. Prepare an immutable V6 transaction plan through the protocol or contract API. Read its calls, amounts, dependencies, warnings, and onchain evidence.
2. Create a sponsorship preparation with that plan ID and the indexes of an independently executable wave. Each selected target must trust the catalog's verified V6 forwarder. Multiple calls on the same chain execute in plan order. Center’s existing 32-step plan capacity and request-size bounds apply; these are not provider transaction limits. Complete prerequisite steps first.
3. Review and sign each returned EIP-712 `ForwardRequest` using the owner wallet. Each signature binds the chain, canonical forwarder, exact sender, target, calldata, native value, forwarding gas, live forwarding nonce, and explicit execution deadline. A registered bot key cannot replace this signature.
4. Approve publication through Center's fresh owner approval and submit the exact ordered signatures with an idempotency key. Center rechecks the signature, runtime, target trust, current nonce, simulation, API grant, and fresh approval before reserving publication.
5. Inspect the stored quote and request a funding plan for one payment chain. Review its exact bundle identifier, payment contract, calldata, native value, and deadline. Sign and submit that funding transaction through the ordinary transaction API.
6. Refresh both sponsorship and source plan. Execution status is a transaction-discovery hint. Center independently verifies the canonical destination transaction, receipt, forwarding execution, confirmations, and operation-specific outcome before reporting completion or unlocking dependencies.
7. Prepare the next dependent wave only after the original journey records the required confirmed outcome. A bundle is not atomic across chains; one destination can succeed while another remains pending or fails.

An ERC-20 approval usually targets a token that does not trust the V6 forwarder. Such a step needs a separate direct wallet transaction and confirmation before the sponsored wave. A prerequisite cannot be smuggled into the same wave and assumed successful because Center accepted the bundle.

## HTTP interface

All paths below are relative to the configured REST API root. The normal signed-request authentication, scope, request-size, rate-limit, and idempotency rules apply.

| Request                                                                  | Purpose                                                                                                                                                     |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /sponsorships` with `{planId, stepIndexes?}`                       | Prepare immutable owner signing documents. Requires the source plan's principal and an idempotency key.                                                     |
| `GET /sponsorships/:id`                                                  | Read the stored preparation and quote.                                                                                                                      |
| `GET /sponsorships/:id?refresh=true`                                     | Fetch bounded provider status and verify destination execution independently.                                                                               |
| `POST /sponsorships/:id/submissions` with `{signatures, ownerApproval?}` | Publish exact externally signed requests once, with an idempotency key and fresh owner authorization.                                                       |
| `POST /sponsorships/:id/funding-plans` with `{chainId, payer}`           | Prepare an ordinary immutable transaction plan for the authenticated account's payer wallet. Funding still requires wallet signing and relay authorization. |

The HTTP adapter restricts `payer` to its authenticated account owner. The transport-independent `prepareFunding` method can also return an unsigned draft addressed to a different payer. That draft must be transferred to the sponsor for independent review and admitted under the sponsor's own account; the original user's bot credentials never authorize the sponsor's wallet. The pinned payment runtime does not inspect payer identity. Its exact call is nevertheless simulated from the named payer before a draft is returned.

Creating the prepaid quote requires a provider `POST`; it discloses usable signed requests. Reading an existing quote uses `GET`. Center therefore does not disguise new quote creation as a read-only action.

## Three different deadlines

| Deadline                              | Effect                                                                                                                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Source plan `publicationExpiresAt`    | Limits when a new authorization may be published. Uses Unix milliseconds.                                                                                                                              |
| Fresh Center owner approval           | Binds the account, principal, sponsorship ID, commitment, submission hash, nonce, audience, and a validity window of at most five minutes. Uses Unix seconds and is rechecked under the dispatch lock. |
| Each signed `ForwardRequest.deadline` | Controls the exact onchain call's validity. Uses Unix seconds and is explicitly reviewed by the owner. The default is 47 hours; the host can shorten it.                                               |

The 47-hour window is a new execution commitment, matching the established Juicebox Money client policy. It does not silently inherit a short source plan lifetime. Once a signature is published, expiry or revocation in Center cannot retract it. The onchain forwarder nonce and signed deadline determine whether the request remains executable.

The quote has its own exact funding deadline. Funding must expire before the earliest forwarding deadline, with a minimum remaining-time margin. Center checks quote affordability and timing before exposing eligible payment data, and repeats runtime, nonce, target trust, timing, and exact-payer simulation checks while preparing funding. It checks the clock again after the final RPC work so a slow observation cannot produce an already expired funding draft.

A long-lived exact-call signature does not establish when it was signed. The separate fresh publication approval is required in production. Idempotent reads of a previously admitted publication do not request a new approval and never trigger a second provider submission.

## Contract and quote verification

The adapter uses the local V6 deployment catalog to find exactly one executable `ERC2771Forwarder` for the destination chain. It verifies the deployed runtime against compiler-backed catalog evidence, reads the live EIP-712 domain and nonce, and requires `isTrustedForwarder` on the exact planned target. Missing or insufficient runtime provenance fails closed. Address-only catalog entries are not sufficient.

The expected domain is `Juicebox`, version `1`, with the exact chain ID and forwarder address. Preparation records the forwarder and target code hashes at a canonical block. Before publication, Center checks those bindings again, recovers the owner from the exact typed signature, invokes the forwarder's real `verify` function, and simulates the encoded outer `execute` call with its exact value. It never rewrites a signed call to make a quote fit.

The payment contract is independently pinned from the existing local webclient implementation and runtime fixture:

| Binding                    | Value                                                                     |
| -------------------------- | ------------------------------------------------------------------------- |
| Provider origin            | `https://api.relayr.ba5ed.com`                                            |
| Payment address            | `0x1c05f7841379d4393574c0ffa17908ec40ffd97d`                              |
| Payment selector           | `0x103903a7`                                                              |
| Payment runtime Keccak-256 | `0x6006b5acadb4cd60aa5c00cb844c34563e182dff83d4f4ff4fde226f7df16fa6`      |
| Quote currency             | Native token, represented by `0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee` |

Payment calldata must be exactly the selector followed by the ABI-encoded `bytes16` bundle UUID and `uint40` deadline, with canonical padding. The declared deadline must match those bytes. Center rejects unsupported chains, tokens, targets, duplicate payment options, invalid amounts, conflicting IDs, and changes to the exact outer call. Zero-value quotes are valid if all other checks pass. The default maximum quoted native funding amount is one native unit (`10^18` base units); the host can set a stricter limit.

Internally, provider bundle entries retain exact chain, forwarder target, execute calldata, native value, consecutive per-chain `virtual_nonce` values, and unique transaction UUIDs. The provider's creation response supplies a UUID set without establishing its order. Center authenticates each UUID against the exact call echoed by a status read, including its forwarding nonce. Status responses must reproduce that verified binding thereafter. Neither a provider URL nor request headers, credentials, arbitrary redirects, or user-selected RPC endpoints can be supplied through this interface.

The payer simulation uses the pinned payment contract, exact quote calldata and value, and a bounded 150,000 gas allowance. Destination simulation uses the owner's real balance and current state without synthetic balance overrides. Consequently, a destination call that fails this conservative simulation is unavailable even if another account might ultimately supply its native value through the execution service. This adapter does not promise that every wallet with no native balance can prepare every value-bearing call.

## Durable admission and recovery

Migration `006_rest_sponsorship.sql` adds sponsorship records and permanent execution reservations. PostgreSQL holds the same account lock used for grant revocation and direct transaction admission while checking authority and reserving the selected plan steps. A direct transaction and prepaid publication cannot both claim the same step. A separate global forwarding reservation prevents different plans or account identities from publishing competing requests for the same chain, forwarder, sender, and forwarding nonce.

Both reservations and the exact submission binding are durable before any provider `POST`. The original plan is tagged with the external execution binding before publication. If the process crashes before that tag, normal plan recovery discovers the permanent transport reservation. No fake EOA transaction attempt is introduced.

The library's memory stores must share one `MemoryTransportReservations` instance with the transaction store. They preserve the same atomic admission rules for tests and local use. Production uses PostgreSQL. Authorization and preparation expiry are sampled again after lock waits; failure rolls back every newly inserted reservation.

| Stored state         | Meaning                                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `prepared`           | Exact signing documents exist; nothing has been published.                                                                             |
| `submitting`         | Publication is permanently reserved. The provider may have received the requests.                                                      |
| `submission_unknown` | The request or response was ambiguous; a provider bundle may exist.                                                                    |
| `quoted`             | A structurally authenticated bundle identity and immutable transaction binding are stored. Funding eligibility is reported separately. |

A valid bundle identity is stored before funding cost, timing, or runtime checks. Thus a runtime RPC outage, oversized price, or expired funding option can make funding unavailable without discarding an otherwise recoverable provider UUID. If the initial status read fails, refresh or funding preparation can authenticate the stored UUID set later without repeating publication. Only that initial UUID-to-call permutation may change the provisional quote commitment; payment bytes, ordered calls, bundle identity, observation time, and UUID set stay fixed. An authenticated mapping cannot change. Unverified UUID-to-call pairs and funding calldata are omitted from the public quote. Funding preparation repeats the relevant checks rather than trusting a cached runtime flag.

Only new records with an explicit provisional binding marker allow that permutation. Older records without the marker retain their original commitment, even when runtime verification is absent, because a funding draft may already have been reviewed. An older mismatched UUID mapping requires independent reconciliation; it cannot be silently rewritten.

The existing prepaid API does not provide a verified idempotency header or lookup by a client-generated publication key. An uncertain `POST` is therefore never repeated automatically. The same idempotency key and exact signature submission return the stored state; conflicting reuse is rejected. Expiry, disconnects, process restarts, grant revocation, or a missing UUID do not release an ambiguous transport or forwarding-nonce reservation.

Without a validated provider UUID, the adapter cannot independently recover a lost provider bundle. Manual reconciliation is required. Advancing the canonical forwarder nonce makes the next nonce independently usable; this adapter does not automatically create nonce-cancellation transactions or retire ambiguous reservations. A failed outer attempt may be retried by the execution service under the same stored bundle and binding, so failed receipt observations are reconciled again.

## Execution and economic completion

Provider success is never completion evidence. Center obtains the destination transaction and receipt from its configured RPC, verifies the exact stored outer calldata, value, chain, target, transaction position, canonical block, forwarder runtime, and bounded receipt logs. A successful outer receipt must contain exactly one successful `ExecutedForwardRequest` event for the reviewed owner and forwarding nonce.

The source transaction service independently refetches the canonical receipt before persisting the external observation. It runs the same operation-specific semantic verifier used by direct execution, using the original plan account and project identity. Logs are consumed transiently for verification and omitted from durable sponsorship records. Reconciliation rechecks known receipts; a later provider retry hash cannot hide an already canonical successful execution. Reorged evidence cannot unlock dependent calls.

`confirmed` describes sufficiently confirmed exact execution. It does not automatically establish a modeled economic result, destination bridge credit, or cross-chain settlement. The operation-specific verifier must also establish the expected outcome. Unmodeled contract calls remain explicitly unmodeled; they do not acquire economic-completion claims from provider status. Confirmation depth is configurable and is not a claim of irreversible L1 or L2 finality.

The public `availability` field uses these values:

| Value                     | Meaning                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| `available`               | The owner can review and sign a prepared request.                                            |
| `submission_unknown`      | Publication is admitted or uncertain; do not repeat it.                                      |
| `requires_verification`   | A stored bundle has funding options that have not passed every eligibility check.            |
| `funding_quote_available` | An authenticated funding quote exists. This does not mean it remains unpaid.                 |
| `execution_verified`      | Every destination's exact inner execution is confirmed; economic verification is incomplete. |
| `completed`               | Every exact execution and its modeled economic result are verified.                          |

The sponsorship record does not independently prove whether a user already funded a bundle. Inspect the separately tracked funding transaction before paying. Pending destination execution is never a reason to infer that another payment is required.

## Integration and bounds

`src/rest/sponsorship/index.ts` exports `RelayrSponsorshipService`, `PostgresSponsorshipStore`, `MemorySponsorshipStore`, their types, and the supported-chain constants. The service takes a bounded `RestRpc`, verified `ContractCatalog`, sponsorship and transaction stores, optional operation-specific semantic verifier, and host policy. Production injects `authorizeDispatch(record, submissionHash)` to verify fresh owner approval. It returns an issued/expiry window that the durable store validates again immediately before admission.

The transaction service receives an external observer with `kind: "relayr"` and `observePlanStep(plan, index, bindingId, {signal})`, forwarding to the sponsorship service. This keeps exact forwarding proof separate from transaction storage and semantic verification. The service supports `prepare`, `submit`, `get`, `refresh`, and `prepareFunding`; none signs transactions or calls `eth_sendRawTransaction`.

Each network operation has a 60-second overall cancellation signal, a maximum of 896 RPC calls (128 plus 24 for each of the 32 supported calls), individual RPC timeouts up to 10 seconds, and provider timeouts up to 45 seconds. Provider responses are streamed with a 512 KiB byte limit, fatal UTF-8 decoding, and bounded structures; timeout and cancellation work even if an injected provider ignores its signal. The host adds shared and account quotas and bounded database timeouts. Each account can retain at most 1,000 sponsorship records. No signatures or provider credentials appear in returned status views or error details.

The implementation and fixtures are derived from the repository's existing `webclients/juicebox-money/src/lib/relayr.ts`, `webclients/juicescan/src/relayr.js`, their pinned payment-runtime tests, the V6 forwarder deployment, and the canonical contract catalog. Offline tests use public fixture keys and injected RPC/provider transports. Real PostgreSQL tests use disposable schemas and verify race behavior and complete rollback. Tests never publish a prepaid bundle, sign with production keys, fund a quote, or broadcast a transaction.

## Wallet operation gas caps

This is separate from the prepaid adapter above. Wallet user operations are sponsored by the operator's Pimlico paymaster policy in `REST_ERC4337_CONFIG`; Signa decides, before asking Pimlico, whether this account may be sponsored on this chain today.

- `SIGNA_SPONSOR_ACCOUNT_DAILY_WEI_<chainId>` is the most one account may be sponsored on that chain over a rolling 24 hours. It is required for every chain with a Pimlico policy; startup fails without it. `0` never sponsors. `SIGNA_SPONSOR_PAUSED=1` stops asking Pimlico on every chain.
- Prepare reserves the operation's maximum gas cost (`src/rest/sponsorCaps.ts`, table `rest_sponsor_cap_reservations`) under a per-account, per-chain lock, so concurrent preparations never pass the cap together. The reservation becomes the canonical `UserOperationEvent.actualGasCost` once the execution reaches its confirmation depth. It is released when the approval is retired unsent or the operation is proven expired, and lapses when an unsigned review expires. An unknown submission keeps it.
- Over the cap, paused, or refused by Pimlico, an owner operation is prepared without a paymaster for the account to pay, after reading the Safe's native balance. Its single review shows the payer from the signed fields: "Gas: sponsored", "Gas: up to <amount> ETH from your account", or "Needs ETH for gas on <chain>." with no approval offered. Session operations and chains whose gas policy sets `requirePaymaster: true` are refused with `USER_OPERATION_SPONSOR_UNAVAILABLE` instead. App sponsor routes (`REST_ERC4337_SPONSOR_ROUTES`) are the app's to meter and are not capped here.
- A sponsored approval whose submission fails is retired and its reservation released; it is never resubmitted as Safe-paid. A fresh review decides the payer again.

## Sessions and prepaid spending

Prepayment buys execution service for exact calls; it does not establish a reusable wallet spending balance or an expiring bot session. V6 operator permission bitmaps have no expiry. A forwarding deadline also does not expire an ERC-20 allowance or permission installed by the forwarded call.

Week/month sessions and repeated payments from an explicitly isolated prepaid balance require additional reviewed onchain authority. The proposed session executor and separate asset-budget architecture, including scope, asset, chain, expiry, target, approval-bypass, revocation, and caller-semantics enforcement, are specified in [SESSIONS.md](./SESSIONS.md). Those contracts are not deployed by this REST adapter. Until such enforcement exists, every new fund-moving authorization requires fresh owner approval.

## Hosting and provider implementation

Center uses an internal relay adapter; API clients use the sponsorship routes and
returned signing documents without integrating with that provider. The historical
transport identifier `relayr-prepaid-erc2771` remains stable for compatibility.
[Bundle ordering](https://relayr-docs-staging.up.railway.app/docs/concepts/bundle/)
is implemented with `MultiChain` virtual nonces (the exact wire enum in
[Relayr's OpenAPI](https://api.relayr.ba5ed.com/openapi.json)): consecutive values starting at
zero per chain, with equal values on different chains eligible to run together.
Center assigns consecutive wallet forwarding nonces, verifies signed prefixes
with sequential `eth_simulateV1` calls against the deployed forwarder, and publishes
individual calls for independent receipt reconciliation. Failed calls stop later
nonce levels; this does not make cross-chain execution atomic. Explicit plan
prerequisites still require canonical confirmation before preparation.

Same-chain sequences require the configured RPC to support
[`eth_simulateV1`](https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-eth#eth-simulatev1).
Center checks every individual execution result and rechecks the canonical parent
block. Unsupported RPC methods, missing results and any failed call prevent
publication. No account balance, code or nonce overrides are used.
