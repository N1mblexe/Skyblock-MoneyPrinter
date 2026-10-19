// Usage: npm run check:owners -- <wave> <agent> [branch] [base]
// Fails if <branch> (default `<wave>/<agent>`) changed files outside the agent's globs in scripts/ownership.json.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** `a/{b,c}.ts` -> ['a/b.ts', 'a/c.ts'] (nested and repeated braces expand too). */
export function expandBraces(g: string): string[] {
  const m = /\{([^{}]*)\}/.exec(g);
  if (!m) return [g];
  return m[1]!.split(',').flatMap((alt) => expandBraces(g.slice(0, m.index) + alt + g.slice(m.index + m[0].length)));
}

/** Minimal glob: `**` = any path, `*` = any chars except '/' (expand braces first). */
export function globToRe(g: string): RegExp {
  const re = g
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/?/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${re}$`);
}

/** Owner test for a glob list: `!` globs deny, braces expand. */
export function ownedBy(globs: readonly string[]): (file: string) => boolean {
  const res = (gs: string[]) => gs.flatMap(expandBraces).map(globToRe);
  const allow = res(globs.filter((g) => !g.startsWith('!')));
  const deny = res(globs.filter((g) => g.startsWith('!')).map((g) => g.slice(1)));
  return (f) => allow.some((r) => r.test(f)) && !deny.some((r) => r.test(f));
}

function main(): void {
  const [wave, agent, branchArg, baseArg] = process.argv.slice(2);
  if (!wave || !agent) {
    console.error('usage: check-ownership <wave> <agent> [branch] [base]');
    process.exit(2);
  }
  const branch = branchArg ?? `${wave}/${agent}`;
  const base = baseArg ?? 'round2';

  const owners = JSON.parse(readFileSync(fileURLToPath(new URL('./ownership.json', import.meta.url)), 'utf8'));
  const globs: string[] | undefined = owners[wave]?.[agent];
  if (!globs) {
    console.error(`no ownership entry for ${wave}/${agent}`);
    process.exit(2);
  }
  const owned = ownedBy(globs);

  const changed = execFileSync('git', ['diff', '--name-only', `${base}...${branch}`], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  const bad = changed.filter((f) => !owned(f));
  console.log(`${branch}: ${changed.length} changed file(s) vs ${base}`);
  if (bad.length) {
    console.error(`outside ownership of ${wave}/${agent}:\n  ${bad.join('\n  ')}`);
    process.exit(1);
  }
  console.log('ownership OK');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
