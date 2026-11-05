'use strict';

const { itemsOf } = require('./symbols');

const EM_URL = 'https://push2.eastmoney.com/api/qt/ulist.np/get';
const EM_FIELDS = 'f1,f2,f3,f4,f12,f13,f14,f15,f16,f17,f18';
const SINA_URL = 'https://hq.sinajs.cn/list=';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const TIMEOUT = 9000;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function itemKey(it) {
  return it.src === 'em' ? it.secid : it.code;
}

/** 东方财富：指数 / 外盘 / 贵金属期货 */
async function fetchEastmoney(items) {
  const ids = items.map((i) => i.secid).filter(Boolean);
  if (!ids.length) return [];

  const url = `${EM_URL}?fltt=2&invt=2&fields=${EM_FIELDS}&secids=${ids.join(',')}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' }, signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`东财行情 HTTP ${res.status}`);
  const json = await res.json();
  const diff = json?.data?.diff || [];

  return diff.map((d) => {
    const price = num(d.f2);
    const prev = num(d.f18);
    const item = items.find((i) => i.secid === `${d.f13}.${d.f12}`);
    return {
      key: `${d.f13}.${d.f12}`,
      short: item?.short || d.f14,
      name: item?.name || d.f14,
      group: item?.group || '',
      price,
      prevClose: prev,
      change: num(d.f4),
      pct: num(d.f3),
      high: num(d.f15),
      low: num(d.f16),
      open: num(d.f17),
      source: 'em',
      at: Date.now(),
    };
  });
}

/**
 * 新浪内盘期货（主力连续）
 * 字段: 0名称 1时间 2开 3高 4低 5昨收 6买 7卖 8最新 9结算 10昨结算 11买量 12卖量 13持仓 14成交 15交易所 16品种 17日期
 */
async function fetchSina(items) {
  if (!items.length) return [];

  const url = SINA_URL + items.map((i) => i.code).join(',');
  const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' }, signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`新浪行情 HTTP ${res.status}`);

  const text = new TextDecoder('gbk').decode(Buffer.from(await res.arrayBuffer()));
  const out = [];
  const re = /var hq_str_(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(text))) {
    const code = m[1];
    const f = m[2].split(',');
    if (f.length < 18) continue;

    const item = items.find((i) => i.code === code);
    if (!item) continue;

    const price = num(f[8]);
    const base = num(f[10]) || num(f[5]); // 期货以昨结算为基准
    if (price === null || price === 0) continue;

    out.push({
      key: code,
      short: item.short,
      name: item.name,
      group: item.group,
      price,
      prevClose: base,
      change: base ? +(price - base).toFixed(4) : null,
      pct: base ? +(((price - base) / base) * 100).toFixed(2) : null,
      high: num(f[3]),
      low: num(f[4]),
      open: num(f[2]),
      source: 'sina',
      at: Date.now(),
    });
  }
  return out;
}

/**
 * 拉取当前启用分组下的全部行情。
 * 两个源互不影响：一个挂了另一个照常返回，并把错误带出去。
 */
async function fetchQuotes(groupIds) {
  const items = itemsOf(groupIds || []);
  const em = items.filter((i) => i.src === 'em');
  const sina = items.filter((i) => i.src === 'sina');

  const [emRes, sinaRes] = await Promise.allSettled([fetchEastmoney(em), fetchSina(sina)]);
  const quotes = [];
  const errors = [];

  if (emRes.status === 'fulfilled') quotes.push(...emRes.value);
  else errors.push(emRes.reason?.message || '东财行情失败');

  if (sinaRes.status === 'fulfilled') quotes.push(...sinaRes.value);
  else errors.push(sinaRes.reason?.message || '新浪行情失败');

  if (!quotes.length && errors.length) throw new Error(errors.join('；'));

  // 按配置顺序输出
  const order = new Map(items.map((it, idx) => [itemKey(it), idx]));
  quotes.sort((a, b) => (order.get(a.key) ?? 999) - (order.get(b.key) ?? 999));

  return { quotes, errors, at: Date.now() };
}

module.exports = { fetchQuotes };