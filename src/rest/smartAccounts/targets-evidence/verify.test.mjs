import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256 } from 'viem';
import { verifyRuntime } from '../../protocol/code.ts';
import { findCachedSolc } from '../stack/passkey/solc-cache.mjs';
import { spawnAnvil } from '../../../../test/support/anvil.ts';

const here = dirname(fileURLToPath(import.meta.url));
const bytes = file => readFileSync(resolve(here, file));
const json = file => JSON.parse(bytes(file));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);
const spans = references => Object.values(references ?? {}).flatMap(value => Array.isArray(value) ? value : spans(value))
  .map(({ start, length }) => ({ start, length })).sort((a, b) => a.start - b.start || a.length - b.length);
const identity = metadata => {
  const settings = { ...metadata.settings, remappings: (metadata.settings.remappings ?? []).map(item => item.replace(/^:/, '')).sort() };
  return sha256(stable({ compiler: metadata.compiler, settings, sources: Object.fromEntries(Object.entries(metadata.sources).map(([path, value]) => [path, value.keccak256])) }));
};
const manifest = json('manifest.json');
const input = json('compiler-input.json');
const output = json('compiler-output.json');
const closure = json('source-closure.json');
const publications = json('publications.json');
const initialization = json('library-initialization.json');
const observations = json('observations.json');
const catalog = json('../../contracts/data/catalog.json');
const artifact = name => output.contracts[`node_modules/@bananapus/core-v6/src/${name.startsWith('JBH') || name.startsWith('JBPayout') ? 'libraries/' : ''}${name}.sol`][name];
let anvil, evmUrl, rpcId = 0;
async function rpc(method, params) {
  const response = await fetch(evmUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }), signal: AbortSignal.timeout(5000) });
  assert(response.ok); const value = await response.json(); assert(!value.error, JSON.stringify(value.error)); return value.result;
}
before(async () => {
  const solc = process.env.CENTER_TARGET_SOLC ?? (process.env.SVM_HOME !== undefined
    ? resolve(process.env.SVM_HOME, '0.8.28/solc-0.8.28') : await findCachedSolc('0.8.28'));
  assert.notEqual(solc, undefined, 'Install the pinned solc 0.8.28 compiler or set CENTER_TARGET_SOLC');
  const allowed = new Set([
    '81515b0e53deaa266d549545ccaac0a5a96e6d4e8201c77f673b2c710976d9ea',
    '9a0fb7e0db2c0641dbae1c5cc645dc686820c83af516226abb1c0a2f76636f25',
  ]);
  assert(allowed.has(sha256(readFileSync(solc))), 'Use the official pinned solc 0.8.28 binary');
  const result = spawnSync(solc, ['--standard-json'], { input: bytes('compiler-input.json'), encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  const recompiled = JSON.parse(result.stdout);
  assert.equal((recompiled.errors ?? []).filter(error => error.severity === 'error').length, 0);
  assert.equal(stable(recompiled.contracts), stable(output.contracts), 'Fresh compiler outputs differ from persisted evidence');
  assert.equal(stable(recompiled.sources), stable(output.sources));
  const server = createServer();
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port;
  await new Promise(done => server.close(done));
  evmUrl = `http://127.0.0.1:${port}`;
  anvil = spawnAnvil(['--port', String(port), '--host', '127.0.0.1', '--silent']);
  let failure;
  anvil.once('error', error => { failure = error; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (failure) throw failure;
    try { assert.equal(Number(BigInt(await rpc('eth_chainId', []))), 31337); return; }
    catch { await new Promise(done => setTimeout(done, 50)); }
  }
  throw new Error('Isolated Anvil did not become ready');
}, { timeout: 90_000 });
after(async () => {
  if (!anvil || anvil.exitCode !== null) return;
  const closed = new Promise(done => anvil.once('close', done));
  anvil.kill('SIGTERM'); await closed;
});

test('all evidence files and complete compiler source bytes match their pinned hashes', () => {
  assert.equal(manifest.protocolVersion, 6);
  for (const [path, digest] of Object.entries(manifest.files)) assert.equal(sha256(bytes(path)), digest, path);
  assert.equal(Object.keys(input.sources).length, 82);
  for (const [path, source] of Object.entries(input.sources)) {
    const record = closure.sources[path]; assert(record);
    assert.equal(keccak256(Buffer.from(source.content)), record.keccak256);
    assert.equal(sha256(source.content), record.sha256);
    assert.equal(Buffer.byteLength(source.content), record.byteLength);
  }
  for (const contracts of Object.values(output.contracts)) for (const compiled of Object.values(contracts)) {
    const metadata = JSON.parse(compiled.metadata);
    for (const [path, record] of Object.entries(metadata.sources)) assert.equal(keccak256(Buffer.from(input.sources[path].content)), record.keccak256);
  }
});

test('target records match exact catalog publications and compiler-declared spans', () => {
  assert.equal(manifest.records.length, 2); assert.equal(publications.deployments.length, 32);
  for (const record of manifest.records) {
    const original = catalog.codes.find(code => code.id === record.catalogCodeId); assert(original);
    for (const key of ['id', 'runtimeTemplate', 'runtimeTemplateSha256', 'runtimeTemplateKeccak256', 'runtimeTemplateByteLength', 'creationSha256']) assert.equal(record.code[key], original[key]);
    const compiled = output.contracts[record.source.compilerPath][record.source.contractName];
    assert.deepEqual(record.code.immutableReferences, spans(compiled.evm.deployedBytecode.immutableReferences));
    assert.deepEqual(record.code.linkReferences, spans(compiled.evm.deployedBytecode.linkReferences));
    assert.equal(record.code.compilerEvidence.sourceInputIdentitySha256, identity(JSON.parse(compiled.metadata)));
    assert.equal(record.code.compilerEvidence.artifactSha256, sha256(bytes('compiler-output.json')));
    const relevant = publications.deployments.filter(item => item.contractId === record.contractId);
    assert.equal(relevant.length, 8);
    for (const publication of relevant) {
      assert.equal(publication.deployment.codeId, record.catalogCodeId);
      assert.equal(publication.deployment.compilerInputIdentitySha256, record.code.compilerEvidence.sourceInputIdentitySha256);
      assert(record.code.compilerEvidence.deploymentPaths.includes(publication.deployment.artifactPath));
      const canonical = catalog.contracts.find(item => item.id === record.contractId).deployments.find(item => item.chainId === publication.chainId).instances[0];
      // Older pinned evidence predates retirement labels; keep every publication field and retirement state bound.
      assert.equal(canonical.retired, false, 'Active target evidence must not match a retired catalog deployment');
      assert.deepEqual({ retired: false, ...publication.deployment }, canonical);
    }
    assert.deepEqual(record.linkage.flatMap(link => link.runtimeReferences).map(({ start, length }) => ({ start, length })).sort((a, b) => a.start - b.start), record.code.linkReferences);
    for (const link of record.linkage) for (const span of link.runtimeReferences) {
      assert.equal(span.length, 20);
      assert.equal(`0x${record.code.runtimeTemplate.slice(2 + span.start * 2, 2 + (span.start + span.length) * 2)}`, link.address.toLowerCase());
    }
  }
});

test('both library runtimes are freshly produced by exact compiler creation code at published addresses', async () => {
  assert.equal(initialization.initialization.length, 2);
  for (const item of initialization.initialization) {
    const compiled = artifact(item.contractName);
    const creation = `0x${compiled.evm.bytecode.object}`;
    assert.equal(sha256(creation), item.compilerCreationSha256);
    const overrides = { [item.address]: { code: creation } };
    const runtime = await rpc('eth_call', [item.request, 'latest', overrides]);
    assert.equal(runtime.toLowerCase(), item.runtime);
    const trace = await rpc('debug_traceCall', [item.request, 'latest', { stateOverrides: overrides }]);
    assert.equal(trace.failed, false);
    assert.deepEqual(trace.structLogs.map(({ pc, op, depth }) => ({ pc, op, depth })), item.constructorTrace);
    assert.equal(keccak256(runtime), item.runtimeKeccak256);
    const link = manifest.records.flatMap(record => record.linkage).find(link => link.libraryName === item.contractName);
    assert.deepEqual(link.code.immutableReferences, []); assert.deepEqual(link.code.linkReferences, []);
    assert.equal(link.code.runtimeTemplate, runtime.toLowerCase());
    assert.equal(link.provenance.initializationSha256, sha256(bytes('library-initialization.json')));
    assert.equal(identity(JSON.parse(compiled.metadata)), link.provenance.sourceInputIdentitySha256);
  }
});

test('all 32 observed runtimes match sources at the same eight revalidated canonical blocks', () => {
  assert.equal(observations.completedObservations, 32); assert.equal(observations.chains.length, 8);
  for (const chain of observations.chains) {
    assert.equal(chain.status, 'observed'); assert.equal(chain.canonicalHashRevalidated, true);
    assert.equal(chain.observations.length, 4);
    for (const observed of chain.observations) {
      assert.equal(observed.blockHash, chain.blockHash); assert.equal(observed.readMode, 'EIP-1898-requireCanonical');
      const runtime = observations.runtimes[observed.runtimeKeccak256].runtimeHex;
      assert.equal(keccak256(runtime), observed.runtimeKeccak256);
      const target = manifest.records.find(record => record.contractId === observed.contractId);
      if (target) {
        for (const link of target.linkage) {
          const lib = chain.observations.find(item => item.contractName === link.libraryName);
          assert.equal(lib.address.toLowerCase(), link.address.toLowerCase());
          assert.equal(observations.runtimes[lib.runtimeKeccak256].runtimeHex, link.code.runtimeTemplate);
          assert.equal(verifyRuntime(link.code.runtimeTemplate, link.code).mode, 'exact-runtime-template');
        }
        assert.equal(verifyRuntime(runtime, { ...target.code, linkReferences: [] }).mode, 'compiler-template-with-observed-immutables');
      } else {
        const link = manifest.records.flatMap(record => record.linkage).find(link => link.libraryName === observed.contractName); assert(link);
        assert.equal(runtime, link.code.runtimeTemplate);
      }
    }
  }
});

test('unresolved links and changes outside compiler immutable spans fail closed', () => {
  for (const record of manifest.records) {
    const observed = observations.chains[0].observations.find(item => item.contractId === record.contractId);
    const runtime = observations.runtimes[observed.runtimeKeccak256].runtimeHex;
    if (record.linkage.length) assert.throws(() => verifyRuntime(runtime, record.code), { code: 'LINKED_RUNTIME_UNSUPPORTED' });
    const data = Buffer.from(runtime.slice(2), 'hex'); data[0] ^= 1;
    assert.throws(() => verifyRuntime(`0x${data.toString('hex')}`, { ...record.code, linkReferences: [] }), { code: 'RUNTIME_CODE_MISMATCH' });
    for (const link of record.linkage) {
      const changed = Buffer.from(runtime.slice(2), 'hex'); changed[link.runtimeReferences[0].start] ^= 1;
      assert.throws(() => verifyRuntime(`0x${changed.toString('hex')}`, { ...record.code, linkReferences: [] }), { code: 'RUNTIME_CODE_MISMATCH' });
      const lib = Buffer.from(link.code.runtimeTemplate.slice(2), 'hex'); lib[1] ^= 1;
      assert.throws(() => verifyRuntime(`0x${lib.toString('hex')}`, link.code), { code: 'RUNTIME_CODE_MISMATCH' });
    }
  }
});
