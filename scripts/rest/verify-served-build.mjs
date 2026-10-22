#!/usr/bin/env node
// Rebuilds a commit's wallet pages and browser assets and compares them with what a live origin serves:
//   node scripts/rest/verify-served-build.mjs https://signa.center <40-hex commit> [--unmerged]
// Exits 0 only when every page, script and stylesheet in the commit's web manifest is served byte for byte.
// The commit must be on origin/main unless --unmerged (a local check of a branch); its build runs that
// commit's code without this shell's environment.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const [origin, commit, flag] = process.argv.slice(2);
let exact;
try { exact = new URL(origin).origin === origin && /^https?:$/.test(new URL(origin).protocol); } catch { exact = false; }
if (!exact || !/^[0-9a-f]{40}$/.test(commit ?? "") || ![undefined, "--unmerged"].includes(flag)) {
  console.error("Usage: node scripts/rest/verify-served-build.mjs <origin, e.g. https://signa.center> <full 40-hex commit> [--unmerged]");
  process.exit(2);
}

const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "signa-verify-"));
const run = (command, args, cwd, env = process.env) => execFileSync(command, args, { cwd, env, stdio: ["ignore", "ignore", "inherit"] });
// The rebuild sees no deployment or operator secrets from this shell.
const buildEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
const sha256 = /^[0-9a-f]{64}$/;
try {
  if (!flag) {
    run("git", ["fetch", "--quiet", "origin", "main"], root);
    run("git", ["merge-base", "--is-ancestor", commit, "FETCH_HEAD"], root);
  }
  run("git", ["worktree", "add", "--detach", directory, commit], root);
  run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], directory, buildEnv);
  run("npm", ["run", "build:web"], directory, buildEnv);
  const manifest = JSON.parse(await readFile(join(directory, ".generated/rest/web-manifest.json"), "utf8"));
  const entries = manifest && typeof manifest === "object" && !Array.isArray(manifest) ? Object.entries(manifest) : [];
  if (!entries.some(([path]) => path === "/") || !entries.some(([path]) => path.startsWith("/assets/"))
    || !entries.every(([path, hash]) => /^\/[A-Za-z0-9./-]*$/.test(path) && !path.includes("..") && sha256.test(hash)))
    throw new Error("its web manifest is missing or malformed");
  let differences = 0;
  for (const [path, built] of entries) {
    let served;
    try {
      // The origin itself must serve the bytes its pages name; a redirect elsewhere is a difference.
      const response = await fetch(new URL(path, origin), { redirect: "error", cache: "no-store" });
      served = response.ok ? createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex") : `HTTP ${response.status}`;
    } catch (error) { served = `unreachable (${error.cause?.code ?? error.message})`; }
    if (served === built) console.log(`same     ${path}`);
    else { differences++; console.log(`DIFFERS  ${path}\n  built  ${built}\n  served ${served}`); }
  }
  console.log(differences ? `${differences} of ${entries.length} served files differ from ${commit}.`
    : `All ${entries.length} served files match ${commit}.`);
  process.exitCode = differences ? 1 : 0;
} catch (error) {
  console.error(`Could not rebuild ${commit}${flag ? "" : " (it must be on origin/main)"}: ${error.message}`);
  process.exitCode = 1;
} finally {
  try { execFileSync("git", ["worktree", "remove", "--force", directory], { cwd: root, stdio: "ignore" }); } catch { /* never added; removed below */ }
  await rm(directory, { recursive: true, force: true });
}
