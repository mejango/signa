# Juicebox Center client

Create API access at https://juicebox.center/accounts and download the connection file.
Keep it in your secret store. The file contains a private signing key.

```sh
npm install https://juicebox.center/api/client/juicebox-center-client-0.1.0.tgz
chmod 600 juicebox-connection.json
npx center account --connection juicebox-connection.json
```

```js
import { connect } from '@juicebox/center-client/node';
const center = await connect('./juicebox-connection.json');
console.log(await center.account());
```

Browser apps can import `CenterClient` and use their existing wallet or local bot
signer. The client handles exact request signing, nonces and authentication expiry.
API access alone does not authorize wallet spending. For unattended payments,
activate separate wallet permissions with an action, recipient, budget and expiry.
Then use `center.smartAccounts()` and `center.signSessionOperation(...)` with the
same downloaded connection. The bot operates within those permissions without
further owner prompts. Activation requires support on each execution network.

Guide: https://juicebox.center/api/docs/quickstart
Client workflows: https://juicebox.center/api/docs/client

Apps that only connect a passkey account and review payments should use the smaller npm package
`@me.jango/signa` (or the Juicebox SDK's `@bananapus/nana-sdk-connect`, which wraps it).

The experimental `createCenterWalletClient` export connects an app to an explicitly
configured Center passkey service. It requires fixed `issuer`, `audience` and exact
`callbackUri` values plus an activated Center allowlist entry. Nothing is activated
by importing it. Runtime integration alone does not enable a public deployment.

Call `prepareConnection()` and then call the returned `launch()` method in the same
app tab. It submits a short signed launch proof by form POST; its public
`authorizationUrl` alone cannot connect a wallet. Allow the configured wallet
origin in CSP `form-action` and use `Referrer-Policy: strict-origin` on pages that
start or resume a connection, including the callback. This sends only the app
origin, without the page path or query. A `no-referrer` or `same-origin` policy makes browsers send
`Origin: null`, which Center rejects. One browser launch is active at a time: a
newer tab replaces the older claim, and the older tab must start again from its app.
On the registered
callback page, call `completeConnection()`; it removes callback parameters before
any exchange and validates the issuer, state and locally retained request key.
`retryConnection()` recovers the same pending exchange after an uncertain response.
`restoreConnection()` returns a locally stored connection candidate; every API
request still checks current server authority. The default storage is the current
tab's `sessionStorage`, which contains an API request key and must be treated as
sensitive. `disconnect()` clears it and invalidates the helper's existing clients.

The returned connection exposes the Base wallet address and an ordinary
`CenterClient` with read/plan/relay access. The request key cannot sign payments or
activate spending sessions. Use the separate payment workflow below for fresh owner approval.


For an explicitly configured Base USDC pilot, call `wallet.payments()` on the same
wallet helper. Prepare a normal smart-account plan and UserOperation through the
returned `CenterClient`, then pass the exact plan, operation and your app's expected
payment to `preparePayment()`. The expected payment includes token, direct V6
terminal, amount, project, beneficiary, minimum returned tokens, memo, metadata and
`maximumNetworkFee` in native wei. This bounds EntryPoint prefund; separate rollup
data fees are not included.

Navigate to the returned `approvalUrl`. Center displays the exact payment and
requires a fresh passkey approval. Back on the same registered callback, call
`completePayment()` to validate the callback and retrieve the original approval.
Call `submitPayment()` explicitly, then `refreshPayment()` to observe that same
operation. A canonical receipt with verified payment effects becomes `paid`;
submission, confirmation in progress and unknown outcomes remain distinct.

`pendingPayment()` returns the retained public state after reload. A disconnected,
expired or replaced grant cannot authorize requests, but disconnect preserves the
payment record. `clearPayment()` refuses to discard a live approval or possible
submission. It can explicitly archive a locally unsent record after its original
finite signing window has elapsed, provided no approval was saved. That archive
remains unknown; the browser clock does not establish chain expiry or nonpayment. Do not prepare a replacement because a response was lost or a review
expired; reconcile the original operation. These methods neither create a wallet
nor activate the pilot service, and they do not add generic EOA signing support.


`connection.client.authorizeRead(requestTarget)` produces an exact signed GET for
an application server to relay without revealing the request key or sending it.
The relay must preserve its URL and signed headers. Trusted app relays additionally
supply their fixed configured app Origin; user input must not select that origin.
The original request expiry, nonce and live server grant checks still apply.
