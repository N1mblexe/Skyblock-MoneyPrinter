import { describe, expect, it } from 'vitest';
import { expandBraces, ownedBy } from '../../scripts/check-ownership.ts';

describe('check-ownership globs', () => {
  it('expands braces, nested and repeated', () => {
    expect(expandBraces('src/{a,b}.ts')).toEqual(['src/a.ts', 'src/b.ts']);
    expect(expandBraces('{x,y}/{1,2}')).toEqual(['x/1', 'x/2', 'y/1', 'y/2']);
    expect(expandBraces('plain/**')).toEqual(['plain/**']);
  });

  it('allows the globs, minus the ! ones', () => {
    const owned = ownedBy(['src/domain/{flip,npc}.ts', 'scripts/**', '!scripts/{smoke,sanity}.ts']);
    expect(owned('src/domain/flip.ts')).toBe(true);
    expect(owned('src/domain/npc.ts')).toBe(true);
    expect(owned('src/domain/craft.ts')).toBe(false);
    expect(owned('scripts/lib/neu.ts')).toBe(true);
    expect(owned('scripts/smoke.ts')).toBe(false);
    expect(owned('scripts/sanity.ts')).toBe(false);
  });
});
