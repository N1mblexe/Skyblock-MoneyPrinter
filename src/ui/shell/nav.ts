// Sidebar navigation (desktop) that doubles as the bottom nav on mobile (primary items + "More").
import { HOTKEYS } from '../../config.ts';
import { t } from '../../i18n/index.ts';
import type { RouteId } from '../../types/contracts.ts';
import { esc } from '../dom.ts';
import { routeToHash } from '../router.ts';
import { NAV, type NavEntry, type NavGroup } from '../views/index.ts';
import { icon } from './icons.ts';
import './i18n.ts';

export type NavId = NavEntry['id'];

/** Shown in the mobile bottom bar; the rest go to the "More" sheet. */
export const PRIMARY_NAV: readonly NavId[] = ['overview', 'flip', 'craft', 'watch'];

const GROUPS: NavGroup[] = ['markets', 'production', 'trade', 'tools'];

/** Hotkey spec for a nav entry, e.g. 'g o'. */
export const navHotkey = (id: NavId): string => HOTKEYS.go[id];

/** `<kbd>` markup for a spec like 'g o' (sequence keys as separate kbd elements). */
export function kbdHtml(spec: string): string {
  return spec
    .split(/\s+/)
    .map((k) => `<kbd>${esc(k)}</kbd>`)
    .join('');
}

/** One nav link (sidebar or More sheet). testid prefix: 'tab' in the sidebar (kept for scripts/smoke.ts), 'more' in the sheet. */
export function navLinkHtml(n: NavEntry, testPrefix: 'tab' | 'more'): string {
  const primary = PRIMARY_NAV.includes(n.id);
  return (
    `<li class="sb-item"${primary ? ' data-primary=""' : ''}><a class="sb-link" href="${esc(routeToHash({ id: n.id }))}" data-nav="${n.id}" data-testid="${testPrefix}-${n.id}">` +
    `${icon(n.id)}<span class="sb-label"></span>` +
    (n.id === 'watch' ? `<span class="sb-badge" aria-hidden="true" hidden></span><span class="kit-sr sb-badge-sr"></span>` : '') +
    `<span class="sb-kbd" aria-hidden="true">${kbdHtml(navHotkey(n.id))}</span></a></li>`
  );
}

/** Sidebar <nav> markup: grouped lists + the mobile "More" button. */
export function navHtml(): string {
  const groups = GROUPS.map((g) => {
    const items = NAV.filter((n) => n.group === g);
    if (!items.length) return '';
    return (
      `<div class="sb-group" data-group="${g}"><div class="sb-gh" id="sb-g-${g}"></div>` +
      `<ul class="sb-list" aria-labelledby="sb-g-${g}">${items.map((n) => navLinkHtml(n, 'tab')).join('')}</ul></div>`
    );
  }).join('');
  return (
    groups +
    `<button type="button" class="sb-link sb-more" data-testid="nav-more" aria-haspopup="dialog" aria-expanded="false" hidden>` +
    `${icon('more')}<span class="sb-label"></span></button>`
  );
}

/** Re-apply labels (and titles) to every nav link/heading under root. */
export function labelNav(root: HTMLElement, collapsed: boolean): void {
  for (const gh of root.querySelectorAll<HTMLElement>('.sb-gh')) {
    const g = gh.parentElement?.dataset.group;
    if (g) gh.textContent = t(`common.navGroup_${g}`);
  }
  for (const a of root.querySelectorAll<HTMLElement>('[data-nav]')) {
    const id = a.dataset.nav as NavId;
    const label = t(`common.nav_${id}`);
    a.querySelector('.sb-label')!.textContent = label;
    if (collapsed) a.title = label;
    else a.removeAttribute('title');
    a.setAttribute('aria-keyshortcuts', navHotkey(id).replace(/\s+/g, ' '));
  }
  const more = root.querySelector<HTMLElement>('.sb-more .sb-label');
  if (more) more.textContent = t('common.more');
}

/** aria-current="page" on the active route's links ('item' and unknown routes highlight nothing). */
export function markActive(root: HTMLElement, id: RouteId | null): void {
  for (const a of root.querySelectorAll<HTMLElement>('[data-nav]')) {
    if (a.dataset.nav === id) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  const more = root.querySelector<HTMLElement>('.sb-more');
  if (more) more.classList.toggle('has-current', !!id && !PRIMARY_NAV.includes(id as NavId) && id !== 'item');
}

/** Watchlist count badge (hidden at 0). */
export function setWatchBadge(root: HTMLElement, n: number): void {
  for (const b of root.querySelectorAll<HTMLElement>('.sb-badge')) {
    b.textContent = n > 99 ? '99+' : String(n);
    b.hidden = n <= 0;
    b.title = t('shell.watchCount', { n });
  }
  for (const sr of root.querySelectorAll<HTMLElement>('.sb-badge-sr')) sr.textContent = n > 0 ? ` (${t('shell.watchCount', { n })})` : '';
}
