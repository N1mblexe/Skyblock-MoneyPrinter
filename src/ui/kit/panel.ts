// Detail side panel. Docks beside the content at >= UI.dockBp, overlays (with a backdrop, modal) below.
//
// CSS contract: put `panel.el` as the LAST child of a `.kit-split` container (e.g. the view root).
// While open the panel adds `.kit-split--open` to that parent, which (at >= dockBp) becomes a
// two-column grid `minmax(0,1fr) var(--detail-w)`. Below dockBp the panel is position:fixed on the right.
import { UI } from '../../config.ts';
import { t } from '../../i18n/index.ts';
import type { DetailPanel, DetailPanelOptions } from './types.ts';
import { focusEl, media, onMedia, trapTab, uid } from './util.ts';

/** Create a (closed) detail panel; place `el` in your layout, then call open(title, body). */
export function createDetailPanel(opts: DetailPanelOptions = {}): DetailPanel {
  const id = uid('kit-panel');
  const el = document.createElement('aside');
  el.className = 'kit-panel';
  el.hidden = true;
  el.tabIndex = -1;
  el.setAttribute('aria-labelledby', `${id}-t`);
  const head = document.createElement('div');
  head.className = 'kit-panel-head';
  const title = document.createElement('h2');
  title.id = `${id}-t`;
  title.className = 'kit-panel-title';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn btn-ghost btn-sm kit-x';
  closeBtn.textContent = '×';
  const body = document.createElement('div');
  body.className = 'kit-panel-body';
  head.append(title, closeBtn);
  el.append(head, body);

  const mql = media(`(min-width: ${UI.dockBp}px)`);
  const backdrop = document.createElement('div');
  backdrop.className = 'kit-backdrop';
  let open = false;
  let returnTo: HTMLElement | null = null;
  const listeners = new Set<() => void>();

  const docked = () => (mql ? mql.matches : true);

  function applyMode(): void {
    const dock = docked();
    el.dataset.mode = dock ? 'dock' : 'overlay';
    el.setAttribute('role', dock ? 'complementary' : 'dialog');
    if (dock) el.removeAttribute('aria-modal');
    else el.setAttribute('aria-modal', 'true');
    if (open && !dock) {
      if (!backdrop.isConnected) document.body.append(backdrop);
    } else backdrop.remove();
    el.parentElement?.classList.toggle('kit-split--open', open);
  }

  const onDocKey = (ev: KeyboardEvent) => {
    if (!open || docked()) return;
    if (ev.key === 'Escape' && !ev.defaultPrevented) {
      ev.preventDefault();
      api.close();
    } else trapTab(el, ev);
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape' && open) {
      ev.preventDefault();
      api.close();
    }
  };
  closeBtn.addEventListener('click', () => api.close());
  backdrop.addEventListener('click', () => api.close());
  el.addEventListener('keydown', onKey);
  const offMedia = onMedia(mql, applyMode);

  function relabel(): void {
    closeBtn.setAttribute('aria-label', t('common.close'));
    closeBtn.title = t('common.close');
  }

  const api: DetailPanel = {
    el,
    open(text, content) {
      relabel();
      title.textContent = text;
      if (typeof content === 'string') body.innerHTML = content;
      else body.replaceChildren(content);
      body.scrollTop = 0;
      if (open) return; // already open: swap content, leave focus where it is
      const active = document.activeElement;
      returnTo = active instanceof HTMLElement && active !== document.body && !el.contains(active) ? active : null;
      open = true;
      el.hidden = false;
      applyMode();
      document.addEventListener('keydown', onDocKey);
      focusEl(el, true);
    },
    close() {
      if (!open) return;
      open = false;
      const hadFocus = el.contains(document.activeElement) || document.activeElement === document.body;
      el.hidden = true;
      applyMode();
      document.removeEventListener('keydown', onDocKey);
      if (hadFocus) {
        const target = returnTo?.isConnected ? returnTo : (opts.returnFocus?.() ?? null);
        focusEl(target);
      }
      returnTo = null;
      for (const fn of [...listeners]) fn();
    },
    isOpen: () => open,
    onClose(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy() {
      if (open) api.close();
      listeners.clear();
      offMedia();
      el.removeEventListener('keydown', onKey);
      document.removeEventListener('keydown', onDocKey);
      backdrop.remove();
      el.remove();
    },
  };
  return api;
}
