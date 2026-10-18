// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLang } from '../../src/i18n/index.ts';
import { consBadge, consListHtml, itemCell, riskBadge, riskScopeHtml, sourceBadge } from '../../src/ui/cells.ts';

const frag = (html: string) => {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
};

beforeEach(() => setLang('en'));
afterEach(() => setLang('en'));

describe('cells', () => {
  it('risk badge lists the flag explanations, NO_HISTORY only when alone', () => {
    const b = frag(riskBadge({ level: 'caution', score: 2, flags: ['WIDE_SPREAD', 'NO_HISTORY'] })).firstElementChild!;
    expect(b.className).toBe('badge risk-caution');
    expect(b.textContent).toBe('Caution');
    expect(b.getAttribute('title')).toContain('Wide spread');
    expect(b.getAttribute('title')).not.toContain('history');
    expect(frag(riskBadge({ level: 'ok', score: 0, flags: ['NO_HISTORY'] })).firstElementChild!.getAttribute('title')).toContain('history');
    expect(frag(riskBadge({ level: 'ok', score: 0, flags: [] })).firstElementChild!.hasAttribute('title')).toBe(false);
  });

  it('item cell escapes and links on request', () => {
    expect(itemCell('A<B', 'x & y')).toBe('x &amp; y<span class="id-sub">A&lt;B</span>');
    expect(frag(itemCell('A B', 'n', true)).querySelector('a')!.getAttribute('href')).toBe('#/item/A%20B');
  });

  it('source badges cover every quote source', () => {
    expect(frag(sourceBadge('ah')).textContent).toBe('AH');
    expect(frag(sourceBadge('mix')).textContent).toBe('NPC + bazaar');
    expect(frag(sourceBadge('npc')).firstElementChild!.className).toBe('badge src-npc');
  });

  it('risk scope names the sides a report checked', () => {
    expect(frag(riskScopeHtml('buy')).textContent).toMatch(/Only the bazaar buy side/);
    expect(frag(riskScopeHtml('sell')).textContent).toMatch(/Only the bazaar sell side/);
    setLang('tr');
    expect(frag(riskScopeHtml('both')).textContent).toMatch(/iki bazaar tarafı/);
  });

  it('cons badge only when something changed', () => {
    expect(consBadge(undefined)).toBe('');
    expect(consBadge({})).toBe('');
    expect(consBadge({ churn: 0 })).toBe('');
    const b = frag(consBadge({ rateMul: 0.8 })).querySelector('.cons-badge')!;
    expect(b.textContent).toBe('Adjusted');
    expect(b.getAttribute('title')).toMatch(/recent price history/);
  });

  it('cons list: one line per adjustment, with the adjusted prices', () => {
    expect(consListHtml(undefined)).toBe('');
    expect(consListHtml({ churn: 0 })).toBe('');
    const all = frag(consListHtml({ buyRef: 100, sellRef: 130, rateMul: 0.75, churn: 0.4 }, { buy: 105, sell: 120 }));
    const lines = [...all.querySelectorAll('[data-testid="cons-list"] li')].map((li) => li.textContent!);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^Buy price 100\.0 in the snapshot → 105\.0/);
    expect(lines[1]).toMatch(/^Sell price 130\.0 in the snapshot → 120\.0/);
    expect(lines[2]).toMatch(/× 0\.75/);
    expect(lines[3]).toMatch(/0\.4 per unit/);
    expect(all.textContent).toContain('turn them off');
    // only the parts that changed; a missing adjusted price shows a dash
    const one = frag(consListHtml({ sellRef: 50 }));
    expect(one.querySelectorAll('li')).toHaveLength(1);
    expect(one.textContent).toContain('→ —');
    expect(frag(consListHtml({ buyRef: 2_500_000 }, { buy: 2_600_000 })).textContent).toContain('2,500,000 in the snapshot → 2,600,000');
  });
});
