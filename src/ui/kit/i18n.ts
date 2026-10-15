// 'kit' namespace: strings the UI kit needs that are not in 'common'.
import { registerDict } from '../../i18n/index.ts';

const tr = {
  loadMore: '{n} tane daha göster',
  sortBy: 'Sırala',
  noResults: 'Sonuç yok',
  actions: 'İşlemler',
  showAllColumns: 'Tümünü göster',
  dismiss: 'Bildirimi kapat',
  results: '{n} sonuç',
  exported: '{file} indirildi',
};

const en: Record<keyof typeof tr, string> = {
  loadMore: 'Show {n} more',
  sortBy: 'Sort by',
  noResults: 'No results',
  actions: 'Actions',
  showAllColumns: 'Show all',
  dismiss: 'Dismiss notification',
  results: '{n} results',
  exported: 'Downloaded {file}',
};

registerDict('kit', { tr, en });
