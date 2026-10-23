# Production operations

Normal execution uses fresh wallet approval. Optional recurring bot permissions remain unavailable until the matching guard is deployed and an owner activates a bounded policy. Gas sponsorship does not require those permissions. See [execution operations](EXECUTION_OPERATIONS.md) for provider configuration and transaction recovery, and [RISKS.md](../../RISKS.md) for the production boundary.

## Monitoring

Signa has no production monitor today. CI (`.github/workflows/ci.yml`) runs the release checks and builds the image; it does not probe the live service. `scripts/check-production.mjs` is inherited from Center and is not scheduled for Signa. The README lists adding a Signa production monitor after activation, with reviewed live endpoints and readiness criteria, as open work.

What exists to inspect by hand:

- `/healthz` reports process liveness. `/readyz` on the API host returns 503 until the runtime is active and the database answers.
- Signa serves no `/metrics` route.
- The service logs structured JSON for creation, recovery and device events (`action` is `creation`, `recovery` or `device`).

For a failure, check the endpoints above and the deployment status, then the structured logs. Check database connectivity and the Base RPC and bundler health. Reconcile the existing transaction or user-operation identifier before asking a user to retry; never turn an uncertain submission into a new payment automatically.

## Shutdown

The server drains for `SHUTDOWN_GRACE_MS` (25 seconds by default) on SIGTERM. `railway.json` sets restart on failure with at most 10 retries and no health check; set the health check per stage as the README describes. No platform drain setting has been verified for Signa.

## Database backups

No backup schedule, retention or recovery point has been recorded or verified for Signa's PostgreSQL database. Do not rely on Center's earlier snapshots or schedules; they cover Center's database.

During an actual recovery, pause application writes and execution workers, record the recovery point, preserve the current volume, and reconcile all potentially submitted transactions on Base, and on any additional network the account was deployed to, before resuming execution. An older database can contain stale request nonces, bot revocations and transaction states; never assume a restored row proves a transaction was not sent.

## Restore verification

No restore drill, schema-only or full, has been run against Signa's database. Recovery time and recoverability of user data are unknown. Before relying on backups, run a drill into an isolated destination and record its date and result here.

## Planned change

The service is expected to move off Railway to GCP with KMS-held keys. Monitoring, backups, restore verification and shutdown settings are to be re-established and recorded for the new platform.
