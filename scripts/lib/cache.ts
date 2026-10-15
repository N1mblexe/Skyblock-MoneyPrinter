// Local cache directory for build scripts (.cache by default, BAZAAR_CACHE_DIR overrides; e.g. a read-only shared cache).
import { join } from 'node:path';

/** Cache directory: $BAZAAR_CACHE_DIR when set (non-empty), else `.cache` (relative to cwd). */
export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const d = env.BAZAAR_CACHE_DIR?.trim();
  return d ? d : '.cache';
}

/** Path of a file inside the cache directory. */
export function cachePath(file: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(cacheDir(env), file);
}

/** Known cache file names (shared by build-data, sanity and capture-fixture). */
export const CACHE_FILES = {
  bazaar: 'bazaar.json',
  items: 'items.json',
  neu: 'neu-master.tar.gz',
  commit: 'neu-commit.txt',
} as const;
