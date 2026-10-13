import { registerDict } from '../../../i18n/index.ts';

const tr = {
  title: 'Flip bulucu',
  intro: 'Buy order ile alıp sell offer ile sattığında kâr bırakan bazaar ürünleri.',
  search: 'Ara',
  searchPh: 'diamond, cookie…',
  minVol: 'Min. haftalık hacim',
  minVolHelp: 'Haftada el değiştiren adet (alım ve satımdan küçüğü).',
  minMargin: 'Min. marj (%)',
  minPph: 'Min. kâr / saat',
  count: '{n} ürün',
  loadingNames: 'Ürün adları yükleniyor…',
  empty: 'Filtreye uyan ürün yok. Min. hacmi, min. marjı veya min. kâr/saati düşür.',
  emptyHidden: 'Filtreye uyan temiz ürün yok; {n} şüpheli ürün gizli.',

  col_item: 'Ürün',
  col_spark: '24 sa',
  col_buyAt: 'Alış',
  col_sellAt: 'Satış',
  col_profit: 'Kâr / adet',
  col_margin: 'Marj',
  col_change: '24 sa değişim',
  col_vol: 'Haftalık hacim',
  col_comp: 'Rekabet',
  col_uph: 'Adet / saat',
  col_capital: 'Bağlanan sermaye',
  col_fill: 'Dolum süresi',
  col_pph: 'Kâr / saat',
  col_risk: 'Risk',

  tip_item: 'Ürün adı ve bazaar ID’si. Satıra tıklayınca ürün sayfası açılır.',
  tip_spark: 'Son 24 saatteki en düşük sell offer (alış) fiyatı. Yeşil: yükseliyor, kırmızı: düşüyor.',
  tip_buyAt: 'Ürünü alacağın birim fiyat. Buy order modunda en yüksek buy order + 0,1 (en az NPC satış fiyatının 0,9 katı); insta modunda sell offer’lardan ortalama.',
  tip_sellAt: 'Ürünü satacağın birim fiyat (vergiden önce). Sell offer modunda en düşük sell offer − 0,1; insta modunda buy order’lardan ortalama.',
  tip_profit: 'Vergi düşüldükten sonra satış − alış, adet başına.',
  tip_margin: 'Adet başı kârın alış fiyatına oranı.',
  tip_change: 'Orta fiyatın (alış+satış)/2 yaklaşık 24 saat öncesine göre değişimi. Geçmiş toplandıkça dolar.',
  tip_vol: 'Haftalık işlem adedi: insta-buy ve insta-sell hacminden küçük olanı.',
  tip_comp: 'En iyi fiyatın yakınındaki rakip emir sayısı: buy order tarafı / sell offer tarafı. Rakip çoksa senin dolum payın küçülür.',
  tip_uph: 'Saatte dolmasını beklediğin adet: pazar dolum hacminden senin payın (rekabetten sonra) ile sermayenin bir döngüde alabildiği miktarın küçüğü.',
  tip_capital: 'Bir döngüde bu ürüne bağlanan coin (adet × alış fiyatı).',
  tip_fill: 'Bir döngülük partinin alınıp satılması için gereken tahmini süre.',
  tip_pph: 'Adet / saat × adet başı kâr. Varsayılan sıralama.',
  tip_risk: 'Manipülasyon ve ölü pazar kontrolleri. Üzerine gelince nedenleri görünür.',

  noteHow:
    '<strong>Nasıl okunur:</strong> Fiyatlar order book’un tepesinden gelir (en yüksek buy order + 0,1 ile alırsın, en düşük sell offer − 0,1 ile satarsın); quick_status ortalamaları kullanılmaz. Vergi sadece bazaar satışlarından düşülür. Buy order’ların en az NPC satış fiyatının 0,9 katına dolduğu varsayılır; ham maddelerdeki 0,1’lik “ölü” teklifler gerçekte dolmaz.',
  notePph:
    '<strong>Kâr / saat bir tahmindir:</strong> pazarın dolum hacminden rekabet sonrası senin payın ile sermayenin döngü başına alabildiği miktarın küçüğü × adet başı kâr. Şüpheli satırlar (ölü teklif, aşırı makas, geniş makas + düşük hacim, fiyat sıçraması) “Şüphelileri gizle” açıkken gizlenir; “N gizli” düğmesiyle bu sekmede gösterebilirsin.',
  noteSettings:
    'Vergi, sermaye, hacim payı, döngü süresi ve alış/satış modu yukarıdaki <strong>Genel ayarlar</strong> panelinden değişir.',
};

const en: Record<keyof typeof tr, string> = {
  title: 'Flip finder',
  intro: 'Bazaar products that leave a profit when you buy with a buy order and sell with a sell offer.',
  search: 'Search',
  searchPh: 'diamond, cookie…',
  minVol: 'Min. weekly volume',
  minVolHelp: 'Units traded per week (the smaller of buys and sells).',
  minMargin: 'Min. margin (%)',
  minPph: 'Min. profit / hour',
  count: '{n} items',
  loadingNames: 'Loading item names…',
  empty: 'No items match the filters. Lower the min. volume, min. margin or min. profit/hour.',
  emptyHidden: 'No clean items match the filters; {n} suspect items are hidden.',

  col_item: 'Item',
  col_spark: '24h',
  col_buyAt: 'Buy at',
  col_sellAt: 'Sell at',
  col_profit: 'Profit / unit',
  col_margin: 'Margin',
  col_change: '24h change',
  col_vol: 'Weekly volume',
  col_comp: 'Competition',
  col_uph: 'Units / hour',
  col_capital: 'Capital used',
  col_fill: 'Fill time',
  col_pph: 'Profit / hour',
  col_risk: 'Risk',

  tip_item: 'Item name and bazaar ID. Click the row to open the item page.',
  tip_spark: 'Lowest sell offer (buy price) over the last 24 hours. Green: rising, red: falling.',
  tip_buyAt: 'Unit price you buy at. In buy-order mode: best buy order + 0.1 (at least 0.9 × NPC sell price); in insta mode: average over sell offers.',
  tip_sellAt: 'Unit price you sell at (before tax). In sell-offer mode: best sell offer − 0.1; in insta mode: average over buy orders.',
  tip_profit: 'Sell price after tax minus buy price, per unit.',
  tip_margin: 'Profit per unit relative to the buy price.',
  tip_change: 'Change of the mid price (bid+ask)/2 versus about 24 hours ago. Fills in as history is collected.',
  tip_vol: 'Weekly traded units: the smaller of insta-buy and insta-sell volume.',
  tip_comp: 'Competing orders near the best price: buy-order side / sell-offer side. More competition means a smaller share of fills for you.',
  tip_uph: 'Units you can expect to fill per hour: the smaller of your share of market fill volume (after competition) and what your capital buys per cycle.',
  tip_capital: 'Coins tied up in this item per cycle (units × buy price).',
  tip_fill: 'Estimated time to buy and sell one cycle’s batch.',
  tip_pph: 'Units / hour × profit per unit. Default sort.',
  tip_risk: 'Manipulation and dead-market checks. Hover to see the reasons.',

  noteHow:
    '<strong>How to read:</strong> prices come from the top of the order book (you buy at best buy order + 0.1 and sell at best sell offer − 0.1); quick_status averages are never used. Tax is taken only from bazaar sales. Buy orders are assumed to cost at least 0.9 × the NPC sell price; 0.1 “dead” bids on raw materials don’t really fill.',
  notePph:
    '<strong>Profit / hour is an estimate:</strong> the smaller of your share of the market fill volume after competition and what your capital buys per cycle, × profit per unit. Suspect rows (dead bid, extreme spread, wide spread + low volume, price spike) are hidden while “Hide suspicious” is on; use the “N hidden” button to show them in this tab.',
  noteSettings:
    'Tax, capital, volume share, cycle length and buy/sell mode are set in the <strong>Global settings</strong> panel above.',
};

registerDict('flip', { tr, en });
