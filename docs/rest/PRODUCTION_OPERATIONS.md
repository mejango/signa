# Production operations

Normal execution uses fresh wallet approval. Optional recurring bot permissions remain unavailable until the matching guard is deployed and an owner activates a bounded policy. Gas sponsorship does not require those permissions. See [execution operations](EXECUTION_OPERATIONS.md) for provider configuration and transaction recovery, and [RISKS.md](../../RISKS.md) for the production boundary.

## Monitoring

Railway production settings observed on 2026-11-12 use `/readyz` as the deployment health check with a 120-second timeout; the API readiness endpoint returned 200. No independent periodic production monitor has been verified. CI (`.github/workflows/ci.yml`) runs the release checks and builds the image; it does not probe the live service. The unused inherited Center monitor was removed with its server code. Adding a Signa production monitor with reviewed live endpoints and readiness criteria remains open work.

What exists to inspect by hand:

- `/healthz` reports process liveness. `/readyz` on the API host returns 503 until the runtime is active and the database answers.
- Signa serves no `/metrics` route.
- The service logs structured JSON for creation, recovery and device events (`action` is `creation`, `recovery` or `device`).

For a failure, check the endpoints above and the deployment status, then the structured logs. Check database connectivity and the Base RPC and bundler health. Reconcile the existing transaction or user-operation identifier before asking a user to retry; never turn an uncertain submission into a new payment automatically.

## Shutdown

The server drains for `SHUTDOWN_GRACE_MS` (25 seconds by default) on SIGTERM. `railway.json` sets restart on failure with at most 10 retries; health checks are configured per stage as the README describes. Railway production settings observed on 2026-11-12 specify a 30-second drain and zero deployment overlap.

## Database backups

Signa's PostgreSQL backup schedule observed in Railway on 2026-11-12 runs daily at 04:53 UTC with six-day retention. Six backup entries were present; the latest was created on 2026-11-12 at 04:53:02.929 UTC and expires on 2026-11-18 at 04:53 UTC. Backup availability does not establish successful restoration. Center's earlier snapshots and schedules cover its separate database.

During an actual recovery, pause application writes and execution workers, record the recovery point, preserve the current volume, and reconcile all potentially submitted transactions on Base, and on any additional network the account was deployed to, before resuming execution. An older database can contain stale request nonces, bot revocations and transaction states; never assume a restored row proves a transaction was not sent.

## Restore verification

No restore drill, schema-only or full, was verified as of 2026-11-12. Recovery time and recoverability of user data remain unverified. Run a drill into an isolated destination and record its date and result here.

## Planned change

The service is expected to move off Railway to GCP with KMS-held keys. Monitoring, backups, restore verification and shutdown settings are to be re-established and recorded for the new platform.
