import { registerDict } from '../../../i18n/index.ts';

const tr = {
  title: 'NPC flip',
  intro: 'Bazaar ile NPC tüccarları arasındaki sabit fiyat farklarından kâr. NPC fiyatları katalogdan gelir.',
  dirAria: 'Yön',
  dir_bz2npc: 'Bazaar → NPC',
  dir_npc2bz: 'NPC → Bazaar',
  dirDesc_bz2npc:
    'Bazaar’dan al (Alırken ayarına göre buy order ya da insta-buy), NPC tüccarına sabit fiyatından sat. NPC satışında vergi yok.',
  dirDesc_npc2bz:
    'NPC dükkanından sabit fiyatından al, bazaar’da sat (Satarken ayarına göre sell offer ya da insta-sell). Vergi düşülür.',

  search: 'Ara',
  searchPh: 'Ürün adı ya da ID',
  minMargin: 'En az marj (%)',
  minPph: 'En az kâr / saat',

  hiddenShowing: '{n} şüpheli gösteriliyor · gizle',
  hiddenTitle: 'Şüpheli (ölü alış, aşırı makas, sıçrama…) satırlar Genel ayarlar’daki “Şüphelileri gizle” yüzünden gizli. Bu sekmede göstermek için tıkla.',
  rowsCount: '{n} satır',

  col_item: 'Ürün',
  col_buy: 'Alış',
  col_sell: 'Satış',
  col_profit: 'Kâr / adet',
  col_margin: 'Marj',
  col_uph: 'Adet / saat',
  col_capital: 'Bağlanan sermaye',
  col_pph: 'Kâr / saat',
  col_risk: 'Risk',
  col_buyTitle: 'Adet başına ödediğin fiyat ve kaynağı',
  col_sellTitle: 'Adet başına eline geçen (bazaar satışında vergi düşülmüş)',
  col_uphTitle: 'Hacimdeki payın, sermaye ve döngü süresiyle saatte işleyebileceğin adet',
  col_capitalTitle: 'Bir döngüde bağlanan coin (adet × alış)',
  col_pphTitle: 'Kâr/adet × adet/saat',

  srcSellOffer: 'Sell offer',
  srcInstaSell: 'Insta-sell',
  floorHint: '≥0,9×NPC',
  floorTitle: 'En iyi buy order NPC fiyatının çok altında (ör. 0,1); bu fiyattan dolmaz. Alış en az 0,9 × NPC fiyatı varsayıldı.',
  limitedBy: 'Sınırlayan: {x}',
  lim_volume: 'pazar hacmi',
  lim_capital: 'sermaye',
  lim_depth: 'emir defteri derinliği / emir limiti',
  lim_forge: 'forge slotu',

  noteTitle: 'Önemli: oyundaki NPC limitleri hesaba katılmaz.',
  noteLimits:
    'NPC dükkanlarında ürün başına günlük satın alma limiti vardır, NPC’ye satışın da oyunda kendi limitleri/davranışı vardır. Bunlar modellenmez: NPC → Bazaar yönünde saatlik adet yalnızca bazaar satış hacmi ve sermayenle sınırlanır, gerçekte daha düşük olabilir.',
  noteFloor:
    'Bazaar → NPC yönünde buy order’ların en az 0,9 × NPC satış fiyatına mal olduğu varsayılır; 0,1’lik “ölü” alış emirleri gerçekte dolmaz.',
  notePricing:
    'Fiyatlar emir defterinin tepesinden gelir (en iyi buy order + 0,1 / en ucuz sell offer − 0,1), quick_status ortalamaları kullanılmaz. Vergi sadece bazaar satışından düşülür. Kâr/saat = hacimdeki payın (rekabet sonrası) ile sermaye/döngü maliyetinin küçüğü.',

  loadingCatalog: 'NPC fiyatları (katalog) yükleniyor…',
  catalogError: 'NPC fiyatları yüklenemedi: {err}. Bu sekme katalog olmadan çalışmaz.',
  emptyNone: 'Bu yönde kârlı NPC flip yok.',
  emptyFiltered: 'Filtrelere uyan satır yok.',
  emptyHidden: 'Görünen satır yok; {n} şüpheli satır gizli.',
};

const en: Record<keyof typeof tr, string> = {
  title: 'NPC flip',
  intro: 'Profit from fixed price gaps between the bazaar and NPC merchants. NPC prices come from the catalog.',
  dirAria: 'Direction',
  dir_bz2npc: 'Bazaar → NPC',
  dir_npc2bz: 'NPC → Bazaar',
  dirDesc_bz2npc:
    'Buy on the bazaar (buy order or insta-buy, per the “When buying” setting), sell to an NPC merchant at its fixed price. No tax on NPC sales.',
  dirDesc_npc2bz:
    'Buy from an NPC shop at its fixed price, sell on the bazaar (sell offer or insta-sell, per the “When selling” setting). Tax is deducted.',

  search: 'Search',
  searchPh: 'Item name or ID',
  minMargin: 'Min margin (%)',
  minPph: 'Min profit / hour',

  hiddenShowing: 'Showing {n} suspect · hide',
  hiddenTitle: 'Suspect rows (dead bid, extreme spread, spike…) are hidden by “Hide suspicious” in Global settings. Click to show them on this tab.',
  rowsCount: '{n} rows',

  col_item: 'Item',
  col_buy: 'Buy at',
  col_sell: 'Sell at',
  col_profit: 'Profit / unit',
  col_margin: 'Margin',
  col_uph: 'Units / hour',
  col_capital: 'Capital used',
  col_pph: 'Profit / hour',
  col_risk: 'Risk',
  col_buyTitle: 'Price you pay per unit and where',
  col_sellTitle: 'What you receive per unit (after tax for bazaar sales)',
  col_uphTitle: 'Units per hour given your share of volume, capital and cycle length',
  col_capitalTitle: 'Coins tied up per cycle (units × buy price)',
  col_pphTitle: 'Profit/unit × units/hour',

  srcSellOffer: 'Sell offer',
  srcInstaSell: 'Insta-sell',
  floorHint: '≥0.9×NPC',
  floorTitle: 'The best buy order is far below the NPC price (e.g. 0.1) and would not fill there. Buying is assumed to cost at least 0.9 × the NPC price.',
  limitedBy: 'Limited by: {x}',
  lim_volume: 'market volume',
  lim_capital: 'capital',
  lim_depth: 'order book depth / order size cap',
  lim_forge: 'forge slots',

  noteTitle: 'Important: in-game NPC limits are not modeled.',
  noteLimits:
    'NPC shops have per-item daily purchase limits, and selling to NPCs has its own limits/behaviour in game. None of this is modeled: in the NPC → Bazaar direction units/hour are capped only by bazaar sell volume and your capital, so real throughput may be lower.',
  noteFloor:
    'In the Bazaar → NPC direction buy orders are assumed to cost at least 0.9 × the NPC sell price; 0.1 “dead” bids don’t really fill.',
  notePricing:
    'Prices come from the top of the order book (best buy order + 0.1 / best sell offer − 0.1), never quick_status averages. Tax applies only to bazaar sales. Profit/hour = the smaller of your share of fill volume (after competition) and capital / cost per cycle.',

  loadingCatalog: 'Loading NPC prices (catalog)…',
  catalogError: 'Could not load NPC prices: {err}. This tab needs the catalog.',
  emptyNone: 'No profitable NPC flips in this direction.',
  emptyFiltered: 'No rows match the filters.',
  emptyHidden: 'Nothing visible; {n} suspect rows are hidden.',
};

registerDict('npc', { tr, en });
