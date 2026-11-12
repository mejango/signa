# Retire a refused payment approval and review a fresh one at once

jango, 2026-10-20: "go ahead and do the queued real fix". Follows PR #18 (4162e5a) and Codex review 7.

## Plan refinement

- **Objective:** After Signa refuses to send an approved passkey payment, the payer sees the reason and can review a fresh payment within seconds instead of waiting on a held approval, and no pair of approved payments can both execute.
- **System fit:** Outcome (one paid payment) <- operation record in `rest_user_operations` (owner of send authority: `claim`) <- review store (`paymentReviewsPostgres`, resends on reopen while `prepared`) <- wallet client journal (`walletPayments.ts`, terminal states gate `clearPayment`). A new terminal operation state `retired` is written under the same row lock `claim` takes, so a retired operation can never be claimed, resent on reopen or approved again; until the chain settles a retired operation (nonce unchanged on a canonical head past validUntil + 120 s, or Signa's own holder of its nonce executed in a successful bundle), any preparation or claim from that Safe, under any account or nonce key, must use its exact nonce, so the EntryPoint lets at most one run. Claim rechecks the set under a per-sender advisory lock. Unaffected: observation, expiry proof, sponsorship, the review ceremony.
- **Reuse and simplicity:** Reuse the row lock and `claimed()` state gate, the review store's existing `state === "prepared"` checks, the client's `receiveOperation` state mapping and `terminal()`; the head nonce and canonical evidence `prepare` already reads; the expiry margin rule (`validUntil + 120 s` on a canonical head) from `execution.ts`. New: one store method pair (`retire`, `retired`), one route, one migration line, one client state `refused`. No auto-retire on the server: the client retires only after a server-answered refusal, so a lost response never kills an approval that may be sending.
- **Evidence and unknowns:** Codex review 7 (replica claim during diagnostics, reopen resend, next-nonce double execution); source of `claim`, `get`/`approve`/`sendApproved`, `prepare`. Ceiling: a nonce consumed outside Signa with no Signa holder to prove it blocks further operations from that Safe (fail closed); it needs a leaked signature or a hostile app. Homerun needs center-wallet 0.3.8 and `refused` in its terminal list to show the fresh review.
- **Verification:** New tests that fail on main: retire vs claim race both orders (memory + PostgreSQL), reopened approval page does not resend a retired operation, fresh preparation refused when the retired nonce moved during its window and allowed at the same nonce or after a canonical window end or when a Signa-executed operation holds the nonce, reorged window evidence refuses, client refused submit becomes `refused` at once and a fresh review prepares immediately. Gates: typecheck, build, vitest (PostgreSQL suites locally on a scratch PG 14 and in CI on PG 16), Codex gpt-6.1-sol adversarial review until SHIP.
- **Resource budget:** One worktree off origin/main, edits limited to user operation store/service/route, review store untouched unless a test shows otherwise, client journal, docs enums. Replan if Codex shows the nonce guard blocks ordinary back-to-back payments or a retire path can race a claim.

## Work items

- [x] Migration 061: `retired` in the operation state check, never with a submission; partial index on unsettled retired rows
- [x] Store: `retire` (row lock + sender lock, no-op with a submission), `retired` across accounts, `settleRetired`, `nonceHolder`, `claimed` refuses retired, claim rechecks retired set
- [x] Service: `retire`, early refusal of retired in `submit`/`submitApproved`, `retiredClear` in `prepare` and admission
- [x] Route `POST /user-operations/{id}/retirement` + OpenAPI + TRANSACTIONS.md
- [x] Client: `refused` state, retire after a server-answered (>= 400) submit refusal, `retirePayment()`, approved branch maps retired, README recovery
- [x] Tests; typecheck, build, vitest, PG suites on local PG 14
- [x] Codex SHIP (pass 5)
- [ ] CI green, merge

## Review

- Before: a refused approval stayed `prepared`; the client journal sat at `unknown` and `clearPayment()` refused until the grant ended and the signed window (about 5 minutes) passed, so the payer waited or was stuck in that tab.
- After: refusal answer plus one retirement round trip (under a second in tests), the journal reads `refused`, `clearPayment()` and a fresh review work at once, and the fresh payment reuses the same nonce.
- Codex pass 1 FIX (6 findings) addressed in 3ffeffa: proof-only settlement, outer receipt success, claim-time recheck under a sender lock, alias-wide lookup, exact full nonce across keys, README recovery.
- Codex pass 2 FIX: session retirement refused (no signed deadline). Outer-revert reservation is main's behavior; an observer change for it caused regressions in pass 3 and was reverted, left as a follow-up.
- Codex pass 4 FIX: retirement requires an approved payment review and live relay authority in the transaction. Pass 5 SHIP.
- Follow-up: an outer-reverted bundle keeps its nonce reservation forever (main behavior); fix needs plan-step and session-aware expiry together.

# Move nana-sdk-connect into @me.jango/signa, and ship #20 plus SDK-derived payFailure flags in 0.4.0 (2026-10-20)

jango ruled 2026-10-20: all of `@bananapus/nana-sdk-connect` (core, wagmi, react, including the modal's
plain external-wallet option) moves into `@me.jango/signa` as `/core`, `/wagmi`, `/react`; the SDK
package is then deprecated.

## Plan refinement

- **Objective:** A consumer switches from `@bananapus/nana-sdk-connect/{core,wagmi,react}` to `@me.jango/signa/{core,wagmi,react}` by changing only the import specifier (same export names, same behavior, same protocol strings), Signa 0.4.0 is on npm with provenance, nana-sdk-connect gets a final "moved" patch plus an npm deprecation, and Sticky runs on Signa 0.4.0; Homerun is untouched (report only).
- **System fit:** Outcome (sign in with a Signa passkey or an external wallet) -> capability (connect controller, passkey option, popup/frame callback, read-only wagmi connector, modal) -> owner moves from juice-sdk-v4/packages/connect to signa/wallet-client, next to the wallet client and server whose protocol strings it must match -> publish via the existing CI-gated publish.yml (provenance) -> verified by npm view + clean-install import of every subpath -> consumers Sticky (switched here) and Homerun (its agent switches after #53). Server, payment review, PR #20 server files and the root wallet client code are unaffected.
- **Reuse and simplicity:** Port the SDK source and tests verbatim (only the `@me.jango/signa` self-import becomes a relative import of `src/rest/client/wallet-package.ts`, built as `../index.js`); reuse the existing esbuild + rollup-plugin-dts build in scripts/rest/build-client.mjs and the existing publish workflow; no new abstraction. React, wagmi, jsdom and coverage join as devDependencies only; React and wagmi are optional peers. User-visible copy that names the destination ("Juicebox Center", "Juicebox account") says Signa, matching the Signa pages the user lands on; wire ids and message types (`juicebox-center`, `juicebox-center:*`) stay.
- **Evidence and unknowns:** Source of truth is juice-sdk-v4 main 8fc9bb4 (connect 0.6.0, on npm). Signa main c64a0ab (0.3.8 on npm). Unknowns to settle by test: whether the connect code passes Signa's stricter tsconfig flags, whether rollup-dts renders the relative re-export cleanly, wagmi devDependency weight in the Docker build stage. Root entry must be byte-identical before and after (diff the built index.js and index.d.ts).
- **Verification:** connect vitest suite with the SDK's coverage bar (100/95/100/100) in the release check; tsc for connect; `npm run check` green in CI; root bundle byte-diff; packed tarball installed into a clean directory resolving `.`, `/core`, `/wagmi`, `/react` (ESM import + tsc types, root import without react/wagmi installed); Codex gpt-6.1-sol adversarial review to SHIP; after merge, npm view shows 0.4.0 with provenance attestation; Sticky full gates under Node 26 + npm 12 and CI green.
- **Scope added mid-task (coordinator):** ship #20's client changes (`refused`, `retirePayment()`) in the same 0.4.0; make the client's validated `payFailure` the SDK decoder's own `PayFailure` (bigint amounts, `zeroFill`, `adjustable`) so Homerun drops its revert-data rebuild. Wire payload stays strict (served flags rejected); `observation.payFailure` keeps the served form so storage stays JSON; d.ts inlines the SDK types.
- **Resource budget:** One Signa PR, one SDK PR, one Sticky PR, each in a fresh worktree under the session scratchpad; no edits to PR #20 server files; rebase if #20 merges first; replan if the stricter tsconfig or the dts build forces source changes beyond types, or if Codex finds behavior issues needing a design change.

## Steps

- [x] Signa: port connect source + tests to wallet-client/src/{core,wagmi,react}, own tsconfig + vitest config with coverage bar
- [x] Signa: build subpaths in build-client.mjs ("use client" banner on subpaths only), exports + optional peers in wallet-client/package.json, bump 0.4.0
- [x] Signa: wire connect typecheck + tests into `npm run typecheck` / `npm run check`; update rest-wallet-package test
- [x] Signa: README updates (wallet-client README carries the connect docs; Center -> Signa where Signa is meant)
- [x] Verify root bundle unchanged by connect, clean-install resolution of every subpath
- [x] Rebase on #20; client payFailure = SDK PayFailure with flags; d.ts inlines SDK types; clean-install interop with payRetrySlippageBps
- [ ] Codex review until SHIP; PR; merge when green; confirm 0.4.0 + provenance on npm
- [ ] SDK: final nana-sdk-connect patch (README: moved), changeset, merge, publish; npm deprecate (or hand jango the command)
- [ ] Sticky: switch web/ to @me.jango/signa@0.4.0, gates on Node 26 + npm 12, merge when CI green
- [ ] Report Homerun import changes

## Review

(filled in at the end)

# Release the nonce of a payment whose whole bundle reverted

jango, 2026-10-20: fix the PR #20 follow-up now ("bad UX is bad security"). Codex: a fix must cover plan-step settlement and session expiry together.

## Plan refinement

- **Objective:** When canonical evidence (outer receipt status 0 at the confirmation depth, block rechecked canonical) shows a payment's whole bundle reverted, the payer sees it failed and why, and a fresh payment from that wallet is reviewed and sent at once; no Signa path resends the reverted bytes and no two payments can both execute.
- **System fit:** Chain evidence (`observeUserOperation`, unchanged verdict `reverted`) -> operation record and nonce reservation (`rest_user_operations`, `rest_user_operation_nonces`; store `observe`) -> admission guard (`retiredClear` in prepare and claim, PR #20) -> plan step (`refreshExternalStep`, unchanged: reverted settles the step failed as on main) -> client journal (`reverted` is already terminal, so `clearPayment()` and a fresh review already work; untouched). Facts: EntryPoint v0.7 `handleOps` reverting rolls back every nonce increment, so the chain nonce is still the operation's, and its signed bytes stay executable until their deadline. So the reservation is released, and the operation joins PR #20's unsettled set: until the chain settles it, any preparation or claim from that Safe, under any account or nonce key, must use its exact full nonce (the EntryPoint runs at most one), and it settles on an unchanged nonce on a canonical head past its enforceable deadline + 120 s, or on a successful outer execution by Signa's own operation at that nonce (the reverted one itself included, if re-included). Session expiry: a session signature binds no deadline, so a session operation's enforceable deadline is its sponsor's signed paymaster window (sessions are always sponsored); the local preparation expiry no longer expires a session operation or settles its plan step early. Unaffected: claim, retire, review ceremony, sponsorship, client.
- **Reuse and simplicity:** Reuse PR #20's unsettled set, `retiredClear`, `settleRetired`, claim recheck (`assertRetiredChecked`) and lock order; the existing `expired` release path; the paymaster policy's own `inspect` for the sponsor window. New: one record field `nonceReleasedAt`, one deadline helper used by observation and settlement (one home), one migration (index, plus releasing reservations already stuck in production), and a conditional delete in the memory store so a late expiry never drops another operation's reservation.
- **Evidence and unknowns:** Source: `execution.ts` (outer status 0 -> `reverted` only at depth after `chain.canonical`), `postgres.ts`/`memory.ts` (release only on `expired`), `paymentReviewsPostgres.unspent` (refuses a reserved nonce), provider `inspect` (Pimlico validUntil from paymaster data, enforced by the EntryPoint as AA32), `prepare` (sessions require sponsorship). PR #20 pass 3: changing the observer verdict regressed plans and sessions, so the verdict stays as on main. Ceiling kept from PR #20: a nonce consumed outside Signa with no Signa operation to prove it fails closed.
- **Verification:** Tests that fail on main, memory and PostgreSQL: whole-bundle revert releases the nonce and a fresh payment at that nonce claims and sends, the reverted bytes are never sent again; a revert seen before its depth or on a reorged block releases nothing; after release a payment on another nonce key waits for settlement, and a reorg of the revert evidence keeps the guard; plan step settles failed and the plan accepts a fresh plan; a session operation is not expired at its preparation expiry while its sponsor window is open and is expired after it. Gates: typecheck, build, full vitest, PostgreSQL suites locally (PG 14) and the release gate in CI (PG 16), Codex gpt-6.1-sol until SHIP.
- **Resource budget:** One worktree off origin/main; edits in `src/rest/userOperations` (store, memory, postgres, service), one migration, tests, TRANSACTIONS.md if it documents the release rule. No client or Bendystraw changes. Replan if Codex shows the release lets two payments execute or blocks ordinary back-to-back payments.

## Work items

- [x] Store: `nonceReleasedAt`; `observe` releases the reservation on a canonical whole-bundle revert (memory and PostgreSQL); memory releases only its own reservation; unsettled set includes released operations
- [x] Migration 062: sender locks, index on unsettled released rows, release (and hold unsettled) rows already reverted by a whole-bundle revert
- [x] Service: one enforceable-deadline helper for observation and settlement; settlement accepts Signa's own execution at the nonce, the released operation included
- [x] Tests (memory + PostgreSQL), typecheck, build, vitest
- [x] Codex SHIP (pass 4)
- [ ] PR, CI green, merge

## Review

- Before: a whole-bundle revert left the payment `reverted` but its nonce reserved forever; the fresh payment was prepared at the same nonce (the revert rolled it back) and every claim failed `USER_OPERATION_NONCE_CONFLICT`, and payment-review creation refused it. A session operation was expired at its local preparation expiry, which its signature does not bind, settling its plan step failed while it could still run.
- After: the payer sees `reverted` with "The entire EntryPoint bundle reverted.", clears it and a fresh payment is reviewed and sent at once at the same nonce. Until the chain settles the reverted one, other nonces from that Safe wait (same rule as retired approvals). Session operations expire only past their sponsor's signed window.
- Codex pass 1 FIX: release took no sender lock (cross-key claim race); migration settled old rows by wall clock. Pass 2 FIX: one failed candidate refresh blocked settlement. Pass 3 FIX: settlement missed an already-settled executed operation at the nonce; migration bypassed the claim's sender lock. Pass 4 SHIP.
- Ceiling (kept from PR #20): a nonce consumed with no Signa execution to prove it fails closed; a session operation with an unreadable sponsor window holds its wallet to its nonce until settlement evidence exists.
- Verification: new tests fail on main (memory service: revert release and fresh send, reorg and late inclusion, sponsor-window session expiry with plan step, session revert, failed-candidate settlement, re-reverted replacement; PostgreSQL: release, sender-lock race, sentAt, reorg, expiry, inner revert, migration backfill; payment review on PG 16 checked locally on a PG 14 copy). typecheck, build, full vitest (3944 passed); PostgreSQL user operation, transactions, sessions, sponsorship, smart account and core suites on local PG 14.
# Signa ownership cleanup

Required shared resources: `/Users/jango/Documents/jb/v6/evm/AGENTS.md`, `/Users/jango/Documents/jb/v6/evm/workflow/ponytail/SKILL.md`, `/Users/jango/Documents/jb/v6/evm/workflow/ponytail/README.md`, `/Users/jango/Documents/jb/v6/evm/docs/PLAN_REFINEMENT.md`, and root `tasks/lessons.md`; local `AGENTS.md` and `mcp/AGENTS.md` apply.

## Plan refinement
- **Objective:** Make Signa own only accounts/wallet execution and obtain protocol primitives from the SDK and hosted protocol preparation from Center; delete unused inherited Center server functionality without changing Signa authority, reviewed bytes or recovery.
- **System fit:** Apps already use Signa apart from separately planned jbm/revnet/juicescan transitions. Center supplies protocol preparation and reference data; SDK owns portable verification and encoding; Signa validates, approves, executes and recovers locally. No Center account-history migration is required.
- **Reuse and simplicity:** Replace copied MCP service construction with a bounded Center protocol adapter and SDK outcome verification; retain Signa's existing auth/transaction services and pinned execution evidence. Delete unused top-level Center routes/assets/tests and MCP transport instead of retaining compatibility layers.
- **Evidence and unknowns:** Fresh origin/main 5c4762a imports @juicebox/mcp/host at eight source modules. Runtime needs prepare operation metadata, exact-head optional preparation and semantic outcome checks. Center API and SDK export seams are being coordinated before replacement; live behavior is not inferred from source.
- **Verification:** Run the complete typecheck/build and affected protocol, execution, wallet, route and client tests; run required release checks where dependencies are available. Test malformed/mismatched/failed Center responses fail closed and exact call evidence survives. No deployment or database mutation.
- **Resource budget:** Delegate disjoint unused Center pruning while root coordinates cross-repo SDK/API seams; use bounded compiler-driven dependency deletion. Preserve authority and transaction modules unchanged unless integration demands a narrow adapter.

- [x] Inspect active dependencies and report API/SDK requirements to root.
- [x] Remove unused inherited Center server surface and build assets.
- [x] Replace copied MCP services with Center adapter and SDK protocol verification (cross-repository SDK candidate pending packed verification).
- [ ] Verify routes, execution, build and client compatibility; document results.

### Cleanup implementation review, verification in progress

- Committed behavior-preserving wallet canonical JSON extraction as `744dae0`, keeping enrolled commitment bytes unchanged.
- Deleted inherited Center HTTP/directory/publication/pinning/sponsor and MCP implementation, plus unused protocol read/indexer/omnichain code and intent storage; retained internal RPC transport and local contract proof resolver because Signa execution uses them.
- Account/credential/approval/nonce/recovery implementation stays local. Applied SQL history remains intact; no live database changes.
- Focused evidence so far: wallet HTTP/docs 45 pass, actual catalog docs 18 pass and browser 3 pass; local resolver 15 pass; transaction-store 28 pass; RPC transport 73 pass; real local SDK-built P256/Safe/EntryPoint/V6 payment execution 5 pass.
- Full typecheck/build/release suite awaits the SDK candidate's new portable evidence export and disposable PostgreSQL16 fixture. The current committed registry pin does not yet contain that export; release coordination is required before deployable lockfile verification.

### Implementation review and release verification status
- Removed inherited Center HTTP, directory, intent/publication/IPFS, sponsor and MCP runtime, copied read/indexer/omnichain services, unused storage/interfaces/dependencies and build/CI packaging. Applied SQL migrations remain intact.
- Signa retains identity, passkeys, grants, approvals/nonces, reviewed call bytes, direct RPC, simulation, exact execution and recovery. Local contract catalog and runtime provenance remain because session-target authorization consumes them. The SDK owns portable outcome verification; fixed Center public preparation supplies unsigned plans. Static reviewed operation descriptors preserve offline startup/recovery. Center remains trusted for protocol routing, quotes and constructed metadata; explicit request fields and actual calldata are bound/reviewed locally.
- Independent adapter and backend reviews found no outstanding actionable issues. Focused route/docs/RPC/store/resolver checks pass, real P256/Safe/EntryPoint/V6 execution passes; actual Signa entrypoint2/2 and SDK semantic boundary5/5 pass.
- Reviewed local SDK candidate6.3.1 SHA1 bab8f2fb99b4b1a64a43cd27d082eb1a1c99e965 is the only dependency differing from the committed lock. Node22.23.4 typecheck, execution53Foundry tests, passkey34stack tests plus256fuzz, and connect41tests passed in the required gate. Gate2026-11-11T17-53-56.076Z-3528ae09 timed out at the service10minute deadline after83files/2497tests under hostload around49; source fingerprint stayed unchanged. Five auth timing failures all pass unchanged when isolated; full79test auth rerun is pending.
- Remaining: coordinated complete release gate at reduced file concurrency, final artifact build, published SDK dependency and registry lock before deployable clean-lock verification. The local tarball contains a new export absent from registry6.3.1; the current3.5.2 manifest pin is not a deployable final dependency. No deployment, publication, merge or live database change performed.
- Runtime assessment is separate from compatibility evidence: Node26.13.1 is current Active LTS with November security fixes; existing22.23.4 is superseded by22.23.5. Official new-patch Docker tags were unavailable at18:00UTC. Verify and test the chosen patched container before any deployment.

- Complete unchanged login/handoff PostgreSQL suites now pass79/79 in123.05s at one worker, /tmp/signa-cleanup-auth-full.log. No per-test clock or harness deadline changes were needed. Other heavy consumer/service stages are held for the next complete Signa gate.

### Production packaging review and final verification schedule
- The service-only aggregate test budget is now twenty minutes; individual test, RPC, SQL and authority deadlines are unchanged. Concurrent runs still encountered host contention, so the final full service check will run with the normal four workers as the only local heavy job after app verification. Three failed cases from the interrupted contended run passed unchanged in isolation (3/3, 29.01s); the interrupted run did not flush assertion stacks or its final JSON and is not a passing release observation.
- Commit d073209 promotes the existing exact zod4.6.7 from a development dependency to a direct production dependency. The runtime had relied on abitype's optional peer retention after removing MCP. No installed version or candidate artifact changed.
- Production build passes. A disposable production-only offline installation contains40packages, with only the reviewed SDK candidate overlaid and no MCP, tsx or Vitest. Built module imports, the packaged18operations/298contracts and actual dormant HTTP smoke pass (health200, readiness/API/wallet503 as expected while disabled). The runtime dependency audit follows204entrypoint modules and9external packages, with no undeclared runtime dependencies. Evidence: /tmp/signa-production-smoke.log and /tmp/signa-runtime-dependency-audit.json. This is production package/startup evidence, not a deployed active-service or container claim.
- Before deployment: publish the reviewed SDK export and update real registry locks; verify a patched supported Node image and runtime. Existing22.23.4 is superseded by the November security patch. Preferred target26.13.1 Active LTS and supported fallback22.23.5 await a verified image digest and compatibility checks. No production runtime pin, deployment, database migration or publication has been performed.

### Final gate finding and narrow correction
The exclusive run at6e22a26 completed all4,065 collected service tests successfully, but its202nd file was an orphaned Center production-monitor test importing the already deleted scripts/check-production.mjs. The deleted script targets juicebox.center and MCP readiness and has no active Signa package/workflow caller. Remove that obsolete test and correct the stale production-operations documentation reference; preserve the explicit absence of a scheduled Signa monitor and the separate retained zero-value execution-check CLI. This is deletion completeness, not a waived active-service test. Run focused retained CLI checks and the complete exclusive release gate again before SDK publication. Original failed observation2026-11-11T20-02-41.687Z-0651e737 remains evidence, not a passing gate.

## Retained unsigned execution-check CLI repair
## Plan refinement
- **Objective:** Preserve the documented unsigned zero-value execution-check command after removing Signa's copied read/preparation services. Keep the existing canonical zero-self-permissions and deployed-wallet requirements; no signing or submission is added.
- **System fit:** Signa's retained catalog/runtime resolver establishes the canonical JBPermissions target; the SDK ABI and direct RPC establish permissions at the same block; Signa's existing validated Center adapter supplies the unsigned contract_calls plan. Account approval and execution remain separate and unchanged.
- **Reuse and simplicity:** Reuse createProtocolReadService.resolve, SDK jbPermissionsAbi, viem encode/decode, the same canonical wallet-code check and createSignaProtocol.prepare. Implement only this specific read needed by the CLI; do not restore a general protocol read server or add a package. Correct three documentation ownership/wire-literal errors identified by the bounded review.
- **Evidence and unknowns:** The current JavaScript CLI calls removed read/prepare methods, while its fake-only unit tests missed the integration break. All26tracked mjs files were inspected and no other removed-interface callers remain. The stopped run2026-11-11T20-14-42.621Z-22ed3648 is interrupted evidence, not a release pass.
- **Verification:** Exercise the real retained resolver/catalog and Signa preparation adapter against scripted RPC/fetch, preserving failure on nonzero permissions, bad canonical evidence and undeployed wallets. Include actual built CLI entrypoint coverage through the existing post-build test hook. Run focused checks, then the complete exclusive release gate before releasing the SDK merge hold.
- **Resource budget:** One narrow CLI repair and three documentation corrections, with existing test/build infrastructure and no new monitoring feature. Source remains frozen during the final gate; no other heavy jobs until it completes.
- [ ] Repair the CLI owner wiring and add the real-adapter/built-entrypoint regression.
- [ ] Correct RPC ownership, exact signing-domain literal and supported-operation documentation.
- [ ] Pass the complete exclusive release check and hand the actual result to the SDK release owner.

### Candidate release gate review, completed
- [x] Repaired the retained unsigned execution-check CLI using the local provenance resolver, SDK ABI and validated Center preparation adapter. Its real built entrypoint passes with fetch-only simulation; the existing disposable fresh-build regression passes under unchanged limits. Independent review found no actionable issues.
- [x] Corrected Center public-RPC ownership, Signa supported-operation selection and the unchanged EIP-712 signing-domain literal. Bounded review of all26tracked mjs files found no other removed-interface callers.
- [x] Full required gate passes at clean078b75a21192970e0d0ff7c0efc01d30463d7e61: all201service files and4,066tests, connect41, execution53Foundry tests plus5target-evidence checks, passkey34stack tests plus256fuzz runs, typecheck, required V6 sources and final production build. No skipped required evidence. Source fingerprint5f09859b00a289842f41f489487f851c121b2e19676dd56bea7334fac9bfd97d remained unchanged throughout.
- Observation: .generated/checks/2026-11-11T20-26-46.789Z-1c20042b/summary.json; log /tmp/signa-cleanup-check-cli-final.log. Earlier interrupted/failed observations remain preserved and are not relabeled as passes.
- The user explicitly authorized SDK implementation PR302 merge and the generated version PR merge/publication when ready. Root released that hold after verifying this terminal result. Actual published SDK dependency/registry lock and clean-install service verification remain pending. Signa merge/deployment is not authorized by that SDK release instruction.
- Runtime follow-up remains separate: official node:26.13.1-bookworm-slim is now available with OCI index digest sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1. This gate used22.23.4; no patched-runtime compatibility/deployment claim is made.

### Independent patched-runtime assessment
Official checksum-verified Node26.13.1/npm11.20.0 passed the V6 fixture, execution, passkey, typecheck and connect41 stages at cleanf209f79. Optional service assessment was deliberately stopped under measured hostload57.53 on10cores with unrelated work; observation2026-11-11T21-14-54.275Z-8e942601 records unchanged source, interrupted service without its final JSON and no final build. No complete Node26 compatibility or Linux-container claim is made, and no runtime pins/defaults changed. This does not alter the passed Node22 candidate release gate or the user's SDK publication authorization. Actual registry dependency/clean verification remains pending publication.


## Complete cleanup with the published SDK (2026-11-12)
## Plan refinement
- **Objective:** Finish Signa cleanup with the verified published core SDK and reproducible registry lock, leaving the concrete service change in draft PR52 without service merge or deployment.
- **System fit:** The published portable verifier supplies Signa's existing semantic validation. Center preparation, Signa account authority/execution/recovery and the reviewed18-operation boundary stay unchanged. Verified registry artifact, generated lock, clean installation and full service evidence complete the candidate-to-release chain.
- **Reuse and simplicity:** Update only the existing exact core pin and npm-generated lock, preserving every unrelated locked dependency and the pending journal assessment. No new runtime, source, tooling, account migration or release mechanism.
- **Evidence and unknowns:** Candidate full gate at078b75a passed all seven stages. Current manifest/lock core3.5.2 lacks the required export, while installed6.3.1 is the reviewed overlay, not the public registry release. SDK Version Packages PR303 merged as7fce09a6 and normal publication43149479673 succeeded; root's registry integrity/parity/provenance handoff is required before installing core6.4.0.
- **Verification:** Inspect minimal generated manifest/lock diff, actual registry integrity and new export. Clean npm ci --ignore-scripts, full npm run check using declared Node22.23.4/npm10.9.9, disposable PG16 and Foundry1.7.0, and production audit. Freeze source during checks and record stable source fingerprint; inspect fresh main and draft PR checks before push. Root remains sole journal writer.
- **Resource budget:** One clean install/full check in the exclusive slot after Center. Preserve per-test/domain deadlines and original timing evidence. Reuse complete consumer evidence if published runtime parity is verified. Replan on material artifact/dependency/source drift; no optional runtime upgrade or broad app rerun.
- [ ] Receive root's verified release identity and exclusive slot.
- [ ] Generate and review actual registry manifest/lock changes.
- [ ] Clean install and pass full required service gate and production audit.
- [ ] Update the existing draft PR with final evidence, preserving deployment authority boundaries.

### Published-registry review
- [x] Verified actual core6.4.0 publication at SDK7fce09a6 and exact registry integrity; updated existing pin and generated npm lock. Only root/SDK lock records changed;247unrelated locked records are unchanged.
- [x] Clean npm ci --ignore-scripts installed198packages; all1931SDK files match the verified public tarball SHA25682939d54cfc6246eb91e4e96a8c75a6394ebe7827d77ef5b79a74c2b848359ed. ESM/CJS operation-evidence exports resolve.
- [x] Full required gate passed at clean074539215c92d5e23e8ed20fd777bd87ab0ba057 in320.217s:201service files/4066tests, connect41, execution53Foundrytests plus5target evidence,34passkey stack tests, required V6 sources/types/productionbuild. All seven stages passed, no required evidence skipped. Source fingerprint684a3e1bd66c16addb4d115fd23ae7fe76fb4bb3b1d9e435fdc9af195c6295f8 remained unchanged. Observation .generated/checks/2026-11-12T04-09-43.526Z-0aec4c90/summary.json; supporting records /private/tmp/signa-registry-20261112/{final-gate-verification,installed-artifact-verification,lock-verification}.json.
- [x] Production audit passes the declared high/critical threshold with zero high/critical and one unchanged moderate @hono/node-server GHSA-rmxm-3fg6-px4f advisory. Existing server uses getRequestListener, with no serveStatic caller found. This is not a vulnerability-free dependency graph claim.
- Final evidence is journal-only after the frozen source run. DraftPR52 remains the delivery surface; fresh remote review/push/CI follow. Declared runtime remains Node22.23.4/npm10.9.9. Patched-runtime evaluation remains incomplete, and this local result does not prove a Linux image/deployment. No service mainmerge, production deployment or live database mutation.


## Diagnose and repair the post-merge Signa fixture race (2026-11-12)
## Plan refinement
- **Objective:** Resolve the concrete Signa main CI failure discovered while answering the user's follow-up about remaining work. Preserve full account/contract invariants and make fixture evidence deterministic; keep unrelated runtime/deployment follow-ups separate.
- **System fit:** Main3953d30f has the same tested source tree as approved PR52, but CI43208233078 failed one EVM test out of4066 before publication. The guard/estimation/test source is unchanged from prior main5c4762a. Two fixture transactions return hashes without confirmed inclusion before counters are read; the same file already confirms an earlier nonce transaction. Correct fixture sequencing restores the existing evidence-to-release gate, without touching production signing, guard authority or SDK semantics.
- **Reuse and simplicity:** Reuse the existing same-file receipt polling pattern through one file-local send-and-confirm helper for all three writes. Inspect every caller before changing it. Prefer a small actual delayed-mining fixture configuration over retrying failed CI, loosening assertions or adding a new support framework.
- **Evidence and unknowns:** Full failed-step log preserved at /private/tmp/signa-postmerge-ci-43208233078.log: expected counters400/400/1, observed0/0/0 at test/rest-user-operations-evm.test.ts425;200otherfiles/4065tests passed. Root-cause hypothesis must be demonstrated with unmodified-source delayed-mining reproduction and receipts, not called a flake without evidence.
- **Verification:** Establish a focused failing reproduction, then pass the existing counter/override/authority assertions with the minimal fixture fix under delayed mining and original limits. Compare test-only diff, run required full gates/normal PR CI at exact head, and independently review before any merge. Preserve the initial failed main result and report the final main/CI state accurately. No production deployment or on-chain transaction is introduced.
- **Resource budget:** One owner uses an isolated main-based fix checkout and the existing verified registry dependency/toolchain. Focused EVM reproduction needs no production database; restart only the owned disposable PG if full local gate needs it. No runtime upgrade, broad app reruns or repeated green-hunting CI retries. Replan if evidence points to a production logic issue instead of fixture ordering.
- [ ] Reproduce and identify the exact EVM fixture failure.
- [ ] Apply and independently review the smallest deterministic fixture correction.
- [ ] Verify through existing local/CI gates and record the final result.

### Reproduction and focused repair evidence
- [x] The unchanged baseline file passes5/5 with normal Anvil and fails exactly the reported counter assertion with one-second block mining. Separate controlled receipt proof observes both setup writes pending with null receipts; successful mined receipts then produce the expected400/400/1 counters. Test, guard and estimation code were unchanged from pre-cleanup main5c4762a. Evidence /private/tmp/signa-postmerge-repro/{baseline-default.log,baseline-delayed.log,receipt-proof.json}.
- [x] A single file-local sendAndConfirm helper reuses the existing receipt-success poll for all three fixture writes. The fixture now starts Anvil with one-second mining so asynchronous inclusion remains covered. Production/contract/dependency code, all counter/override/authority assertions and existing RPC/poll/test limits are unchanged.
- [x] Clean locked install and focused whole-file verification pass5/5 in3.76s; git diff --check passes. Evidence /private/tmp/signa-postmerge-repro/fix-focused.log. No PostgreSQL restart or unrelated tests were needed for this focused reproduction.
- Independent review and full normal PR CI remain required before shipping this corrective test change. Retain initial main-CI failure43208233078 as evidence; a successful receipt, not transaction-hash return, is the fixture's state boundary.


# 2026-11-12: Signa Node 26.13.1 security runtime

## Plan refinement
- **Objective:** Move Signa build, CI, publish workflow and production Docker runtime to Node26.13.1 without changing wallet behavior or its public client's compatibility contract.
- **System fit:** Signa remains the account/wallet authority, using SDK6.4.0 and Center protocol preparation. The runtime is delivered through the existing main CI and Railway build; exact source/build evidence, readiness and recovery behavior remain required.
- **Reuse and simplicity:** Add the conventional .nvmrc exact pin and have existing setup-node steps read it; update existing Docker pins and private-service engine floor, existing preflight checks and active setup guidance. Preserve separately pinned publishing npm11.21.1, all dependencies and public wallet-client engine range. No new package-manager policy is needed.
- **Evidence and unknowns:** Current main e60b011 contains the confirmed delayed-mining test fix. Official26.13.1 is a security release bundling npm11.20.0. Fresh official Docker digest is verified separately. Existing production deployment is successful, but upgraded runtime and readiness require fresh evidence after delivery.
- **Verification:** Review only runtime/build metadata and corresponding guard tests; reject26.13.0 in the updated preflight; clean locked install; existing full release gate on26.13.1, CI Linux Docker build/audit, independent diff review, main and live deployment checks. Do not weaken assertion or timeout limits.
- **Resource budget:** Agent owns source edits in this isolated worktree, root owns this journal. Center uses the first heavy local slot, Signa follows; remote CI may run independently. Existing PostgreSQL fixtures and verified Node binary are reused. Stop and refine on concrete compatibility failures.

- [ ] Update runtime pins, private-service engine metadata and existing runtime guard tests.
- [ ] Verify locked install, release gate, CI Docker build and independent review.
- [ ] Deliver normal PR and verify requested runtime in the live deployment.

## Review
Pending runtime changes and verification.

### Verification progress and resource adjustment
- Exact Node26.13.1/npm11.20.0 clean install passed; parsed lock comparison proves all248 dependency entries unchanged, with only owning Node engine metadata updated.
- Existing runtime guard test passed with the new minimum and unchanged database checks. A direct old-validator comparison accepted26.13.0, confirming the new patch-floor boundary is meaningful. The focused run selected one test and intentionally did not select25 others; it is not a full-suite result.
- Host load rose to88 from unrelated Go compilation/tests and other work. Preserve other processes and all existing test deadlines; use the existing remote Linux CI full release gate and Docker build for acceptance instead of duplicating the full gate locally under contention.
- Production operations guidance now records Railway observations from2026-11-12: /readyz120s, drain30s, overlap0, daily04:53UTC PostgreSQL backups retained6days, latestNov12 04:53:02.929UTC. These observations establish configured readiness and backup entries, not a successful restore drill or end-to-end wallet transaction.
- Independent source review and exact-head CI remain pending before merge.


# 2026-11-12: Report Railway's actual deployment commit

## Plan refinement
- **Objective:** Finish hosting verification by making API health identify the actual deployed Signa commit when the optional explicit build variable is absent or empty.
- **System fit:** This changes public operational metadata only. Wallet authority, credential host boundaries, readiness, transaction construction and persistence remain unchanged. Signa's explicit provider-neutral build argument stays preferred; the already-present Railway deployment metadata supplies the fallback.
- **Reuse and simplicity:** Reuse the existing servedBuild function and40-hex validator with a single fallback expression; extend its existing HTTP health test. Remove the ineffective hosting alias and correct existing operator guidance, without adding another metadata service or key.
- **Evidence and unknowns:** The documented alias was applied exactly but live SSH proved SIGNA_BUILD_COMMIT is empty while RAILWAY_GIT_COMMIT_SHA equals00a7e1bb62982cfb5ed52aba3cdaf14bdae50aa9. All18 served assets already match that source and Node26.13.1 is live. A direct environment fallback uses the verified value rather than relying on unproven interpolation timing.
- **Verification:** Existing host tests must fail for the observed empty-alias case before the fix and pass afterward, including explicit override priority and malformed-value rejection. Run typecheck and full required remote CI/Docker, independently review, then verify automatic deployment, Node version, API health commit, readiness and served assets against merged source.
- **Resource budget:** One-line runtime change with focused local tests; reuse exact-lock dependencies and existing CI. Root owns journals. Remove only the ineffective alias using a checked skip-deploy variable batch, then let the normal source merge trigger the single rollout.

- [x] Extend existing host regression and prove observed empty alias fails before the fix.
- [x] Add native deployment fallback and correct operator guidance; run focused checks and independent review.
- [ ] Pass required CI, merge exact reviewed head, remove ineffective alias and verify live metadata.

## Review
Pending implementation and verification.

### Verification before PR
- The unchanged health implementation failed the extended existing regression: expected native deployment commit, received null.
- After the one-line fallback, all12 host-boundary tests passed on Node26.13.1. Both TypeScript checks and git diff --check passed. Locked install did not change dependency manifests or locks.
- Independent review found no actionable issues. Explicit nonempty overrides retain priority; malformed overrides and native values remain null.
- Removed only the ineffective Railway SIGNA_BUILD_COMMIT alias with skipDeploys. Fresh raw-map comparison proves every other service variable unchanged, and no deployment was triggered. The next normal source rollout will supply native metadata.
- Required remote CI, exact-head merge and live commit verification remain pending. No wallet authority or request handling changed.
