# Signa account and wallet journeys

Signa owns account access, wallet approval, execution and recovery. Its credential
origin is `https://signa.center`; its API and Accounts page use
`https://api.signa.center`. Center owns Juicebox protocol information, hosted
preparation, project publication and MCP. Use the service that owns the task.

A transaction plan stores exact calls for review. API grants permit account access
and preparation; they do not authorize spending. Fresh owner approval is the
default. Optional installed sessions authorize only their explicit actions,
allocations and expiry. Keep the network, wallet, asset and amount explicit.

## Check availability

Read [Signa capabilities](https://api.signa.center/api/v1/capabilities) before
preparing an action. Source code, local tests and a documented route do not establish
configured providers, funded sponsorship or a verified wallet on a particular chain.
Account creation, owner execution, recurring sessions and additional networks have
separate prerequisites. Follow [execution operations](./EXECUTION_OPERATIONS.md)
for the release checks and [production checks](./PRODUCTION_CHECK.md) for live proof.

## Journeys and approvals

| Goal | Path | Authority and evidence |
| --- | --- | --- |
| Sign in, add a device or recover a wallet | Signa credential page → exact passkey ceremony → return to the registered app. | Verify the configured credential origin, RP ID, current account authority and callback. Recovery and device enrollment have their own approvals. |
| Connect a bot | [Accounts](https://api.signa.center/accounts) → API access → choose scopes and expiry → save the connection file. | Owner approves the grant; the client keeps its key. [Quickstart](./QUICKSTART.md). |
| Read an account or existing plan | Signed Signa account/plan request. | Requires current account authority and the appropriate scope; no wallet spending approval. |
| Prepare a Juicebox action | Obtain inputs from [Center's catalog](https://juicebox.center/api/v1/catalog/operations) → signed Signa plan request → review the exact calls. | Center supplies an unsigned draft. Signa validates it and creates its own durable plan, commitment and expiry. |
| Submit a direct transaction | Prepare → simulate → owner signs exact transaction → submit → reconcile. | Fresh owner consent is required for each new dispatch. An API grant or old transaction signature alone is insufficient. [Transaction lifecycle](./TRANSACTIONS.md). |
| Use sponsored owner execution | Bind the verified smart wallet → prepare its plan and UserOperation → owner approves → submit → reconcile. | Requires configured provider/paymaster and current wallet authority. Gas sponsorship is not permission to spend. [Smart accounts](./SMART_ACCOUNTS.md). |
| Prepay execution across chains | Prepare a sponsorship wave → review/sign exact forwarding requests → fund the reviewed quote → reconcile every destination. | Funding and destination execution have separate evidence. Reconcile an uncertain provider submission before retrying. [Sponsorship](./SPONSORSHIP.md). |
| Run a limited recurring action | Review exact policy → owner activates it onchain → verify installed state → bound bot submits within limits. | Requires a configured reviewed guard and fresh canonical policy/counter evidence. Revoking API access does not revoke onchain authority. [Sessions](./SESSIONS.md). |
| Resume after interruption | Load the existing plan, UserOperation or sponsorship identifier and reconcile its original submission. | A timeout, dismissed window or empty new browser slot does not prove a transaction was never sent. Keep exact identities and signed bytes. |
| Research projects or publish metadata/intents | Use [Center's API](https://juicebox.center/api) or `https://juicebox.center/mcp`. | Signa does not host protocol reads, MCP, pinning or intent publication. Publication consent and wallet spending approval are separate. |

## Keep the outcome intact

- Preserve exact request bytes and idempotency identity when retrying an operation;
  use a fresh request nonce and signature.
- Distinguish preparation, approval, submission, canonical execution and verified
  protocol effects. An outer receipt does not establish every inner effect or
  cross-chain settlement.
- Treat unavailable or mismatched evidence as unknown. Do not silently switch
  sources, substitute calls or spend from a different wallet.
- Keep account grants, spending approvals, delegated sessions and sponsorship
  eligibility separate throughout review and recovery.

The separately planned jbm, revnet and juicescan Signa integrations are outside
this server cleanup; other apps already use Signa. No Center account-history
migration or compatibility runtime is required.
