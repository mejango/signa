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
Existing Center credentials and operations remain with Center.

## Build and run

Use Node 22 and the committed dependency locks:

```sh
npm ci --ignore-scripts
npm --prefix mcp ci --ignore-scripts
npm run build
npm start
```

`npm run dev` builds and starts the source entry point with `.env` loaded.
`npm start` and the Docker image use deployment environment variables. Copy
[.env.example](.env.example) for local configuration and supply deployment secrets
through the hosting environment. Never commit signing keys or connection files.

The build preserves the module-relative layout of contract catalogs, reviewed
artifacts, factory history, storage-layout evidence, SQL migrations and browser
assets. The retained `mcp` package supplies protocol libraries; Signa does not mount
an MCP listener. Client packages and API documentation remain available through
the API host. Inherited Center source has not all been pruned.

The Signa API exposes account and bot management, smart wallets, delegated sessions,
wallet payment reviews, transaction plans, sponsorship and UserOperations. Its
`/api` page and OpenAPI document list those routes. Protocol catalogs, project and
indexer reads remain at [Juicebox Center](https://juicebox.center/api); inherited
Markdown guide links redirect there. Signa does not serve those protocol read routes.

Protocol project-intent reads query `https://juicebox.center` with Signa's configured
API origin; they do not read or import Center accounts into Signa's database. Center
must admit that exact origin for these reference reads. RPC requests use Signa's
configured provider directly. Center publication and pinning remain outside Signa's
REST operation surface.

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

Configure a fresh `DATABASE_URL`, `DWELLIR_API_KEY`, the two origins and a new random
`MCP_PLAN_SECRET` of at least 32 bytes before activation. Keep that plan secret stable
across Signa restarts and replicas. `MCP_*` settings configure retained protocol
libraries, including optional Bendystraw endpoints; the protocol public origin is
bound to `REST_PUBLIC_ORIGIN`.

Base creation requires all four `WALLET_CREATION_*` settings: a dedicated signer,
pool UUID, reviewed allocation and initial nonce. Recovery and device addition
require all three `WALLET_RECOVERY_*` settings. `WALLET_NETWORKS_PAYER_KEY` enables
additional-network funding. Fund independent Signa senders and configure their
actual reviewed nonce and budget state. Do not reuse Center's active treasury
senders or share a signer across creation, recovery and network funding lanes.
`CDP_API_KEY_ID` with `CDP_API_KEY_SECRET` (a CDP Secret API key, Ed25519 or EC) adds
"Add funds" to the account page: Apple Pay through Coinbase's headless onramp
(`CDP_ONRAMP_APPLE_PAY=false` hides it) and Coinbase's hosted checkout for Coinbase accounts.
Purchases land as USDC on Base at the account's own address. Coinbase sends and checks the
email and mobile codes; the verification stays on the person's device, never on Signa.
`CDP_ONRAMP_SANDBOX=true` uses Coinbase's sandbox with the same key.
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

The protocol implementation is vendored from validated Juicebox Center baseline
`8949a2d4f970a128dfbadf46fed6920731dbbe6b`; the Signa preparation reference is
`ef1a4c70516a8a0f4e71ed276a92a809f52564b0`. Signa owns its runtime; complete source
extraction and deduplication are not finished. Protocol sources, artifact hashes,
manifests, factory-history seeds and API evidence retain their reviewed identities.
Keep provenance and operation evidence when replacing an inherited adapter.
