// Filter bar bound to a QueryState: search / number / segment / toggle fields, "Filters (n)" + reset.
// Below UI.mobileBp the fields collapse behind a disclosure button (CSS: .kit-filterbar[data-open]).
import { t } from '../../i18n/index.ts';
import type { FilterBar, FilterSpec, QueryState } from './types.ts';
import { debounce, uid } from './util.ts';

/** Input debounce for search / number fields (ms). */
export const FILTER_DEBOUNCE_MS = 250;

type Values = Record<string, unknown>;

/** Parse a user-typed number ('1.5', '1,5', ' 2 '); '' -> null; invalid -> undefined. */
export function parseNumberInput(raw: string): number | null | undefined {
  const s = raw.trim().replace(/\s/g, '');
  if (s === '') return null;
  // "1.234,5" (tr) or "1,234.5" (en): the last separator is the decimal one
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let norm = s;
  if (lastComma >= 0 && lastDot >= 0) norm = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (lastComma >= 0) norm = s.replace(',', '.');
  const n = Number(norm);
  return Number.isFinite(n) ? n : undefined;
}

interface Bound {
  spec: FilterSpec;
  label: HTMLElement;
  sync(v: Values): void;
  relabel(): void;
  dispose(): void;
}

/** Render filter fields for `specs`, two-way bound to `state` (keys must exist in its schema). */
export function createFilterBar<V extends object>(specs: FilterSpec[], state: QueryState<V>): FilterBar {
  const st = state as unknown as QueryState<Values>;
  const id = uid('kit-fb');
  const el = document.createElement('div');
  el.className = 'kit-filterbar';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'btn btn-sm kit-fb-toggle';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', `${id}-f`);
  const fields = document.createElement('div');
  fields.className = 'filters kit-fb-fields';
  fields.id = `${id}-f`;
  const actions = document.createElement('div');
  actions.className = 'kit-fb-actions';
  const count = document.createElement('span');
  count.className = 'kit-fb-count';
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'btn btn-sm btn-ghost kit-fb-reset';
  actions.append(count, reset);
  el.append(toggle, fields, actions);

  toggle.addEventListener('click', () => {
    const open = el.dataset.open == null;
    if (open) el.dataset.open = '';
    else delete el.dataset.open;
    toggle.setAttribute('aria-expanded', String(open));
  });
  reset.addEventListener('click', () => {
    for (const b of bound) b.dispose();
    st.reset();
  });

  const bound: Bound[] = specs.map(build);
  for (const b of bound) fields.append(b.label);

  function field(labelText: HTMLElement, control: HTMLElement, help?: HTMLElement | null, check = false): HTMLElement {
    const lab = document.createElement('label');
    lab.className = check ? 'field field-check' : 'field';
    if (check) {
      const row = document.createElement('span');
      row.className = 'check-row';
      row.append(control, labelText);
      lab.append(row);
    } else lab.append(labelText, control);
    if (help) lab.append(help);
    return lab;
  }

  function span(cls: string): HTMLElement {
    const s = document.createElement('span');
    s.className = cls;
    return s;
  }

  function build(spec: FilterSpec): Bound {
    const name = span('field-label');
    const key = spec.key;
    switch (spec.kind) {
      case 'search': {
        const inp = document.createElement('input');
        inp.type = 'search';
        inp.dataset.filter = key;
        inp.autocomplete = 'off';
        const push = debounce((v: string) => st.set({ [key]: v }), FILTER_DEBOUNCE_MS);
        inp.addEventListener('input', () => push(inp.value));
        inp.addEventListener('change', () => push.flush());
        return {
          spec,
          label: field(name, inp),
          sync(v) {
            const next = String(v[key] ?? '');
            // don't clobber text the user is still typing (debounce pending)
            if (inp.value !== next && !push.pending()) inp.value = next;
          },
          relabel() {
            name.textContent = spec.label();
            inp.placeholder = spec.placeholder?.() ?? '';
          },
          dispose: () => push.cancel(),
        };
      }
      case 'number': {
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.inputMode = 'decimal';
        inp.dataset.filter = key;
        inp.autocomplete = 'off';
        const help = spec.help ? span('field-help') : null;
        const push = debounce(() => {
          const n = parseNumberInput(inp.value);
          if (n === undefined) {
            inp.setAttribute('aria-invalid', 'true');
            inp.title = t('common.invalid');
            return;
          }
          inp.removeAttribute('aria-invalid');
          inp.removeAttribute('title');
          st.set({ [key]: n });
        }, FILTER_DEBOUNCE_MS);
        inp.addEventListener('input', () => push());
        inp.addEventListener('change', () => push.flush());
        let control: HTMLElement = inp;
        if (spec.suffix) {
          control = span('kit-fb-num');
          const suf = span('kit-fb-suffix');
          suf.textContent = spec.suffix;
          control.append(inp, suf);
        }
        return {
          spec,
          label: field(name, control, help),
          sync(v) {
            const cur = parseNumberInput(inp.value);
            const want = (v[key] as number | null | undefined) ?? null;
            if (cur !== want && !push.pending()) {
              inp.value = want == null ? '' : String(want);
              inp.removeAttribute('aria-invalid');
            }
          },
          relabel() {
            name.textContent = spec.label();
            if (help) help.textContent = spec.help!();
          },
          dispose: () => push.cancel(),
        };
      }
      case 'segment': {
        const wrapper = document.createElement('div');
        wrapper.className = 'field';
        const seg = document.createElement('div');
        seg.className = 'seg';
        seg.setAttribute('role', 'group');
        seg.dataset.filter = key;
        const nameId = `${id}-${key}`;
        name.id = nameId;
        seg.setAttribute('aria-labelledby', nameId);
        const btns = spec.options.map((o) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.dataset.value = o.value;
          b.addEventListener('click', () => st.set({ [key]: o.value }));
          seg.append(b);
          return b;
        });
        wrapper.append(name, seg);
        return {
          spec,
          label: wrapper,
          sync(v) {
            for (const b of btns) b.setAttribute('aria-pressed', String(b.dataset.value === v[key]));
          },
          relabel() {
            name.textContent = spec.label();
            spec.options.forEach((o, i) => (btns[i]!.textContent = o.label()));
          },
          dispose() {},
        };
      }
      case 'toggle': {
        const inp = document.createElement('input');
        inp.type = 'checkbox';
        inp.dataset.filter = key;
        inp.addEventListener('change', () => st.set({ [key]: inp.checked }));
        return {
          spec,
          label: field(name, inp, null, true),
          sync(v) {
            inp.checked = !!v[key];
          },
          relabel() {
            name.textContent = spec.label();
          },
          dispose() {},
        };
      }
    }
  }

  function syncCounts(): void {
    const n = st.activeCount();
    const txt = n ? t('common.filtersN', { n }) : t('common.filters');
    toggle.textContent = txt;
    count.textContent = txt;
    count.classList.toggle('on', n > 0);
    reset.disabled = n === 0;
  }

  function sync(v: Values): void {
    for (const b of bound) b.sync(v);
    syncCounts();
  }

  const off = st.onChange(sync);

  const api: FilterBar = {
    el,
    refresh() {
      for (const b of bound) b.relabel();
      reset.textContent = t('common.resetFilters');
      sync(st.get());
    },
    destroy() {
      off();
      for (const b of bound) b.dispose();
      el.remove();
    },
  };
  api.refresh();
  return api;
}
