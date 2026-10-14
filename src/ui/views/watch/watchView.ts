// Wave 0 placeholder; replaced in Wave 2.
import type { View } from '../../../types/contracts.ts';

export function createWatchView(): View {
  return {
    id: 'watch',
    mount(root, ctx) {
      root.innerHTML = '<section class="card"><h2></h2><p class="note">—</p></section>';
      root.querySelector('h2')!.textContent = ctx.t('common.nav_watch');
    },
    unmount() {},
  };
}
