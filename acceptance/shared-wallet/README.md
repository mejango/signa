# Shared client acceptance

Run this separately from `npm run check`: it requires built Beep assets and an
already-running local Homerun Next preview. Missing configuration fails the run;
the ordinary release gate keeps all its required suites.

The test uses the actual clients and their installed wallet SDKs, genuine HTTP
handlers, PostgreSQL, Beep's SQLite store, a virtual passkey authenticator, and a
fresh unforked Anvil wallet deployment. A browser-only route bridges the configured
Signa HTTPS names to a local HTTP listener. No request is sent to the production
Signa issuer or API. The test starts no production signer and uses only public
fixture keys and synthetic Anvil balances.

Prepare both client checkouts with their supported Node versions and dependencies.
Build Beep with `npm run build`. Start Homerun on a loopback HTTP origin using a
separate `NEXT_DIST_DIR` build with these public settings:

```sh
NEXT_PUBLIC_CENTER_WALLET_ENABLED=true
NEXT_PUBLIC_CENTER_WALLET_ISSUER=https://signa.center
NEXT_PUBLIC_CENTER_WALLET_AUDIENCE=https://api.signa.center
NEXT_PUBLIC_CENTER_WALLET_MANIFEST_ID=wallet-dispatch-unforked-anvil
NEXT_PUBLIC_CENTER_WALLET_MANIFEST_REVISION=0x5fb10c62fa993223a3f6aa8d323cdf99ecd9c33b70ba37f61b8502363903be04
NEXT_PUBLIC_CENTER_WALLET_MAXIMUM_NETWORK_FEE_WEI=100000000000000
```

These manifest values enable the local **connection** preview. They are not
production payment pins. Keep production client configuration unchanged.

From Signa, with Node 22.16+ and `anvil` on PATH:

```sh
TEST_DATABASE_URL=postgresql://... \
BEEP_PILOT_ROOT=/absolute/path/to/beep \
HOMERUN_PILOT_ORIGIN=http://localhost:54065 \
npm run wallet:client-pilot
```

Use a disposable PostgreSQL 16 database with schema creation permission. Each run
creates and drops its own schema and in-memory Beep database, and stops its own
Anvil, browser and HTTP listeners. It leaves the pre-existing Homerun preview alone.
Next may append temporary build-directory types to its tsconfig; preserve unrelated
work when removing those generated entries afterward.

The test verifies two framed Signa sign-ins and the same deployed account across both
clients, distinct app signing keys, cookie-free handoff exchanges, callback secret
scrubbing, exact recovery of a committed exchange after its reply is lost, reload,
and real signed account reads. Framed sign-in does not give the client a central
session cookie, so this pilot does not exercise central logout; Signa's dedicated
logout tests cover revocation.
Screenshots and a sanitized report are written to
`.generated/wallet-observations/shared-clients/`.

Beep payments remain disabled. Its preview reaches a local chain without the
Juicebox project contracts, so a quote error is expected and is not payment evidence.
Homerun's Founder Haus project data is its existing demo. This test does not qualify
project quotes, payment execution, physical devices, production TLS/proxy behavior,
Base fee/settlement providers, deployment funding or production recovery relay.
