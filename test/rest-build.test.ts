import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { expect, it } from "vitest";
// @ts-expect-error The build script is plain ESM without declarations.
import { webBuildOptions, webManifest } from "../scripts/rest/build-web.mjs";
import { createWalletSite } from "../src/rest/wallet/site.js";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));

it("rebuilds only current runtime files and all assets needed by a fresh dev start", async () => {
  const directory = await mkdtemp(join(tmpdir(), "center-build-"));
  try {
    // Share read-only inputs; every compiler, bundler and package output stays in this fixture.
    for (const name of ["src", "docs", "client", "wallet-client", "node_modules"]) await symlink(join(root, name), join(directory, name));
    for (const name of ["mcp", "scripts/rest", "test", "dist/src/db/migrations", ".generated/rest", ".generated/checks"])
      await mkdir(join(directory, name), { recursive: true });
    for (const name of ["src", "node_modules"]) await symlink(join(root, "mcp", name), join(directory, "mcp", name));
    for (const name of ["package.json", "tsconfig.json", "tsconfig.build.json", "mcp/package.json", "mcp/tsconfig.json", "mcp/tsconfig.build.json",
      "scripts/rest/clean-build.mjs", "scripts/rest/build-web.mjs", "scripts/rest/build-client.mjs", "scripts/rest/copy-assets.mjs", "scripts/rest/center.mjs"])
      await copyFile(join(root, name), join(directory, name));
    await writeFile(join(directory, "test/build-only.test.ts"), "export const testOnly = true;\n");
    await writeFile(join(directory, "dist/src/removed.js"), "throw new Error('obsolete');\n");
    await writeFile(join(directory, "dist/src/db/migrations/999_removed.sql"), "SELECT 'obsolete';\n");
    await writeFile(join(directory, ".generated/rest/removed-client.tgz"), "obsolete");
    await writeFile(join(directory, ".generated/checks/retained.json"), "{}");

    await execute("npm", ["run", "build"], { cwd: directory, timeout: 170_000, maxBuffer: 1024 * 1024 });

    for (const name of ["dist/src/removed.js", "dist/src/db/migrations/999_removed.sql", ".generated/rest/removed-client.tgz",
      "dist/.generated/rest/removed-client.tgz", "dist/test", "dist/scripts"])
      await expect(stat(join(directory, name)), name).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(directory, ".generated/checks/retained.json"), "utf8")).toBe("{}");
    expect((await readdir(join(directory, "dist/src/db/migrations"))).sort())
      .toEqual((await readdir(join(root, "src/db/migrations"))).sort());
    expect((await stat(join(directory, "mcp/dist/host.js"))).isFile()).toBe(true);
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as { scripts: { dev: string } };
    expect(manifest.scripts.dev).toMatch(/^npm run build && /);

    // Load the real emitted asset reader and public package; no server or upstream is started.
    const smoke = await execute(process.execPath, ["--input-type=module", "--eval", `
      import assert from 'node:assert/strict';
      import { createHash } from 'node:crypto';
      import { readFile } from 'node:fs/promises';
      import { readRestAssets } from './dist/src/rest/site.js';
      import { createSignaApp } from './dist/src/signaApp.js';
      import { CenterClient } from './.generated/rest/client/index.js';
      import { connect } from './.generated/rest/client/node.js';
      import { createCenterWalletClient } from './.generated/rest/wallet-client/index.js';
      import * as core from './.generated/rest/wallet-client/core/index.js';
      import { centerAccountConnector } from './.generated/rest/wallet-client/wagmi/index.js';
      import { JBConnectModal } from './.generated/rest/wallet-client/react/index.js';
      const assets = await readRestAssets();
      for (const key of ['accountsScript', 'walletScript', 'walletPaymentScript', 'walletSignupScript', 'walletRecoveryScript', 'walletDeviceScript', 'docsScript'])
        assert(assets[key].length > 0, key);
      assert(assets.documents.size > 0);
      assert.deepEqual([...assets.clientPackage.slice(0, 2)], [0x1f, 0x8b]);
      assert.equal(typeof CenterClient, 'function');
      assert.equal(typeof connect, 'function');
      assert.equal(typeof createCenterWalletClient, 'function');
      // /core re-exports the root entry instead of bundling a second copy.
      assert.equal(core.createCenterWalletClient, createCenterWalletClient);
      for (const value of [core.passkeyOption, centerAccountConnector, JBConnectModal]) assert.equal(typeof value, 'function');
      // The image's liveness names the commit it was built from and the manifest it serves.
      const health = await (await createSignaApp({ apiAudience: 'https://api.signa.center', walletOrigin: 'https://signa.center',
        currentRuntime: () => undefined }).request('http://api.signa.center/healthz')).json();
      assert.deepEqual(health, { ok: true, commit: process.env.SIGNA_BUILD_COMMIT,
        web: createHash('sha256').update(await readFile('./dist/.generated/rest/web-manifest.json')).digest('hex') });
      console.log('assets and client ready');
    `], { cwd: directory, timeout: 15_000, maxBuffer: 1024 * 1024, env: { ...process.env, SIGNA_BUILD_COMMIT: "cd".repeat(20) } });
    expect(smoke.stdout.trim()).toBe("assets and client ready");
    const cli = await execute(process.execPath, [".generated/rest/client/cli.mjs", "--help"], { cwd: directory, timeout: 15_000 });
    expect(cli.stdout).toContain("Install the Center client package");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 200_000);

it("the web manifest covers every served page, script and stylesheet", async () => {
  const { outputFiles } = await build({ ...webBuildOptions, write: false });
  const bundle = (name: string) => outputFiles!.find(file => file.path.endsWith(`/${name}.js`))!.text;
  const manifest: Record<string, string> = webManifest(bundle);
  // Production's wallet host serves these pages at the origin root (src/index.ts); no handler reads a service here.
  const app = createWalletSite({ origin: "https://signa.center", audience: "https://api.signa.center", basePath: "",
    browserScript: bundle("wallet"), qrScript: bundle("wallet-qr"), recoveryKitScript: bundle("wallet-recovery-kit"),
    payments: {} as never, paymentBrowserScript: bundle("wallet-payment"),
    signup: {} as never, signupBrowserScript: bundle("wallet-signup"),
    recovery: {} as never, recoveryBrowserScript: bundle("wallet-recovery"),
    devices: {} as never, deviceBrowserScript: bundle("wallet-device"), onramp: {} as never,
    login: {} as never, handoff: {} as never, policy: {} as never, refresh: { request: async () => {}, tick: async () => {} } });
  const sha256 = async (response: Response) => createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex");
  const pages = Object.keys(manifest).filter(path => !path.startsWith("/assets/"));
  expect(pages.sort()).toEqual(["/", "/add", "/create", "/funds", "/payment", "/recover"]);
  const named = new Set<string>();
  for (const page of pages) {
    const html = await (await app.request(`https://signa.center${page}`)).text();
    expect(createHash("sha256").update(html).digest("hex"), page).toBe(manifest[page]);
    const references = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g), ...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g),
      ...html.matchAll(/<meta name="module:[^"]+" content="([^"]+)"/g)].map(match => match[1]!);
    expect(references.length, page).toBeGreaterThan(1);
    for (const path of references) {
      expect(manifest, `${page} names ${path}`).toHaveProperty([path]);
      named.add(path);
    }
  }
  expect([...named].sort()).toEqual(Object.keys(manifest).filter(path => path.startsWith("/assets/")).sort());
  for (const path of named) expect(await sha256(await app.request(`https://signa.center${path}`)), path).toBe(manifest[path]);
}, 60_000);
