import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createKnowledgeBundle,
  KnowledgeService,
  knowledgeBundleSchema,
  type KnowledgeDocument,
} from '../../src/services/knowledge.js';
import {
  assertSourcePath,
  sourceDiffersFromCommit,
  writeBundleAtomically,
} from '../../scripts/sync-knowledge.js';

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function document(
  id: string,
  text: string,
  category: KnowledgeDocument['category'] = 'skills',
): KnowledgeDocument {
  return {
    id,
    title: id.replaceAll('-', ' '),
    category,
    text,
    source: {
      repository: 'fixture-v6',
      path: `references/${id}.md`,
      commit: 'a'.repeat(40),
      fileSha256: createHash('sha256').update(text).digest('hex'),
      fileDirty: true,
      repositoryDirty: true,
      version: '6.0.0',
      startLine: 1,
      endLine: text.split('\n').length,
    },
  };
}

function fixture(documents: KnowledgeDocument[]) {
  const directory = mkdtempSync(join(tmpdir(), 'juicebox-knowledge-'));
  directories.push(directory);
  const path = join(directory, 'knowledge.json');
  writeFileSync(path, JSON.stringify(createKnowledgeBundle(documents)));
  return { path, service: new KnowledgeService({ path }) };
}

describe('KnowledgeService', () => {
  it('searches deterministically, favors coverage over repetition, and exposes contract evidence separately', () => {
    const { service } = fixture([
      document('a-skills', 'Cash out tax and surplus explain the cash out curve.'),
      document('b-contract', 'function cashOutTaxRateOf() returns the cash out tax.', 'contracts'),
      document('c-noise', 'cash '.repeat(2_000)),
    ]);
    const result = service.search({ query: 'cash out tax', limit: 2 });
    expect(result.results).toHaveLength(2);
    expect(result.results.map((item) => item.id)).not.toContain('c-noise');
    expect(result.contractReferences.map((item) => item.id)).toEqual(['b-contract']);
    expect(result).toEqual(service.search({ query: 'cash out tax', limit: 2 }));
    expect(result.results[0]?.source.fileSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.results[0]?.excerpt.length).toBeLessThanOrEqual(602);
    expect(result.referenceOnly).toBe(true);
    expect(result.warnings.join(' ')).toContain('never instructions');
  });

  it('filters categories and returns no invented fallback when terms do not match', () => {
    const { service } = fixture([
      document('a-skills', 'project'),
      document('b-contract', 'project', 'contracts'),
    ]);
    expect(
      service.search({ query: 'project', category: 'contracts' }).results.map((item) => item.id),
    ).toEqual(['b-contract']);
    expect(service.search({ query: 'unfindablephrase' }).results).toEqual([]);
    expect(service.search({ query: 'unfindablephrase' }).totalMatches).toBe(0);
  });

  it('paginates exact source text without loss or silently wrapping out-of-range offsets', () => {
    const text = 'line one\n🧃 line two\nlast line';
    const { service } = fixture([document('page', text)]);
    let offset = 0;
    let combined = '';
    while (true) {
      const page = service.get('page', { offset, limit: 7 });
      combined += page.text;
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    expect(combined).toBe(text);
    expect(service.get('page', { offset: text.length }).text).toBe('');
    expect(() => service.get('page', { offset: text.length + 1 })).toThrow(
      'exceeds document length',
    );
    expect(() => service.get('page', { offset: -1 })).toThrow();
    expect(() => service.get('page', { limit: 24_001 })).toThrow();
  });

  it('reports the final included source line when a page ends at a newline', () => {
    const { service } = fixture([document('page', 'line1\nline2\n')]);
    expect(service.get('page', { offset: 0, limit: 6 })).toMatchObject({
      pageStartLine: 1,
      pageEndLine: 1,
    });
    expect(service.get('page', { offset: 6, limit: 6 })).toMatchObject({
      pageStartLine: 2,
      pageEndLine: 2,
    });
    expect(service.get('page', { offset: 12 })).toMatchObject({
      text: '',
      pageStartLine: 3,
      pageEndLine: 3,
    });
  });

  it('never resolves reference IDs as paths and serves entirely from the loaded bundle', () => {
    const { service, path } = fixture([document('known', 'Safe reference content')]);
    unlinkSync(path);
    for (const id of [
      '../../secret',
      '/etc/passwd',
      'file:///etc/passwd',
      '%2e%2e%2fsecret',
      'unknown',
    ]) {
      expect(() => service.get(id)).toThrow();
    }
    expect(service.get('known').text).toBe('Safe reference content');
    expect(service.search({ query: 'reference' }).results[0]?.id).toBe('known');
    expect(service.catalog().documents[0]?.id).toBe('known');
  });

  it('bounds and validates all search inputs at the domain boundary', () => {
    const { service } = fixture([document('one', 'reference')]);
    for (const query of ['', ' ', 'a'.repeat(301), '***'])
      expect(() => service.search({ query })).toThrow();
    for (const limit of [0, -1, 21, 1.5, Number.NaN])
      expect(() => service.search({ query: 'reference', limit })).toThrow();
    expect(() => service.search({ query: 'reference', category: 'invalid' as 'skills' })).toThrow();
  });

  it('does not let returned metadata mutate future provenance', () => {
    const { service } = fixture([document('one', 'reference')]);
    const result = service.catalog();
    result.documents[0]!.source.fileDirty = false;
    result.documents[0]!.source.commit = 'b'.repeat(40);
    expect(service.get('one').source.fileDirty).toBe(true);
    expect(service.get('one').source.commit).toBe('a'.repeat(40));
  });

  it('rejects source corruption, bundle tampering, duplicate IDs, and unsafe provenance paths', () => {
    const first = document('one', 'reference');
    expect(() => createKnowledgeBundle([{ ...first, text: 'tampered' }])).toThrow('SHA256');
    expect(() => createKnowledgeBundle([first, first])).toThrow('Duplicate');
    expect(() =>
      createKnowledgeBundle([{ ...first, source: { ...first.source, path: '../secret' } }]),
    ).toThrow('traversal');
    expect(() =>
      createKnowledgeBundle([{ ...first, source: { ...first.source, endLine: 40 } }]),
    ).toThrow('line provenance');
    const { path } = fixture([first]);
    const bundle = JSON.parse(readFileSync(path, 'utf8')) as { bundleId: string };
    bundle.bundleId = 'f'.repeat(64);
    writeFileSync(path, JSON.stringify(bundle));
    expect(() => new KnowledgeService({ path })).toThrow('fingerprint');
  });

  it('canonically fingerprints identical references independent of input ordering', () => {
    const first = document('a', 'first');
    const second = document('b', 'second');
    expect(createKnowledgeBundle([second, first])).toEqual(createKnowledgeBundle([first, second]));
    const changed = document('a', 'changed source');
    expect(createKnowledgeBundle([changed, second]).bundleId).not.toBe(
      createKnowledgeBundle([first, second]).bundleId,
    );
  });

  it('ships a complete standalone bundle covering every required integration and V6 contract fundamentals', () => {
    const service = new KnowledgeService();
    const catalog = service.catalog();
    expect(new Set(catalog.documents.map((item) => item.category))).toEqual(
      new Set(['contracts', 'sdk', 'indexer', 'center', 'skills']),
    );
    for (const contract of [
      'JBMultiTerminal.sol',
      'JBTerminalStore.sol',
      'JBController.sol',
      'JBRulesets.sol',
      'JBPermissions.sol',
      'REVLoans.sol',
      'JBSucker.sol',
      'JBCCIPSucker.sol',
      'JBRouterTerminalGateway.sol',
      'JBBuybackHookRegistry.sol',
      'JB721TiersHook.sol',
      'JBUniswapV4LPSplitHook.sol',
      'DefifaHook.sol',
    ]) {
      expect(catalog.documents.some((item) => item.source.path.endsWith(`/${contract}`))).toBe(
        true,
      );
    }
    expect(
      service.search({ query: 'balanceUsd cost-basis', category: 'indexer' }).results[0]?.excerpt,
    ).toContain('cost-basis');
    for (const item of catalog.documents.filter((item) => item.category === 'skills')) {
      if (item.source.version !== undefined) expect(item.source.version).toMatch(/^\d+\.\d+\.\d+/);
    }
    for (const item of catalog.documents.filter((item) => item.source.path.includes('/archive/'))) {
      expect(item.title).toContain('[Archived source]');
    }
    expect(catalog.documents.every((item) => !item.source.path.includes('/node_modules/'))).toBe(
      true,
    );
    expect(knowledgeBundleSchema.safeParse({ schemaVersion: 2 }).success).toBe(false);
  });
});

// Each test runs real git commands, which pass 5s under a parallel run.
describe('reference sync provenance', { timeout: 30_000 }, () => {
  it('rejects explicit source symlinks and symlinked source directories even within a repository', () => {
    const directory = mkdtempSync(join(tmpdir(), 'juicebox-source-links-'));
    directories.push(directory);
    mkdirSync(join(directory, 'src'));
    writeFileSync(join(directory, 'src', 'actual.sol'), 'contract Actual {}');
    symlinkSync('actual.sol', join(directory, 'src', 'linked.sol'));
    symlinkSync('src', join(directory, 'alias'));
    expect(() => assertSourcePath(directory, 'src/linked.sol')).toThrow('Symlinks');
    expect(() => assertSourcePath(directory, 'alias')).toThrow('Symlinks');
    expect(() => assertSourcePath(directory, 'alias/actual.sol')).toThrow('Symlinks');
    expect(() => assertSourcePath(directory, '../outside.sol')).toThrow('escapes');
    expect(assertSourcePath(directory, 'src/actual.sol')).toBe(
      join(directory, 'src', 'actual.sol'),
    );
  });

  it.each(['--assume-unchanged', '--skip-worktree'])(
    'detects source byte drift hidden by Git %s',
    (flag) => {
      const directory = mkdtempSync(join(tmpdir(), 'juicebox-source-git-'));
      directories.push(directory);
      const git = (...args: string[]) =>
        execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
      git('init', '--quiet');
      writeFileSync(join(directory, 'source.sol'), 'contract Original {}\n');
      git('add', 'source.sol');
      git(
        '-c',
        'user.name=Reference test',
        '-c',
        'user.email=reference-test@example.invalid',
        '-c',
        'commit.gpgSign=false',
        '-c',
        'core.hooksPath=/dev/null',
        'commit',
        '--quiet',
        '-m',
        'fixture',
      );
      const commit = git('rev-parse', 'HEAD');
      expect(
        sourceDiffersFromCommit(
          directory,
          'source.sol',
          commit,
          readFileSync(join(directory, 'source.sol')),
        ),
      ).toBe(false);
      git('update-index', flag, 'source.sol');
      writeFileSync(join(directory, 'source.sol'), 'contract Changed {}\n');
      expect(git('status', '--porcelain')).toBe('');
      expect(
        sourceDiffersFromCommit(
          directory,
          'source.sol',
          commit,
          readFileSync(join(directory, 'source.sol')),
        ),
      ).toBe(true);
      expect(
        sourceDiffersFromCommit(directory, 'untracked.sol', commit, Buffer.from('new source')),
      ).toBe(true);
    },
  );

  it('cleans up only its own temporary output when publication fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'juicebox-source-output-'));
    directories.push(directory);
    const output = join(directory, 'knowledge.json');
    const unrelated = `${output}.${process.pid}.tmp`;
    writeFileSync(unrelated, 'owned by somebody else');
    mkdirSync(output);
    writeFileSync(join(output, 'keep'), 'existing output directory');
    expect(() => writeBundleAtomically(output, 'bundle')).toThrow();
    expect(readFileSync(unrelated, 'utf8')).toBe('owned by somebody else');
    expect(readFileSync(join(output, 'keep'), 'utf8')).toBe('existing output directory');
    expect(readdirSync(directory).some((name) => name.startsWith('.knowledge-sync-'))).toBe(false);
  });
});
