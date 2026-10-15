// Usage: npm run check:owners -- <wave> <agent> [branch] [base]
// Fails if <branch> (default `<wave>/<agent>`) changed files outside the agent's globs in scripts/ownership.json.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

/** Minimal glob: `**` = any path, `*` = any chars except '/'. */
export function globToRe(g: string): RegExp {
  const re = g
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/?/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${re}$`);
}

const allow = globs.filter((g) => !g.startsWith('!')).map(globToRe);
const deny = globs.filter((g) => g.startsWith('!')).map((g) => globToRe(g.slice(1)));
const owned = (f: string) => allow.some((r) => r.test(f)) && !deny.some((r) => r.test(f));

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
