import { describe, expect, it } from 'vitest';
import { setLang, t } from '../../src/i18n/index.ts';

describe('common dict', () => {
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
