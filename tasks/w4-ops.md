# W4 operator steps

Steps the W4 hardening changes need outside the repository. Each names its PR and what stays degraded until it is done.

## Signa build commit on Railway (verifiable build)

The Dockerfile accepts the explicit build argument `SIGNA_BUILD_COMMIT`; CI passes `${{ github.sha }}`. When that value is absent or empty, the server reads Railway's native `RAILWAY_GIT_COMMIT_SHA` directly. No service-variable alias is needed.

Remove an existing `SIGNA_BUILD_COMMIT=${{RAILWAY_GIT_COMMIT_SHA}}` alias. The production check on 2026-11-12 found that alias resolved to an empty string while the native Railway variable contained the correct deployment commit.

Only a full 40-hex commit is reported. A nonempty malformed explicit override remains null rather than being replaced by the fallback. These are deployment metadata; the manifest and served-file verifier independently check the browser assets. After deployment, confirm `GET https://api.signa.center/healthz` reports the deployment SHA, then run `node scripts/rest/verify-served-build.mjs https://signa.center <that commit>`.

On GCP, pass the same build argument from the build trigger (for Cloud Build, `--build-arg SIGNA_BUILD_COMMIT=$COMMIT_SHA`).

## npm trusted publishing for @me.jango/signa

The publish workflow authenticates with GitHub OIDC (npm 11.21.1, pinned) and no longer reads `NPM_TOKEN`. Until the trusted publisher exists, the publish job fails with an auth error and no new version of the wallet client ships.

1. On npmjs.com, open `@me.jango/signa`, Settings, Trusted Publisher, add GitHub Actions: owner `mejango`, repository `signa`, workflow `publish.yml` (no environment), and enable "Allow npm publish" (the default may be staging-only).
2. Merge the PR that removes the token only after step 1.
3. After the first OIDC publish (Task 19 version bump; the OIDC setup is only proven by a real publish of a new version) shows provenance with no token, delete the `NPM_TOKEN` repository secret and revoke the token on npmjs.com.

## Hosting-neutral environment names

Signa reads `SIGNA_ENVIRONMENT` (`dev` or `production`, default production), `SIGNA_REPLICA_ID` and `SIGNA_REPLICA_REGION`, and falls back to `RAILWAY_ENVIRONMENT_NAME`, `RAILWAY_REPLICA_ID` and `RAILWAY_REPLICA_REGION`. Today's deploy needs no change. Set the three `SIGNA_*` names on each service (the dev service gets `SIGNA_ENVIRONMENT=dev`) before leaving Railway; a later PR removes the fallback.
