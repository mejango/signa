import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertDevelopmentSnapshot,
  readDevelopmentRepository,
  writeDevelopmentBundle,
} from '../../scripts/sync-development.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'juicebox-development-sync-')));
  directories.push(workspace);
  const repo = join(workspace, 'juicescan');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ version: '1.0.0', license: 'MIT' }));
  writeFileSync(join(repo, 'src', 'source.ts'), 'export const value = 1;\n');
  writeFileSync(join(repo, 'src', 'unchanged.ts'), 'export const unchanged = true;\n');
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('add', '.');
  const commit = () =>
    git(
      '-c',
      'user.name=Development reference test',
      '-c',
      'user.email=development-reference@example.invalid',
      '-c',
      'commit.gpgSign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    );
  commit();
  const definition = {
    directory: 'juicescan',
    upstream: 'https://github.com/example/juicescan',
    framework: 'vanilla' as const,
    files: [
      ['fixture.source', 'src/source.ts'],
      ['fixture.unchanged', 'src/unchanged.ts'],
    ] as const,
  };
  return {
    workspace,
    repo,
    git,
    commit,
    read: () => readDevelopmentRepository(workspace, 'juicescan', definition),
  };
}

// Each test runs real git commands, which pass 5s under a parallel run.
describe('development source synchronization', { timeout: 30_000 }, () => {
  it.each(['--assume-unchanged', '--skip-worktree'])(
    'records exact source and repository drift hidden by Git %s',
    (flag) => {
      const source = fixture();
      const original = source.read();
      expect(
        original.references.every(
          (reference) => !reference.source.fileDirty && !reference.source.repositoryDirty,
        ),
      ).toBe(true);
      source.git('update-index', flag, 'src/source.ts');
      const changed = 'export const value = 42;\n';
      writeFileSync(join(source.repo, 'src', 'source.ts'), changed);
      expect(source.git('status', '--porcelain')).toBe('');
      const snapshot = source.read();
      const reference = snapshot.references.find((item) => item.id === 'fixture.source')!;
      expect(reference.text).toBe(changed);
      expect(reference.source.fileSha256).toBe(createHash('sha256').update(changed).digest('hex'));
      expect(reference.source.fileDirty).toBe(true);
      expect(reference.source.commit).toBe(original.commit);
      expect(snapshot.references.every((item) => item.source.repositoryDirty)).toBe(true);
      expect(
        snapshot.references.find((item) => item.id === 'fixture.unchanged')?.source.fileDirty,
      ).toBe(false);
      expect(() => assertDevelopmentSnapshot(snapshot)).not.toThrow();
      expect(() => assertDevelopmentSnapshot(original)).toThrow('Source bytes changed');
    },
  );

  it('includes hidden package metadata drift and rechecks package bytes even when its manifest is not a reference', () => {
    const source = fixture();
    const original = source.read();
    source.git('update-index', '--assume-unchanged', 'package.json');
    writeFileSync(
      join(source.repo, 'package.json'),
      JSON.stringify({ version: '2.0.0', license: 'MIT' }),
    );
    expect(source.git('status', '--porcelain')).toBe('');
    expect(() => assertDevelopmentSnapshot(original)).toThrow('Source bytes changed');
    const updated = source.read();
    expect(
      updated.references.every((reference) => reference.source.packageVersion === '2.0.0'),
    ).toBe(true);
    expect(
      updated.references.every(
        (reference) => !reference.source.fileDirty && reference.source.repositoryDirty,
      ),
    ).toBe(true);
  });

  it('rejects source symlinks within the same repository and invalid UTF-8 instead of normalizing source bytes', () => {
    const source = fixture();
    rmSync(join(source.repo, 'src', 'source.ts'));
    symlinkSync('unchanged.ts', join(source.repo, 'src', 'source.ts'));
    expect(() => source.read()).toThrow('Symlinks');
    rmSync(join(source.repo, 'src', 'source.ts'));
    writeFileSync(join(source.repo, 'src', 'source.ts'), Buffer.from([0xff, 0xfe]));
    expect(() => source.read()).toThrow();
  });

  it('rejects commits made after sampling before output publication', () => {
    const source = fixture();
    const snapshot = source.read();
    writeFileSync(join(source.repo, 'src', 'source.ts'), 'export const value = 2;\n');
    source.git('add', '.');
    source.commit();
    expect(() => assertDevelopmentSnapshot(snapshot)).toThrow('Source commit changed');
  });

  it('checks reproducibility without writes and preserves existing output on a failed atomic replacement', () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'juicebox-development-output-')));
    directories.push(directory);
    const output = join(directory, 'development.json');
    writeDevelopmentBundle(output, 'reference bundle\n');
    const before = statSync(output).mtimeMs;
    expect(() => writeDevelopmentBundle(output, 'reference bundle\n', true)).not.toThrow();
    expect(statSync(output).mtimeMs).toBe(before);
    expect(() => writeDevelopmentBundle(output, 'different bundle\n', true)).toThrow('differs');
    expect(readFileSync(output, 'utf8')).toBe('reference bundle\n');
    const blocked = join(directory, 'blocked');
    mkdirSync(blocked);
    writeFileSync(join(blocked, 'keep'), 'retained');
    expect(() => writeDevelopmentBundle(blocked, 'new bundle\n')).toThrow();
    expect(readFileSync(join(blocked, 'keep'), 'utf8')).toBe('retained');
    expect(readdirSync(directory).some((name) => name.startsWith('.knowledge-sync-'))).toBe(false);
    expect(() => writeDevelopmentBundle(join(directory, 'missing'), 'bundle', true)).toThrow(
      'differs',
    );
  });
});
