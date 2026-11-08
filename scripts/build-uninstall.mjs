import { build } from 'esbuild';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
await build({
  entryPoints: [path.join(root, 'src', 'uninstall.ts')],
  outfile: path.join(root, 'dist', 'uninstall.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node16',
  sourcemap: false,
  legalComments: 'inline',
});
