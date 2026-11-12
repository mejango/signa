# Wallet-owned accounts and signed REST requests

Signa's API lets software request data or actions through web requests (REST).
To use protected routes, select **Sign in** on [Accounts](/accounts) and connect
an existing wallet. Your wallet signs the request that creates or loads your
account. The network used to identify that account is its **authority chain**.
The account identifier is
`eip155:<authorityChainId>:<lowercaseOwnerAddress>`.

Owners can let a bot sign API requests using its own locally generated
secp256k1 key. The permissions form a **grant**; each permission is a **scope**.
The private key stays with the client. Signa stores the public address, fixed
grant ID, scopes, label, expiry, and revocation time. This scheme uses request
signatures, with no API key, bearer token, or server-held wallet key. See the
[glossary](https://api.signa.center/api#glossary).

Public discovery does not require a bot grant. Owner enrollment is an independently
signed request and works before an account or bot exists. A bot cannot enroll an
account on behalf of an unrelated owner.

## Start with the client

Sign in on [Accounts](https://api.signa.center/accounts), then create a connection
under **02 / API access**. Choose its permissions and expiry and approve the
locally generated bot key. The bot then authenticates API requests automatically
through `SignedRestClient`; routine reads and planning need no owner wallet prompt.
See [the setup walkthrough](./QUICKSTART.md#create-your-connection).

```ts
import { SignedRestClient } from "@juicebox/center-client";

// botSigner is the registered key held in your local signer or secret store.
// accountId and grantId are the public identifiers returned at registration.
const center = new SignedRestClient({
  audience: "https://api.signa.center",
  accountId,
  grantId,
  signer: botSigner,
});
const account = await center.request({ requestTarget: "/api/v1/accounts/me" });
```

The client creates the signature, nonce and expiry, and sends the exact signed
request bytes. Use the wire reference below when implementing another client.
The owner address identifies whose account is being accessed; the signer is the
owner or the registered bot acting for that account.

## API access and wallet actions

| Layer | What you approve | What happens afterward |
| --- | --- | --- |
| API access | A bot key, scopes and expiry | The client signs requests using that key. Revoke its grant to end access. |
| One wallet action | Exact calls, amounts and execution deadline | The wallet signs the returned transaction or approval document. |
| Recurring wallet actions | A separate supported session with actions, budgets and expiry | The delegated key can authorize only what the verified wallet policy allows. |

API `read`, `plan` and `relay` scopes do not grant wallet spending authority.
Use [owner-approved transactions](./CLIENT.md#prepare-review-approve-submit)
for individual actions and [wallet sessions](./SESSIONS.md) for optional recurring
execution. Direct and prepaid bot submissions require fresh owner dispatch
approval; supported Safe execution uses its time-limited `SafeOp` approval.

## Request signatures

Every protected request signs structured fields using the EIP-712 standard and
Signa's `CenterRequest` format. A single-use random value (**nonce**) prevents
replay. An **idempotency key** identifies retries of the same operation. The exact schema
and browser-compatible helpers live in
[`src/rest/auth/signatures.ts`](../../src/rest/auth/signatures.ts).

| Header | Meaning |
| --- | --- |
| `X-Juicebox-Account` | Wallet-owned account identifier |
| `X-Juicebox-Signer` | Owner wallet or bot public address |
| `X-Juicebox-Grant` | Bot grant UUID; omit for the owner |
| `X-Juicebox-Issued-At` | Integer Unix seconds |
| `X-Juicebox-Expires-At` | Integer Unix seconds, after issuance and within 300 seconds |
| `X-Juicebox-Nonce` | `0x` followed by 64 lowercase hex digits from 32 random bytes |
| `X-Juicebox-Signature` | EIP-712 signature |
| `Idempotency-Key` | Optional operation retry identifier; covered by the signature |

The EIP-712 domain is `{ name: "Juicebox Center REST", version: "1",
chainId: authorityChainId, salt: keccak256(utf8(audience)) }`. The audience is the
configured public service URL, without a trailing slash; production uses
`https://api.signa.center`. It is not inferred from an untrusted Host header.

The signed message contains, in schema order:

```text
audience: string
accountId: string
signer: address
grantId: string
method: string
requestTarget: string
contentType: string
bodyHash: bytes32
issuedAt: uint64
expiresAt: uint64
nonce: bytes32
idempotencyKey: string
```

Use an empty string for an absent grant, content type, or idempotency key. Sign the
uppercase HTTP method, exact path plus raw query including `/api/v1`, and the exact
`Content-Type` value sent. `bodyHash` is Keccak-256 of the transmitted body bytes,
including the empty byte array for a bodyless request. JSON whitespace and query
parameter order are significant. Do not sort or reserialize a request after
signing it. Compressed request bodies are rejected.

The HTTP integration must supply the original Node `IncomingMessage.url` to
`readSignedRequest` or the account-router request-target resolver. Using only a
parsed URL can erase distinctions such as dot segments before verification.

The service verifies the signature, then atomically rechecks the account or grant
and consumes the nonce while holding the account lock. A nonce is single-use for
the entire account. A 30-second future clock allowance is permitted; expired
requests and validity windows exceeding five minutes fail. Waiting for an account
lock cannot extend a request or grant's validity.

PostgreSQL uses its own `clock_timestamp()` for acceptance, grant expiry, and nonce
cleanup across all service instances. It rechecks validity after nonce insertion
before committing, so asynchronous storage work cannot admit an expired replay
after cleanup removes the original nonce. A node's preliminary clock check may
reject a request, but cannot override the shared database's authorization time.

Retries use a **new nonce and signature**. Reuse the same signed idempotency key
where the operation supports idempotency. Authentication itself does not cache
responses or make account mutations idempotent. A signature accepted by the
server can consume its nonce even if the subsequent operation fails. Never repeat
a financial operation merely because its HTTP response was lost.

## Enrollment and profile routes

The account router mounts under `/api/v1`. Profile fields remain available to
API clients: a display name, biography, and optional avatar URI. These fields
do not establish identity or grant permissions.

| Method and path | Authority | Input / response |
| --- | --- | --- |
| `POST /api/v1/accounts/enroll` | Owner signature; no previous account required | Empty JSON object; returns `{ account }` |
| `GET /api/v1/accounts/me` | Owner or bot with `read` | Returns `{ account }` |
| `PATCH /api/v1/accounts/me` | Owner | Replaces profile `{ displayName, bio, avatarUri }`; returns `{ account }` |
| `GET /api/v1/accounts/me/bots` | Owner | Returns `{ bots }` |
| `POST /api/v1/accounts/me/bots` | Owner plus bot possession proof | Returns `{ bot }` with its new UUID |
| `DELETE /api/v1/accounts/me/bots/:grantId` | Owner | Revokes that exact grant; returns `{ bot }` |

Reenrollment with a fresh owner-signed request returns the existing account without
resetting its profile or bots. The authority chain and owner cannot be edited
through profile routes. Contract-wallet owners require a configured EIP-1271
verifier on the account's authority chain; unavailable or failing verification
never authorizes a request. Verification has a five-second deadline and passes an
abort signal to the verifier's RPC adapter. Bot keys must prove EOA signature possession.

Profile names and bot labels allow 120 UTF-8 bytes, biographies 2,000 bytes, and
avatar URIs 2,048 bytes. Avatar URIs use HTTPS or IPFS and are never fetched by the
authentication service. The route body limit is 64 KiB, with a 15-second read
deadline.

## Register a bot

1. Generate a new secp256k1 keypair on the client with a cryptographically secure
   generator. Keep the private key in the client's secret storage.
2. Choose a label, expiry, and scopes. An omitted scope list means `["read"]`.
   Generate the nonce that the owner's registration HTTP request will use.
3. Sign `buildBotProofTypedData(audience, proof)` with the bot's key. The proof
   contains `accountId`, `botAddress`, the ordered scope list, expiry, label, and
   `ownerRequestNonce` under the distinct `CenterBotProof` type.
4. Include that `proofSignature` in the JSON registration body. The owner signs
   the HTTP request including the hash of this entire body, using the same nonce
   as `ownerRequestNonce`.
5. Store the returned grant UUID alongside the bot's local key. Include it in
   `X-Juicebox-Grant` on subsequent requests signed by the bot.

Registration input:

```json
{
  "botAddress": "0x...",
  "scopes": ["read", "plan", "relay"],
  "expiresAt": 1900003600,
  "label": "My local agent",
  "proofSignature": "0x..."
}
```

The addresses, timestamp, and signature above are illustrative placeholders.
The expiry must be in the future and no more than one year away. Scopes must use
one of three cumulative profiles in canonical order: `["read"]`,
`["read", "plan"]`, or `["read", "plan", "relay"]`. Incomplete, repeated, or
reordered scopes are rejected; the server never expands or sorts a signed grant.
The proof must contain the same ordered list. The owner signs every new grant; bots cannot create
grants, escalate scopes, edit owner profiles, or revoke other bots.

| Scope | Permission |
| --- | --- |
| `read` | Protected reads |
| `plan` | Preparing reviewable unsigned transaction plans |
| `relay` | Relaying separately signed wallet transactions through allowed routes |

Planning requires `read` so the bot can retrieve and review its saved plans;
relaying also requires `plan`. Plans belong to the exact bot grant that created
them. A different grant, including a replacement using the same bot address,
cannot take over their submission. The account owner can read all plans belonging
to the account. Grant renewal does not transfer an old grant's plans.

None of these API permissions grants
Juicebox operator permissions, token allowances, access to an owner private key,
or authority to sign an onchain transaction. A prepared plan contains no signature.
The wallet signs its own transaction; the relay submits only those signed bytes.

## Fresh owner approval for transaction dispatch

An Ethereum transaction signature contains no signing timestamp. Possessing signed
transaction bytes does not prove that the wallet owner recently approved their
submission. Every mutation that could move funds therefore requires fresh owner
approval before dispatch, even when a bot has the `relay` scope. There is no
standing spending-budget exception in this API.

A newly verified **owner-signed HTTP request** already provides fresh approval for
the exact request body. A bot-signed submission requires an additional
`ownerApproval` object signed by the account's wallet owner. The owner signs
`buildTransactionApprovalTypedData(audience, claims)` from
[`src/rest/approvals.ts`](../../src/rest/approvals.ts). The private key remains in
the owner's wallet. Bot keys and API scopes cannot sign on the owner's behalf.

The EIP-712 primary type is `CenterTransactionApproval`, distinct from request
authentication and bot-registration proofs. It uses the same REST domain name,
version, configured audience salt, and account authority chain. Its message is:

```text
audience: string
accountId: string
principalId: string
planId: string
commitment: bytes32
stepIndex: uint32
transactionHash: bytes32
issuedAt: uint64
expiresAt: uint64
nonce: bytes32
```

The submission's `ownerApproval` JSON contains all those fields except `audience`
(supplied by the configured service origin), plus `signature`. Times use integer
Unix seconds. `transactionHash` is Keccak-256 of the exact serialized signed
transaction bytes. The plan commitment comes from the saved immutable plan;
`principalId` identifies its exact originating grant. Generate a fresh random
32-byte nonce for each new approval. Review the plan and transaction before asking
the owner to sign.

An approval lasts at most five minutes; a 30-second future-clock allowance matches
request authentication. The server derives the owner and authority chain from
the expected account identifier, then checks its EOA or configured EIP-1271
signature. Verification is bounded to five seconds and rechecks expiry after
awaited work. Durable dispatch admission rechecks the verified approval window
using the database clock while holding the transaction's authorization lock.
An approval that expires during preparation or a lock wait cannot authorize a new
dispatch. A previously admitted dispatch can already be in flight.

An approval is bound to one account, grant, plan, commitment, step, and transaction
hash. Reusing its nonce or signature with another effect fails. The same exact
approval can be checked again during its validity window: permanent transaction
hash and wallet-nonce reservations prevent an additional distinct effect. This
is why approval nonces do not require a separate replay table. A lease retry that
actually dispatches again still needs a valid approval at its new admission.

Reading receipts, reconciling a known transaction, and returning an idempotent
result without dispatch do not require a new owner approval. A lost HTTP response
does not justify signing a different financial transaction; reconcile the
original hash first.

Sponsored publication uses a separate `CenterSponsorshipApproval` type. Its message
contains `audience`, `accountId`, `principalId`, `sponsorshipId`, `commitment`,
`submissionHash`, `issuedAt`, `expiresAt`, and `nonce`, in that order. The two hashes
and nonce are `bytes32`; timestamps are `uint64`; other fields are strings. Use
`buildSponsorshipApprovalTypedData(audience, claims)` and attach its resulting
signature to the same claims as `ownerApproval` alongside the ordered forwarding
`signatures` in the publication body. A transaction approval cannot authorize
sponsored publication, and a sponsorship approval cannot authorize direct relay.

Existing preparation responses provide the necessary approval inputs:

| Approval field | Direct transaction | Sponsored publication |
| --- | --- | --- |
| `accountId` | Originating client's account identifier | Same |
| `principalId` | `bot:<originatingGrantId>` | Same |
| Preparation identifier | `planId: plan.id` | `sponsorshipId: preparation.id` |
| `commitment` | `plan.commitment` | `preparation.commitment` |
| Exact effect | `stepIndex` and `transactionHash: keccak256(rawSignedTransaction)` | `submissionHash: sponsorshipSubmissionHash(preparation.commitment, signatures)` |
| Freshness | New `issuedAt`, `expiresAt`, and random `nonce` | Same |

The browser-safe `sponsorshipSubmissionHash` helper uses the server's SHA-256
canonical JSON identity for the commitment and ordered, lowercase forwarding
signatures. It preserves their order and rejects malformed signatures. This
submission hash differs from an Ethereum transaction hash.

The production dispatch authorizers in
[`src/rest/dispatchAuthority.ts`](../../src/rest/dispatchAuthority.ts) read the
authenticated request from async-local context. They require the exact account
and originating principal, preventing another request or grant from supplying
authority. For an owner shortcut, they also check the exact signed POST path and
body: the selected step's raw transaction hash, or the sponsorship's ordered
signature hash. A signed GET, profile update, different step, or duplicate bundle
step cannot serve as a dispatch approval. The original owner HTTP signature is
verified again before returning its fresh window to durable admission.

For direct bundles, each bot submission carries its own `ownerApproval` for its
step. The owner can instead sign the exact bundle HTTP request. Approval objects
are authorization metadata inside the signed HTTP body: changing an approval
changes the request's exact idempotency identity. Keep the permanent transaction
hash unchanged when reconciling or renewing consent to its dispatch.

## Revocation and concurrent work

Revocation changes durable authorization immediately at its database commit.
Grant IDs and permissions are immutable: renewing or changing permissions creates
a new grant. Requests using an expired or revoked generation fail even when the
same public address has another valid generation.

Authentication, nonce acceptance, and revocation use the same account row lock.
Durable relay admission must also check the original actor under this lock in the
same transaction that claims the job. The exported
`assertRestActorActive(client, actor, scopes, now)` supports that integration.
The lock order is **account, then plan/job, then wallet nonce**. Do not hold the
database lock while making an RPC request.

A revocation committed before job admission prevents the claim. A job already
claimed under that lock is in flight and may submit afterward; revocation cannot
undo a transaction already sent to a chain. A standalone `assertActive` check
followed by a later unlocked claim is insufficient for this guarantee.

The default bounds are 100,000 accounts, 100 retained bot-grant records per account,
and 1,000 unexpired request nonces per account. Retained revoked grants count
toward the grant bound so an old identifier is never silently revived. Limits
return explicit errors. The nonce bound reserves 32 slots for verified owner
requests: bots cannot exhaust those slots and prevent an owner from revoking a
grant. Merely omitting the grant header does not establish owner authority.
Expired nonces are removed during bounded per-account
cleanup; `cleanupExpiredNonces` supports indexed background cleanup in batches of
at most 10,000. Active request validity is checked before expired nonce records
can be reused.

## Agent clients

Clients need a signer that calculates a fresh signature for every protected HTTP
request. Static headers or a pasted bearer token cannot implement this protocol.
A local signing adapter can keep the key outside an agent conversation while
forwarding its requests. Ordinary MCP URL configuration does not automatically
add this REST signing behavior.
