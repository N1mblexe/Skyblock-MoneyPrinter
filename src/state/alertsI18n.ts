// 'alerts' namespace: alert notification / toast texts. Owner: history package.
import { registerDict } from '../i18n/index.ts';

const tr = {
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

const en: Record<keyof typeof tr, string> = {
  title: 'Alert: {name}',
  fired: '{name}: {metric} {value} ({op} {threshold})',
  m_ask: 'ask',
  m_bid: 'bid',
  m_spreadPct: 'spread',
  m_flipMargin: 'flip margin',
  m_flipProfit: 'flip profit',
  op_lt: '<',
  op_gt: '>',
};

registerDict('alerts', { tr, en });
