import { build } from 'esbuild';
import { rollup } from 'rollup';
import { dts } from 'rollup-plugin-dts';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
const destination = join(root, '.generated/rest/client');
await mkdir(destination, { recursive: true });
await build({ absWorkingDir: root, entryPoints: ['src/rest/client/index.ts'], outfile: join(destination, 'index.js'),
  bundle: true, platform: 'browser', format: 'esm', target: 'es2022', external: ['viem', 'viem/*'] });
const types = await rollup({ input: join(root, 'dist/src/rest/client/index.d.ts'), plugins: [dts()],
  external: id => !id.startsWith('.') && !id.startsWith('/') });
await types.write({ file: join(destination, 'index.d.ts'), format: 'es' });
await types.close();
for (const name of ['package.json', 'README.md']) await copyFile(join(root, 'client', name), join(destination, name));
const cli = (await readFile(join(root, 'scripts/rest/center.mjs'), 'utf8'))
  .replace('../../dist/src/rest/client/index.js', './index.js')
  .replace('Run npm run build in extensions/jbcenter before proof/sign/send.', 'Install the Center client package before running these commands.');
await writeFile(join(destination, 'cli.mjs'), cli, { mode: 0o755 });
await writeFile(join(destination, 'node.js'), `import { CenterClient } from './index.js';\nimport { readProtectedDocument } from './cli.mjs';\nexport async function connect(filename, options) { return CenterClient.fromConnection(await readProtectedDocument(filename), options); }\n`);
await writeFile(join(destination, 'node.d.ts'), `import { CenterClient, ClientOptions } from './index.js';\nexport declare function connect(filename: string, options?: Pick<ClientOptions, 'fetch' | 'timeoutMs' | 'now'>): Promise<CenterClient>;\n`);
const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--cache', join(root, '.generated/npm-cache'), '--json', '--pack-destination', join(root, '.generated/rest')], { cwd: destination, encoding: 'utf8' }));
console.log('Client package:', packed[0].filename);
// The npm package `@me.jango/signa` is the browser-only connection and payment slice. Both
// packages keep viem as their only dependency: the SDK's payment-failure decoder is bundled in.
const walletDestination = join(root, '.generated/rest/wallet-client');
await mkdir(walletDestination, { recursive: true });
await build({ absWorkingDir: root, entryPoints: ['src/rest/client/wallet-package.ts'], outfile: join(walletDestination, 'index.js'),
  bundle: true, platform: 'browser', format: 'esm', target: 'es2022', external: ['viem', 'viem/*'] });
const walletTypes = await rollup({ input: join(root, 'dist/src/rest/client/wallet-package.d.ts'), plugins: [dts()],
  external: id => !id.startsWith('.') && !id.startsWith('/') });
await walletTypes.write({ file: join(walletDestination, 'index.d.ts'), format: 'es' });
await walletTypes.close();
for (const name of ['package.json', 'README.md']) await copyFile(join(root, 'wallet-client', name), join(walletDestination, name));
console.log('Wallet package:', walletDestination);
