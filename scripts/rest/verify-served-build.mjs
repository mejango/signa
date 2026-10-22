#!/usr/bin/env node
// Rebuilds a commit's browser assets and compares them with what a live origin serves:
//   node scripts/rest/verify-served-build.mjs https://signa.center <40-hex commit>
// Exits 0 only when every script and stylesheet in the commit's web manifest is served byte for byte.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const [origin, commit] = process.argv.slice(2);
let exact;
try { exact = new URL(origin).origin === origin && /^https?:$/.test(new URL(origin).protocol); } catch { exact = false; }
if (!exact || !/^[0-9a-f]{40}$/.test(commit ?? "")) {
  console.error("Usage: node scripts/rest/verify-served-build.mjs <origin, e.g. https://signa.center> <full 40-hex commit>");
  process.exit(2);
}

const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "signa-verify-"));
const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: ["ignore", "ignore", "inherit"] });
try {
  run("git", ["worktree", "add", "--detach", directory, commit], root);
  run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], directory);
  run("npm", ["run", "build:web"], directory);
  const manifest = JSON.parse(await readFile(join(directory, ".generated/rest/web-manifest.json"), "utf8"));
  let differences = 0;
  for (const [path, built] of Object.entries(manifest)) {
    let served;
    try {
      // The origin itself must serve the bytes its pages name; a redirect elsewhere is a difference.
      const response = await fetch(new URL(path, origin), { redirect: "error", cache: "no-store" });
      served = response.ok ? createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex") : `HTTP ${response.status}`;
    } catch (error) { served = `unreachable (${error.cause?.code ?? error.message})`; }
    if (served === built) console.log(`same     ${path}`);
    else { differences++; console.log(`DIFFERS  ${path}\n  built  ${built}\n  served ${served}`); }
  }
  console.log(differences ? `${differences} of ${Object.keys(manifest).length} served assets differ from ${commit}.`
    : `All ${Object.keys(manifest).length} served assets match ${commit}.`);
  process.exitCode = differences ? 1 : 0;
} catch (error) {
  console.error(`Could not rebuild ${commit}: ${error.message}`);
  process.exitCode = 1;
} finally {
  try { run("git", ["worktree", "remove", "--force", directory], root); } catch { /* removed below */ }
  await rm(directory, { recursive: true, force: true });
}
