# @me.jango/signa

Sign in to your app with a Signa passkey account or an external wallet, then have Signa review any call
set or signature the app asks of the account. This is the browser-only slice of the Signa client. Bot access and the CLI ship separately as
the full client archive linked from https://api.signa.center/api/docs/client.

```sh
npm install @me.jango/signa viem
```

viem is a peer dependency (`^2.37.5`): the package uses the app's own copy.

| Import | What it is | Needs |
| --- | --- | --- |
| `@me.jango/signa` | The wallet client: connect an account, review and submit call sets, signatures and payments | viem |
| `@me.jango/signa/core` | The connect step, headless: sign-in options, popup or frame, callback page, and `signaWalletAdapter` for the SDK's `sendReviewed`. Also re-exports the wallet client | viem |
| `@me.jango/signa/wagmi` | A read-only wagmi connector for the passkey account on every chain Signa enables | wagmi |
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
`reviews()` does the same for any call set (`prepareReview({ chainId, calls })`, one chain at a time) and any
signature (`prepareSignature(request)`, typed data or text), with Signa's page reviewing the raw request. A call
set follows a payment's states and record (`completeReview`, `submitReview`, `refreshReview`, `retireReview`,
`pendingReview`, `clearReview`); a signature is approved, with the account's ERC-1271 signature, or cancelled
(`completeSignature`, `refreshSignature`, `pendingSignature`). `payments()` stays for 0.5.x apps.
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
display as an external-wallet payment. `observation.payFailure` keeps the reason as Signa served it. Because the
amounts are bigints, `JSON.stringify` of a status or error needs a replacer such as
`(_, value) => typeof value === 'bigint' ? value.toString() : value`. Without `adjustable`, no setting the
payer controls would help, so never relax a minimum then.

## With the SDK's `sendReviewed`

```js
import { signaWalletAdapter } from '@me.jango/signa/core';
import { sendReviewed } from '@bananapus/nana-sdk-core/review';
// approve shows Signa's page (a frame or popup) and resolves the callback URL, or null when it was closed.
const adapter = signaWalletAdapter(wallet, { approve: url => showSignaReview(url) });
const { hashes } = await sendReviewed({ account, calls }, { adapter, clientFor, hold });
```

Signa's page is the one confirmation: core shows no prompt of its own. A closed or cancelled review throws
EIP-1193 4001 (nothing was sent). The hash is the transaction that carried the account's UserOperationEvent,
never the userOpHash, so the app waits on a real receipt. Calls on more than one chain are refused before
Signa with "Signa sends one chain at a time.". `signTypedData` and `signMessage` go through the same page and
resolve the account's ERC-1271 signature.

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
- `/wagmi`: `centerAccountConnector({ wallet, read })`, a read-only connector for the passkey account on every
  chain Signa enables. It answers reads through `read`, which names the chain, and refuses to sign: calls and
  signatures go through Signa's review.
- `/react`: `<JBConnectModal open controller onClose />` shows the passkey account as the primary button
  (named after the platform prompt: Touch ID, Face ID, Windows Hello, unless `passkeyLabel` overrides it)
  and external wallets as tiles. Theme it with the `--jb-connect-*` custom properties (`--jb-connect-pad`
  is the dialog's inset, which the Signa frame bleeds through). The modal answers the frame's size reports
  with its resolved theme, so the Signa page inside takes the app's colours, font and corners.

The passkey account signs nothing in the app. Calls, signatures and payments go through Signa's review flow.
