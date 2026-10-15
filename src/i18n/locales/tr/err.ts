import type { Messages } from '../en/index.ts';

// 'err' namespace: errors that can reach the UI (status pill, catalog banner, manual load, toasts).
export const err: Messages['err'] = {
  timeout: 'Bazaar isteği {s} sn sonra zaman aşımına uğradı',
  http: 'HTTP {status}',
  bazaarBadJson: 'Bazaar yanıtı geçerli JSON değil: {detail}',
  bazaarNotObject: 'Bazaar yanıtı bir JSON nesnesi değil',
  apiError: 'Hypixel API hatası: {cause}',
  noSuccess: 'Bazaar yanıtında "success": true yok',
  noProducts: 'Bazaar yanıtında "products" nesnesi yok',
  noLastUpdated: 'Bazaar yanıtında sayısal "lastUpdated" yok',
  catNotObject: 'Katalog bir JSON nesnesi değil',
  catVersion: 'Desteklenmeyen katalog sürümü: {v} (1 ya da 2 bekleniyordu)',
  catNoItems: 'Katalogda "items" nesnesi yok',
  catNoRecipes: 'Katalogda "recipes" dizisi yok',
  catRequest: 'Katalog isteği başarısız ({url}): {detail}',
  catHttp: 'Katalog HTTP {status} ({url})',
  catBadJson: 'Katalog geçerli JSON değil ({url}): {detail}',
  idbUnavailable: 'IndexedDB kullanılamıyor',
  idbOpen: 'IndexedDB açılamadı: {name}',
  idbBlocked: 'IndexedDB açılışı engellendi: {name}',
  idbUpgrade: 'IndexedDB yükseltmesi başarısız',
  idbRequest: 'IndexedDB isteği başarısız',
  idbTx: 'IndexedDB işlemi başarısız',
  idbTxAbort: 'IndexedDB işlemi iptal edildi',
  bootFailed: 'Uygulama başlatılamadı: {err}',
};
