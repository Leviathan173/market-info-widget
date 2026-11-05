'use strict';

const FLASH_URL = 'https://flash-api.jin10.com/get_flash_list?channel=-8200&vip=1';
const HEADERS = {
  'x-app-id': 'bVBF4FyRTn5NJF5n',
  'x-version': '1.0.0',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Referer: 'https://www.jin10.com/',
};
const TIMEOUT = 9000;

function trim(s) {
  return typeof s === 'string' ? s.trim() : '';
}

/** 金十正文偶尔内嵌 HTML / 实体，转成纯文本 */
function stripHtml(s) {
  return trim(
    s
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&'),
  ).replace(/\s+/g, ' ');
}

/** 金十原始结构 -> 界面用的扁平结构 */
function normalize(raw) {
  const d = raw.data || {};
  let text = stripHtml(d.content);
  let title = stripHtml(d.title);

  // 正文常以【标题】开头，拆出来单独加粗展示
  const m = text.match(/^【([^】]{1,60})】([\s\S]*)$/);
  if (m) {
    if (!title) title = m[1];
    text = m[2].trim();
  }

  const remark = Array.isArray(raw.remark) && raw.remark[0] ? stripHtml(raw.remark[0].title) : '';
  const time = trim(raw.time); // 2026-11-05 09:40:50

  return {
    id: String(raw.id),
    date: time.slice(0, 10),
    time: time.slice(11, 16),
    important: raw.important === 1 || raw.important === true,
    title,
    text: text || title,
    remark,
    hasPic: Boolean(trim(d.pic)),
    source: trim(d.source),
  };
}

async function fetchFlash() {
  const res = await fetch(FLASH_URL, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`金十快讯 HTTP ${res.status}`);

  const json = await res.json();
  if (json?.status !== 200 || !Array.isArray(json.data)) {
    throw new Error(json?.message || '金十快讯返回异常');
  }

  return json.data
    .filter((it) => it && it.data && (it.data.content || it.data.title) && !it.extras?.ad)
    .map(normalize);
}

module.exports = { fetchFlash };