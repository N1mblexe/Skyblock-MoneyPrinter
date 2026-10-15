// Registers the service worker in production builds (installable app, offline start). When a new version takes over
// a page that was already controlled, a toast suggests reloading.
import { t } from '../i18n/index.ts';
import { toast } from '../ui/kit/toast.ts';

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const base = import.meta.env.BASE_URL;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) void toast(t('common.updateReady'), 'info');
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch((e) => console.warn('service worker registration failed', e));
  });
}
