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
  it("the root entry installs with the consumer's viem only", () => {
    const manifest = JSON.parse(readFileSync(new URL('../wallet-client/package.json', import.meta.url), 'utf8'));
    expect(manifest.name).toBe('@me.jango/signa');
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    // No dependency of its own: the app's viem (2.55.19 in Homerun, Sticky, jbm and revnet) is the one copy.
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.bin).toBeUndefined();
    expect(manifest.files).toEqual(['index.js', 'index.d.ts', 'core/', 'wagmi/', 'react/', 'README.md']);
    expect(manifest.publishConfig).toEqual({ access: 'public' });
    // The connect subpaths bring React and wagmi only to apps that import them.
    expect(Object.keys(manifest.exports)).toEqual(['.', './core', './wagmi', './react']);
    expect(manifest.peerDependencies).toEqual({ viem: '^2.37.5', react: '^18.3.1 || ^19.0.0', wagmi: '^2.10.2 || ^3.0.0' });
    expect(manifest.peerDependenciesMeta).toEqual({ react: { optional: true }, wagmi: { optional: true } });
  });
});
