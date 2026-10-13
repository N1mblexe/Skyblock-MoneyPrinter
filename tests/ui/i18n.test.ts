import { describe, expect, it } from 'vitest';
import '../../src/i18n/common.ts';
import { dictKeys, setLang, t } from '../../src/i18n/index.ts';

describe('common dict', () => {
  it('has identical tr/en key sets', () => {
    const { tr, en } = dictKeys('common');
    expect(tr.length).toBeGreaterThan(50);
    expect(en).toEqual(tr);
  });
  it('has non-empty values and required keys', () => {
    for (const k of ['tab_flip', 'tab_craft', 'tab_fusion', 'tab_npc', 'tableShowing', 'manualBadJson', 'st_live', 'st_error']) {
      setLang('tr');
      const trv = t(`common.${k}`);
      setLang('en');
      const env = t(`common.${k}`);
      expect(trv).not.toBe(`common.${k}`);
      expect(env).not.toBe(`common.${k}`);
    }
    setLang('tr');
    expect(t('common.tab_flip')).toBe('Flip bulucu');
  });
});
