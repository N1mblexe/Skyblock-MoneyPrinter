// Placeholder for the kat page (filled in by wave k2).
import { onLangChange, t } from '../../../i18n/index.ts';
import type { View } from '../../../types/contracts.ts';
import { esc } from '../../dom.ts';

export function createKatView(): View {
  let offs: (() => void)[] = [];
  return {
    id: 'kat',
    mount(root, ctx) {
      const render = () => {
        root.innerHTML = `<h1 tabindex="-1">${esc(t('kat.title'))}</h1>`;
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
