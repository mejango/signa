# @me.jango/signa

Sign in to your app with a Signa passkey account or an external wallet, then request exact payment
reviews. This is the browser-only slice of the Signa client. Bot access and the CLI ship separately as
the full client archive linked from https://api.signa.center/api/docs/client.

```sh
npm install @me.jango/signa
```

| Import | What it is | Needs |
| --- | --- | --- |
| `@me.jango/signa` | The wallet client: connect an account, review and submit payments | viem |
| `@me.jango/signa/core` | The connect step, headless: sign-in options, popup or frame, callback page. Also re-exports the wallet client | viem |
| `@me.jango/signa/wagmi` | A read-only wagmi connector for the passkey account | wagmi |
| `@me.jango/signa/react` | The sign-in modal | React |

React and wagmi are optional peers: an app that imports only the root entry or `/core` never loads them.
These subpaths replace `@bananapus/nana-sdk-connect`; the export names are the same, so moving over only
changes the import specifier.

## Wallet client

```js
import { createCenterWalletClient } from '@me.jango/signa';
const wallet = createCenterWalletClient({
  issuer: 'https://signa.center', audience: 'https://api.signa.center',
  callbackUri: window.location.origin + '/center/callback',
});
const prepared = await wallet.prepareConnection();
prepared.launch(); // full-page redirect to the account
// prepared.launch({ target: name }) submits into a window or iframe the app opened under that
// name; Signa serves the sign-in inside an iframe only for apps its operator admits to frame.
// On /center/callback:
const connection = await wallet.completeConnection(window.location.href);
```

Your app origin and exact callback URI must be allowlisted by Signa. Allow the issuer in your
`form-action` CSP directive and send `Referrer-Policy: strict-origin`. `restoreConnection()` reads the
saved connection, `disconnect()` clears it, and `payments()` prepares, completes and submits reviewed
payments. Protocol details: https://api.signa.center/api/docs/client
`refreshPayment({ waitSeconds })` holds a submitted payment's read on Signa (up to 20 s) until the
operation moves, so an app can wait on it instead of polling. A record whose app grant is gone and whose
signed validity has passed can be cleared; it is archived as unknown and Signa keeps the outcome.
When Signa refuses to send an approved payment, `submitPayment()` throws the refusal (with
`payFailure` when the calls say why) after asking Signa to retire the approval. Read
`pendingPayment()` next: `refused` means Signa retired it and never sends it, so `clearPayment()` and a
fresh `preparePayment()` can follow at once; the fresh payment takes the refused one's nonce, so at most
one of them executes. `pending` or `confirming` means a send won before the retirement: follow it.
`unknown` means the retirement or the answer was lost: `retirePayment()` retires an approved payment
Signa has not sent, or returns the submission that already claimed it.
A reverted payment's status and a refused submission's `RestClientError` carry `payFailure`: the SDK's own
`PayFailure`, as `decodePayFailure` reads the same revert (bigint `received` and `minimum`, plus `zeroFill`
and `adjustable` for a shortfall), so it goes straight to the SDK's `payRetrySlippageBps` and to the same
display as an external-wallet payment. `observation.payFailure` keeps the reason as Signa served it.

## Connect

- `/core`: `createConnectController(options)` (headless, no React or wagmi) takes the passkey option and
  any external-wallet options (each a `ConnectOption`: `id`, `name`, optional `icon`, and `connect`, which
  may publish a pairing URI through `handoff` for a QR code). `passkeyOption({ wallet, connected })` is the
  Signa account. For the app's `/center/callback` page, call `deliverCenterCallback(url, { window })`, then
  `completeCenterCallback(wallet, url)` when it returns false. The passkey account opens Signa in a popup
  and the page stays; the callback page hands its URL back to the page, which finishes the exchange and runs
  `connected`. A blocked popup falls back to a full-page redirect, where the callback page completes the
  exchange itself. With `passkeyOption({ frame: true })` Signa opens in a frame the modal shows instead;
  the callback page hands its URL up to the framing page through the same `deliverCenterCallback`. Signa
  serves the sign-in framed only for apps its operator admits to frame (`WALLET_FRAMEABLE_APP_ORIGINS`),
  and the page inside offers "Open as a page" when it cannot continue there. The frame delegates passkey
  prompts and creation to Signa's origin by name, so a new user can sign up inside it.
- `/wagmi`: `centerAccountConnector({ wallet, read })`, a read-only Base connector for the passkey account.
  It answers reads through `read` and refuses to sign: payments go through Signa's review.
- `/react`: `<JBConnectModal open controller onClose />` shows the passkey account as the primary button
  (named after the platform prompt: Touch ID, Face ID, Windows Hello, unless `passkeyLabel` overrides it)
  and external wallets as tiles. Theme it with the `--jb-connect-*` custom properties (`--jb-connect-pad`
  is the dialog's inset, which the Signa frame bleeds through). The modal answers the frame's size reports
  with its resolved theme, so the Signa page inside takes the app's colours, font and corners.

The passkey account signs nothing in the app. Payments go through Signa's review flow.
