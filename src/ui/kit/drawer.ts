// <dialog>-based slide-in drawer (settings, filters on mobile, "More" sheet).
import { t } from '../../i18n/index.ts';
import type { Drawer, DrawerOptions } from './types.ts';
import { focusEl, focusables, trapTab, uid } from './util.ts';

/** Create a drawer; fill `drawer.body`, then open(). It appends itself to <body> on first open. */
export function createDrawer(opts: DrawerOptions): Drawer {
  const id = uid('kit-drawer');
  const dlg = document.createElement('dialog');
  dlg.className = 'kit-drawer';
  dlg.dataset.side = opts.side ?? 'right';
  dlg.setAttribute('aria-labelledby', `${id}-t`);
  const head = document.createElement('div');
  head.className = 'kit-drawer-head';
  const title = document.createElement('h2');
  title.id = `${id}-t`;
  title.className = 'kit-drawer-title';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn btn-ghost btn-sm kit-x';
  closeBtn.textContent = '×';
  const body = document.createElement('div');
  body.className = 'kit-drawer-body';
  head.append(title, closeBtn);
  dlg.append(head, body);

  let open = false;
  let returnTo: HTMLElement | null = null;
  const readTitle = () => (typeof opts.title === 'function' ? opts.title() : opts.title);

  function finish(): void {
    if (!open) return;
    open = false;
    if (returnTo?.isConnected) focusEl(returnTo);
    returnTo = null;
    opts.onClose?.();
  }

  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      api.close();
    } else trapTab(dlg, ev);
  };
  // native Esc on a modal dialog fires `cancel`; route it through close() so focus/onClose run
  const onCancel = (ev: Event) => {
    ev.preventDefault();
    api.close();
  };
  // a click on the ::backdrop area targets the dialog element itself
  const onClick = (ev: MouseEvent) => {
    if (ev.target === dlg) api.close();
  };
  dlg.addEventListener('keydown', onKey);
  dlg.addEventListener('cancel', onCancel);
  dlg.addEventListener('close', finish);
  dlg.addEventListener('click', onClick);
  closeBtn.addEventListener('click', () => api.close());

  const api: Drawer = {
    el: dlg,
    body,
    open() {
      title.textContent = readTitle();
      closeBtn.setAttribute('aria-label', t('common.close'));
      closeBtn.title = t('common.close');
      if (open) return;
      if (!dlg.isConnected) document.body.append(dlg);
      const active = document.activeElement;
      returnTo = active instanceof HTMLElement && active !== document.body ? active : null;
      open = true;
      try {
        if (typeof dlg.showModal === 'function') dlg.showModal();
        else dlg.setAttribute('open', '');
      } catch {
        dlg.setAttribute('open', '');
      }
      focusEl(focusables(body)[0] ?? closeBtn);
    },
    close() {
      if (!open) return;
      try {
        if (typeof dlg.close === 'function') dlg.close();
        else dlg.removeAttribute('open');
      } catch {
        dlg.removeAttribute('open');
      }
      dlg.removeAttribute('open');
      finish();
    },
    isOpen: () => open,
    setTitle(text) {
      title.textContent = text;
    },
    destroy() {
      api.close();
      dlg.removeEventListener('keydown', onKey);
      dlg.removeEventListener('cancel', onCancel);
      dlg.removeEventListener('close', finish);
      dlg.removeEventListener('click', onClick);
      dlg.remove();
    },
  };
  return api;
}
