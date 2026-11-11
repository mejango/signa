# Signed REST access to Juicebox V6

Implementation architecture. The generated OpenAPI specification describes the mounted routes;
capability discovery reports which execution transports and deployment adapters are configured.

Signa owns accounts and wallet execution. [The ownership contract](SIGNA_MIGRATION.md)
defines the split: Center supplies hosted protocol services, and the Juicebox SDK
supplies reusable local protocol code. There is no Center account migration or
compatibility runtime.

## Confirmed scope

- Serve credential ceremonies at `https://signa.center` and account/API operations at
  `https://api.signa.center`, with separate host boundaries.
- Owners manage accounts, profiles, passkeys and revocable app/bot grants. Client keys
  stay with the client; account API requests use exact signed requests.
- Prepare and store reviewed wallet plans, collect owner approval or enforce an
  explicitly installed session, submit exact signed bytes, and reconcile execution.
- Protocol reads, catalogs, indexed project history, intents, publication, IPFS and
  MCP belong to [Center](https://juicebox.center/api), not this server.

## Boundaries

The Signa HTTP adapter owns parsing, authentication, authorization and wallet API
schemas. Its account database owns grants, approvals, nonce reservations and durable
execution state. Authorization and dispatch stay under the same transactional checks;
Center cannot authorize spending on Signa's behalf.

Signa requests unsigned drafts from `POST https://juicebox.center/api/v1/plans`.
The bounded adapter checks returned operation, account, calls and evidence before the
existing transaction service validates ownership and canonical observations. Protocol
operation descriptors are reviewed data, not runtime code or authority. The SDK owns
portable encoding, decoding and protocol outcome checks. Signa uses its configured
RPC for simulation, exact execution proofs and recovery. Neither recovery nor an
existing submission needs a new Center preparation.

Account grants authorize access to Signa. They do not grant Juicebox permissions,
move funds or let a bot sign from its owner's wallet. The actual transaction signer
is committed in each plan and recovered independently from submitted bytes.

## Request authentication

An owner-signed operation registers a public bot key, its exact scopes, expiry, and account.
Registration includes proof that the client possesses the bot key. Revocation is durable and
checked on every request. Bot credentials cannot create or elevate other bot grants.

Request signatures bind the configured service audience, account, signer, HTTP method, exact
request target including query, content type, exact transmitted body digest, issue/expiry times,
nonce, and idempotency identifier. Signing is distinct from transaction signing. Replay prevention
uses shared durable state and atomic authorization checks, including concurrent revocation.

Retries use a fresh request signature and nonce with the same idempotency identifier. A conflicting
body for an existing identifier is rejected. A lost response must not create another journey or
broadcast a different transaction.

## Protocol data and provenance

Fetch protocol catalogs and project information from Center. Onchain observations
carry a canonical block hash; indexed Bendystraw data has its separate freshness
and pagination guarantees. Indexed balances do not establish executable balances.

A Center draft is input to Signa's own review, not permission to execute. Signa
retains exact decimal integers, chain/account/project identity, destinations,
calldata, values and dependencies, and verifies canonical evidence with its own RPC.
Unknown or mismatched evidence fails closed. No caller-provided upstream URL or ABI
can replace the reviewed execution and account manifests.

## Transactions and journeys

Plans commit to sender, chain, destination, calldata, value, dependencies, and expiry. Preparation
and simulation precede signing. Signed submissions must match the reviewed call exactly; gas and
nonce fields receive explicit validation. The server never signs or substitutes transaction bytes.

A wallet transaction signature does not establish when the owner approved sending it. Dispatch
therefore also requires a fresh owner-signed HTTP request or a separate owner approval bound to
the submitting principal, plan, commitment, step, and exact signed transaction hash. The database
rechecks the approval window after acquiring the admission locks. The same rule applies to the
publication of usable signed forwarding requests. Observing an already admitted submission does
not require another wallet approval and cannot silently trigger another dispatch.

Journeys are durable ordered steps, not a promise of atomic execution. Each step has independent
submission, confirmation, and outcome evidence. A reverted or unresolved dependency prevents its
dependents from advancing. State changes require fresh simulation. Partial completion, reorgs,
ambiguous upstream failures, and receipt polling remain explicit and resumable.

Cross-chain receipt confirmation does not establish bridge delivery. Operations requiring a
future project ID, bridge proof, or new wallet signature remain pending until that evidence or
signature is supplied. No automatic rollback or invented placeholder transaction is permitted.

## Sponsorship and delegated accounts

The Relayr adapter prepares and publishes exact owner-signed ERC-2771 requests. Its provider
response is bound to permanent plan-step and forwarding-nonce reservations before payment
calldata is exposed. A separate wallet funds gas. Canonical outer and inner execution evidence
feeds back into the original plan; provider status alone cannot unlock a dependency. An uncertain
provider POST is not repeated. See [sponsorship](SPONSORSHIP.md) for execution deadlines and recovery.

Broader delegation uses a distinct smart-account boundary: owner wallet, verified account on each
chain, scoped bot session, and explicitly allocated spending limits. API access, wallet ownership,
installed onchain authority, and paymaster eligibility are separate checks. The binding registry
verifies the current Safe owner threshold and deployment state; a policy review commits to its
generation, expiry, exact actions, and budget allocations. Neither operation installs a session.

Seven/thirty-day sessions now have a pinned stack, policy compiler, installed-policy verifier,
durable lifecycle store and UserOperation transport. Live recurring execution requires a verified
deployed session guard matching the selected paymaster, configured hosted bundler/paymaster,
provider billing, eligible sponsorship and owner activation. Both checked guard artifacts are
undeployed; legacy profile defaults remain unchanged. Runtime capabilities expose configuration,
and each operation verifies current account and chain evidence. Removing an API grant or
unlinking an account cannot revoke signatures or permissions already accepted by an onchain
module. Contract-enforced revocation is a separate owner action. See [sessions](SESSIONS.md).

## Documentation and verification

Ship a versioned OpenAPI document, searchable human documentation, machine-readable capability
and coverage catalogs, exact signing test vectors, and small TypeScript/CLI examples. Document
source semantics, pagination, limits, idempotency, error codes, timeouts, finality, and recovery.
Unknown reads and unavailable deployments remain explicit errors or unavailable capabilities.

Tests cover request tampering/replay/revocation, account isolation, concurrent idempotency,
schema/deployment coverage, Center response boundaries, exact transaction matching, interrupted
journeys, upstream ambiguity, and restart/reorg recovery. Changes affecting signing, authority,
or financial outcomes receive an independent review before release.

## Primary references

- [OpenAPI specification](https://spec.openapis.org/oas/)
- [HTTP message signature considerations](https://www.rfc-editor.org/rfc/rfc9421.html)
- [HTTP problem details](https://www.rfc-editor.org/rfc/rfc9457.html)
