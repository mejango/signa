import { spawn, spawnSync, type ChildProcess, type StdioOptions } from "node:child_process";

const binary = process.env.ANVIL_BINARY ?? "anvil";

/** EVM suites skip when the Anvil binary does not run. */
export function anvilAvailable(): boolean {
  return spawnSync(binary, ["--version"]).status === 0;
}

/**
 * Every test chain starts here. Unpruned, Anvil writes block states to ~/.foundry/anvil/tmp and leaves
 * them behind when stopped (about 3 GB a run). Pruning keeps the newest `history` states in memory
 * (500 is Anvil's default) and writes none to disk.
 */
export function spawnAnvil(args: readonly string[],
  { stdio = "ignore", history = 500 }: { stdio?: StdioOptions; history?: number } = {}): ChildProcess {
  return spawn(binary, [...args, "--prune-history", String(history)], { stdio });
}
