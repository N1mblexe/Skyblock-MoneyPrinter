import type { Messages } from '../en/index.ts';

// 'risk' namespace: risk levels, flag explanations and price-source badges (src/ui/cells.ts).
export const risk: Messages['risk'] = {
  ok: 'Temiz',
  caution: 'Dikkat',
  suspect: 'Şüpheli',
  DEAD_BID: 'Ölü alış: en iyi buy order satış fiyatının yanında önemsiz (ör. 0,1).',
  WIDE_SPREAD: 'Geniş makas: alış ile satış arasındaki fark {wide} üzerinde.',
  EXTREME_SPREAD: 'Aşırı makas ({extreme}+): bir taraf neredeyse kesin bayat ya da manipüle.',
  LOW_VOLUME: 'Düşük hacim: haftalık işlem çok az, emirler dolmayabilir.',
  FEW_ORDERS: 'Az emir: bir tarafta {few} emirden az var.',
  THIN_TOP: 'İnce tepe: en iyi fiyatta çok az ürün var, bir sonraki seviye çok farklı.',
  QUICK_DIVERGENCE: 'Ortalama fiyat (quick_status) en iyi fiyattan çok farklı.',
  VOLUME_IMBALANCE: 'Dengesiz hacim: alım ve satım hacmi {imbalance} kattan fazla farklı.',
  PRICE_SPIKE: 'Fiyat sıçraması: son 24 saatin medyanından çok saptı.',
  AH_THIN: 'Müzayedede çok az ilan var: en düşük BIN fiyatı güvenilir olmayabilir.',
  AH_VARIANT: 'Varyantlı ürün: petler seviyeye, ekipman ve aletler yıldız, reforge ve büyüye göre değişir. En ucuz kopya ikinciyle aynı ürün olmayabilir.',
  AH_GAP: 'İkinci en düşük BIN çok yüksek: büyük ihtimalle farklı bir varyant ya da önce alınacak/çekilecek bir ilan.',
  NO_HISTORY: 'Henüz yeterli fiyat geçmişi yok (sıçrama kontrolü yapılamadı).',
  srcOrder: 'Buy order',
  srcInsta: 'Insta',
  srcNpc: 'NPC',
  srcCraft: 'Craft',
};
