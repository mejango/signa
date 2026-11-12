# Signa account ownership

Signa is the sole account and wallet service. Center account history and credentials
are not migrated or supported through a compatibility runtime. This supersedes the
historical preparation proposal that kept Center account paths during extraction.

| Owner | Responsibility |
| --- | --- |
| Signa | Identity, passkeys, app/bot grants, approvals, sessions, submission and recovery |
| Juicebox SDK | Reusable transaction encoding, decoding and protocol outcome verification |
| Center | Protocol reads/reference, project intents, publication, IPFS, RPC and hosted preparation |

Signa requests unsigned protocol drafts through Center's public API. Each draft is
checked against the request, canonical chain evidence and the authenticated Signa
account before it enters Signa's own durable approval and execution lifecycle.
Center's plan data is never execution authority. Account permissions, spending
allocations, approval consumption, reservations and dispatch remain atomic in Signa.

The credential origin and general account/API origin remain separate. Existing
Signa credentials, exact signed audiences, RP IDs, callbacks, durable execution
records and idempotency identities keep their meaning. Protocol preparation does
not need a Center account or a shared database. Signa's configured RPC supplies
independent canonical observations, including recovery when Center is unavailable.

The cleanup does not delete a production database or execute a migration of funds.
Deployment requires the release checks and verification of the configured Signa
runtime. The separately planned jbm, revnet and juicescan account integrations are
outside this server cleanup; other apps already use Signa.
