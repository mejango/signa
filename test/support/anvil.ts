import { spawn, spawnSync, type ChildProcess, type StdioOptions } from "node:child_process";

const binary = process.env.ANVIL_BINARY ?? "anvil";

/** EVM suites skip when the Anvil binary does not run. */
export function anvilAvailable(): boolean {
  return spawnSync(binary, ["--version"]).status === 0;
}

/** Every test chain starts here. */
export function spawnAnvil(args: readonly string[], { stdio = "ignore" }: { stdio?: StdioOptions } = {}): ChildProcess {
  return spawn(binary, args, { stdio });
}
