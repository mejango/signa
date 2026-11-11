import { cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
for (const [from, to] of [
  ["src/rest/smartAccounts/factory-history", "dist/src/rest/smartAccounts/factory-history"],
  ["src/db/migrations", "dist/src/db/migrations"],
  ["src/rest/contracts/data", "dist/src/rest/contracts/data"],
  [
    "src/rest/smartAccounts/stack/artifacts",
    "dist/src/rest/smartAccounts/stack/artifacts",
  ],
  [
    "src/rest/smartAccounts/stack/passkey/artifacts",
    "dist/src/rest/smartAccounts/stack/passkey/artifacts",
  ],
  [
    "src/rest/smartAccounts/targets-evidence",
    "dist/src/rest/smartAccounts/targets-evidence",
  ],
  ["src/rest/userOperations/evidence", "dist/src/rest/userOperations/evidence"],
  [
    "src/rest/smartAccounts/stack/current-pimlico/artifacts",
    "dist/src/rest/smartAccounts/stack/current-pimlico/artifacts",
  ],
  [
    "src/rest/smartAccounts/stack/current-pimlico/evidence",
    "dist/src/rest/smartAccounts/stack/current-pimlico/evidence",
  ],
  [".generated/rest", "dist/.generated/rest"],
  ["docs/rest", "dist/docs/rest"],
]) {
  await mkdir(join(root, to), { recursive: true });
  await cp(join(root, from), join(root, to), { recursive: true });
}
await cp(
  join(root, "src/rest/smartAccounts/stack/manifest.json"),
  join(root, "dist/src/rest/smartAccounts/stack/manifest.json"),
);
for (const name of ["paymaster-manifest.json", "guard-manifest.json"]) {
  await cp(
    join(root, "src/rest/smartAccounts/stack/current-pimlico", name),
    join(root, "dist/src/rest/smartAccounts/stack/current-pimlico", name),
  );
}

await cp(join(root, "src/rest/protocol/operations.json"), join(root, "dist/src/rest/protocol/operations.json"));
