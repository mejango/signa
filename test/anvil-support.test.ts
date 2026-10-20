import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { anvilAvailable, spawnAnvil } from "./support/anvil.js";

const root = resolve(import.meta.dirname, "..");

describe.skipIf(!anvilAvailable())("test Anvil", () => {
  it("writes no block state to disk", async () => {
    const server = createServer();
    await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
    const port = (server.address() as { port: number }).port;
    await new Promise<void>(done => server.close(() => done()));
    // Unpruned, Anvil writes hundreds of states into the cache path for 1,000 blocks.
    const cache = await mkdtemp(join(tmpdir(), "anvil-cache-"));
    const rpc = async (method: string, params: unknown[] = []) => (await fetch(`http://127.0.0.1:${port}`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
    const child = spawnAnvil(["--host", "127.0.0.1", "--port", String(port), "--cache-path", cache, "--silent"]);
    const stopped = new Promise(done => { child.once("exit", done); child.once("error", done); });
    const stop = async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await stopped; };
    try {
      for (let i = 0; i < 100; i++) {
        try { await rpc("eth_chainId"); break; } catch { await new Promise(done => setTimeout(done, 30)); }
      }
      expect(await rpc("anvil_mine", ["0x3e8"])).toMatchObject({ result: null });
      // Suites read recent history; bare --prune-history would keep none.
      expect(await rpc("eth_getBalance", ["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", "0x258"])).toMatchObject({ result: expect.any(String) });
      await stop();
      expect(await readdir(cache, { recursive: true })).toEqual([]);
    } finally {
      await stop();
      await rm(cache, { recursive: true, force: true });
    }
  });
});

it("starts every test Anvil through the helper", () => {
  const helper = join("test", "support", "anvil.ts"), self = join("test", "anvil-support.test.ts");
  const direct = ["test", "src"].flatMap(dir => readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
    .map(file => join(dir, file)))
    .filter(file => /\.(ts|mjs)$/.test(file) && file !== helper && file !== self)
    .filter(file => /ANVIL_BINARY|spawn(Sync)?\(\s*["']anvil["']/.test(readFileSync(join(root, file), "utf8")));
  expect(direct).toEqual([]);
});
