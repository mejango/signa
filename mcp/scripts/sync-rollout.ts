import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  assertSourcePath,
  sourceDiffersFromCommit,
  writeBundleAtomically,
} from './sync-knowledge.js';

export function assertExecutedReceipt(receipt: unknown, path: string): void {
  const value = receipt && typeof receipt === 'object' ? (receipt as Record<string, unknown>) : {};
  const hash = (candidate: unknown) =>
    typeof candidate === 'string' &&
    /^0x[0-9a-f]{64}$/i.test(candidate) &&
    !/^0x0+$/.test(candidate);
  const block = value.blockNumber;
  if (
    ![1, '1', '0x1'].includes(value.status as string | number) ||
    !hash(value.transactionHash) ||
    !hash(value.blockHash) ||
    (typeof block !== 'string' && typeof block !== 'number') ||
    !/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(String(block)) ||
    BigInt(block) <= 0n
  ) {
    throw new Error(`Deployment has no successful execution receipt: ${path}`);
  }
}

function sync() {
  const { values } = parseArgs({
    options: {
      workspace: { type: 'string' },
      check: { type: 'boolean', default: false },
    },
  });
  const workspace = resolve(
    values.workspace ?? fileURLToPath(new URL('../../../../', import.meta.url)),
  );
  const repository = resolve(workspace, 'deploy-all-v6');
  const names = [
    'JBBuybackHook',
    'JBRouterTerminal',
    'JBRouterTerminalGateway',
    'JBRatioPriceFeed',
  ];
  const contracts: Record<string, { abi: unknown[]; deployments: unknown[] }> = {};
  const sources: { path: string; sha256: string; dirty: boolean }[] = [];
  const commit = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  for (const chain of readdirSync(resolve(repository, 'deployments')).sort()) {
    for (const name of names) {
      for (const [suffix, generation] of [
        ['', 'current'],
        ['_deprecated2', 'previous'],
        ['_deprecated1', 'v2'],
        ['_deprecated', 'v1'],
      ] as const) {
        const path = `deployments/${chain}/${name}${suffix}.json`;
        if (!existsSync(resolve(repository, path))) continue;
        const bytes = readFileSync(assertSourcePath(repository, path));
        const artifact = JSON.parse(bytes.toString());
        if (!artifact.address || !artifact.chainId || !Array.isArray(artifact.abi))
          throw new Error(`Invalid deployment: ${path}`);
        assertExecutedReceipt(artifact.receipt, path);
        const dirty = sourceDiffersFromCommit(repository, path, commit, bytes);
        sources.push({ path, sha256: createHash('sha256').update(bytes).digest('hex'), dirty });
        const entry = (contracts[name] ??= { abi: artifact.abi, deployments: [] });
        entry.deployments.push({
          chainId: Number(artifact.chainId),
          address: artifact.address,
          generation,
          retired: generation !== 'current',
          source: path,
        });
        // A deployed gateway and ratio feed establish their ABI without advertising an address on other chains.
        if (generation === 'current') entry.abi = artifact.abi;
      }
    }
  }
  for (const name of names)
    if (!contracts[name]) throw new Error(`Missing deployed ${name} source`);
  const serialized = `${JSON.stringify({ source: 'deploy-all-v6/deployments', commit, sources, contracts })}\n`;
  const output = fileURLToPath(new URL('../data/rollout.json', import.meta.url));
  if (values.check) {
    if (readFileSync(output, 'utf8') !== serialized)
      throw new Error('Rollout deployment bundle is stale; run rollout:sync.');
  } else writeBundleAtomically(output, serialized);
  process.stdout.write(
    `Rollout bundle ${values.check ? 'verified' : 'updated'} from ${sources.length} deployment records.\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) sync();
