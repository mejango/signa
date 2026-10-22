# Wallet signup

Signa composes passkey enrollment, deployment, canonical setup and fresh sign-in
into one resumable browser journey at `/wallet/create`, with recovery at
`/wallet/recover`. Production runs the hosted Base path only; creation and recovery
mount when their `WALLET_CREATION_*` and `WALLET_RECOVERY_*` settings are present.
See [RISKS.md](RISKS.md) for the production boundary and the
[handoff](docs/rest/CENTER-WALLET-HANDOFF.md) for the build history.

The browser lets the user name a discoverable P-256 passkey. First-time users can
create a recovery kit without connecting an existing wallet. The browser generates
a 256-bit BIP39 phrase and derives its independent EOA at `m/44'/60'/0'/0/0`, with
no additional BIP39 passphrase. Users with a wallet can select the existing-wallet
option. The independent EOA separately signs the exact enrollment. The threshold-one Safe
starts with two full owners: the passkey signer and that EOA. Added devices become
further full owners. Neither an email address nor
a browser API key substitutes for either owner.

The kit contains the words, recovery-owner address, original Safe address,
initializer hash, explicit derivation path, `network: "base"` and `chainId: 8453`.
The Safe cannot be reconstructed from these words alone; preserving its address
is necessary. Before deployment review, the kit path requires downloading and
reopening the saved file against that exact wallet. A kit from another wallet is
rejected. Reloading requires restoring the kit or words; the phrase is never
stored in localStorage, sessionStorage, a cookie, URL or server request. The only
durable secret export is the user's explicit download. Anyone who has that file
can control the wallet. Browser JavaScript cannot guarantee deterministic secret
erasure; DOM text and references are cleared after verification and on pagehide.
A kit for any other network is rejected.

## Sequence and recovery

1. The server selects the RP, origin and pinned creation manifest. An enrollment
   and hashed continuation token commit together. Registration expires in five
   minutes by default; the continuation lasts thirty minutes.
2. Native registration creates an unverified candidate. A fresh possession proof
   and the EOA's typed enrollment signature verify that exact candidate and Safe.
3. A separate passkey approval claims the exact deployment. The existing worker
   preserves signed bytes, sender nonce, accounting reservation and settlement
   evidence across retries. Polling never creates a replacement transaction.
4. Once the latest canonical observation proves creation and wallet readiness,
   the account is bound from the consent the passkey already gave at enrollment,
   with no further prompt and no browser grant. Treasury settlement can finalize
   later; its sender lane remains held meanwhile.
5. The session comes from the deployment approval's passkey assertion, which the
   server holds for at most 15 minutes in one process. After that, a resumed
   signup or a restart, the user gets the ordinary sign-in prompt. Enrollment and
   signup continuation never act as login credentials.

The browser retries the same pending completion after an uncertain response.
Reloading reads durable state. Losing the signup cookie requires a fresh
`signup-resume` assertion: the opaque user handle locates the enrollment but the
matching P-256 signature authorizes rotation of its continuation token. Exact
retries return the original rotation; an older rotation cannot supersede a newer
one. Verified enrollment can resume after its original deadline. Expired,
unverified enrollment cannot be renewed; the explicit restart action only clears
that expired continuation and requires a new registration.

Signup continuation remains separate from lost-passkey replacement. The internal
recovery proof store now records a purpose-bound new-key proof and independent
owner signature tied to the original Safe, enrollment, current credential and
binding. Intake is bounded, continuation secrets are hashed, accepted records are
immutable, and concurrent/lost-response retries return the original receipt.
The recovery host composes this store behind dedicated HTTP boundaries.
After an actual owner rotation, the account is bound under the
replacement passkey from the recovery's own proof, with no further prompt and no
browser grant. The internal activation store then calls the
configured canonical observer. It atomically supersedes the previous credential,
inserts immutable replacement lineage, revokes old bot/app grants, and advances
authority and session epochs. Canonical readiness must refresh before a fresh login. Exact retries read the original result;
expiry during SQL rolls all mapping, grant and epoch changes back. Genesis remains unchanged.

The canonical observer rechecks the replacement account's original block anchor on
every observation. A chain rollback makes the account unready and cannot undo
credential supersession or revive previous sessions. Payment approval retains its
existing proof format; the authority identity commits replacement lineage, and
fresh approval must verify under the replacement key.

The recovery page imports a saved kit in browser memory or connects the
original recovery wallet for typed-data signing. It creates a named replacement
passkey, proves both owners, and presents the exact signer-creation and owner-swap
calls. A relayer submits two transactions after the backup owner signs the exact
Safe transaction. No non-creation delegatecall exception is added. The relayer
cannot share a signup treasury sender. It stores the review, approval, both signed
transaction bytes and nonce/maximum-cost reservations before any network send. Each
worker pass sends at most one transaction; a marked attempt is never resent
automatically. Lost replies reconcile the original hashes. Reservations never
recycle. Recovery changes the owners on Base only; see "Owner state across chains"
in [RISKS.md](RISKS.md).

The initial proof deadline only limits proof intake. An accepted proof can later
be followed by separate Safe transaction approval and fresh canonical evidence.
The standard Safe transaction signature has no onchain expiry: browser cancellation
cannot invalidate an already signed transaction or release its retained liabilities.

Cookie loss resumes the original recovery reference using a fresh replacement-key
assertion and independent recovery-owner signature. Only the hash of the browser
continuation is stored. Atomic token rotation fences the old cookie, and stale
resume receipts cannot restore an older continuation. The original proof record
stays immutable. Credential activation precedes a fresh login; resuming never
issues spending authority or a session.

An expired attempt without an accepted proof has an explicit Start again action.
The server checks expiry using database time while holding the recovery and flow
locks, refuses accepted proofs and stale continuations, and clears only the browser
cookie. All recovery records remain intact. A lost reset reply can be retried;
resetting never starts a new recovery automatically.

## Composition and observation

`createRestRuntime.walletSignup` accepts an explicit host-side factory after
the smart-account service is constructed. It receives the shared pool, configured
RPC, wallet runtime and smart-account service. The host must supply a qualified
signer, deployment transport, settlement observer and initialized allocation to
`createLocalWalletSignup`. No request field constructs treasury authority.

Production uses the hosted Base host (`src/rest/wallet/baseHost.ts`); the unforked
Anvil producers exist for tests only. The Base host uses `deploymentBase.ts`: one Dwellir
endpoint with no public fallback, chain identity plus the pinned L1Block and
GasPriceOracle implementation runtimes checked on every observation, a reservation
of execution plus twice the current L1 and operator estimate priced from the head
block's Jovian attributes deposit, one exact send, and complete Fjord/Jovian receipt
fees at the finalized inclusion. An actual finalized debit above the allocation is
retained and fences the pool as `allocation-exceeded`. `src/index.ts` mounts it only
when every `WALLET_CREATION_*` setting is present (`WALLET_ORIGIN` defaults to `https://signa.center`); the first
start configures the single pool and initializes accounting with the explicit
`WALLET_CREATION_INITIAL_NONCE`, refusing a provider nonce that differs.

The runtime mounts signup only when that factory is provided, and starts/stops its
worker with maintenance. Normal startup and external-wallet access remain
available. Public wallet discovery preserves the installed SDK's exact schema.

`createRestRuntime.walletRecovery` is the corresponding explicit host factory for
recovery. It mounts the page only when supplied and starts/stops its bounded worker
with maintenance. The shared relay (`src/rest/wallet/recoveryRelay.ts`) takes the
same chain adapter as creation; the Base wrapper (`recoveryBase.ts`) quotes fees from the head block, reserves execution plus twice the L1/operator
estimate per transaction, records complete receipt fees as a monotonic actual spend
(fencing the lane as `allocation-exceeded` above its budget) and releases the lane
only after both receipts are finalized. Setup and fresh login proceed once both
receipts are canonical. `index.ts` mounts it, and device addition on the same relay,
from `WALLET_RECOVERY_SIGNER_KEY`, `WALLET_RECOVERY_MAX_OPERATIONS` and
`WALLET_RECOVERY_MAX_COST_WEI`; operators must keep the relay key different from the
creation treasury. Production startup never constructs either signer
from an environment flag or request field. Recovery has distinct HttpOnly cookies,
cookie-bound CSRF, exact Host/Origin checks and no trusted-app CORS access.

Signup uses distinct `__Host-` HttpOnly, Secure, SameSite cookies. Central POSTs
require exact Host/Origin, the wallet request header and cookie-bound CSRF for
existing flows. Bodies, credentials, row admission, cleanup and worker passes are
bounded. Trusted-app CORS does not confer central cookie access. Public responses
contain explicit journey views, never storage rows or signed treasury bytes.

The worker's optional event hook reports stage, outcome, operation ID and elapsed
time. Observation errors cannot undo authority. Do not log assertions, cookie
tokens, browser private keys or raw request bodies.

## Evidence

Run `npm run check` with Node 22.23.4, PostgreSQL 16 via `TEST_DATABASE_URL`, the
pinned browser installation, and Foundry available. The required catalog includes
the signup PostgreSQL, HTTP-boundary and joined EVM/browser suites.

The joined suite uses four distinct users, real HTTP handlers, PostgreSQL,
unforked Anvil, a virtual browser authenticator and an independent test EOA. It
checks prompt cancellation, lost registration/setup responses, cookie loss,
continuation rotation, unchanged wallet identity, canonical deployment/setup,
fresh login, an existing recovery wallet, a generated recovery kit, wrong-kit
rejection, kit restoration after reload, absence of the phrase from storage and
requests, and a 320px viewport. Sanitized results and screenshots are written
to `.generated/wallet-observations/signup-browser/` and `signup-browser-kit/`; release evidence is written
to `.generated/checks/<run-id>/summary.json` with a source fingerprint.

The joined EVM suite also performs a real backup-owner Safe rotation, replacement
setup, atomic credential activation, fresh new-key login, old-key/session/resume
rejection and an actual Anvil rollback. Sanitized evidence is written to
`.generated/wallet-observations/recovery-evm/summary.json`. Those actions use only
public fixture keys and synthetic local balances, not the production relay or fee provider.

The kit browser journey now removes the original virtual passkey and exercises real
HTTP, PostgreSQL and Anvil recovery. It covers prompt cancellation, wrong-kit
rejection, lost registration/approval/setup responses, cookie loss after onchain
rotation, resumed setup, old-session rejection and fresh new-key login at the same
address. Screenshots and sanitized results are in
`.generated/wallet-observations/recovery-browser/`; phrases are absent from requests,
browser storage and observation artifacts. The separate EVM helper also injects a
lost accepted RPC response and verifies exactly two physical sends and retained
dispatch history after rollback.

`npm run wallet:client-pilot` separately connects the actual built Homerun and Beep
clients to real Center handlers, PostgreSQL and a freshly deployed Anvil wallet.
It requires the explicit local client paths/origin documented in
`acceptance/shared-wallet/README.md`. Its report distinguishes shared sign-in and
signed account authorization from project quote and payment evidence. Production
TLS, funding and fee qualification remain outside this local route bridge.

Local test-chain success does not establish production fee qualification, funding
controls, database restore evidence, real-device behavior or a joined client payment
against the live service.
