import { API_BAZAAR } from '../config.ts';
import { onLangChange, t } from '../i18n/index.ts';
import { esc } from './dom.ts';

/** Collapsible fallback: paste API JSON or pick a .json file. Calls onText with the text; shows returned error message if any. */
export function createManualLoad(onText: (text: string) => string | null): { el: HTMLElement; open(): void; destroy(): void } {
  const el = document.createElement('details');
  el.className = 'panel load';
  el.dataset.testid = 'manual-load';

  let msgState: { kind: 'ok' | 'err' | 'info'; text: string; key?: string } | null = null;

  function build(): void {
    const link = `<a href="${esc(API_BAZAAR)}" target="_blank" rel="noopener">${esc(API_BAZAAR.replace(/^https:\/\//, ''))}</a>`;
    // step texts contain only our own <b> markup; the link is escaped above
    el.innerHTML =
      `<summary>${esc(t('common.manualTitle'))}</summary>` +
      `<div class="panel-body">` +
      `<p class="muted">${esc(t('common.manualIntro'))}</p>` +
      `<ol class="steps">` +
      `<li>${t('common.manualStep1', { link })}</li>` +
      `<li>${t('common.manualStep2')}</li>` +
      `<li>${t('common.manualStep3')}</li>` +
      `</ol>` +
      `<div class="load-row">` +
      `<div class="paste" tabindex="0" role="button" aria-label="${esc(t('common.pasteAria'))}"><div><strong>${esc(t('common.pasteHere'))}</strong><br><span>${esc(t('common.pasteHint'))}</span></div></div>` +
      `<label class="field load-file"><span class="field-label">${esc(t('common.jsonFile'))}</span><input type="file" accept=".json,application/json,text/plain"></label>` +
      `</div>` +
      `<div class="msg" role="status" aria-live="polite"></div>` +
      `</div>`;
    renderMsg();
  }

  function renderMsg(): void {
    const m = el.querySelector<HTMLElement>('.msg');
    if (!m) return;
    m.className = 'msg' + (msgState ? ` ${msgState.kind}` : '');
    m.textContent = msgState ? (msgState.key ? t(msgState.key) : msgState.text) : '';
  }

  function setMsg(kind: 'ok' | 'err' | 'info', text: string, key?: string): void {
    msgState = { kind, text, key };
    renderMsg();
  }

  function handle(text: string): void {
    if (!text.trim()) {
      setMsg('err', '', 'common.loadEmpty');
      return;
    }
    let res: string | null;
    try {
      res = onText(text);
    } catch (e) {
      res = e instanceof Error ? e.message : String(e);
    }
    if (res) setMsg('err', res);
    else setMsg('ok', '', 'common.loadOk');
  }

  function readFile(f: File): void {
    setMsg('info', '', 'common.reading');
    f.text().then(handle, () => setMsg('err', '', 'common.readFail'));
  }

  const onPaste = (ev: ClipboardEvent) => {
    if (!(ev.target instanceof Element) || !ev.target.closest('.paste')) return;
    ev.preventDefault();
    handle(ev.clipboardData?.getData('text/plain') || ev.clipboardData?.getData('text') || '');
  };
  const onChange = (ev: Event) => {
    const inp = ev.target as HTMLInputElement;
    if (inp.type !== 'file') return;
    const f = inp.files?.[0];
    if (f) readFile(f);
    inp.value = '';
  };
  const onDragOver = (ev: DragEvent) => {
    if (!(ev.target instanceof Element) || !ev.target.closest('.paste')) return;
    ev.preventDefault();
    ev.target.closest('.paste')!.classList.add('drag');
  };
  const onDragLeave = (ev: DragEvent) => {
    if (ev.target instanceof Element) ev.target.closest('.paste')?.classList.remove('drag');
  };
  const onDrop = (ev: DragEvent) => {
    if (!(ev.target instanceof Element) || !ev.target.closest('.paste')) return;
    ev.preventDefault();
    ev.target.closest('.paste')!.classList.remove('drag');
    const f = ev.dataTransfer?.files?.[0];
    if (f) readFile(f);
    else {
      const txt = ev.dataTransfer?.getData('text/plain');
      if (txt) handle(txt);
    }
  };

  el.addEventListener('paste', onPaste);
  el.addEventListener('change', onChange);
  el.addEventListener('dragover', onDragOver);
  el.addEventListener('dragleave', onDragLeave);
  el.addEventListener('drop', onDrop);

  build();
  const unLang = onLangChange(() => {
    const wasOpen = el.open;
    build();
    el.open = wasOpen;
  });

  return {
    el,
    open() {
      el.open = true;
    },
    destroy() {
      unLang();
      el.removeEventListener('paste', onPaste);
      el.removeEventListener('change', onChange);
      el.removeEventListener('dragover', onDragOver);
      el.removeEventListener('dragleave', onDragLeave);
      el.removeEventListener('drop', onDrop);
      el.remove();
    },
  };
}
