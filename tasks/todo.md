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
