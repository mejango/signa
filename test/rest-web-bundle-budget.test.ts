import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { expect, it } from "vitest";
// @ts-expect-error The build script is plain ESM without declarations.
import { webBuildOptions } from "../scripts/rest/build-web.mjs";

// Gzip bytes each served page may load. Raise a budget only for code the page itself needs.
const budgets: Record<string, number> = {
  "wallet-recovery": 122_000, "wallet-device": 11_000, "wallet-signup": 119_000, "wallet-payment": 26_000,
  wallet: 12_500, accounts: 73_000, docs: 1_000,
};

it("keeps every browser bundle within its budget and the SDK on the server", async () => {
  const result = await build({ ...webBuildOptions, write: false, metafile: true });
  const sizes = Object.fromEntries(result.outputFiles!.map(file =>
    [file.path.split("/").pop()!.replace(/\.js$/, ""), gzipSync(file.contents).length]));
  for (const [name, budget] of Object.entries(budgets)) expect(sizes[name], name).toBeLessThanOrEqual(budget);
  // The SDK's generated ABI and address tables are server-side; pages get its decoded results.
  const inputs = Object.values(result.metafile!.outputs).flatMap(output => Object.keys(output.inputs));
  expect(inputs.filter(input => input.includes("@bananapus/"))).toEqual([]);
}, 60_000);
