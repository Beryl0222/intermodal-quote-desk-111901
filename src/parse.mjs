// 邮件正文 → 结构化事实。中英文混排、无固定主题、无完整表格均可处理；
// 每条事实都带回原文片段（span），核价时可逐句回查。

const ORDINAL_ZH = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
const ORDINAL_EN = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6,
};

// 路段限定词：同一对站点有多条路段时，靠正文里的限定词区分
const QUALIFIERS = [
  { key: 'east', pattern: /东线|east/i },
  { key: 'rail', pattern: /铁路|rail/i },
  { key: 'road', pattern: /公路|卡车|货车|\broad\b|\btruck\b/i },
];

export function buildLexicon(data) {
  const sites = new Set();
  for (const s of data.network ?? []) { sites.add(s.from); sites.add(s.to); }
  for (const r of data.requests ?? []) { sites.add(r.from); sites.add(r.to); }
  for (const t of data.transfers ?? []) sites.add(t.site);
  return {
    sites: [...sites],
    allotments: (data.allotments ?? []).map(a => a.id),
  };
}

const clean = (s) => s.trim();

export function parseMail(mail, lexicon) {
  const body = mail.body;
  const facts = [];
  const push = (type, data, span) => facts.push({ type, span: clean(span), ...data });

  // 价格：CNY 4200 / RMB 3000 / ¥3000 / 3000 元
  for (const m of body.matchAll(/(?:CNY|RMB|¥)\s*([\d,]+)|([\d,]+)\s*(?:元|块)/gi))
    push('price', { amount: Number((m[1] ?? m[2]).replaceAll(',', '')), currency: 'CNY' }, m[0]);

  // 站点提及（按出现位置排序），用于识别「X到Y / X至Y」直达段
  const mentions = [];
  for (const site of lexicon.sites) {
    let at = body.indexOf(site);
    while (at !== -1) { mentions.push({ site, at }); at = body.indexOf(site, at + site.length); }
  }
  mentions.sort((a, b) => a.at - b.at);
  for (let i = 0; i + 1 < mentions.length; i++) {
    const [cur, nxt] = [mentions[i], mentions[i + 1]];
    const between = body.slice(cur.at + cur.site.length, nxt.at).trim();
    if (cur.site !== nxt.site && /^(?:到|至|→|->)$/.test(between))
      push('leg', { from: cur.site, to: nxt.site }, body.slice(cur.at, nxt.at + nxt.site.length));
  }

  // 英文经由：to X via Y（Y 为途经点，X 为目的站；起点从线程前文继承）
  for (const m of body.matchAll(/to\s+([^\s,.;:，。；]+)\s+via\s+([^\s,.;:，。；]+)/gi)) {
    const to = lexicon.sites.find(s => s === m[1]);
    const via = lexicon.sites.find(s => s === m[2]);
    if (to && via) push('viaRoute', { to, via }, m[0]);
  }

  // 包舱回执编号：资料内编号唯一；同一编号被重复提及/转寄只算一次回执
  const seen = new Set();
  for (const id of lexicon.allotments) {
    if (body.includes(id) && !seen.has(id)) { seen.add(id); push('allotment', { id }, id); }
  }
  for (const m of body.matchAll(/\b([A-Z]\d{1,4})\b/g)) {
    if (!seen.has(m[1])) { seen.add(m[1]); push('allotment', { id: m[1] }, m[0]); }
  }

  // 选项引用：Option two（自称=新方案）/ 方案二 / 第二种 / 前信方案二 / 前封第二种（指代前文）
  for (const m of body.matchAll(/[Oo]ption\s+([A-Za-z]+|\d+)/g)) {
    const index = ORDINAL_EN[m[1].toLowerCase()] ?? Number(m[1]);
    if (index) push('optionRef', { index, reference: false }, m[0]);
  }
  for (const m of body.matchAll(/(前[信封])?方案([一二两三四五六\d])|第([一二两三四五六\d])种/g)) {
    const index = ORDINAL_ZH[m[2] ?? m[3]] ?? Number(m[2] ?? m[3]);
    if (index) push('optionRef', { index, reference: Boolean(m[1]) || m[0].startsWith('第') }, m[0]);
  }

  // 拆卖与下单方式
  const noSplit = body.match(/no split|不可拆|不拆卖|不得拆|整程不拆/i);
  if (noSplit) push('noSplit', {}, noSplit[0]);
  const separate = body.match(/分开下单|分开订|单独下单|booked separately|separate booking/i);
  if (separate) push('separateBooking', {}, separate[0]);

  // 费用口径：不含装卸费 / 含XX费；只字未提费项的报价在组合阶段补缺口提示
  for (const m of body.matchAll(/不含([一-龥]{1,6}?费)/g)) push('feeExclusion', { item: m[1] }, m[0]);
  for (const m of body.matchAll(/(?<!不)含([一-龥]{1,6}?费)/g)) push('feeInclusion', { item: m[1] }, m[0]);

  // 温控承诺与限制
  for (const m of body.matchAll(/cold cover only until\s+([^\s,.;:，。；]+)/gi)) {
    const site = lexicon.sites.find(s => s === m[1]);
    if (site) push('coldCoverUntil', { site }, m[0]);
  }
  for (const m of body.matchAll(/冷[^。；;.]{0,6}?只到([一-龥]{2,4})/g)) {
    const site = lexicon.sites.find(s => s === m[1] || m[1].startsWith(s));
    if (site) push('coldCoverUntil', { site }, m[0]);
  }
  const fullCold = body.match(/全程冷[^。；;.,]*/);
  if (fullCold) push('fullColdChain', {}, fullCold[0]);
  const throughReefer = body.match(/through reefer/i);
  if (throughReefer) push('coldClaim', { note: 'through reefer' }, throughReefer[0]);

  // 待办与班次
  for (const m of body.matchAll(/[^。；;.\n]*另询[^。；;.\n]*/g)) push('openItem', { text: clean(m[0]) }, m[0]);
  for (const m of body.matchAll(/周[一二三四五六日]/g)) push('schedule', { text: m[0] }, m[0]);
  for (const m of body.matchAll(/no change to\s+[^\s,.;:，。；]+(?:\s+\w+)?/gi)) push('carryOver', { text: clean(m[0]) }, m[0]);

  // 路段限定词（东线车 / 铁路 / 公路…）
  for (const q of QUALIFIERS) {
    const m = body.match(q.pattern);
    if (m) push('qualifier', { key: q.key }, m[0]);
  }

  return facts;
}
