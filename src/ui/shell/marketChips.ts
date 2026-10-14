// Top-bar market context: the mayor chip (election) and the auction-house scan status.
import { onLangChange, t } from '../../i18n/index.ts';
import type { AppState, ElectionInfo, Store } from '../../types/contracts.ts';
import { esc } from '../dom.ts';
import { fmtAge } from '../format.ts';
import { icon } from './icons.ts';
import './i18n.ts';

/** AH age text refresh period. */
export const AH_TICK_MS = 15_000;

export interface Chip {
  el: HTMLElement;
  destroy(): void;
}

export interface MayorChip extends Chip {
  /** close the perks popover; true when it was open */
  close(): boolean;
}

/** Plain-text perk summary (button tooltip). */
export function perkSummary(e: ElectionInfo): string {
  const lines: string[] = [];
  if (e.mayor) {
    lines.push(t('shell.mayorChip', { name: e.mayor.name }));
    for (const p of e.mayor.perks) lines.push(`• ${p.name}`);
  }
  if (e.minister) lines.push(`${t('common.minister')}: ${e.minister.name} (${e.minister.perk.name})`);
  return lines.join('\n');
}

/** Mayor chip: name (+ minister) with a perks popover. Hidden until store.election has a mayor. */
export function createMayorChip(store: Store<AppState>): MayorChip {
  const el = document.createElement('div');
  el.className = 'mayor';
  el.hidden = true;
  const popId = `mayor-pop-${Math.random().toString(36).slice(2, 8)}`;
  el.innerHTML =
    `<button type="button" class="tb-chip mayor-btn" data-testid="mayor-chip" aria-expanded="false" aria-controls="${popId}">` +
    `${icon('crown')}<span class="mayor-name"></span><span class="mayor-min"></span></button>` +
    `<div class="tb-pop mayor-pop" id="${popId}" hidden></div>`;
  const btn = el.querySelector<HTMLButtonElement>('.mayor-btn')!;
  const pop = el.querySelector<HTMLElement>('.mayor-pop')!;
  const nameEl = el.querySelector<HTMLElement>('.mayor-name')!;
  const minEl = el.querySelector<HTMLElement>('.mayor-min')!;

  function render(): void {
    const e = store.get().election;
    if (!e?.mayor) {
      el.hidden = true;
      setOpen(false);
      return;
    }
    el.hidden = false;
    nameEl.textContent = e.mayor.name;
    minEl.textContent = e.minister ? ` · ${e.minister.name}` : '';
    btn.title = perkSummary(e);
    btn.setAttribute('aria-label', `${t('common.mayor')}: ${e.mayor.name}${e.minister ? `, ${t('common.minister')}: ${e.minister.name}` : ''}`);
    const perks = e.mayor.perks.length
      ? `<ul class="perk-list">${e.mayor.perks.map((p) => `<li><b>${esc(p.name)}</b><span>${esc(p.description)}</span></li>`).join('')}</ul>`
      : `<p class="muted small">${esc(t('shell.noPerks'))}</p>`;
    const minister = e.minister
      ? `<div class="pop-sec"><div class="pop-k">${esc(t('common.minister'))}: <b>${esc(e.minister.name)}</b></div>` +
        `<ul class="perk-list"><li><b>${esc(e.minister.perk.name)}</b><span>${esc(e.minister.perk.description)}</span></li></ul></div>`
      : '';
    pop.innerHTML =
      `<div class="pop-head"><span class="pop-k">${esc(t('common.mayor'))}</span> <b>${esc(e.mayor.name)}</b>` +
      (e.year != null ? ` <span class="muted small">${esc(t('shell.mayorYear', { y: e.year }))}</span>` : '') +
      `</div><div class="pop-sec"><div class="pop-k">${esc(t('shell.perks'))}</div>${perks}</div>${minister}`;
  }

  function setOpen(open: boolean): void {
    pop.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) document.addEventListener('mousedown', onDocDown, true);
    else document.removeEventListener('mousedown', onDocDown, true);
  }
  const onDocDown = (ev: MouseEvent) => {
    if (!el.contains(ev.target as Node)) setOpen(false);
  };
  const onClick = () => setOpen(Boolean(pop.hidden));
  btn.addEventListener('click', onClick);

  const unsub = store.subscribe((s, prev) => {
    if (s.election !== prev.election) render();
  });
  const unLang = onLangChange(render);
  render();

  return {
    el,
    close() {
      if (pop.hidden) return false;
      setOpen(false);
      btn.focus();
      return true;
    },
    destroy() {
      setOpen(false);
      btn.removeEventListener('click', onClick);
      unsub();
      unLang();
      el.remove();
    },
  };
}

/** AH status: scan progress (store.ahProgress) while scanning, else the age of the last AH snapshot. */
export function createAhStatus(store: Store<AppState>): Chip {
  const el = document.createElement('div');
  el.className = 'ah-stat';
  el.dataset.testid = 'ah-status';
  el.hidden = true;
  el.innerHTML =
    `${icon('gavel')}<span class="ah-text"></span>` +
    `<span class="ah-bar" role="progressbar" aria-valuemin="0" hidden><span class="ah-fill"></span></span>`;
  const text = el.querySelector<HTMLElement>('.ah-text')!;
  const bar = el.querySelector<HTMLElement>('.ah-bar')!;
  const fill = el.querySelector<HTMLElement>('.ah-fill')!;

  function render(): void {
    const s = store.get();
    const p = s.ahProgress;
    if (p) {
      const n = Math.max(p.totalPages, 1);
      const done = Math.min(p.page, n);
      el.hidden = false;
      el.dataset.state = 'scanning';
      text.textContent = t('common.ahScanning', { p: done, n: p.totalPages });
      el.title = text.textContent;
      bar.hidden = false;
      bar.setAttribute('aria-valuemax', String(n));
      bar.setAttribute('aria-valuenow', String(done));
      bar.setAttribute('aria-label', t('shell.ahProgressAria'));
      fill.style.width = `${Math.round((done / n) * 100)}%`;
      return;
    }
    bar.hidden = true;
    if (s.ah) {
      const age = fmtAge(Date.now() - s.ah.fetchedAt);
      el.hidden = false;
      el.dataset.state = 'idle';
      text.textContent = t('shell.ahAge', { age });
      let title = t('shell.ahAgeTitle', { age });
      if (s.ah.failedPages?.length) title += ` · ${t('shell.ahPartial', { n: s.ah.failedPages.length })}`;
      el.title = title;
    } else {
      el.hidden = true;
      delete el.dataset.state;
    }
  }

  const timer = setInterval(() => {
    if (!store.get().ahProgress && store.get().ah) render();
  }, AH_TICK_MS);
  const unsub = store.subscribe((s, prev) => {
    if (s.ah !== prev.ah || s.ahProgress !== prev.ahProgress) render();
  });
  const unLang = onLangChange(render);
  render();

  return {
    el,
    destroy() {
      clearInterval(timer);
      unsub();
      unLang();
      el.remove();
    },
  };
}
