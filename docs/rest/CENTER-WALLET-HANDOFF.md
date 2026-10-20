# Continue the Center wallet delivery

Snapshot: 2026-09-15 UTC, updated after the hosted Base creation slice. Read this first, then the
[delivery report](CENTER-WALLET-DELIVERY.md). Open deeper references only for the
slice you are implementing. Older documents contain historical plans as well as
completed checkpoints; source and the latest evidence decide current status.

## Objective and authorization

Deliver production passkey signup **for people without an existing wallet**,
same-wallet recovery, and the shared Center connection on **Homerun and Beep**.
Use TDD, review and an observable test loop. Finish the hosted journey rather
than repeating already-passed localhost passkey probes.

- The user explicitly approved **Center remote-main pushes**, as well as Beep
  and Homerun main merges/pushes and the production pilot. Do not ask again for
  that permission. Review and run appropriate release checks before shipping.
- **Do not modify Juicebox Money or Revnet Money.** Center's Para integration is
  retired; passkey accounts and external-wallet support remain. Preserve
  external-wallet support in the pilot clients.
- Use the shared Center origin allowlist. Bind each app request/callback
  cryptographically; do not introduce an extra per-site consent workflow.
- Use **Center's Dwellir APIs** for chain RPC. No public RPC fallback.
- Passkeys first; recovery kit for new users, existing recovery wallet optional.
  WhatsApp is deferred. Fresh exact owner approval is required for spending.
- The user authorized continued reviews with the real **Claude Fable 5.1** CLI.
  Label these model-assisted reviews, not independent audit certification.
- Tell the user when a concrete gas funding request or a working hosted device
  test is ready. Do not request funds before the address, budget and reviewed
  dispatch behavior exist. Do not turn flags on to expose an incomplete route.

## Current state: start here

**Update 2026-09-15 (evening): the production pilot is live and has created its
first wallet.** Center main `c8aff02` is deployed on Railway; `wallet.juicebox.center`
serves signup, the landing page redirects bare visits to `/wallet/create`, and the
root `/` redirects to `/wallet`. The first real signups surfaced four production
faults, all fixed with red-then-green tests against the Base-shaped fixture
([test/fixtures/wallet-base-anvil.ts](../../test/fixtures/wallet-base-anvil.ts)):

1. **Head pairing on a two-second chain.** The approval read the chain twice
   (preflight, then funding) and the claim refused two heads; settlement re-read
   funding at `latest` and required it to equal the observation's head from ~20 s
   earlier. Rule: every multi-read evidence bundle pins its later reads to the first
   read's block by number. Reproduce such races by mining one block from the
   fixture's `faults.after` hook, never with interval mining.
2. **Dwellir plan limits.** `eth_getLogs` windows are capped at 500 blocks
   (error -32005). The disposable wallet inspector proved creation by scanning the
   factory from genesis, which can never finish. It now receives the ProxyCreation log
   verified in the treasury receipt (CREATE2 cannot reuse an occupied address and
   post-Cancun Base cannot vacate one) and pages logs at 500 blocks. The fixture
   enforces the limit. A live inspection measured 85 calls / ~18 s within the 30 s
   observation budget; `debug_traceTransaction` works on the archive host.
3. **Swallowed worker errors.** The creation worker now logs the `RestError` code
   and bounded scalar details for every pending pass.
4. **Signup page.** One click runs create, check and approve; a small in-page note
   precedes every native passkey prompt; "Check signup" answers visibly; "Start over"
   drops the continuation cookie at any phase; the busy treasury lane is named.

**Later on 2026-09-15:** the wallet moved to `https://my.juicebox.center` (Railway custom
domain; `WALLET_ORIGIN`, with `WALLET_LEGACY_ORIGINS` for the retired host). Pages are mounted
at the host root (`basePath: ''` in `src/index.ts`): `/` is the signup page for a plain visit,
`/create`, `/recover`, `/config`, `/handoff/*` and the rest sit directly under the host, and
`/wallet/…` links still work (navigations 301, calls are served). The REST app dispatches the
wallet origins to the wallet app before path routing (`walletOrigins` in `mountRestSite`). Creation
approvals are v2 (bound to the registered identity, so one assertion approves creation and proves
possession; migration 036). A third recovery option, a password the user chooses, was built
and then withdrawn the same evening after review: a sealed envelope fetchable by wallet address
lets an attacker guess the password offline. Migration 037 created its table and 038 drops it;
the Railway wrap key was deleted. Do not reintroduce it without an online-only opening step
(an OPRF or equivalent) so guesses cannot proceed without the server.

Throughput: one operation is in flight at a time, but the treasury lane is released
at canonical inclusion (migration 054), so the next creation is admitted seconds after
the previous send lands; each finalized fee is settled behind it, in nonce order, from
a queue of at most eight released inclusions that reserve their admitted maximum cost.
Before public launch: add treasuries (pools) and parallelise the inspector's
independent reads.

**Signup speed (2026-09-20):** the send goes out on the worker's first pass — the
admission is pinned to the observed head by hash and only asks that `latest` be at
or past it — and the approval's chain reads (treasury funding, creation preflight)
run while the passkey prompt is up, held per approval inside the 20 s admission
window and validated by the claim like fresh ones (`walletSignupSpeculation`); the
worker is kicked at the claim. The page is told "ready" at the canonical receipt:
the worker's active-operation read is `inspection: "inclusion"` (our exact
transaction, its one ProxyCreation log, the sender nonce past it, finality), the
lane is released on it, and the wallet's full inspection runs behind the release
through the API's smart-account service, which remembers it. Activation binds from
that remembered verification when it is under four minutes old (its block re-checked
canonical) and the first authority observation after the binding carries the same
state at its own block (`carried` on the authority chain: canonical, live, matching
the bound state, no prior anchor past it); every later observation inspects in full.
Settlement's observation is still the full one. The page hears "ready" and the inspection starts at the canonical observation, before the release; a settled dispatch attempt no longer holds the lane for the rest of its 15 s lease (migration 056); activation joins an inspection already in flight; a completed login drops the signup continuation cookie. **Signup session:** a fresh signup is
signed in from its creation-approval assertion (`PostgresWalletLoginStore.completeFromSignup`,
`POST /signup/session`): the assertion the claim verified is held in the approving process's memory
(≤ 15 min, once), re-verified at issuance against the claimed deployment's proof digest with the
claim's clock, and completes a login row whose proof says `signup-approval` and names the
deployment, once the account's authority is verified; a resumed signup (the hold names the
approving continuation's revision, which a resume advances), a restarted process or anything
older gets the ordinary login prompt, server-side. Round trips on the send path (measured with a 40 ms
fixture delay): the unsent observation 6 → 3, the admission 16 → 7, the preflight's pinned reads in
one group; the Base identity check and the creation-signer inspection are one round trip each.
Same checks, same head pins, fewer waits. Fewer than five passkey prompts
(create, check, approve, setup, login) needs protocol changes (fold possession into
the creation approval; fold the setup grant into login).

The paragraphs below describe the state before activation and remain accurate for
the composition and the review history.


Application source on Center main is
`ac6e48d52fb43d5c90205e9892fff4ccaa011484`; the handoff is a later documentation
commit. That application revision passed 4,583 checks with zero failures/skips,
and [remote CI succeeded](https://github.com/mejango/jbcenter/actions/runs/34921022953).

**Hosted Base creation is implemented but not yet configured; hosted recovery is
not.** [src/index.ts](../../src/index.ts) mounts the wallet site when `WALLET_ORIGIN`
is set and hosted creation only when every `WALLET_CREATION_*` setting is present
(see [WALLET_SIGNUP.md](../../WALLET_SIGNUP.md), "Composition and observation").
Center's Railway environment has none of these yet; no treasury key or funding
exists. The creation host ([baseHost.ts](../../src/rest/wallet/baseHost.ts)) composes
[deploymentBase.ts](../../src/rest/wallet/deploymentBase.ts) over the generic
[deploymentTransport.ts](../../src/rest/wallet/deploymentTransport.ts) and
[deploymentSettlementObserver.ts](../../src/rest/wallet/deploymentSettlementObserver.ts);
migration 034 admits the `base-mainnet` environment, the reserved Base admission,
complete `base-fjord-jovian-receipt-v1` fees and the `allocation-exceeded` fence.
Recovery still has only the local Anvil relay
([recoveryLocalAnvil.ts](../../src/rest/wallet/recoveryLocalAnvil.ts)).

Local signup, recovery and app handoff are implemented and tested against
PostgreSQL, Chromium and unforked Anvil. Shared dependency deployment is complete
on eight chains. The new Base receipt verifier/observer is on main, but no
production creation/recovery adapter consumes it yet. DNS and TLS for
`wallet.juicebox.center` were verified; its last observed `/wallet` response was
503 setup-unavailable. Recheck deployment identity before changing hosting.

## Repository map and local changes to preserve

| Repository/worktree | Snapshot | Instruction |
| --- | --- | --- |
| `/Users/jango/Documents/jb/v6/evm/extensions/jbcenter` | Center canonical main | Fetch/check current HEAD; handoff docs are pushed here |
| `/private/tmp/center-wallet-base-adapters` | `feat/wallet-base-adapters`, same application base plus these docs | Current documentation worktree; reuse or create an isolated next worktree |
| `/Users/jango/Documents/jb/v6/evm/extensions/homerun` | main/origin `6bb9f9c9b8583a366f9683aa1db9b625f3084d96` | Preserve modified `README.md`, `src/components/CreateFlow.tsx`, `test/create-browser.mjs`; these are unrelated user work |
| `/Users/jango/Documents/cocopay/beep` | main/origin `c672751c41428312dde45037ec6b6f5d5ffe28d0` | Preserve modified `ARCHITECTURE.md`, `README.md`, and untracked `CENTER-WALLET-PLAN.md`, `CENTER-WALLET-SPEC.md` |

Read each repository's `AGENTS.md`. Center requires the pinned Ponytail workflow.
Keep edits isolated; never stage another worktree's dirt. The client SDK tarball
and SHA256 are recorded in the delivery report. Both clients have the latest
app-bound launch integration, with passkey activation off.

Other work worth preserving, without merging blindly:

- `/private/tmp/center-wallet-admission`, branch `feat/wallet-admission`, base
  `c11d471`: untracked `src/db/lanes.ts`, `src/db/admissionPool.ts`, and
  `test/database-admission-postgres.integration.test.ts`. Four real PostgreSQL
  tests passed. It is not wired into runtime or release-qualified. Review before
  reuse; this prototype is not a prerequisite for understanding signup.
- `/private/tmp/center-wallet-publication-review`, revision
  `94d89f6209cd755d7f9020e5bc778f8a21fc122d`: preserve this exact audited operator
  checkout and its dependency journal. Do not modify/reinstall or rerun funding.

## Completed slice: hosted Base creation (revision 516d163)

Evidence: `~/.juicebox-center/wallet-dependencies/reviews/516d163/base-creation-adapter/`
(release check `2026-09-15T03-25-19.016Z-49f2e259`, 181 files / 4,139 service tests,
all steps passed on clean source; Fable review prompt and output). Tests:
`rest-wallet-deployment-base-boundaries`, `-base-postgres.integration`, `-base-anvil`,
`rest-wallet-signup-base-postgres.integration` (two users through reserved admission,
one send each, complete-fee settlement, next-user admission) and
`rest-wallet-base-host-postgres.integration` (runtime host initializes accounting once
with the explicit first nonce and refuses a mismatching one). The Base-shaped fixture
(`test/fixtures/wallet-base-anvil.ts`) runs the unforked Safe stack behind a proxy that
presents the public fee predeploys, a Jovian attributes deposit at index zero of every
block and receipt L1 fees priced from those attributes. It is not a Base provider.

Design decisions to keep: the Base environment identity is the chain (genesis); the
pinned L1Block/GasPriceOracle implementation runtimes are checked on every observation
and at the inclusion block, failing closed on a later upgrade. A reservation is
execution maximum plus twice the current L1/operator estimate and is not a cap; an
actual finalized debit above the allocation is recorded and fences the pool. The
chain nonce versus accounting `nextNonce` is the restore fence. The shared
funding-evidence lifetime bound is 60 s (local producers keep 5 s). The lane is
released at canonical inclusion and each fee settles at finality (see constraint 1).

## Completed slice: hosted Base recovery

The shared relay ([recoveryRelay.ts](../../src/rest/wallet/recoveryRelay.ts)) now takes
the same chain adapter as creation; [recoveryBase.ts](../../src/rest/wallet/recoveryBase.ts)
and `createBaseWalletRecoveryHost` compose it, and migration 035 admits the
`base-mainnet-recovery-v1` lane with a monotonic actual spend and the
`allocation-exceeded` fence. The joined Base test recovers a Base-created wallet through
the relay with a lost accepted reply, a process kill before activation, old-credential
rejection, finality-gated lane settlement with complete fees, and a chain rollback that
fails closed. `WALLET_RECOVERY_*` settings mount it; the relay key must differ from the
creation treasury.

## Next: production configuration and the pilot

Center main is at the reviewed revision `321f8e9` (release check
`2026-09-15T11-45-52.140Z-531b7a5d`, all steps passed on clean source). Two Base pilot
keys were generated in memory on 2026-09-15 and stored only in Center's Railway
production variables under staging names the application does not read yet:

| Role | Address | Railway variables | Proposed budget |
| --- | --- | --- | --- |
| Creation treasury | `0xa347d65309D1254a9d7a366B4F4b5F255c549310` | `CENTER_WALLET_CREATION_TREASURY_PRIVATE_KEY`, `..._ADDRESS` | funded 0.006 ETH; allocation 0.005 ETH |
| Recovery relay | `0x518bEc74014Eed3a517faF0E33c3E3f651C8cB63` | `CENTER_WALLET_RECOVERY_RELAY_PRIVATE_KEY`, `..._ADDRESS` | funded 0.002 ETH; budget 0.002 ETH |
| Networks payer | `0x9e0A97A470379DD7cb8a4a8CbB196d00Be9b62a2` | `WALLET_NETWORKS_PAYER_KEY` (read directly; set 2026-09-16) | fund Base ETH (about 0.01) and Base Sepolia ETH; caps 0.003 / 0.01 ETH per bundle |

Both are fresh EOAs with nonce 0. The first provisioning was rotated the same day after
a variable listing exposed key prefixes in a session log; only these addresses are valid.
Never list Railway variable values; check names with `railway variables --kv | cut -d= -f1`.

Activation, after the user funds the addresses: set `WALLET_ORIGIN=https://wallet.juicebox.center`,
`WALLET_CREATION_SIGNER_KEY` (the creation key), `WALLET_CREATION_POOL_ID` (a fresh UUID),
`WALLET_CREATION_ALLOCATION_WEI=5000000000000000`, `WALLET_CREATION_INITIAL_NONCE=0`,
`WALLET_RECOVERY_SIGNER_KEY` (the relay key), `WALLET_RECOVERY_MAX_OPERATIONS=50`,
`WALLET_RECOVERY_MAX_COST_WEI=2000000000000000` together in one deploy; partial settings
fail startup by design. The first start configures the pool and initializes accounting.
Begin by reading
[WALLET_SIGNUP.md](../../WALLET_SIGNUP.md), the
[deployment strategy](WALLET-DEPLOYMENT-STRATEGY.md),
[Base fee notes](../../src/rest/wallet/stack/baseFees/README.md), and the following
source. Avoid restarting the cryptography or SDK design.

| Source under `src/rest/wallet/` | Boundary to preserve or extend |
| --- | --- |
| `signup.ts`, `recoveryLocalAnvil.ts` | Resumable composition, separate fresh proofs, exact recovery signer-creation/owner-swap order; local-only settlement assumptions |
| `deploymentPostgres.ts`, `deploymentDispatch.ts` | Permanent sender/nonce, immutable winning signed bytes before send, durable attempt before physical send, leases and unknown-outcome retention |
| `deploymentObservation.ts`, `deploymentChain.ts` | Latest canonical readiness separate from retained historical evidence and treasury finality |
| `deploymentSettlement.ts`, `deploymentSettlementLocalAnvil.ts` | Current local-only accounting types; extend deliberately for complete Base costs instead of casting local evidence as Base |
| `baseReceiptFees.ts`, `baseFeeObservation.ts`, `operationRpc.ts` | Exact signed-envelope fees, inclusion/attributes binding, shared bounded reads and final recheck |

Add behavioral failing cases at the real boundary, then implement the smallest
shared change. The first acceptance case should demonstrate actual production
composition reaching a durable, exactly identified creation operation and its
complete settlement evidence under controlled RPC fixtures. Join real Base
provider observations and a funded canary only after review and funding policy.
Recovery must then demonstrate replacement login to the same Safe and rejection
of the previous credential across uncertain replies and restart.

Known design constraints:

1. Deployment migrations 016/026/034/054 select one exclusive pool, one active
   (not yet canonical) operation and a released queue of at most eight canonical,
   unsettled inclusions. `nextNonce` advances at release; `sequence` and
   `spentWei` advance at each finalized settlement, taken in nonce order. A released
   inclusion reserves `max(execution ceiling, Base reservation)` against the
   allocation until its settlement; claims and dispatches spend only what is left.
   A released inclusion whose latest observation is positively not canonical fences
   the pool (`inclusion-reorged`); no bytes are resent and an operator restores.
   Liabilities are never discarded to increase throughput.
2. Type-2 maximum execution fees do **not** cap future Base L1/operator fees.
   Estimate plus margin is a reservation, not an enforceable chain cost ceiling.
   Migration 034 now records `spent > allocation` behind the `allocation-exceeded`
   fence. A sender's balance is not immutable, and one nonce does not mean one
   sender transaction per block.
3. A database cannot prove it has not been restored to an earlier snapshot. The
   sender's chain nonce is the external fence: claim and admission require it to
   equal accounting `nextNonce` (release requires it to be exactly one past the
   included nonce; a settlement bounds it by the queue), and initialization requires the
   explicit `WALLET_CREATION_INITIAL_NONCE`. A restore therefore stalls closed; an
   operator must inspect and re-pin before any new claim.
4. Local recovery has a separate treasury sender, fixture-only budget and locks
   across bounded RPC work. Reassess those assumptions for hosted DB pressure.
5. The Base settlement producer binds finality, the pinned runtimes at the inclusion
   block and the durable operation before consuming fee output. Measured read-only on
   2026-09-15 against Center's Dwellir archive from this machine: identity 1.7 s,
   reservation 0.8 s, funding read 3.1 s; the live genesis and both fee predeploys
   matched the pins at block 51327173. The hosted admission window is therefore 20 s
   (shared bound in migration 034 and `walletDeploymentDispatchLimits`); the local
   producer keeps 5 s. The final pending-nonce and canonical-head recheck still runs
   immediately before the single send.
6. Read the actual Base chain configuration, not a generic OP schedule. The
   preserved source pin includes Jovian and later Base-specific upgrades.

The new [source evidence bundle](evidence/wallet-delivery-2026-09-15/README.md)
preserves exact compiler/source hashes, observed runtimes and the successful
three-contract full-byte rebuild. The complete compiler inputs/outputs are in
the durable archive specified there. This work is done; do not repeat the source
search or download a compiler unless needed to reproduce it. The runtime
reconstruction itself still needs review and integration.

## Other launch blockers to retain

- **Application Relayr quote binding:** `src/rest/sponsorship/provider.ts`
  `parseQuoteBinding` maps returned UUIDs by array position. Actual Relayr POST
  UUID order differs from request order. `sponsorship/service.ts` durably settles
  that quote before exact echo checks. Reuse the independent operator's GET
  echo/bijection approach before payment activation; do not reinterpret existing
  immutable commitments. Keep sponsorship disabled until resolved.
- Complete the joined Homerun/Beep payment journey with actual provider
  acceptance. Contract math and local EVM tests alone do not qualify it.
- Public intake and authenticated control work still compete for capacity.
  Public IP headers or cookie presence are not proof for a privileged lane.
  Current refresh limits are 32 queued accounts, two concurrent observations and
  30 starts/minute. Cold wallet inspection was measured at 92 RPC calls; authority
  inspection at 86/87. Provider quota and active-user capacity need measurement.
- The current pressure diagnostic uses two initialized wallets and synthetic
  chain observations, with an optional 10,000-row inventory. It is not evidence
  for 10,000 active wallets or the sustained/burst/two-hour-soak targets.
- Homerun `src/providers/ExternalWalletDialog.tsx` still says “Connect your wallet”
  and “Choose your wallet.” Once signup works, improve first-time copy and enable
  the build-time configuration in `wallet-config.ts`. Missing/malformed manifest,
  issuer/audience or fee settings currently disable the integration.
- Device probes proved local passkeys on Mac Safari/Chrome and iPhone Safari.
  Production RP, iPad, sync, actual recovery and Beep native handoff remain. Ask
  for device interaction when the hosted flow is observable and ready.

## Funding and operational records

Shared dependencies are **already deployed**. See the
[rollout](WALLET-DEPENDENCY-ROLLOUT.md); do not redeploy or repeat its payments.
The Base manifest is `center-passkey-base-v1`, revision
`0xb7e29918ff85d6eb8b925a81bcc3259f2d1d83f22c92ea17bd912d65a3d64008`.
All 13 contracts matched; `dispatchEnabled` remained false.

The dedicated dependency payer is
`0x097334063a5c2505d8df1C660B996699c27E6Fd3`. Its unspent funds are not a newly
authorized runtime allocation. Do not reuse Beep deployment keys, invent a new
funding purpose or sweep leftovers. Prepare separate production creation/recovery
funding addresses and budgets when that implementation is ready.

Preserve the original unknown, unpaid mixed Relayr request
`0x2f8bfba5e4b707ddcd8891fcd59715d2f6575b6db146e63b94e75f1846fbdd05`.
Never delete its claim, pay it, or retry the POST blindly. Mainnet and testnet
finalized bundles are recorded separately in the rollout evidence.

Railway project `4a070739-bf7b-41f2-bdc1-fe6a77f98545`, environment
`f0adf022-61c8-4c3d-b60b-602f5328eb34`, Center service
`0236bff9-1d8f-494c-9445-b7549ae3d043`. Existing local CLI authentication is at
`/Users/jango/.railway/config.json`. Read credentials only in memory. Never dump
environment values, include provider keys in command arguments/logs, or commit
funding keys. Dwellir credentials already exist in Center's Railway environment.

## Hosted-provider timing (measured 2026-09-15)

One complete Safe7579 inspection over Dwellir Base is ~83 RPC calls and takes 20 to 27 s
(`eth_getLogs` windows are capped at 500 blocks, error -32005). Every constant on that path
is sized to it, and `test/rest-wallet-runtime.test.ts` pins the production values:

- Three inspectors exist (legacy stack and wallet profile in `runtime.ts`, the DB-free one in
  `authorityChain.ts`). All prove creation without a history scan: the runtime ones from the
  `FactoryHistoryIndex`, the authority chain from the creation receipt named by the bound
  setup state. All use `maxLogRangeBlocks: 500` and a 90 s deadline.
- Authority observation budget `walletAuthorityObservationBounds.totalTimeoutMs` 90 s; a
  verified snapshot is the account's *identity*: sign-in, the app hand-off, app-signed requests,
  payment-review reads and approvals are served from it regardless of its age (`settled` in
  `loginPostgres.ts`, `settledAuthority` in `appGrantsPostgres.ts`, `finishWalletAppRequest`),
  and each of them queues a background refresh. Only an account never observed (fresh from
  signup) waits for its first observation, and only dispatch to other networks
  (`networks/*`, `sessionFor`) waits for a snapshot younger than `walletAuthorityMaximumAgeMs`
  15 min (migration 049; 039 had 120 s). Every action that changes the account (payment
  submission, device addition, recovery) verifies it again at a fresh block. Refresh queue lease 120 s, refresh lead 60 s, worker
  attempt 100 s. The queue pins its settings in `rest_wallet_authority_refresh_control` for
  all replicas: changing them means bumping `revision` in the defaults (a newer revision replaces the pinned copy during the rollover), or
  every claim fails with WALLET_AUTHORITY_REFRESH_CONFIG_CONFLICT (`queue_failed` in the log).
- A payment approval is the send: after the approval is durable, the review store hands the
  operation to `UserOperationService.submitApproved` (`attachSubmission` in `runtime.ts`) on the
  review's own authority (the app's signed review request names the operation; the passkey
  approved it; the grant's `relay` scope is still required at the claim), publication key
  `review:<id>`, window from the approval. The same signed bytes under another publication key
  observe that submission (`replayed`, `claimed()`), so the app's hand-back `POST /submissions`
  is the fallback, never a second send. A reload of the approval page retries while the
  operation is still `prepared` (a session read of an approved review sends again too). The page
  says "Sending on Base…", never "sent" or "paid".
- Signup shows `preparing_sign_in` after setup until the worker's snapshot is verified; the
  signup site asks the worker on every such view and the page polls state every 2 s. Recovery
  still refreshes inline in its status call (open item).

## Account binding by creation consent (2026-09-15 late)

Signup and recovery no longer ask for the "Authorize this browser" prompt. The account binding
uses method `center-wallet-passkey-creation-v1` (src/rest/wallet/bindingConsent.ts): its
digest is the passkey proof already on record, the enrollment possession proof at signup
(`0x` + `enrollment.receipt.verificationDigest`) or the recovery proof for a replacement
(`0x` + `record.proof.verificationDigest`); no setup document, no browser grant. The page calls
`POST signup/activate` (or `recovery/activate`) after creation (or rotation) with no prompt;
phases run `awaiting_activation` → `preparing_sign_in` → `ready_to_sign_in`, and both sites ask
the refresh worker while preparing. Accounts from before keep the owner-signed setup binding
(`safe-passkey-owner-threshold-and-api-grant`); both methods are accepted by the authority
context, the login store, the app-grant readiness join, the refresh eligibility SQL and the
bindings CHECK constraint (migration 042). Reads and prepared requests need no grant; execution
always takes the passkey. Public read/prepare on the signed app API is a separate slice.

## The account on more chains ("Add more", 2026-09-15 late)

`src/rest/wallet/networks.ts`: the Base creation calldata carries no chain id, so replaying the
exact `createProxyWithNonce` call reaches the same CREATE2 address on every chain where the stack
sits at the same addresses; all 13 pins (Safe stack + passkey dependencies) verified by runtime
hash on chains 1, 10, 42161, 8453, 11155111, 11155420, 84532, 421614 on 2026-09-15. Relayr runs
the calls from one prepaid bundle per family (`createIndependent`, nonce mode Disabled); the
payment is one `prepayment` call on Base (mainnets) or Base Sepolia (testnets) from Center's payer
(`WALLET_NETWORKS_PAYER_KEY`, its own nonce space). One passkey prompt approves the chain list,
bundle uuid, payment and calldata hash (`walletNetworksDocument`). `status()` treats code at the
address on a chain as deployed. Offered now: Optimism, Arbitrum and the four testnets (Center
pays). Ethereum mainnet is listed but not offered until the account-pays path exists.
Routes: `GET /networks`, `GET /networks/status`, `POST /networks/quote`, `POST /networks/approve`
(session cookie, CSRF on mutations). Tables: `rest_wallet_network_bundles`, `rest_wallet_networks`
(migration 043).

## App connections: npm package and allowlist (2026-09-16)

- Apps integrate through the npm package `@me.jango/signa` (built from
  `src/rest/client/wallet-package.ts` by `scripts/rest/build-client.mjs`, manifest in `wallet-client/`).
  It carries only the connection and payment-review surface; bots and the CLI keep using the full
  client archive at `/api/client/`. `.github/workflows/publish.yml` publishes a new version after CI passes on
  `main` when `wallet-client/package.json` names one that npm does not have yet (`NPM_TOKEN`, scope
  `@me.jango`; it was `@me.jango/center-wallet` through 0.3.7). Since 0.4.0 it also carries the connect
  step as `/core`, `/wagmi` and `/react` (source and tests in `wallet-client/src/`, React and wagmi as
  optional peers), which moved here from `@bananapus/nana-sdk-connect`. Apps depend on this package directly.
- The app allowlist is database state and starts inactive. Activate or replace it from inside the
  production container, which holds `DATABASE_URL`:
  `railway ssh --service juice-central -- node dist/src/rest/wallet/policyCli.js --expected <revision> https://homerun.money /center/callback https://beep.biz /center/callback`
  (`--expected 0` for the first activation). Verify from outside with
  `curl -H "Origin: https://homerun.money" https://my.juicebox.center/config`, which returns the app
  entry when allowlisted and `WALLET_POLICY_INACTIVE` when no policy exists.

## Passkey name (2026-09-15)

`rest_wallet_credentials.passkey_name` (migration 041) keeps the name typed at signup or recovery;
`PostgresWalletLoginStore.passkeyName(session)` reads it and the account page shows it as
"Passkey". It is display only: WebAuthn cannot rename a passkey, and changing the passkey itself
is the recovery flow (new signer on the Safe, old one removed).

## Checks, review and observation loop

Use Node 22 and Foundry. On this machine:

```sh
export PATH=/Users/jango/.nvm/versions/node/v22.23.1/bin:/Users/jango/.foundry/bin:$PATH
export TEST_DATABASE_URL=postgresql://center_wallet_test:center_wallet_local_test@127.0.0.1:55440/center_wallet_test
npm run check
```

The database above is the disposable local PostgreSQL 16 test container,
`center-shared-wallet-pg`. Confirm it is available. New worktrees need the root
and MCP dependencies installed. Run the complete release gate alone; simultaneous
heavy browser/Next/Forge builds caused avoidable fixture contention. Focused
checks come first; the required clean release report qualifies the code shipped.

Claude CLI: `/Users/jango/.local/bin/claude`, model `claude-fable-5-1`. Supply an
exact bounded review scope with files visible in its workdir. The last reviewer
could not read a prior report outside that workdir. Do not claim review of files
it did not see. Codex subagents had exhausted their usage allowance at handoff;
do not busy-retry that failure.

Record operation ID, phase/revision, public transaction hash, nonce reservation,
attempt outcome, canonical/finality status, fee completeness, RPC calls/deadlines
and queue/DB latency. Retain red/green failure evidence and reviewed source hashes.
Never log phrases, private keys, assertions, cookies or recovery/launch secrets.

Durable evidence lives under
`/Users/jango/.juicebox-center/wallet-dependencies/reviews/`, especially:

- `ac6e48d52fb43d5c90205e9892fff4ccaa011484/base-fee-observation-release/`:
  exact tested source, red/green/full-gate logs, two Fable reviews and live results.
- `ac6e48d52fb43d5c90205e9892fff4ccaa011484/base-runtime-source-rebuild/`:
  full public source inputs/outputs, verification records, Dwellir observations
  and inventory; compiler binary deliberately omitted.
- `55bd93be5be46fcd291e12f3019405e5d9756c7a/signup-inclusion-release/`:
  canonical signup-before-finality test and review evidence.

Keep the user informed about concrete completed milestones and what the next
test will resolve. A green test count, a deployed contract and an enabled
consumer journey are different claims. The finish line is a person starting
without a wallet, signing up on Homerun, reconnecting, recovering to the same
wallet and using the authorized Beep/payment paths with observed production
behavior and the agreed release gates satisfied.
