# Juicebox Center wallet client

Connect a Juicebox Center passkey account to your app, then request exact payment reviews.
This is the browser-only slice of the Center client. Bot access and the CLI ship separately as the
full client archive linked from https://juicebox.center/api/docs/client.

```sh
npm install @me.jango/signa
```

```js
import { createCenterWalletClient } from '@me.jango/signa';
const wallet = createCenterWalletClient({
  issuer: 'https://my.juicebox.center', audience: 'https://juicebox.center',
  callbackUri: window.location.origin + '/center/callback',
});
const prepared = await wallet.prepareConnection();
prepared.launch(); // full-page redirect to the account
// prepared.launch({ target: name }) submits into a window or iframe the app opened under that
// name; Center serves the sign-in inside an iframe only for apps its operator admits to frame.
// On /center/callback:
const connection = await wallet.completeConnection(window.location.href);
```

Your app origin and exact callback URI must be allowlisted by Center. Allow the issuer in your
`form-action` CSP directive and send `Referrer-Policy: strict-origin`. `restoreConnection()` reads the
saved connection, `disconnect()` clears it, and `payments()` prepares, completes and submits reviewed
payments. Protocol details: https://juicebox.center/api/docs/client
`refreshPayment({ waitSeconds })` holds a submitted payment's read on Center (up to 20 s) until the
operation moves, so an app can wait on it instead of polling. A record whose app grant is gone and whose
signed validity has passed can be cleared; it is archived as unknown and Center keeps the outcome.
