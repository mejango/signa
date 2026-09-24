import { spawn } from "node:child_process";
import { get } from "node:http";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("boots the real dormant entrypoint without database, RPC, or signing configuration", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    // Deliberately omit DATABASE_URL and every provider/treasury secret. A
    // dormant deployment must not construct the account runtime to become live.
    env: { PATH: process.env.PATH, NODE_ENV: "production", PORT: "0", SIGNA_RUNTIME_ENABLED: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "", errors = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.on("data", chunk => { errors += String(chunk); });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  try {
    let port: number | undefined;
    await expect.poll(() => {
      if (child.exitCode !== null) throw new Error(`Signa exited before listening: ${errors}`);
      for (const line of output.split("\n").slice(0, -1)) {
        const event = JSON.parse(line) as { event?: string; port?: number; mode?: string };
        if (event.event === "listening" && event.mode === "dormant") port = event.port;
      }
      return port;
    }, { timeout: 10_000 }).toBeGreaterThan(0);
    for (const [host, path, status] of [
      ["127.0.0.1", "/healthz", 200], ["127.0.0.1", "/readyz", 503],
      ["api.signa.center", "/api/v1", 503], ["signa.center", "/", 503],
    ] as const) {
      const actual = await new Promise<number | undefined>((resolve, reject) => {
        get({ hostname: "127.0.0.1", port, path, headers: { host } }, response => {
          response.resume();
          response.once("end", () => resolve(response.statusCode));
          response.once("error", reject);
        }).once("error", reject);
      });
      expect(actual).toBe(status);
    }
    expect(output).not.toContain('"runtime_ready"');
    expect(errors).toBe("");
  } finally {
    child.kill("SIGTERM");
    const deadline = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try { expect(await exited).toBe(0); }
    finally { clearTimeout(deadline); }
  }
}, 20_000);
