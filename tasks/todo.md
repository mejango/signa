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
- [ ] Codex SHIP, CI green, merge

## Review

- Before: a refused approval stayed `prepared`; the client journal sat at `unknown` and `clearPayment()` refused until the grant ended and the signed window (about 5 minutes) passed, so the payer waited or was stuck in that tab.
- After: refusal answer plus one retirement round trip (under a second in tests), the journal reads `refused`, `clearPayment()` and a fresh review work at once, and the fresh payment reuses the same nonce.
- Codex pass 1 FIX (6 findings) addressed in 3ffeffa: proof-only settlement, outer receipt success, claim-time recheck under a sender lock, alias-wide lookup, exact full nonce across keys, README recovery.
