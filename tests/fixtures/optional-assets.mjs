import {existsSync} from 'node:fs';

// Artwork is deliberately absent from the public source repository. Tests that
// verify those exact bytes run only when an owner supplies the assets locally.
export function missingAssetReason(paths) {
  if (process.env.ASUN_TEST_CODE_ONLY === '1') return 'Code-only verification: private artwork is excluded.';
  const missing = paths.filter(path => !existsSync(new URL('../../' + path, import.meta.url)));
  return missing.length ? 'Private artwork is excluded from the public repository: ' + missing.join(', ') : false;
}
