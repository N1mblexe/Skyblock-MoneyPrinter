import './styles/theme.css';
import './styles/base.css';
import './styles/components.css';
import { bootstrap } from './app.ts';
import { msgOf, msgText, t } from './i18n/index.ts';
import { registerServiceWorker } from './pwa/register.ts';

bootstrap(document.getElementById('app')!).catch((e) => {
  console.error(e);
  document.getElementById('app')!.textContent = t('err.bootFailed', { err: msgText(msgOf(e)) });
});

registerServiceWorker();
