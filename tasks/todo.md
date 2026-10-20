# Retire a refused payment approval and review a fresh one at once

jango, 2026-10-20: "go ahead and do the queued real fix". Follows PR #18 (4162e5a) and Codex review 7.

## Plan refinement

- **Objective:** After Signa refuses to send an approved passkey payment, the payer sees the reason and can review a fresh payment within seconds instead of waiting on a held approval, and no pair of approved payments can both execute.
- **System fit:** Outcome (one paid payment) <- operation record in `rest_user_operations` (owner of send authority: `claim`) <- review store (`paymentReviewsPostgres`, resends on reopen while `prepared`) <- wallet client journal (`walletPayments.ts`, terminal states gate `clearPayment`). A new terminal operation state `retired` is written under the same row lock `claim` takes, so a retired operation can never be claimed, resent on reopen or approved again; a fresh preparation must reuse a retired operation's nonce while that operation could still execute, so the EntryPoint itself lets at most one of them run. Unaffected: observation, expiry proof, sponsorship, the review ceremony.
- **Reuse and simplicity:** Reuse the row lock and `claimed()` state gate, the review store's existing `state === "prepared"` checks, the client's `receiveOperation` state mapping and `terminal()`; the head nonce and canonical evidence `prepare` already reads; the expiry margin rule (`validUntil + 120 s` on a canonical head) from `execution.ts`. New: one store method pair (`retire`, `retired`), one route, one migration line, one client state `refused`. No auto-retire on the server: the client retires only after a server-answered refusal, so a lost response never kills an approval that may be sending.
- **Evidence and unknowns:** Codex review 7 (replica claim during diagnostics, reopen resend, next-nonce double execution); source of `claim`, `get`/`approve`/`sendApproved`, `prepare`. Unknown/ceiling: an approval's signed bytes executed outside Signa before retirement; covered while its window is open by the nonce guard, after that only by the user's chain history (ponytail note in code). Homerun needs center-wallet 0.3.9 and `refused` in its terminal list to show the fresh review.
- **Verification:** New tests that fail on main: retire vs claim race both orders (memory + PostgreSQL), reopened approval page does not resend a retired operation, fresh preparation refused when the retired nonce moved during its window and allowed at the same nonce or after a canonical window end or when a Signa-executed operation holds the nonce, reorged window evidence refuses, client refused submit becomes `refused` at once and a fresh review prepares immediately. Gates: typecheck, build, vitest (PostgreSQL suites locally on a scratch PG 14 and in CI on PG 16), Codex gpt-6.1-sol adversarial review until SHIP.
- **Resource budget:** One worktree off origin/main, edits limited to user operation store/service/route, review store untouched unless a test shows otherwise, client journal, docs enums. Replan if Codex shows the nonce guard blocks ordinary back-to-back payments or a retire path can race a claim.

## Work items

- [ ] Migration 061: `retired` in the operation state check
- [ ] Store: `retire` (row lock, no-op with a submission), `retired` (open retired records of a sender), `claimed` refuses retired with USER_OPERATION_RETIRED
- [ ] Service: `retire`, early refusal of retired in `submit`/`submitApproved`, nonce guard in `prepare`
- [ ] Route `POST /user-operations/{id}/retirement` + OpenAPI
- [ ] Client: `refused` state, retire after a server-answered submit refusal, `retirePayment()`, approved branch maps retired
- [ ] Tests listed above; gates; Codex; PR; merge on SHIP + green CI
