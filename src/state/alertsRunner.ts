// Runs alert rules on every new snapshot; fires notifications/toasts. Owner: history package.
import type { AppState, Derived, Store, ToastKind } from '../types/contracts.ts';

export interface AlertsRunnerOptions {
  store: Store<AppState>;
  derived: Derived;
  toast(msg: string, kind?: ToastKind): void;
  /** browser notification (only called when settings.notify and permission is granted) */
  notify(title: string, body: string): void;
}

/** Wave 0 stub: returns an unsubscribe function. */
export function startAlerts(_opts: AlertsRunnerOptions): () => void {
  return () => {};
}
