import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { finished } from "node:stream/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const requiredVitestSuites = [
  "test/postgres.integration.test.ts",
  "test/rest-smart-accounts-postgres.integration.test.ts",
  "test/rest-transactions-postgres.integration.test.ts",
  "test/rest-user-operations-postgres.integration.test.ts",
  "test/rest-wallet-owner-state.test.ts",
  "test/rest-wallet-owner-state-postgres.integration.test.ts",
  "test/rest-wallet-recovery-multichain.test.ts",
  "test/rest-sponsorship-postgres.integration.test.ts",
  "test/rest-sponsor-caps-postgres.integration.test.ts",
  "test/rest-sponsor-caps.test.ts",
  "test/rest-sessions-postgres.integration.test.ts",
  "test/rest-smart-account-onboarding-store.integration.test.ts",
  "test/rest-auth-store.test.ts",
  "test/rest-sessions-service.test.ts",
  "test/rest-smart-account-checkpoints.test.ts",
  "test/rest-wallet-ceremonies-postgres.integration.test.ts",
  "test/rest-smart-accounts-policy-evm.test.ts",
  "test/rest-smart-accounts-inspector-evm.test.ts",
  "test/rest-user-operations-evm.test.ts",
  "test/rest-user-operations-chain-execution.test.ts",
  "test/rest-sponsorship-execution.test.ts",
  "test/rest-execution-app.test.ts",
  "test/rest-execution-runtime.test.ts",
  "test/rest-execution-config.test.ts",
  "test/rest-wallet-webauthn.test.ts",
  "test/rest-wallet-production-stack.test.ts",
  "test/rest-wallet-dependency-bundle.test.ts",
  "test/rest-web-bundle-budget.test.ts",
  "test/rest-user-pay-metadata.test.ts",
  "test/rest-web-assets.test.ts",
  "test/rest-accounts-browser.test.ts",
  "test/rest-docs-browser.test.ts",
  "test/rest-wallet-dependency-funding.test.ts",
  "test/rest-relayr-payment-evm.test.ts",
  "test/rest-relayr-payment-source.test.ts",
  "test/rest-relayr-payment-event.test.ts",
  "test/rest-passkey-evidence.test.ts",
  "test/rest-passkey-signatures.test.ts",
  "test/rest-wallet-passkey-evm.test.ts",
  "test/rest-passkey-profile-evm.test.ts",
  "test/rest-passkey-onboarding.test.ts",
  "test/rest-passkey-user-operations.test.ts",
  "test/rest-passkey-creation.test.ts",
  "test/rest-passkey-creation-evm.test.ts",
  "test/rest-wallet-registration.test.ts",
  "test/rest-wallet-browser.test.ts",
  "test/rest-wallet-enrollment-postgres.integration.test.ts",
  "test/rest-wallet-signup-postgres.integration.test.ts",
  "test/rest-wallet-signup-evm-postgres.integration.test.ts",
  "test/rest-wallet-signup-site.test.ts",
  "test/rest-wallet-networks.test.ts",
  "test/rest-wallet-networks-postgres.integration.test.ts",
  "test/rest-wallet-passkey-recovery.test.ts",
  "test/rest-wallet-passkey-recovery-postgres.integration.test.ts",
  "test/rest-wallet-recovery-kit.test.ts",
  "test/rest-wallet-recovery-lineage.test.ts",
  "test/rest-wallet-recovery-flow-postgres.integration.test.ts",
  "test/rest-wallet-recovery-dispatch-postgres.integration.test.ts",
  "test/rest-wallet-recovery-rotation.test.ts",
  "test/rest-wallet-device-addition.test.ts",
  "test/rest-wallet-device-site.test.ts",
  "test/rest-web-qr.test.ts",
  "test/rest-wallet-device-browser.test.ts",
  "test/rest-wallet-recovery-review.test.ts",
  "test/rest-wallet-recovery-site.test.ts",
  "test/rest-wallet-recovery-browser.test.ts",
  "test/rest-wallet-enrollment-browser.test.ts",
  "test/rest-wallet-enrollment-pressure.test.ts",
  "test/rest-wallet-deployment.test.ts",
  "test/rest-wallet-deployment-postgres.integration.test.ts",
  "test/rest-wallet-deployment-execution.test.ts",
  "test/rest-wallet-deployment-execution-postgres.integration.test.ts",
  "test/rest-wallet-deployment-dispatch-evm-postgres.integration.test.ts",
  "test/rest-wallet-deployment-local-anvil.test.ts",
  "test/rest-wallet-deployment-scalar-evm.test.ts",
  "test/rest-wallet-deployment-chain.test.ts",
  "test/rest-wallet-deployment-chain-evm.test.ts",
  "test/rest-wallet-deployment-observation.test.ts",
  "test/rest-wallet-deployment-observation-evm.test.ts",
  "test/rest-wallet-deployment-fees.test.ts",
  "test/rest-wallet-deployment-fees-anvil.test.ts",
  "test/anvil-support.test.ts",
  "test/rest-wallet-base-receipt-fees.test.ts",
  "test/rest-wallet-base-fee-observation.test.ts",
  "test/rest-wallet-policy.test.ts",
  "test/rest-wallet-policy-postgres.integration.test.ts",
  "test/rest-wallet-app-grants.test.ts",
  "test/rest-wallet-app-grants-postgres.integration.test.ts",
  "test/rest-wallet-app-authority.test.ts",
  "test/rest-wallet-app-auth-postgres.integration.test.ts",
  "test/rest-wallet-app-dispatch.test.ts",
  "test/rest-wallet-app-sessions.test.ts",
  "test/rest-wallet-authority.test.ts",
  "test/rest-wallet-authority-chain.test.ts",
  "test/rest-wallet-authority-evm.test.ts",
  "test/rest-wallet-authority-postgres.integration.test.ts",
  "test/rest-wallet-authority-service.test.ts",
  "test/rest-wallet-authority-refresh.test.ts",
  "test/rest-wallet-authority-refresh-postgres.integration.test.ts",
  "test/rest-wallet-login.test.ts",
  "test/rest-wallet-login-postgres.integration.test.ts",
  "test/rest-wallet-handoff.test.ts",
  "test/rest-wallet-handoff-postgres.integration.test.ts",
  "test/rest-wallet-site.test.ts",
  "test/rest-wallet-site-postgres.integration.test.ts",
  "test/rest-wallet-connect-browser-postgres.integration.test.ts",
  "test/rest-wallet-app-refresh-postgres.integration.test.ts",
  "test/rest-wallet-payment-reviews-postgres.integration.test.ts",
  "test/rest-wallet-payment-reviews.test.ts",
  "test/rest-wallet-payment-public.test.ts",
  "test/rest-wallet-payment-client.test.ts",
  "test/rest-wallet-payment-browser.test.ts",
  "test/rest-wallet-payment-http-postgres.integration.test.ts",
  "test/rest-wallet-pressure-schedule.test.ts",
  "test/rest-wallet-pressure-postgres.integration.test.ts",
  "test/rest-user-operations-v6-payment-semantics.test.ts",
  "test/rest-wallet-deployment-settlement-postgres.integration.test.ts",
  "test/rest-wallet-deployment-settlement-evm-postgres.integration.test.ts",
  "test/rest-wallet-deployment-settlement.test.ts",
  "test/rest-wallet-deployment-settlement-local-anvil.test.ts",
  "test/rest-wallet-deployment-base-boundaries.test.ts",
  "test/rest-wallet-deployment-base-postgres.integration.test.ts",
  "test/rest-wallet-deployment-base-anvil.test.ts",
  "test/rest-wallet-signup-base-postgres.integration.test.ts",
  "test/rest-wallet-base-host-postgres.integration.test.ts",
  "test/rest-wallet-recovery-base-postgres.integration.test.ts",
  "test/rest-wallet-v6-payment-evm.test.ts",
  "test/rest-reviewed-calls.test.ts",
  "test/rest-reviewed-calls-evm.test.ts",
  "test/rest-v6-payment-fixture.test.ts",
  "test/rest-wallet-http.test.ts",
  "test/rest-wallet-runtime.test.ts",
  "test/rest-wallet-client.test.ts",
  "test/rest-wallet-device-probe.test.ts",
  "test/rest-wallet-device-probe-browser.test.ts",
  "test/rest-signed-transaction.test.ts",
];

// Reuse the execution fixture's catalog/source/compiler validation without starting an EVM.
// No local checkout path is implied; its explicit dependency is documented beside the fixture.
export const v6PaymentSourcePreflight = ["--import", "tsx", "--input-type=module", "--eval", `
  try {
    const { loadV6PaymentArtifacts } = await import('./test/fixtures/v6-payment/contracts.ts');
    const { contracts, verifiedSourceCount } = await loadV6PaymentArtifacts();
    process.stdout.write(JSON.stringify({ contracts: contracts.size, verifiedSourceCount }) + '\\n');
  } catch {
    process.stderr.write('V6 payment source preflight failed. Configure CENTER_V6_SOURCE_ROOT with the pinned source and artifacts documented in test/fixtures/v6-payment/README.md.\\n');
    process.exitCode = 1;
  }
`];

export function validateRuntime(version, databaseUrl) {
  const [major, minor] = version.split(".").map(Number);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || major < 22 || (major === 22 && minor < 16)) {
    throw new Error("Release checks require Node.js 22.16.0 or newer, matching the MCP package.");
  }
  if (!databaseUrl?.trim()) throw new Error("Release checks require TEST_DATABASE_URL pointing to a disposable PostgreSQL 16 database; focused npm test remains available without it.");
}

export async function checkDatabase(client) {
  try {
    await client.connect();
    const { rows } = await client.query("SELECT current_setting('server_version_num') AS version");
    if (Math.floor(Number(rows[0]?.version) / 10_000) !== 16) throw new Error("version");
    // Prove the permissions used by the integration suites without leaving any schema behind.
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA "center_check_${randomUUID().replaceAll("-", "")}"`);
    await client.query("ROLLBACK");
    return { major: 16, schemaPermissions: true };
  } catch {
    // Driver errors can include credentials, host names or connection strings.
    throw new Error("Test PostgreSQL preflight failed; use a reachable, writable PostgreSQL 16 test database.");
  } finally {
    try { await client.end(); } catch { /* Never expose a driver error while closing a failed connection. */ }
  }
}

export function summarizeVitest(report, projectRoot, requiredSuites = requiredVitestSuites) {
  const fail = (suites = []) => {
    const error = new Error("Required service test evidence is failed, skipped, todo or missing; no release check may silently omit tests.");
    error.suites = suites;
    throw error;
  };
  if (!Array.isArray(report?.testResults)) fail();
  const suites = report.testResults.map(result => {
    if (typeof result.name !== "string" || !Array.isArray(result.assertionResults)) fail();
    return { name: relative(projectRoot, resolve(projectRoot, result.name)), total: result.assertionResults.length,
      passed: result.assertionResults.filter(test => test.status === "passed").length,
      failed: result.assertionResults.filter(test => test.status === "failed").length,
      skipped: result.assertionResults.filter(test => test.status !== "passed" && test.status !== "failed").length };
  });
  const names = new Set(suites.map(suite => suite.name));
  if (!report.success || !report.numTotalTests || report.numFailedTests || report.numPendingTests || report.numTodoTests ||
    report.testResults.some(result => result.status !== "passed") || suites.some(suite => !suite.total || suite.passed !== suite.total) ||
    names.size !== suites.length || requiredSuites.some(name => !names.has(name)) ||
    suites.reduce((total, suite) => total + suite.total, 0) !== report.numTotalTests) fail(suites);
  return suites;
}

export function verifyExecutionReport(report) {
  if (!Array.isArray(report?.suites) || !report.suites.length || report.suites.some(suite =>
    typeof suite.name !== "string" || !suite.name || !Number.isSafeInteger(suite.total) || suite.total < 1 ||
    suite.passed !== suite.total || suite.failed !== 0 || suite.skipped !== 0) ||
    new Set(report.suites.map(suite => suite.name)).size !== report.suites.length) {
    throw new Error("Required execution suite counts are missing, failed, skipped or empty.");
  }
  return report.suites.map(({ name, total, passed, failed, skipped }) => ({ name, total, passed, failed, skipped }));
}

export function redactOutput(env) {
  const secrets = new Set();
  const collect = (name, value) => {
    if (value && typeof value === "object") { for (const [key, item] of Object.entries(value)) collect(key, item); return; }
    if (typeof value !== "string" || !value) return;
    if (/TOKEN|SECRET|PASSWORD|PRIVATE_?KEY|DATABASE_URL|API_?KEY|JWT|AUTHORIZATION_?KEY/i.test(name)) {
      secrets.add(value);
      for (const line of value.split(/\r?\n/)) if (line) secrets.add(line);
    }
    try {
      const url = new URL(value);
      if (url.password) secrets.add(decodeURIComponent(url.password));
    } catch { /* An opaque secret is already covered by its exact value. */ }
    if (value.startsWith("{") || value.startsWith("[")) {
      try { collect(name, JSON.parse(value)); } catch { /* Non-JSON configuration has no structured credentials. */ }
    }
  };
  for (const [name, value] of Object.entries(env)) collect(name, value);
  const values = [...secrets].sort((a, b) => b.length - a.length);
  return input => {
    for (const value of values) input = input.replaceAll(value, "[redacted]");
    return input.replace(/\b(?:postgres(?:ql)?|https?):\/\/[^\s'"<>]+/gi, "[redacted-url]");
  };
}

export async function writeObservation(path, observation) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(observation, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export async function captureSourceSnapshot(projectRoot, gitEnv = process.env, gitBinary = 'git') {
  const git = args => {
    const result = spawnSync(gitBinary, args, { cwd: projectRoot, env: gitEnv, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 10_000 });
    if (result.error || result.status !== 0) throw new Error("Cannot attribute checks to the Git source tree.");
    return result.stdout;
  };
  const revision = git(["rev-parse", "HEAD"]).trim();
  const objectFormat = git(["rev-parse", "--show-object-format"]).trim();
  if (objectFormat !== "sha1" && objectFormat !== "sha256") throw new Error("Unsupported Git object format for source attribution.");
  const entries = args => git(args).split("\0").filter(Boolean).map(entry => {
    const separator = entry.indexOf("\t");
    if (separator < 0) throw new Error("Invalid Git source inventory.");
    return { path: entry.slice(separator + 1), metadata: entry.slice(0, separator).split(" ") };
  });
  const committed = new Map();
  for (const { path, metadata: [mode, type, object] } of entries(["ls-tree", "-r", "-z", "--full-tree", revision])) {
    if (type !== "blob") throw new Error("Git submodule source requires its own attribution evidence.");
    committed.set(path, { mode, object });
  }
  const indexed = new Map();
  for (const { path, metadata } of entries(["ls-files", "--stage", "-z"])) {
    if (metadata[0] === "160000") throw new Error("Git submodule source requires its own attribution evidence.");
    indexed.set(path, [...(indexed.get(path) ?? []), metadata]);
  }
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
  const paths = [...new Set([...committed.keys(), ...indexed.keys(), ...untracked])].sort();
  const readSource = async path => {
    let location = projectRoot;
    const components = path.split("/");
    for (const [index, component] of components.entries()) {
      location = resolve(location, component);
      let stat;
      try { stat = await lstat(location); }
      catch (error) {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return { mode: "missing", bytes: null };
        throw error;
      }
      const last = index === components.length - 1;
      if (stat.isSymbolicLink()) return { mode: last ? "120000" : "symlink-parent", bytes: await readlink(location, { encoding: "buffer" }) };
      if (!last && !stat.isDirectory()) return { mode: "non-directory-parent", bytes: null };
      if (last) {
        if (stat.isFile()) return { mode: stat.mode & 0o111 ? "100755" : "100644", bytes: await readFile(location) };
        if (stat.isDirectory()) return { mode: "040000", bytes: null };
        throw new Error("Cannot attribute a non-regular source file.");
      }
    }
  };
  // Like MCP source evidence, read actual bytes: index flags and clean filters can hide executable changes.
  // Git blob framing compares those bytes to HEAD without invoking a clean filter or one Git process per file.
  let dirty = false;
  const hash = createHash("sha256").update(revision);
  for (const path of paths) {
    const { mode, bytes } = await readSource(path);
    const head = committed.get(path);
    const index = indexed.get(path) ?? [];
    const object = bytes === null ? null : createHash(objectFormat).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (!head || head.mode !== mode || head.object !== object || index.length !== 1 ||
      index[0][0] !== head.mode || index[0][1] !== head.object || index[0][2] !== "0") dirty = true;
    const contentHash = bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
    hash.update(JSON.stringify([path, mode, contentHash, index])).update("\n");
  }
  return { revision, dirty, fingerprint: hash.digest("hex") };
}

export async function runStep(name, binary, args, { directory, observation, cwd, env, save, timeoutMs = 10 * 60_000 }) {
  const step = { name, status: "running", startedAt: new Date().toISOString(), log: `${name}.log`, timeoutMs };
  observation.steps.push(step);
  await save();
  console.log(`[check] ${name}: started`);
  const log = createWriteStream(resolve(directory, step.log), { mode: 0o600 });
  const redact = redactOutput(env);
  const child = spawn(binary, args, { cwd, env: { ...env, FORCE_COLOR: "0" }, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  let failure;
  const terminate = () => {
    if (!child.pid) return;
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", timeout: 5_000 });
    else { try { process.kill(-child.pid, "SIGKILL"); } catch { /* The whole process group already exited. */ } }
  };
  const logFinished = finished(log).catch(() => { failure ??= "log write failed"; terminate(); });
  const interrupted = () => { failure ??= "interrupted"; terminate(); };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  const deadline = setTimeout(() => { failure ??= "timed out"; terminate(); }, timeoutMs);
  let outputBytes = 0;
  const drain = async (stream, target) => {
    stream.setEncoding("utf8");
    let pending = "";
    for await (const chunk of stream) {
      pending += chunk.toString();
      outputBytes += Buffer.byteLength(chunk);
      if (pending.length > 1024 * 1024 || outputBytes > 32 * 1024 * 1024) {
        throw new Error("Output limit exceeded.");
      }
      const boundary = pending.lastIndexOf("\n");
      if (boundary < 0) continue;
      const output = redact(pending.slice(0, boundary + 1));
      log.write(output);
      target.write(output);
      pending = pending.slice(boundary + 1);
    }
    if (pending) { const output = redact(pending); log.write(output); target.write(output); }
  };
  const closed = new Promise(done => {
    child.once("error", () => done({ code: null, signal: null }));
    child.once("close", (code, signal) => done({ code, signal }));
  });
  const drainSafely = stream => drain(stream, stream === child.stdout ? process.stdout : process.stderr)
    .catch(() => { failure ??= "output processing failed"; terminate(); });
  const [{ code, signal }] = await Promise.all([closed, drainSafely(child.stdout), drainSafely(child.stderr)]);
  clearTimeout(deadline);
  terminate(); // Also clean up descendants whose parent exited without awaiting them.
  process.removeListener("SIGINT", interrupted);
  process.removeListener("SIGTERM", interrupted);
  log.end();
  await logFinished;
  Object.assign(step, { status: code === 0 && !failure ? "passed" : "failed", endedAt: new Date().toISOString(), exitCode: code, signal,
    timedOut: failure === "timed out", ...(failure ? { failure } : {}) });
  await save();
  console.log(`[check] ${name}: ${step.status}`);
  if (step.status !== "passed") throw new Error(`${name} failed${failure ? ` (${failure})` : ""}; see ${step.log}.`);
}

export async function prepareV6PaymentDependency(env, options) {
  if (env.CENTER_V6_SOURCE_ROOT?.trim()) return null;
  const temporary = await realpath(await mkdtemp(resolve(tmpdir(), "center-check-v6-")));
  try {
    const destination = resolve(temporary, "source");
    await runStep("v6-payment-extract", process.execPath,
      ["scripts/rest/prepare-v6-payment-fixture.mjs", "--output", destination], { ...options, env, timeoutMs: 30_000 });
    env.CENTER_V6_SOURCE_ROOT = destination;
    return temporary;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }); throw error;
  }
}

async function main() {
  const preflightOnly = process.argv.includes("--preflight");
  if (process.argv.slice(2).some(arg => arg !== "--preflight")) throw new Error("Usage: check-required-tests.mjs [--preflight]");
  const runId = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`;
  const directory = resolve(root, ".generated/checks", runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const observation = { schemaVersion: 1, runId, startedAt: new Date().toISOString(), endedAt: null,
    revision: null, dirty: null, sourceStart: null, sourceEnd: null, sourceChangedDuringCheck: null,
    node: process.versions.node, mode: preflightOnly ? "preflight" : "release", status: "running", steps: [], suites: [] };
  const save = () => writeObservation(resolve(directory, "summary.json"), observation);
  const checkEnv = { ...process.env };
  const options = { directory, observation, cwd: root, env: checkEnv, save };
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  let temporary, v6Temporary;
  console.log(`[check] observation: ${relative(root, directory)}/summary.json`);
  await save();
  try {
    observation.sourceStart = await captureSourceSnapshot(root);
    observation.revision = observation.sourceStart.revision;
    observation.dirty = observation.sourceStart.dirty;
    validateRuntime(process.versions.node, process.env.TEST_DATABASE_URL);
    v6Temporary = await prepareV6PaymentDependency(checkEnv, options);
    await runStep("v6-payment-sources", process.execPath, v6PaymentSourcePreflight, { ...options, timeoutMs: 30_000 });
    observation.database = await checkDatabase(new Client({ connectionString: process.env.TEST_DATABASE_URL,
      connectionTimeoutMillis: 5_000, query_timeout: 5_000 }));
    await save();
    if (!preflightOnly) {
      const executionReport = resolve(directory, "execution.json");
      await runStep("execution", npm, ["run", "check:execution"], { ...options,
        env: { ...checkEnv, CENTER_EXECUTION_REPORT: executionReport } });
      observation.suites.push(...verifyExecutionReport(JSON.parse(await readFile(executionReport, "utf8"))));
      const passkeyReport = resolve(directory, "passkey.json");
      await runStep("wallet-compatibility", npm, ["run", "check:wallet-compatibility"], { ...options,
        env: { ...checkEnv, CENTER_PASSKEY_REPORT: passkeyReport } });
      observation.suites.push(...verifyExecutionReport(JSON.parse(await readFile(passkeyReport, "utf8"))));
      temporary = await mkdtemp(resolve(tmpdir(), "center-check-report-"));
      const mcpReport = resolve(temporary, "mcp.json");
      let mcpError;
      try { await runStep("mcp", npm, ["--prefix", "mcp", "run", "check"], { ...options,
        env: { ...checkEnv, CENTER_MCP_REPORT: mcpReport } }); }
      catch (error) { mcpError = error; }
      observation.suites.push(...summarizeVitest(JSON.parse(await readFile(mcpReport, "utf8")), root, []));
      if (mcpError) throw mcpError;
      await runStep("typecheck", npm, ["run", "typecheck"], options);
      await runStep("connect", npm, ["run", "test:connect"], options);
      const report = resolve(temporary, "service.json");
      let testError;
      try { await runStep("service", npm, ["test", "--", "--reporter=default", "--reporter=json", `--outputFile.json=${report}`], options); }
      catch (error) { testError = error; }
      const service = JSON.parse(await readFile(report, "utf8"));
      observation.suites.push(...summarizeVitest(service, root));
      if (testError) throw testError;
      await runStep("build", npm, ["run", "build"], options);
    }
    observation.status = "passed";
  } catch (error) {
    observation.status = "failed";
    if (Array.isArray(error?.suites)) observation.suites.push(...error.suites);
    observation.failure = redactOutput(process.env)(error instanceof Error ? error.message : "Required check failed.");
    process.stderr.write(`[check] ${observation.failure}\n`);
    process.exitCode = 1;
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
    if (v6Temporary) await rm(v6Temporary, { recursive: true, force: true });
    try {
      observation.sourceEnd = await captureSourceSnapshot(root);
      observation.sourceChangedDuringCheck = observation.sourceStart?.fingerprint !== observation.sourceEnd.fingerprint;
      if (observation.sourceChangedDuringCheck) {
        observation.status = "failed";
        observation.failure ??= "Source changed during checks; rerun against a stable source tree.";
        process.exitCode = 1;
      }
    } catch {
      observation.status = "failed";
      observation.failure ??= "Cannot attribute the completed check to the Git source tree.";
      process.exitCode = 1;
    }
    observation.endedAt = new Date().toISOString();
    await save();
    console.log(`[check] ${observation.status}: ${relative(root, directory)}/summary.json`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
