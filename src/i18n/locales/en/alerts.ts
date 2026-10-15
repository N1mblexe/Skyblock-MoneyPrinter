// 'alerts' namespace: alert notification / toast texts. Owner: history package.
export const alerts = {
  title: 'Alert: {name}',
  fired: '{name}: {metric} {value} ({op} {threshold})',
  m_ask: 'ask',
  m_bid: 'bid',
  m_spreadPct: 'spread',
  m_flipMargin: 'flip margin',
  m_flipProfit: 'flip profit',
  op_lt: '<',
  op_gt: '>',
  // a rule as a short phrase: "ask < 1,200"
  rule: '{metric} {op} {value}',
  // market alerts (any opportunity above a threshold)
  oppTitle: 'Market alert',
  oppFired_one: '{n} new opportunity above {value} {metric}: {names}',
  oppFired_other: '{n} new opportunities above {value} {metric}: {names}',
  oppMore: 'and {n} more',
  om_profitPerHour: 'profit/hour',
  om_profit: 'profit per item',
  om_margin: 'margin',
};
