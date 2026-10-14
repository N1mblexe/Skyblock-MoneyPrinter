// Keyboard shortcuts help (content of the "?" dialog), generated from config.HOTKEYS.
import { HOTKEYS } from '../../config.ts';
import { t } from '../../i18n/index.ts';
import { esc } from '../dom.ts';
import { hotkeyLabel } from '../kit/index.ts';
import { NAV } from '../views/index.ts';
import { navHotkey } from './nav.ts';
import './i18n.ts';

/** One spec as kbd chips: 'mod+k' -> <kbd>Ctrl</kbd><kbd>K</kbd>; 'g o' -> <kbd>G</kbd> then <kbd>O</kbd>. */
const ARROWS: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };

function specHtml(spec: string): string {
  if (ARROWS[spec]) return `<kbd>${ARROWS[spec]}</kbd>`;
  return hotkeyLabel(spec)
    .map((chord) => chord.split(' ').map((k) => `<kbd>${esc(k)}</kbd>`).join('+'))
    .join(` <span class="muted small">${esc(t('shell.then'))}</span> `);
}

function keysHtml(specs: readonly string[]): string {
  return specs.map(specHtml).join(` <span class="muted small">${esc(t('shell.or'))}</span> `);
}

function rows(list: [readonly string[], string][]): string {
  return list.map(([specs, label]) => `<tr><td class="hk-keys">${keysHtml(specs)}</td><td>${esc(label)}</td></tr>`).join('');
}

const table = (title: string, body: string) =>
  `<section class="hk-sec"><h3 class="set-h">${esc(title)}</h3><table class="tbl-plain hk-table"><tbody>${body}</tbody></table></section>`;

/** Shortcuts help HTML (global, navigation, tables). */
export function shortcutsHtml(): string {
  const global = rows([
    [HOTKEYS.palette, t('shell.hk_palette')],
    [HOTKEYS.refresh, t('shell.hk_refresh')],
    [HOTKEYS.help, t('shell.hk_help')],
    [HOTKEYS.close, t('shell.hk_close')],
  ]);
  const nav = rows(NAV.map((n): [readonly string[], string] => [[navHotkey(n.id)], t('shell.hk_go', { page: t(`common.nav_${n.id}`) })]));
  const tables = rows([
    [['ArrowUp', 'ArrowDown', 'j', 'k'], t('shell.hk_rows')],
    [['Enter'], t('shell.hk_open')],
    [HOTKEYS.star, t('shell.hk_star')],
    [HOTKEYS.export, t('shell.hk_export')],
  ]);
  return (
    `<div class="hk" data-testid="shortcuts">` +
    table(t('shell.hkGlobal'), global) +
    table(t('shell.hkNav'), nav) +
    table(t('shell.hkTable'), tables) +
    `</div>`
  );
}
