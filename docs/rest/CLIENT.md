# Client workflows

Install the [Signa client](./QUICKSTART.md#install-and-connect) once. It handles
request signatures, nonces and request expiry. You explicitly choose API access,
review wallet actions and control when they are submitted.

## Connect from Node

```js
import { connect } from '@juicebox/center-client/node';
const center = await connect('./juicebox-connection.json');
const { account } = await center.account();
```

The file is read locally with ownership and permission checks. Its key is never
sent to Signa. To use a managed signer, construct `CenterClient` with your
`audience`, `accountId`, `grantId` and `signer` instead.

## Connect a browser app

In your application, sign the user in and obtain their account-wallet signer,
then approve one local bot key. The signer can come from an embedded wallet or
an existing wallet connection. The returned client can read and plan without
more owner prompts.

The example below uses a browser wallet, the installed package and `viem`.
For Signa's hosted setup, use **Sign in** and **02 / API access** on
[Accounts](/accounts), then follow the [quickstart](./QUICKSTART.md).

```ts
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { CenterClient, signWalletTypedData, type WalletProvider, type WalletTypedData } from '@juicebox/center-client';
import { getAddress } from 'viem';

// Use the provider selected by your wallet connector.
const provider = (window as Window & { ethereum?: WalletProvider }).ethereum;
if (!provider) throw new Error('Connect a browser wallet first.');
const accounts = await provider.request({ method: 'eth_requestAccounts' });
if (!Array.isArray(accounts) || typeof accounts[0] !== 'string') throw new Error('No wallet account selected.');
const address = getAddress(accounts[0]);
const chainId = Number(await provider.request({ method: 'eth_chainId' }));
const owner = {
  address,
  signTypedData: (document: WalletTypedData) => signWalletTypedData({
    provider, address, chainId, document, signatureFormat: 'wallet',
  }),
};
const ownerApi = CenterClient.forOwner({
  audience: 'https://api.signa.center', chainId, signer: owner,
});
await ownerApi.enroll();

const botSigner = privateKeyToAccount(generatePrivateKey());
const { client: center, bot } = await ownerApi.registerBot({
  signer: botSigner,
  scopes: ['read', 'plan'],
  label: 'My app',
  expiresAt: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
});
console.log((await center.account()).account.id);
```

In an app with a wallet connector, use its selected provider instead of the
`window.ethereum` fallback shown here.

This example keeps the local key only in memory. Revoke the returned `bot.id`
when access is no longer needed: `await ownerApi.revokeBot(bot.id)`. A new page
load needs a new connection unless your app has a suitable local key store.
Handle wallet rejection and account/network changes through your connector.
The signing helper checks the wallet identity before and after each signature.

## Prepare, review, approve, submit

Keep the same client for a plan’s preparation and submission. A different bot
cannot take over the plan. Give an operation a stable idempotency key and save
its returned ID so your application can recover after a restart.

```ts
const plan = await center.prepare({
  operation: 'contract_calls',
  input: reviewedContractCalls,
}, 'my-action-2026-001');

await center.simulate(plan.id, 0);
```

`reviewedContractCalls` follows the [contract-call schema](https://juicebox.center/api/docs/contracts).
Review `plan.draft.calls`, native amounts, dependencies, commitment and expiry
with the user. Have the transaction wallet sign those exact transaction bytes
including the reviewed gas and fees. The client never invents fee approval.

For a bot with **Read + plan + relay**, the account owner approves dispatch of
those signed bytes. The client constructs the exact approval document:

```ts
const approved = await center.approveTransaction({
  plan,
  stepIndex: 0,
  rawSignedTransaction, // exact bytes returned by the transaction wallet
}, owner);

const submission = await center.submitTransaction(approved, 'my-action-2026-001-send');
console.log(submission.dispatch.hash);

const latest = await center.plan(plan.id, { refresh: true });
console.log(latest.steps[0].state);
```

`owner` is the account-owner signer from your wallet connector, as in the browser
example. The transaction wallet and API account owner may differ. An owner API
client approves its exact submission request and does not need the additional
bot dispatch document. Supported smart-wallet execution uses its separate
[time-limited wallet approval](./SMART_ACCOUNTS.md).

A submission response means processing began. It does not mean the transaction
confirmed. Inspect the refreshed step and its receipt; `unknown`, `confirming`
and `reverted` are distinct outcomes. Confirm required earlier steps before
continuing. Approval expiry does not cancel transactions already submitted.

## Prepay across chains

Use the [prepaid workflow](./SPONSORSHIP.md) when capabilities enable it:

```ts
const prepared = await center.preparePrepaid(plan.id, [0, 1], 'my-action-prepaid');
// Show each returned authorization to its wallet owner and collect its exact
// EIP-712 signature in the returned order.
const approved = await center.approvePrepaid(prepared, forwardSignatures, owner);
const published = await center.submitPrepaid(approved, 'my-action-publish');
const current = await center.prepaid(published.id, { refresh: true });
```

Once the verified quote provides a funding option, use
`center.prepareFunding(id, chainId, payer, idempotencyKey)`. Review and sign the
returned ordinary funding plan separately. Check existing payment and execution
before paying again. Provider details are handled by Signa.

## Run payments without another owner prompt

Approve a bot's wallet permissions once on [Accounts](/accounts): the action,
recipient, asset, network, maximum per payment, total budget, call count and expiry.
The permission becomes usable after its activation confirms. Within those limits,
the bot signs and submits using its own key. The owner does not need to keep a
browser open. The owner must approve changes to the limits or a renewal.

This requires a transaction wallet on each execution network and session support
in `sessions.configuredChainIds`. One downloaded bot connection works across those
networks. Each network has its own activated permission, funds and remaining
budget. A budget on one network cannot be spent on another.

Use the same connection throughout preparation, signing and submission:

```js
import { connect } from '@juicebox/center-client/node';
import { sessionActionPlanInput } from '@juicebox/center-client';

const center = await connect('./juicebox-connection.json');
const wallets = center.smartAccounts();
const session = await wallets.session(process.env.CENTER_SESSION_ID);
if (session.state !== 'active') throw new Error('Wallet permission is not active.');

// One unique, persisted ID for this scheduled payment, reused for its recovery.
const paymentId = 'invoice-2026-001';
const input = sessionActionPlanInput(session, {
  amount: '1000000', // smallest token units; must fit the approved per-call limit
  tokenContractId: process.env.CENTER_TOKEN_CONTRACT_ID, // ERC20 transfers only
});
const plan = await wallets.preparePlan(
  session.compiled.bindingId, 'contract_calls', input, `${paymentId}-plan`,
);
const operation = await wallets.prepareUserOperation({
  planId: plan.id, stepIndexes: [0], sessionId: session.id,
}, `${paymentId}-prepare`);
const signature = await center.signSessionOperation({ plan, operation, session });

// Save operation.id, signature and this submission key before sending.
// These are recovery data; the bot's private key stays in the local signer.
const submitted = await wallets.submitUserOperation(
  operation.id, signature, `${paymentId}-send`,
);
console.log(submitted.state);
const current = await wallets.userOperation(operation.id);
console.log(current.state);
```

`signSessionOperation` checks that the plan, network, wallet and activated
permission match this bot connection before signing. It does not send a request
or open an owner wallet. A managed signer must support `signMessage` as well as
API request signing; downloaded connections already do.

Run the job from your own worker or scheduler. Before the next payment, reconcile
the previous operation and read `wallets.quota(session.id)` for observed limits.
If submission times out, look up the saved operation ID; do not create a new
payment to replace an unknown result. A failed operation may still consume call
or network-cost limits. Funding and token allowances need separate owner approval.
See [wallet permissions](./SESSIONS.md) for activation, revocation and expiry.

## Recovery and lower-level requests

Persist plan IDs, submission hashes, idempotency keys and exact approved payloads
in your application’s private storage. A timeout can leave the outcome unknown.
Read the existing record before attempting another mutation. Do not regenerate
a key or change transaction bytes just because a request timed out.

Every endpoint is available through `center.request({ requestTarget, method,
json, idempotencyKey })`. The client signs the exact body and URL automatically.
Retries are opt-in with `retries: 1` or `2`; mutation retries require a stable
idempotency key. [Authentication](./AUTHENTICATION.md) describes the wire format
for clients in other languages.

## Bring an existing bot key

On [Accounts](/accounts), sign in and expand **Bring your own bot key** under
**02 / API access**. Download the public proof request. Keep your existing key file on your machine and run:

```sh
npx center proof --key bot-key.json --request juicebox-bot-proof-request.json --out registration.json
```

Paste only `registration.json` into the page, review its permissions and expiry,
and select **Sign and register this bot**. The key file uses the existing
`juicebox-center-bot-key-v1` format and must have mode `0600` or `0400`.
The registered bot record supplies the public account and grant IDs for a
`CenterClient` using your managed signer. This advanced path never uploads a key.
