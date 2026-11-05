'use strict';

/**
 * 行情标的配置。
 *   src: 'em'   东方财富  push2.eastmoney.com（secid）
 *   src: 'sina' 新浪财经  hq.sinajs.cn（nf_ 前缀 = 内盘期货主力连续）
 *   src: 'fund' 场外基金净值（蛋卷基金，代码）
 * 想加品种，往对应 groups[].items 里加一行即可，页面会自动出现。
 */
const GROUPS = [
  {
    id: 'cn',
    name: 'A股指数',
    items: [
      { short: '上证', name: '上证指数', src: 'em', secid: '1.000001' },
      { short: '深成', name: '深证成指', src: 'em', secid: '0.399001' },
      { short: '创业板', name: '创业板指', src: 'em', secid: '0.399006' },
      { short: '沪深300', name: '沪深300', src: 'em', secid: '1.000300' },
    ],
  },
  {
    id: 'etf',
    name: '板块 ETF / 基金',
    items: [
      { short: '人工智能', name: '易方达人工智能ETF联接C', src: 'fund', code: '012734', ref: { src: 'em', secid: '0.159819' } },
      { short: '芯片', name: '芯片ETF', src: 'em', secid: '0.159995' },
      { short: '证券', name: '证券ETF', src: 'em', secid: '1.512880' },
      { short: '军工', name: '军工ETF', src: 'em', secid: '1.512660' },
      { short: '医疗', name: '医疗ETF', src: 'em', secid: '1.512170' },
      { short: '新能源车', name: '新能源车ETF', src: 'em', secid: '1.515030' },
      { short: '光伏', name: '光伏ETF', src: 'em', secid: '1.515790' },
      { short: '消费', name: '消费ETF', src: 'em', secid: '0.159928' },
      { short: '稀土', name: '稀土ETF', src: 'em', secid: '1.516780' },
    ],
  },
  {
    id: 'global',
    name: '港股 / 美股',
    items: [
      { short: '恒生', name: '恒生指数', src: 'em', secid: '100.HSI' },
      { short: '纳指', name: '纳斯达克', src: 'em', secid: '100.NDX' },
      { short: '道指', name: '道琼斯', src: 'em', secid: '100.DJIA' },
      { short: '标普', name: '标普500', src: 'em', secid: '100.SPX' },
    ],
  },
  {
    id: 'metal',
    name: '贵金属',
    items: [
      { short: 'COMEX金', name: 'COMEX黄金', src: 'em', secid: '101.GC00Y' },
      { short: 'COMEX银', name: 'COMEX白银', src: 'em', secid: '101.SI00Y' },
      { short: '沪金', name: '沪金主力', src: 'sina', code: 'nf_AU0' },
      { short: '沪银', name: '沪银主力', src: 'sina', code: 'nf_AG0' },
      { short: '美元指数', name: '美元指数', src: 'em', secid: '100.UDI' },
    ],
  },
  {
    id: 'futures',
    name: '原油 / 内盘期货',
    items: [
      { short: 'WTI原油', name: 'NYMEX原油', src: 'em', secid: '102.CL00Y' },
      { short: '螺纹', name: '螺纹钢主力', src: 'sina', code: 'nf_RB0' },
      { short: '铁矿', name: '铁矿石主力', src: 'sina', code: 'nf_I0' },
      { short: '沪铜', name: '沪铜主力', src: 'sina', code: 'nf_CU0' },
      { short: '玻璃', name: '玻璃主力', src: 'sina', code: 'nf_FG0' },
      { short: '纯碱', name: '纯碱主力', src: 'sina', code: 'nf_SA0' },
      { short: '焦煤', name: '焦煤主力', src: 'sina', code: 'nf_JM0' },
    ],
  },
];

function allItems() {
  return GROUPS.flatMap((g) => g.items.map((it) => ({ ...it, group: g.id })));
}

function itemsOf(groupIds) {
  const set = new Set(groupIds);
  return allItems().filter((it) => set.has(it.group));
}

module.exports = { GROUPS, allItems, itemsOf };