// Placeholder for the bits page (filled in by wave k2).
import { onLangChange, t } from '../../../i18n/index.ts';
import type { View } from '../../../types/contracts.ts';
import { esc } from '../../dom.ts';

export function createBitsView(): View {
  let offs: (() => void)[] = [];
  return {
    id: 'bits',
    mount(root, ctx) {
      const render = () => {
        root.innerHTML = `<h1 tabindex="-1">${esc(t('bits.title'))}</h1>`;
      };
      render();
      offs = [onLangChange(render), ctx.store.subscribe(render)];
    },
    unmount() {
      for (const f of offs) f();
      offs = [];
    },
  };
}
