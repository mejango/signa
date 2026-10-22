# W4 operator steps

Steps the W4 hardening changes need outside the repository. Each names its PR and what stays degraded until it is done.

## Signa build commit on Railway (verifiable build)

The Dockerfile takes the source commit as the plain build argument `SIGNA_BUILD_COMMIT`; CI passes `${{ github.sha }}`. Railway builds from the Dockerfile and passes a service variable to a build argument of the same name, so the Signa service needs:

- Variable `SIGNA_BUILD_COMMIT` = `${{RAILWAY_GIT_COMMIT_SHA}}` (a Railway reference to the deployed commit).

Until it is set, `GET https://api.signa.center/healthz` reports `"commit": null`. The `web` manifest hash and `scripts/rest/verify-served-build.mjs` work without it.

Anything other than a full 40-hex commit (an unresolved reference included) is reported as null, never echoed. Check after the next deploy: `curl -s https://api.signa.center/healthz` shows the deployed 40-hex commit, then `node scripts/rest/verify-served-build.mjs https://signa.center <that commit>` exits 0.

On GCP, pass the same build argument from the build trigger (for Cloud Build, `--build-arg SIGNA_BUILD_COMMIT=$COMMIT_SHA`).

## npm trusted publishing for @me.jango/signa

The publish workflow authenticates with GitHub OIDC (npm 11.21.1, pinned) and no longer reads `NPM_TOKEN`. Until the trusted publisher exists, the publish job fails with an auth error and no new version of the wallet client ships.

1. On npmjs.com, open `@me.jango/signa`, Settings, Trusted Publisher, add GitHub Actions: owner `mejango`, repository `signa`, workflow `publish.yml` (no environment), and enable "Allow npm publish" (the default may be staging-only).
2. Merge the PR that removes the token only after step 1.
3. After the first OIDC publish (Task 19 version bump; the OIDC setup is only proven by a real publish of a new version) shows provenance with no token, delete the `NPM_TOKEN` repository secret and revoke the token on npmjs.com.
