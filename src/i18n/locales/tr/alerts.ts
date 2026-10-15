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
};
