import type { Messages } from '../en/index.ts';

// 'alerts' namespace: alert notification / toast texts. Owner: history package.
export const alerts: Messages['alerts'] = {
  title: 'Alarm: {name}',
  fired: '{name}: {metric} {value} ({op} {threshold})',
  m_ask: 'satış fiyatı (ask)',
  m_bid: 'alış fiyatı (bid)',
  m_spreadPct: 'makas',
  m_flipMargin: 'flip marjı',
  m_flipProfit: 'flip kârı',
  op_lt: '<',
  op_gt: '>',
  // a rule as a short phrase: "ask < 1,200"
  rule: '{metric} {op} {value}',
  // market alerts (any opportunity above a threshold)
  oppTitle: 'Piyasa alarmı',
  oppFired_one: '{value} {metric} üzerinde {n} yeni fırsat: {names}',
  oppFired_other: '{value} {metric} üzerinde {n} yeni fırsat: {names}',
  oppMore: 've {n} tane daha',
  om_profitPerHour: 'kâr/saat',
  om_profit: 'adet başına kâr',
  om_margin: 'marj',
};
