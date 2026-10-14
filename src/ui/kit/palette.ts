// Command palette: modal combobox + grouped listbox (aria-activedescendant), sync providers.
import { t } from '../../i18n/index.ts';
import { esc } from '../dom.ts';
import './i18n.ts';
import type { PaletteHandle, PaletteItem, PaletteOptions } from './types.ts';
import { focusEl, uid } from './util.ts';

/** Default cap on results across all providers. */
export const PALETTE_LIMIT = 50;

let current: PaletteHandle | null = null;

/** Collect up to `limit` items from the providers (in order), then group by item.group (first-seen group order). */
export function collectPalette(providers: PaletteOptions['providers'], query: string, limit = PALETTE_LIMIT): PaletteItem[] {
  const items: PaletteItem[] = [];
  for (const p of providers) {
    if (items.length >= limit) break;
    let got: PaletteItem[] = [];
    try {
      got = p(query);
    } catch (e) {
      console.warn('palette provider failed', e);
    }
    for (const it of got) {
      if (items.length >= limit) break;
      items.push(it);
    }
  }
  const groups = new Map<string, PaletteItem[]>();
  for (const it of items) {
    const g = groups.get(it.group);
    if (g) g.push(it);
    else groups.set(it.group, [it]);
  }
  return [...groups.values()].flat();
}

/** The open palette, if any. */
export const currentPalette = (): PaletteHandle | null => current;

/**
 * Open the command palette (only one at a time: a second call focuses the open one).
 * Arrow keys move, Enter runs the active item (palette closes first), Esc closes. Focus returns on close.
 */
export function openPalette(opts: PaletteOptions): PaletteHandle {
  if (current) {
    current.el.querySelector<HTMLInputElement>('input')?.focus();
    return current;
  }
  const id = uid('kit-pal');
  const limit = opts.limit ?? PALETTE_LIMIT;
  const root = document.createElement('div');
  root.className = 'kit-palette-root';
  const box = document.createElement('div');
  box.className = 'kit-palette';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', t('common.commandPalette'));
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'kit-palette-input';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-controls', `${id}-lb`);
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-label', t('common.commandPalette'));
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = opts.placeholder ?? t('common.paletteHint');
  input.value = opts.query ?? '';
  const listbox = document.createElement('div');
  listbox.id = `${id}-lb`;
  listbox.className = 'kit-palette-list';
  listbox.setAttribute('role', 'listbox');
  listbox.setAttribute('aria-label', t('common.commandPalette'));
  const status = document.createElement('div');
  status.className = 'kit-sr';
  status.setAttribute('role', 'status');
  box.append(input, listbox, status);
  root.append(box);

  let flat: PaletteItem[] = [];
  let active = -1;
  const active0 = document.activeElement;
  const returnTo = active0 instanceof HTMLElement && active0 !== document.body ? active0 : null;
  const optId = (i: number) => `${id}-o${i}`;

  function setActive(i: number): void {
    if (!flat.length) {
      active = -1;
      input.removeAttribute('aria-activedescendant');
      return;
    }
    const n = flat.length;
    const next = ((i % n) + n) % n;
    if (active >= 0) listbox.querySelector(`#${optId(active)}`)?.setAttribute('aria-selected', 'false');
    active = next;
    const opt = listbox.querySelector<HTMLElement>(`#${optId(active)}`);
    opt?.setAttribute('aria-selected', 'true');
    input.setAttribute('aria-activedescendant', optId(active));
    if (opt && typeof opt.scrollIntoView === 'function') opt.scrollIntoView({ block: 'nearest' });
  }

  function search(): void {
    flat = collectPalette(opts.providers, input.value.trim(), limit);
    let html = '';
    let g: string | null = null;
    flat.forEach((it, i) => {
      if (it.group !== g) {
        if (g !== null) html += '</div>';
        g = it.group;
        const gid = `${id}-g${i}`;
        html += `<div role="group" class="kp-group" aria-labelledby="${gid}"><div class="kp-glabel" id="${gid}" role="presentation">${esc(g)}</div>`;
      }
      html += `<div role="option" class="kp-opt" id="${optId(i)}" data-i="${i}" aria-selected="false"><span class="kp-label">${esc(it.label)}</span>${it.hint ? `<span class="kp-hint">${esc(it.hint)}</span>` : ''}</div>`;
    });
    if (g !== null) html += '</div>';
    if (!flat.length) html = `<div class="kp-empty" role="presentation">${esc(t('kit.noResults'))}</div>`;
    listbox.innerHTML = html;
    active = -1;
    setActive(0);
    status.textContent = flat.length ? t('kit.results', { n: flat.length }) : t('kit.noResults');
  }

  function choose(i: number): void {
    const it = flat[i];
    if (!it) return;
    handle.close();
    it.run();
  }

  const onKey = (ev: KeyboardEvent) => {
    switch (ev.key) {
      case 'ArrowDown':
        ev.preventDefault();
        setActive(active + 1);
        break;
      case 'ArrowUp':
        ev.preventDefault();
        setActive(active - 1);
        break;
      case 'PageDown':
        ev.preventDefault();
        setActive(Math.min(flat.length - 1, active + 8));
        break;
      case 'PageUp':
        ev.preventDefault();
        setActive(Math.max(0, active - 8));
        break;
      case 'Enter':
        ev.preventDefault();
        choose(active);
        break;
      case 'Escape':
        ev.preventDefault();
        ev.stopPropagation();
        handle.close();
        break;
      case 'Tab':
        ev.preventDefault(); // focus stays in the palette
        break;
    }
  };
  const optFrom = (ev: Event) => (ev.target instanceof Element ? ev.target.closest<HTMLElement>('[role="option"]') : null);
  const onMove = (ev: MouseEvent) => {
    const o = optFrom(ev);
    if (o && Number(o.dataset.i) !== active) setActive(Number(o.dataset.i));
  };
  const onListClick = (ev: MouseEvent) => {
    const o = optFrom(ev);
    if (o) choose(Number(o.dataset.i));
  };
  const onRootDown = (ev: MouseEvent) => {
    if (ev.target === root) handle.close();
    else if (listbox.contains(ev.target as Node)) ev.preventDefault(); // keep focus in the input
  };
  input.addEventListener('keydown', onKey);
  input.addEventListener('input', search);
  listbox.addEventListener('mousemove', onMove);
  listbox.addEventListener('click', onListClick);
  root.addEventListener('mousedown', onRootDown);

  const handle: PaletteHandle = {
    el: root,
    close() {
      if (current !== handle) return;
      current = null;
      root.remove();
      if (returnTo?.isConnected) focusEl(returnTo);
      opts.onClose?.();
    },
  };
  current = handle;
  document.body.append(root);
  search();
  focusEl(input);
  input.select();
  return handle;
}
