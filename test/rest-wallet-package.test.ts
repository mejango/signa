import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as wallet from '../src/rest/client/wallet-package.js';

/** The npm package carries only what an app needs to connect an account and review a payment. */
describe('published wallet package', () => {
  it('exports exactly the connection and payment surface', () => {
    expect(Object.keys(wallet).sort()).toEqual([
      'RestClientError', 'assertReviewedOperation', 'createCenterWalletClient',
      'ownerOperationSignature', 'ownerOperationSigning', 'sponsoredCallsCommitment', 'userOperationMaximumCost',
    ]);
  });
  it('is a browser package with viem as its only dependency, optional React and wagmi peers, and no executable', () => {
    const manifest = JSON.parse(readFileSync(new URL('../wallet-client/package.json', import.meta.url), 'utf8'));
    expect(manifest.name).toBe('@me.jango/signa');
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys(manifest.dependencies)).toEqual(['viem']);
    expect(manifest.bin).toBeUndefined();
    expect(manifest.files).toEqual(['index.js', 'index.d.ts', 'core/', 'wagmi/', 'react/', 'README.md']);
    expect(manifest.publishConfig).toEqual({ access: 'public' });
    // The connect subpaths bring React and wagmi only to apps that import them.
    expect(Object.keys(manifest.exports)).toEqual(['.', './core', './wagmi', './react']);
    expect(Object.keys(manifest.peerDependencies)).toEqual(['react', 'wagmi']);
    expect(manifest.peerDependenciesMeta).toEqual({ react: { optional: true }, wagmi: { optional: true } });
  });
});
