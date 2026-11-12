# Signa

Signa is an independent account and wallet service. Its Node runtime owns account
identity, passkeys, app and bot grants, delegated sessions, owner approvals,
execution and recovery, backed by its own PostgreSQL database and workers.
Juicebox Center continues operating independently. This deployment does not import
Center account data, migrate existing credentials or forward Center traffic.

## Origins

- `https://signa.center` serves credential pages and creates new Signa passkeys.
- `https://api.signa.center` serves the signed REST API, Accounts page, API docs
  and client archive. It is the exact API audience.

Credential and account-management origins remain separate. The credential host
does not serve the general Accounts UI or MCP. Keep exact reviewed request bytes,
RP ID, issuer, audience, callbacks and `/wallet` client compatibility paths.
Center account history is not migrated; Signa is the sole account service.

## Build and run

Use Node 26.13.1 from `.nvmrc`, its bundled npm 11.20.0 and the committed dependency lock:

```sh
npm ci --ignore-scripts
npm run build
npm start
```

`npm run dev` builds and starts the source entry point with `.env` loaded.
`npm start` and the Docker image use deployment environment variables. Copy
[.env.example](.env.example) for local configuration and supply deployment secrets
through the hosting environment. Never commit signing keys or connection files.

The build preserves the module-relative layout of contract catalogs, reviewed
artifacts, factory history, storage-layout evidence, SQL migrations and browser
assets. Shared protocol primitives and outcome verification come from the pinned Juicebox SDK.
Signa does not package or mount Center's server or MCP implementation.

Signa exposes account and bot management, smart wallets, delegated sessions, payment
reviews, transaction plans, sponsorship and UserOperations. Protocol catalogs,
project/indexer reads, intents, publication and pinning belong to
[Juicebox Center](https://juicebox.center/api). Account guides are served by Signa;
protocol guide links redirect to Center.

New protocol transaction drafts come from Center's public `POST /api/v1/plans`.
Signa validates the returned unsigned draft and independently verifies ownership,
canonical chain evidence, simulation, exact approvals and execution. Center receives
no account credentials or signing authority. Center remains the source of protocol
routing, quotes and constructed hook metadata. Signa binds explicit request fields
and presents the actual call bytes for review. Reviewed transaction descriptor schemas
are packaged with Signa so an unavailable Center prevents new preparation without
blocking signup, login, existing approvals, receipt reconciliation or recovery.
Refresh those schemas deliberately with `node scripts/rest/sync-protocol-operations.mjs`
(or `--input reviewed-catalog.json` for a reviewed response); `--check` verifies
without writing. A refresh preserves the reviewed operation allowlist. New operations
also require explicit request binding in Signa before being added to its snapshot.

The local contract catalog and deployment artifacts remain necessary for Signa's
session-target and account authorization checks. They are not exposed as a second
protocol read API. RPC requests go directly to Signa's configured provider.

## Configuration and activation

`SIGNA_RUNTIME_ENABLED` defaults to `false`. Dormant startup constructs no account
runtime, database migrations, signers or workers. `/healthz` reports process
liveness; `/readyz` on the deployment/API host returns 503 until the runtime is
active. Set the Railway service's health check explicitly for each stage: use
`/healthz` with a 30-second timeout for a dormant deployment, then `/readyz` with a
120-second timeout when enabling the runtime. Verify those settings in the active
deployment manifest. The repository leaves health check settings to the service
so a later deployment cannot restore the dormant liveness probe. A successful
build or liveness probe does not establish wallet readiness.

`/healthz` on the API host also names the build: `commit` uses `SIGNA_BUILD_COMMIT`,
falling back to Railway's native `RAILWAY_GIT_COMMIT_SHA` when absent or empty. Only
a full 40-hex commit is reported; other values become null. `web` is the sha256 of
the image's web manifest. `node scripts/rest/verify-served-build.mjs https://signa.center
<commit>` rebuilds that commit (it must be on `origin/main`) and exits 1 when any wallet
page, script or stylesheet the origin serves differs. The manifest describes production's
configuration: signup, recovery, devices, payments and funds all enabled. It checks the
bare unframed pages and the files they name, that their policy runs only same-origin
scripts, and that no response redirects; a server can still answer other requests differently.

Configure `DATABASE_URL`, `DWELLIR_API_KEY` and the two origins before activation.
Keep existing Signa database state across deployments; no Center account import is
needed. SDK versions are reviewed build dependencies, never runtime-downloaded code.

Base creation requires all four `WALLET_CREATION_*` settings: a dedicated signer,
pool UUID, reviewed allocation and initial nonce. Recovery and device addition
require all three `WALLET_RECOVERY_*` settings. `WALLET_NETWORKS_PAYER_KEY` enables
additional-network funding. Fund independent Signa senders and configure their
actual reviewed nonce and budget state. Do not reuse Center's active treasury
senders or share a signer across creation, recovery and network funding lanes.
`CDP_API_KEY_ID` with `CDP_API_KEY_SECRET` (a CDP Secret API key, Ed25519 or EC) adds
"Add funds" to the account page: Apple Pay through Coinbase's headless onramp
(`CDP_ONRAMP_APPLE_PAY=false` hides it) and Coinbase's hosted checkout for Coinbase accounts.
Purchases land as USDC or ETH on Base at the account's own address. Apple Pay uses Coinbase's
embedded checkout (needs Coinbase to enable it): Coinbase's frame asks for and verifies the email
and phone, so Signa never sees them; the device keeps only Coinbase's returning-user token.
`CDP_ONRAMP_SANDBOX=true` uses Coinbase's sandbox with the same key. The Apple Pay button embeds
in the funds page that "Add funds" opens, the one Signa page that frames another origin and the
one on which no passkey can be used (the wallet host must be on the CDP Portal's Onramp domain allowlist); the
file Coinbase issues for that domain goes in `CDP_APPLE_PAY_DOMAIN_FILE` and is served at
`/.well-known/apple-developer-merchantid-domain-association`. Inside an app's frame the button
opens in a window instead, since Apple checks the top page's domain.
`REST_ERC4337_CONFIG` and optional `REST_ERC4337_SPONSOR_ROUTES` retain the existing
reviewed execution-policy formats.

Deploy dormant, provision the fresh database and required providers/funding, then
run the release checks before setting `SIGNA_RUNTIME_ENABLED=true`. Verify readiness,
new signup/login, callback completion, account API access and canonical operation
reconciliation on Signa. One service owns Signa's workers; Center keeps its own.
Preserve Signa's durable nonces, reservations and unfinished operations across
redeployments. Reconcile unknown submissions instead of replacing them.

Run `npm run check:preflight` and `npm run check`; see
[execution operations](docs/rest/EXECUTION_OPERATIONS.md) and
[production recovery](docs/rest/PRODUCTION_OPERATIONS.md) for required checks and
execution invariants. CI retains the full release checks and image build. It does
not publish the inherited Center wallet client or monitor Center's production
service. Add a Signa production monitor after activation with reviewed live
endpoints and readiness criteria.

## Source provenance

Signa originated from reviewed Juicebox Center baseline
`8949a2d4f970a128dfbadf46fed6920731dbbe6b`; its preparation reference was
`ef1a4c70516a8a0f4e71ed276a92a809f52564b0`. The inherited Center server and MCP
implementation have been removed. Protocol preparation uses Center HTTP and portable
outcome verification uses the SDK. Retained account-execution artifact hashes,
factory-history seeds, deployment catalogs and evidence keep their reviewed identities.
