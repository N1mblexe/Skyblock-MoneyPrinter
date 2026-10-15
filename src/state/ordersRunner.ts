// Watches your tracked bazaar orders (Trades page) on every new live snapshot: stores each order's status and fires
// a toast (and a browser notification when settings.notify) once when an order loses the top of the book.
import { lostTop, orderStatus } from '../domain/orders.ts';
import { t } from '../i18n/index.ts';
import type { AppState, Store, ToastKind } from '../types/contracts.ts';
import { fmtPrice } from '../ui/views/item/helpers.ts';

export interface OrdersRunnerOptions {
  store: Store<AppState>;
  toast(msg: string, kind?: ToastKind): void;
  notify(title: string, body: string): void;
}

/** Order-alert text: "Enchanted Gold: your buy order at 100 was outbid (best now 100.1)". */
export function orderAlertText(name: string, side: 'buy' | 'sell', price: number, best: number | null): { title: string; body: string } {
  const body = t(side === 'buy' ? 'trades.alertOutbid' : 'trades.alertUndercut', { name, price: fmtPrice(price), best: best == null ? '—' : fmtPrice(best) });
  return { title: t('trades.alertTitle', { name }), body };
}

/**
 * Evaluates orders once per new live snapshot (cached snapshots and the one present at start are skipped, like
 * alerts). Statuses are saved on the orders (lastStatus) so an alert fires once per lost top. Returns an unsubscribe.
 */
export function startOrderWatch(opts: OrdersRunnerOptions): () => void {
  const { store } = opts;
  let done: number | null = store.get().snapshot?.lastUpdated ?? null;
  return store.subscribe(() => {
    const s = store.get();
    const snap = s.snapshot;
    if (!snap || snap.lastUpdated === done) return;
    done = snap.lastUpdated;
    if (snap.source === 'cache' || !s.orders.length) return;
    const fired: { name: string; side: 'buy' | 'sell'; price: number; best: number | null }[] = [];
    let changed = false;
    const next = s.orders.map((o) => {
      const st = orderStatus(o, snap.products[o.id]);
      if (st.kind === o.lastStatus) return o;
      changed = true;
      if (lostTop(o.lastStatus, st.kind)) fired.push({ name: s.catalog?.name(o.id) ?? o.id, side: o.side, price: o.price, best: st.best });
      return { ...o, lastStatus: st.kind };
    });
    if (changed) store.set({ orders: next });
    for (const f of fired) {
      const m = orderAlertText(f.name, f.side, f.price, f.best);
      opts.toast(m.body, 'warn');
      if (store.get().settings.notify) opts.notify(m.title, m.body);
    }
  });
}
