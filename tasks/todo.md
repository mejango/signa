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

# Sign typed data and messages from a Signa account through its own page (W4 Task 18, 2026-10-26)

## Plan refinement

- **Objective:** An app asks a Signa account for a Permit2, ERC-2771 forward request, SafeTx for another Safe, other typed data or a plain message; Signa's own approval page shows it decoded from the raw request, one passkey prompt signs, and the app receives the account's ERC-1271 signature, checked with isValidSignature on Base first. Anything addressed to the account itself, Signa's own authority documents, SmartSession enables and chain-free or wrong-chain domains are refused.
- **System fit:** App (wallet-app principal) -> POST /wallet/signature-reviews (refusals, deployed + owners consistent, inner call source) -> the payment review store keeps it as review kind `reviewed-signature-v1` (same table, grant/authority guard, ceremony, approvers) -> the approval page re-derives facts, warnings and the SafeMessage challenge from the raw request with the shared viem-only rules module, refuses a served description that differs -> one navigator.credentials.get -> approve builds the Safe7579 message signature (zero validator + contract owner signature), verifies it onchain, stores it -> GET /wallet/payment-reviews/:id returns it to the app. No plan, operation, submission or gas.
- **Reuse and simplicity:** Reuse safe7579MessageSigningPayload/encodeSafe7579MessageSignature, verifyWalletAssertion, the review store's guard/ceremony/approver path, reviewedCallsView + the extracted callSource for the inner call, exactFunction, readTokens and the page's request/run/status flow. New: reviewedSignatureRules.ts (viem-only, page-shared), reviewedSignatures.ts (server review), a signature draft create/validate beside the payment one (shared authority checks extracted first, behavior-preserving), one migration widening the stored signature length, one route.
- **Evidence and unknowns:** SmartSession enable digest uses a name/version-only domain (rhinestone HashLib f24dddf), so the chainId rule refuses it; Signa's own domains all start "Juicebox Center". PG16 suites only in CI (local PG 14). Base only; Task 16 adds chains.
- **Verification:** New suites rest-reviewed-signatures (rules, refusals, draft validation) and rest-reviewed-signatures-evm (isValidSignature on a real passkey Safe), browser test extension (one prompt, refused tampered model), typecheck, full vitest, bundle budget with before/after numbers, click-to-review at 360/1280.
- **Resource budget:** One branch stacked on #45 in the reused t15 worktree; replan if the store branching exceeds a few conditionals or the page bundle grows past ~2 KB gzip.

## Review

- [x] Refactor first (4a33ed0): shared review authority/ceremony checks and callSource, behavior-preserving.
- [x] Rules, server review, store kind, route, page, docs, RISKS, migration 067.
- [x] Tests: rest-reviewed-signatures (10), rest-reviewed-signatures-evm (isValidSignature on anvil), PG store signature test (run on a local PG 14 copy), browser: one prompt per signature request, refused served model (12 tamper cases, 0 prompts).
- Bundle: wallet-payment 25,793 -> 29,080 B gzip, past the ~2 KB replan line. Replanned rather than trimmed: the growth is the rules module (6.2 KB min) and viem's typed-data hashing/validation, which the page needs to re-derive the request without trusting the server. Budget raised to 29,500.
- Click-to-review (ready to Sign/Approve, median of 7, 80 ms simulated API): pay 148 -> 147 ms (360), 139 -> 142 ms (1280); message 136/137 ms; Permit2 with a token read 292/291 ms (150 ms simulated RPC). One click to the passkey prompt in every case.
- Ceiling: the same request has the same passkey challenge (the SafeMessage digest, which the ceremony table keeps unique), so a declined request is signed again only as a new request, as a declined payment operation is.
