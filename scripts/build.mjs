#!/usr/bin/env node
// Bundles the server and the notify hook, injecting the version from package.json.
//
// The version used to be a literal in src/index.ts. That made package.json and the
// running server two sources of truth for the same fact, and they drifted: the
// manifests moved 0.2.0 -> 0.3.0 -> 0.3.1 while the server kept reporting 0.2.0 to
// every client, which is precisely why the drift went unnoticed for months.
//
// `define` substitutes the identifier at build time, so package.json is the only
// place a version is written.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  define: { __PKG_VERSION__: JSON.stringify(pkg.version) },
  absWorkingDir: root,
};

await Promise.all([
  build({ ...common, entryPoints: ['src/index.ts'], outfile: 'bundle/index.mjs' }),
  build({ ...common, entryPoints: ['src/notify-hook.ts'], outfile: 'bundle/notify-hook.mjs' }),
]);

console.log(`bundled time-mcp ${pkg.version}`);
