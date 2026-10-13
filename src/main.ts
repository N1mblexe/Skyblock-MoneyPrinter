import './styles/theme.css';
import './styles/base.css';
import './styles/components.css';
import { bootstrap } from './app.ts';

bootstrap(document.getElementById('app')!).catch((e) => {
  console.error(e);
  document.getElementById('app')!.textContent = String(e);
});
