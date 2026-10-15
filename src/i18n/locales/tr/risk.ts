import type { Messages } from '../en/index.ts';

// 'risk' namespace: risk levels, flag explanations and price-source badges (src/ui/cells.ts).
export const risk: Messages['risk'] = {
  ok: 'Temiz',
  caution: 'Dikkat',
  suspect: 'Şüpheli',
  DEAD_BID: 'Ölü alış: en iyi buy order satış fiyatının yanında önemsiz (ör. 0,1).',
  WIDE_SPREAD: 'Geniş makas: alış ile satış arası %60’tan fazla.',
  EXTREME_SPREAD: 'Aşırı makas (%200+): bir taraf neredeyse kesin bayat ya da manipüle.',
  LOW_VOLUME: 'Düşük hacim: haftalık işlem çok az, emirler dolmayabilir.',
  FEW_ORDERS: 'Az emir: bir tarafta 5’ten az emir var.',
  THIN_TOP: 'İnce tepe: en iyi fiyatta çok az ürün var, bir sonraki seviye çok farklı.',
  QUICK_DIVERGENCE: 'Ortalama fiyat (quick_status) en iyi fiyattan çok farklı.',
  VOLUME_IMBALANCE: 'Dengesiz hacim: alım ve satım hacmi 10 kattan fazla farklı.',
  PRICE_SPIKE: 'Fiyat sıçraması: son 24 saatin medyanından çok saptı.',
  AH_THIN: 'Müzayedede çok az ilan var: en düşük BIN fiyatı güvenilir olmayabilir.',
  NO_HISTORY: 'Henüz yeterli fiyat geçmişi yok (sıçrama kontrolü yapılamadı).',
  srcOrder: 'Buy order',
  srcInsta: 'Insta',
  srcNpc: 'NPC',
  srcCraft: 'Craft',
};
