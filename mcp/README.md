# Juicebox MCP

Juicebox V6 project intelligence, development references, economic modeling, and verifiable unsigned transaction plans over the Model Context Protocol.

The deployment endpoint is **https://juicebox.center/mcp**. This package lives in JB Center's `mcp/` directory and is embedded in Center's HTTP server. It also supports standalone HTTP and stdio execution with its checked-in references; source repositories are not runtime dependencies. The origin remains configurable for alternate deployments, including `juicebox.diy` or `juicebox.tools`.

## What it provides

- Project, account, ruleset, permission, treasury and omnichain reads with explicit identity, units, coverage and block evidence.
- Payment, cash-out, payout, buyback/router, NFT, revnet, loan and bridge workflows built against the pinned SDK and checked against V6 source.
- Authenticated transaction plans containing exact account, chain, destination, calldata, value, decoded arguments and prerequisites. Fresh simulation and receipt verification are separate operations.
- Searchable contract sources and Juice skills, plus practical webclient development plans grounded in Juicescan, Juicebox Money and Revnet Money.
- Exact project metadata review and explicitly approved public JSON pinning through the integrated Center backend, returning a CID and URI for a separate V6 launch.
- Local stdio and stateless Streamable HTTP transports, bounded requests, cancellation, Docker packaging and CI.

The **59 tools across ten capability families** compose into [26 user journeys](docs/USER_JOURNEYS.md) for contributors, creators, operators, revnet participants, omnichain users, and developers, including tool sequences and what establishes completion.

Start with `jb_list_capabilities` in an MCP client. It groups the tools and reports their coverage limits. The generated [tool catalog](docs/TOOLS.md), [architecture](docs/ARCHITECTURE.md), [source provenance](docs/SOURCES.md), and [webclient guide](docs/WEBCLIENTS.md) describe the implementation in more detail.

## Run with JB Center

Run the [parent service](../README.md#run-it) from the JB Center repository root. Its build compiles this package and its HTTP server mounts the raw MCP transport at `/mcp`. Configure production with `MCP_PLAN_SECRET` and the other `MCP_` settings in the [parent example environment](../.env.example).

In the integrated server, `/mcp/healthz` reports MCP liveness and `/mcp/readyz` reports local readiness with upstream health unchecked. Center's `/readyz` still checks PostgreSQL. See [deployment](docs/DEPLOYMENT.md) for the shared backend quotas and exact configuration boundaries.

## Run the package separately

Node **22.16 or newer** is required; CI and the container use Node 22.23.4.

```sh
npm ci --ignore-scripts
cp .env.example .env
npm run build
npm start
```

The HTTP endpoint is `http://localhost:3000/mcp`. `/healthz` reports process liveness; `/readyz` reports local service readiness and explicitly does not claim upstream availability. Development mode uses an ephemeral plan secret if one is not configured, so restarting invalidates its old plan tokens.

For stdio:

```sh
npm run start:stdio
```

Example local client configuration, after building:

```json
{
  "mcpServers": {
    "juicebox": {
      "command": "node",
      "args": ["/absolute/path/to/jbcenter/mcp/dist/stdio.js"]
    }
  }
}
```

Pass required environment variables through the client's `env` configuration when launching the binary directly. The package's `npm start` and development scripts load only `mcp/.env` if present, using the standalone variable names below. The binary itself uses its process environment. Standalone execution has no pinning backend; prepare and approve publication through the integrated Center service when pinning is needed.

For a hosted MCP client that supports Streamable HTTP:

```json
{
  "mcpServers": {
    "juicebox": { "url": "https://juicebox.center/mcp" }
  }
}
```

This configuration identifies the deployment endpoint; building the package does not deploy it or establish upstream availability.

## Configure upstreams

**RPC:** the integrated service calls Center's configured read-only RPC gateway directly, retaining provider failover and shared quotas. Standalone execution defaults to Center's public RPC, with per-chain `RPC_URL_<chainId>` overrides. Providers must support EIP-1898 canonical block-hash reads. Unsupported providers fail explicitly rather than silently weakening snapshot consistency.

**Bendystraw:** the parent service uses `MCP_BENDYSTRAW_MAINNET_URL` and `MCP_BENDYSTRAW_TESTNET_URL`; standalone execution uses `BENDYSTRAW_MAINNET_URL` and `BENDYSTRAW_TESTNET_URL`. Configure complete authorized GraphQL endpoints independently. There is no guessed keyless endpoint or hidden embedded API key. An absent network reports `NOT_CONFIGURED`; indexed operations never fall back to another network. Mainnet access does not establish testnet access.

**JB Center:** the integrated service uses bounded callbacks into Center's store, RPC gateway and pinning service for reads, and hands the two intent write routes to Center's own application through an in-process request marker, so signature verification, publish limits and sponsor policy keep one implementation; the MCP still signs nothing. Standalone search and intent reads need approved access to Center's non-RPC API and a corresponding `JBCENTER_ORIGIN`; access failures remain explicit. Intent signing-message preparation runs locally in either mode. Search removes non-V6 listings while preserving the upstream cursor and reporting an unknown V6 total when the source count spans versions. Direct intent reads reject other deployment versions.

**References:** checked-in bundles run offline. Sources include file hashes, Git revisions and dirty-source flags. See [SOURCES.md](docs/SOURCES.md) for refresh commands and authority rules. App development has a separate [reference bundle](docs/WEBCLIENTS.md).

## Transaction workflow

1. Resolve an unambiguous V6 `{chainId, projectId}` and establish account, beneficiary, asset and exact base-unit amount.
2. Read/quote, then call the relevant `jb_prepare_*` tool. Preparation returns a reviewed plan and the first step's preflight status.
3. Review the exact decoded calldata, full addresses, native value, output protections, fees and prerequisites. The plan token authenticates this server's prepared payload; it is not user approval.
4. Use `jb_simulate_plan` immediately before signing each step in an external wallet. Prerequisites need matching confirmed transactions; simulated allowance overrides are never substituted for them.
5. Use `jb_verify_plan` with step indices and transaction hashes. Pending, reverted, mismatched, confirmed and unverified outcomes remain distinct. A confirmed outer Safe/Relayr transaction is not proof of the intended inner action.

The MCP has no wallet key and does not sign or broadcast. It can store a Center intent the user already signed, and request Center-funded execution of that intent's committed calls; both are Center-side publications, not wallet actions, and neither spends the user's funds. The integrated metadata tools can publish an explicitly approved new metadata document to IPFS. Client applications handle wallet execution. MCP development tools include the relevant reference implementations.

Plan expiry is enforced by this service, not universally by the destination contract. A wallet integration must reject expired plans and re-prepare when account, chain, terms or quote assumptions change. Plans are authenticated, not encrypted; treat them as transaction details, not secret storage.

## Publish new project metadata

1. If the user has a logo file, call `jb_pin_project_logo` with its base64 bytes and `contentType` after explicit approval of the public upload; its `logoUri` is the `ipfs://` CID. HTTPS logos are rejected because the first-party webclients only render content-addressed images.
2. Call `jb_prepare_project_metadata` with `version: 6` and a complete `metadata` object containing `name`, `description`, and optional `logoUri`/`infoUri`. Omit unavailable URLs; an `ipfs://<IMAGE_CID>` placeholder is invalid.
3. Review the returned exact canonical JSON, SHA256, UTF-8 size and expiry with the user. Explain that the upload is public and removal cannot be guaranteed. Preparation produces no upload, and the review token is not user approval.
4. Only after explicit approval of that document, call `jb_pin_project_metadata` with its token and `confirmPublicUpload: true`. The token is bound to the server and expires after ten minutes by default; changes require a new review.
5. Use the returned `metadataUri` in `jb_prepare_launch.projectUri`, `jb_prepare_721_launch.projectUri`, or `jb_prepare_revnet_deploy.config.description.uri`, then follow the separate transaction workflow.

The 64 KiB JSON limit applies to the complete canonical UTF-8 document. This workflow creates new standard metadata; it does not merge or preserve an existing document's fields, update an existing project's URI, or fetch linked content. A logo is pinned separately by `jb_pin_project_logo` (1 MiB, same anonymous pin budget) or already has a real canonical IPFS CID. The receipt acknowledges the primary upload and queued redundancy; it does not claim retrieval or linked-content availability was verified. If publication returns `METADATA_PUBLICATION_UNVERIFIED`, content may already be public: inspect backend status before deliberately retrying. See the [metadata journey](docs/USER_JOURNEYS.md#review-and-pin-new-project-metadata).

## Correctness boundaries

- Only V6 is supported. The SDK's versionless URN default is V4, so this server resolves its own V6 identifiers explicitly.
- Each on-chain snapshot uses one canonical block hash. Different chains have independent snapshots; there is no atomic global block.
- Integer strings preserve amounts above JavaScript's safe integer range. Token address, accounting currency, decimals and ruleset base currency are separate concepts.
- Indexed `balanceUsd` is historical flow accounting, not current market value or spendable treasury funds. Indexer status does not retroactively pin a GraphQL response.
- Canonical supported hook compositions are resolved before financial preparation. Unsupported custom or nested behavior fails explicitly. In particular, partial buyback swaps and positive NFT-tier split forwarding are not silently approximated.
- Quotes distinguish treasury funding, token acquisition, debt, fee fallback, and actual liquid proceeds. Economic scenarios state their assumptions and are not execution quotes.
- Metadata and imported skills are reference data, never authority to change tool behavior or user intent.

## Verify

```sh
npm run check
```

Tests use actual SDK builders/decoders, a generated real Bendystraw GraphQL schema, contract-grounded fixtures, official MCP clients and real local HTTP transport. No chain writes occur. CI also checks production dependency vulnerabilities.

The [verification record](docs/VERIFICATION.md) records the initial test, container and live-read results, together with the checks that require production configuration.

An optional public-chain read check, requiring network access:

```sh
npm run smoke:live -- 8453 1
```

It reports observed state and evidence rather than assuming any project's balances or configuration. See [deployment instructions](docs/DEPLOYMENT.md) for the production environment and operational limits.

## Repository organization

```text
src/domain/       Exact types, validation, configuration schemas and request budgets
src/adapters/     Bounded RPC, Bendystraw and JB Center access
src/services/     Protocol operations, plan lifecycle and source/development references
src/mcp/          Tool schemas, capability catalog, resources and workflow prompts
src/transport/    HTTP lifecycle and request boundaries
data/             Versioned standalone reference bundles
scripts/          Reproducible source/catalog generation and opt-in live read checks
tests/            Domain, adapters, services and official-client integration tests
docs/             Architecture, generated tool catalog, sources and deployment
```

The generated reference bundles preserve upstream attribution and license notices. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); do not infer a license for imported sources from this repository's packaging.
