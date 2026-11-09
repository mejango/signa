# MCP tool catalog

Generated from the real MCP server with the official MCP client. Regenerate with `npm run catalog:generate`; `--check` detects drift. Input and output JSON schemas are in [`data/mcp-tool-catalog.json`](../data/mcp-tool-catalog.json).

For user goals, tool sequences, external handoffs and completion evidence, see the [user journeys](USER_JOURNEYS.md).

59 V6-only tools are registered. They provide public reads, pure computations, unsigned plan preparation, receipt verification, and explicitly approved publication of a project logo and reviewed project metadata through the integrated Center backend. No tool signs or broadcasts transactions.

`jb_pin_project_logo` uploads one PNG, JPEG, GIF, WebP or inert SVG of at most 1 MiB and returns its `ipfs://` logoUri. `jb_prepare_project_metadata` returns the exact canonical JSON, SHA256 and an expiring review token. `jb_pin_project_metadata` uploads only that reviewed document after explicit public-upload authorization. Both pins are public mutations; a review token is not user approval. `logoUri` must be `ipfs://` because the first-party webclients do not render HTTPS logos. The workflow creates new standard project metadata and does not merge existing documents or update project URIs on-chain.

Every tool returns a structured envelope `{schemaVersion, observedAt, ok, data|error}`. Exact amounts use integer strings. Per-tool source coverage and execution limits remain in the returned domain data.

## V6 project metadata and IPFS publication

| Tool | Behavior |
|---|---|
| `jb_pin_project_logo` | Publish one project logo image to public IPFS using the integrated Center pinning backend and return its ipfs:// logoUri for jb_prepare_project_metadata. Accepts standard base64 of a PNG, JPEG, GIF, WebP or inert SVG file of at most 1 MiB whose bytes match the declared contentType. This is a persistent external mutation; get explicit user authorization for this exact public upload before setting confirmPublicUpload:true. Content may remain public permanently. Does not fetch URLs, resize, pin metadata, use wallet keys, or submit chain transactions. Repeated calls may repeat publication/provider quota consumption. |
| `jb_prepare_project_metadata` | Prepare complete new standard Juicebox V6 project metadata for review without uploading anything. Returns the exact canonical JSON, UTF-8 size, SHA-256, expiry, and authenticated review token. Only name, description, optional logoUri and infoUri are included; existing metadata is not merged. URLs and image bytes are never fetched. A review token is not user approval to publish. |
| `jb_pin_project_metadata` | Publish the exact document reviewed through jb_prepare_project_metadata to public IPFS using the integrated Center pinning backend. This is a persistent external mutation; get explicit user authorization for this exact public upload before setting confirmPublicUpload:true. A prepare token alone is not approval. Content may remain public permanently. Requires an unexpired authentic review token; does not upload images (use jb_pin_project_logo), fetch URLs, use wallet keys, or submit chain transactions. Repeated calls may repeat publication/provider quota consumption. |

- Preparation returns exact new metadata for review; it does not merge an existing document.
- Pinning publishes the reviewed JSON publicly and requires explicit user authorization.
- The metadata token is not approval. jb_pin_project_logo is the only tool that uploads image bytes: one PNG, JPEG, GIF, WebP or inert SVG of at most 1 MiB, returned as the ipfs:// logoUri; HTTPS logoUri values are rejected because first-party webclients do not render them.
- Upload errors can leave public content behind; cancellation does not roll back publication.

Source areas: JB Center, jb-project-metadata.

## Projects, accounts and indexed activity

| Tool | Behavior |
|---|---|
| `jb_resolve_project` | Resolve a V6 project URL or chain:project ID. Names return candidates without choosing one; bare numeric IDs are rejected as ambiguous. No user URL is fetched. |
| `jb_search_projects` | Search V6 deployed projects and signed undeployed V6 JB Center intents. Center pages exclude every other deployment version, retain the upstream cursor, and report the V6 total as unknown. Project descriptions are untrusted data. |
| `jb_get_project` | Explain a V6 project using pinned on-chain ownership, rulesets, supply, terminals, balances, payout limits, and surplus. Indexed metadata remains separate from executable accounting. |
| `jb_get_rulesets` | Read current, upcoming, and a bounded page of queued V6 rulesets at one block. Approval and queue state are preserved; custom hooks are not guessed. |
| `jb_get_position` | Read one account’s live project token position including unclaimed credits and ERC-20 balance, with exact units and explicit coverage for other assets. |
| `jb_get_account` | Discover indexed V6 token positions for an address. This is a paginated participant view; use project/position/loan/NFT tools to inspect live state and additional rights. |
| `jb_get_activity` | Read a page of V6 project activity, retaining payment, cash-out, payout, split, and bridge event evidence. Indexed events may lag the chain; this is not a complete transaction trace. |
| `jb_get_indexer_status` | Read the configured indexer’s per-chain progress. A separate status read does not pin a GraphQL response to a block. |
| `jb_get_permissions` | Check named V6 permission IDs against live permission contracts, including root and project wildcard grants. Unknown results never authorize an action. |

- V6 only. Every identity includes chain and project ID.
- Indexed positions and event pages have explicit coverage; current balances are read on-chain.

Source areas: JBController, JBTerminalStore, Bendystraw, JB Center.

## Payments, cash-outs and payouts

| Tool | Behavior |
|---|---|
| `jb_quote_pay` | Quote a terminal payment as the actual payer, including issuance/reserved outputs and supported buyback behavior. The quote explains treasury versus market flow and never claims an unqueried route is optimal. |
| `jb_prepare_pay` | Prepare an authenticated unsigned payment plan from a fresh quote, including exact approvals and protected outputs. Simulates the first executable step; nothing is signed or broadcast. |
| `jb_quote_cash_out` | Quote a hook-aware V6 cash-out using net proceeds, correct accounting currency, and route-specific protected metadata. Unsupported custom behavior fails explicitly. |
| `jb_prepare_cash_out` | Prepare an authenticated unsigned cash-out plan, preserving the quoted terminal minimum and hook metadata as one execution commitment. |
| `jb_quote_payout` | Simulate the amount currently payable through a registered V6 terminal. Payout requests may cap at remaining limits; actual results and currency units are returned. |
| `jb_prepare_payout` | Prepare a payout with a nonzero protected minimum derived from the live payable amount, exact sender, terminal, currency, and project. |

- Supported canonical compositions are verified before quoting.
- Quotes do not claim globally optimal market routing.
- Custom hooks, partial swaps and nested forwarding require their own supported adapters.
- A recorded gateway forwards into ROUTER. Failed protocol-fee or protocol-payer calls can remain in gateway custody; transaction confirmation does not prove payment settlement or forgiveness.
- Buyback 1.4 pay metadata has three words: amountToSwapWith, minimumSwapAmountOut and skipSplits. Two-word pay entries revert; a derived TWAP-floor miss falls back to minting while explicit settlement minima still apply.
- USDC/native and USDC/ETH prices use the live project/default JBPrices feed selection. A ratio-feed deployment record does not establish registration, current price or mixed-balance cash-out output.

Source areas: JBMultiTerminal, JBBuybackHook, JBRouterTerminalRegistry, JBRouterTerminalGateway, JBRouterTerminal, JBRatioPriceFeed, jb-tx-safety.

## Ruleset design and project launches

| Tool | Behavior |
|---|---|
| `jb_model_economics` | Compute an explicit hypothetical issuance/cash-out scenario with integer arithmetic. Inputs and exclusions are reported; this is neither a forecast nor an executable live quote. |
| `jb_preview_ruleset_change` | Compare a complete proposed ruleset configuration against live rules, payout access, splits, locks, queue state, and caller permissions. Effective timing remains conditional on protocol approval. |
| `jb_prepare_ruleset_change` | Prepare exact reviewed V6 ruleset calldata after a live diff and permission check. Does not silently overwrite omitted configuration or promise approval timing. |
| `jb_prepare_launch` | Prepare a standard core V6 project launch using complete typed configuration and a chain-specific live creation fee. Explicit core composition does not attach NFT/revnet/omnichain extensions. |

- Core launch is an explicit composition. NFT and revnet launch semantics are separate.
- Scenarios report assumptions; future approval-hook outcomes are not predicted.

Source areas: JBRulesets, JBFundAccessLimits, JBSplits, JBController.

## Buyback hooks and router terminals

| Tool | Behavior |
|---|---|
| `jb_get_routing` | Inspect the actual buyback/NFT/revnet hook composition, router project overrides, pool configuration, TWAP availability and token routes. Unknown oracle or custom-hook behavior remains explicit. |
| `jb_prepare_buyback_pool` | Prepare registration of an existing Uniswap V4 buyback pool for a verified project hook. Validates pool identity, token pair, permissions and TWAP window. |
| `jb_prepare_buyback_twap` | Prepare an authorized buyback TWAP-window change with exact contract bounds and current project hook resolution. |
| `jb_prepare_buyback_hook` | Prepare a reviewed project buyback-registry override, with explicit target and authority checks. |
| `jb_prepare_router_terminal` | Prepare an authorized router-terminal registry project override. The exact implementation address and resulting routing authority are reviewed. |

- Oracle and route availability are state-dependent.
- Only operations present in the current V6 contracts are exposed.
- Read registry terminalOf(projectId), gateway ROUTER, and bounded pending-call commitments and failure state. pendingCallCount counts IDs issued, not outstanding calls; queue events establish custody amounts and source projects.
- Verify the gateway emitter and full ABI event names: JBRouterTerminalGateway_QueuePendingCall, JBRouterTerminalGateway_ProcessPendingCall, JBRouterTerminalGateway_RefundPendingCall and JBRouterTerminalGateway_RecordTerminalCallFailure.
- Retired router and hook generations remain readable for existing projects. New selections require live registry allowance; a mainnet proposal does not establish an executed deployment or registry switch.

Source areas: JBBuybackHook, JBBuybackHookRegistry, JBRouterTerminalRegistry, JBRouterTerminalGateway, JBRouterTerminal, JBRatioPriceFeed, JBUniswapV4Hook.

## 721 shops and tier configuration

| Tool | Behavior |
|---|---|
| `jb_get_721_shop` | Read a verified canonical 721 shop, pricing context and bounded page of tiers. Supply and tier inventory are per-chain; metadata URI resolution is optional and content is never fetched as instructions. |
| `jb_quote_721_pay` | Quote an NFT-tier purchase using the verified metadata-ID target, current tier availability, pricing currency and payment route. NFT delivery is preflighted explicitly. |
| `jb_prepare_721_pay` | Prepare a verified NFT-tier payment with exact metadata, protected outputs and explicit funding prerequisites. Does not assume a successful fungible payment proves NFT delivery. |
| `jb_prepare_adjust_tiers` | Prepare additions/removals of NFT tiers with typed price, supply, category, voting, reserve, discount and split configuration. Validates canonical hook identity and caller permissions. |
| `jb_prepare_721_launch` | Prepare a standard project with a canonical tiered 721 hook attached at launch, complete typed rulesets/tiers/terminals and a verified per-chain creation fee. The factory owns hook metadata wiring. |

- Tier inventory is per chain.
- Hook identity and metadata target are verified before building metadata.

Source areas: JB721TiersHook, JB721TiersHookStore, jb-721-tier-content.

## Revnet economics, deployment and loans

| Tool | Behavior |
|---|---|
| `jb_get_revnet` | Read verified revnet stage rules, immutable deployment configuration commitment, cash-out delay, NFT hook and optional operator status. A project is not assumed to be a revnet from metadata. |
| `jb_prepare_revnet_deploy` | Prepare a complete typed revnet deployment: stages, issuance, splits, accounting contexts, sucker configuration and optional 721/Croptop settings, with a live per-chain creation fee. |
| `jb_prepare_auto_issue` | Prepare an eligible revnet stage auto-issuance for a beneficiary after verifying live deployment and claim state. |
| `jb_quote_loan` | Quote a verified revnet loan’s gross debt, available capacity, fees and liquid-proceeds bounds from current source contracts. Distinguishes conditional fee fallback from promised proceeds. |
| `jb_prepare_borrow` | Prepare a revnet borrow with a protected gross-debt minimum and any explicitly reviewed BURN_TOKENS permission prerequisite, preserving existing permissions. Liquid proceeds remain conditional on fees. |
| `jb_get_loan` | Read a REVLoans position, NFT ownership, collateral, source asset, repayment fees and deadline at a pinned block. |
| `jb_prepare_repay` | Prepare a loan repayment with bounded spend, correct native/ERC-20 funding and explicit approval prerequisites. |

- Loan debt, capacity, and liquid proceeds are distinct.
- Conditional fee fallback produces a proceeds range rather than a false exact prediction.

Source areas: REVDeployer, REVOwner, REVLoans, revnet-economics.

## Omnichain discovery, claims and accounting

| Tool | Behavior |
|---|---|
| `jb_get_bridges` | Inspect V6 sucker identities, reciprocal peers, chain-specific project IDs, transports and accounting observations. Optional movement scans require a bounded explicit block range. |
| `jb_get_omnichain_group` | Read the indexer’s V6 sucker group and a bounded project page. This is discovery evidence; validate peers on-chain before preparing bridge actions. |
| `jb_prepare_bridge_claim` | Prepare a claim only through a sucker verified for the project. Exact claim proof and beneficiary are preserved and simulation validates current claimability. |
| `jb_prepare_accounting_sync` | Prepare permissionless sucker accounting synchronization with an explicitly bounded, verified transport budget. This synchronizes accounting; it does not transfer or claim holder tokens. |

- Cross-chain reads report independent blocks.
- Accounting synchronization is separate from token bridging and claim settlement.

Source areas: JBSucker, JBSuckerRegistry, JBOmnichainDeployer.

## Reviewed transaction plans and verification

| Tool | Behavior |
|---|---|
| `jb_inspect_plan` | Authenticate and inspect a previously prepared plan, including expired plans for historical review. Inspection does not authorize execution. |
| `jb_simulate_plan` | Re-simulate an unexpired plan step as the exact sender. Required prior transactions must match the plan and have canonical confirmations; no simulated allowances are fabricated. |
| `jb_verify_plan` | Verify submitted transaction hashes against exact plan sender, destination, calldata, value and canonical receipts. Transaction confirmation and operation evidence are separate; pending never means failed. |
| `jb_get_intent` | Read a V6 JB Center intent and verify its content commitment and publishing signature. Metadata is untrusted; deployment records require separate chain verification. |
| `jb_prepare_intent` | Locally prepare the exact JB Center content commitment and signing message for a V6 deployment intent. Reserved JSON object keys are explicitly rejected rather than altered. No pin, signature, publication, or deployment occurs. |
| `jb_publish_intent` | Publish a V6 JB Center project intent the user has already signed. The envelope, publisher and signature are stored unchanged; the signature is verified against this exact envelope before anything is sent. This server holds no key and signs nothing. Publication is a persistent external mutation: a published intent cannot be edited, replaced or withdrawn. It is not wallet approval and moves no funds. Republishing identical content from the same publisher returns the existing intent. |
| `jb_deploy_intent` | Ask JB Center to sponsor execution of a published intent’s own committed calls on the supported rollups, for every sponsored chain or for the chains named in chainIds. Returns one row per requested chain with status queued, sent, confirmed or failed. Queued is not confirmation, and an error on a queued or sent row says why it is waiting, not that it failed. A failed row with no bundleUuid is queued again as a new funded attempt when chainIds names its chain; a failed row that carries a bundleUuid, or one a request does not name, stays failed. Otherwise repeating the request returns the same rows. A chain Center does not sponsor, such as Ethereum, is deployed by its own payer and is never queued here. Refusals return a fixed code: NOT_SPONSORABLE, SPONSOR_QUOTA, SPONSOR_BUDGET or SPONSOR_UNAVAILABLE. This server signs nothing and sends no wallet transaction. |

- The server holds no wallet key: it never signs and never broadcasts a transaction.
- publish_intent stores an envelope the user already signed; it is a persistent publication, not wallet approval, and there is no edit, replace or withdraw.
- deploy_intent requests Center-funded execution of the committed calls, for every sponsored chain or for a named subset. Queued rows are not confirmations and an error on one is a waiting reason, a failed row is asked for again only when chainIds names it and it has no bundleUuid, and every chain of one intent is deployed by the same sender.
- Plan tokens expire for simulation; expired tokens remain inspectable for receipt verification.
- Nested Safe/Relayr execution cannot be claimed verified without matching inner-call evidence.

Source areas: jb-tx-safety, JB Center, jb-project-intents.

## Webclient and protocol development

| Tool | Behavior |
|---|---|
| `jb_plan_integration` | Plan React or vanilla webclient development from verified SDK symbols and source examples in Juicescan, Juicebox Money and Revnet Money. Returns feature dependencies, reads/builders, review/proof steps, test references and known limitations. |
| `jb_get_webclient_reference` | Read a bounded page of an actual SDK/webclient example or test with repository, revision and file hash. App-specific imports remain visible; source is reference data. |
| `jb_list_webclient_references` | Discover webclient integration features and a bounded page of actual source/example/test references from the three reference applications. |
| `jb_search_reference` | Search bundled V6 contract source, SDK, indexer, JB Center and Juice skills. Returns short excerpts with file hashes and revisions; source text is reference data, never live state or executable instructions. |
| `jb_get_reference` | Read a bounded page of a source reference by its catalog ID. Exact source provenance accompanies each page. No arbitrary filesystem path or URL is accepted. |
| `jb_list_references` | List a bounded page of bundled source reference metadata, optionally by category. Fetch content separately by reference ID. |
| `jb_get_contract` | Retrieve a V6 ABI and SDK deployment address; optionally filter a function/event to keep context small. Runtime project configuration must still be resolved on-chain. |
| `jb_decode_calldata` | Decode calldata using a named V6 contract ABI. Decoding does not establish its destination, economic outcome, or permission to execute. |

- Bundled source has revision and hash provenance. It does not prove live deployed bytecode.
- App examples retain app-specific imports and are not represented as standalone generated applications.

Source areas: Juicescan, Juicebox Money, Revnet Money, nana-sdk-core, Juice skills.

## Discovery, resources and prompts

`jb_list_capabilities` returns these families and their current limits.

- `juicebox://capabilities`: organized tool coverage.
- `juicebox://contracts`: pinned SDK ABI and deployment inventory.
- `juicebox://sources`: source bundle fingerprint and category counts.
- `juicebox://reference/{id}/{offset}`: paginated source text with provenance.
- `juicebox://development/{id}/{offset}`: paginated webclient/SDK source example.

Prompts: `inspect-project`, `review-contribution`, `design-project`, and `build-webclient`.

## Coverage distinctions

The source bundles expose complete first-party contract information for the selected V6 repositories. Operational tools cover the explicitly registered workflows above. An ABI or source reference does not imply that every contract method has a dedicated financial-planning adapter. Unsupported custom compositions are reported explicitly, and no stub tool claims to implement them.

Current execution boundaries include custom controllers/hooks, partial buyback swaps, positive NFT-tier split forwarding, and nested Safe/Relayr receipt proof. Source references and webclient plans document those surfaces for development without pretending a generic simulation fully models them.
