import { spawnSync } from 'node:child_process';
import { targets } from './platform.mjs';
for (const target of targets) {
  for (const script of ['scripts/package.mjs', 'scripts/verify-package.mjs']) {
    const result = spawnSync(process.execPath, [script, '--target', target], {
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

// Leave local helpers runnable after cross-packaging the other architectures.
const restore = spawnSync(process.execPath, ['scripts/build-native.mjs'], {
  stdio: 'inherit',
});
if (restore.error) throw restore.error;
if (restore.status !== 0) process.exit(restore.status ?? 1);
