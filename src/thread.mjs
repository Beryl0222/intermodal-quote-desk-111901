// 回复链解析：把邮件事实归并成「有效报盘」。
// 规则：方案按线程登记编号；改信（无新价格、带约束）修订所指方案；
// 重复转寄只算原来那次回执；指代不明的改信不擅自套用，只标记可能涉及的范围。

import { parseMail } from './parse.mjs';

const CONSTRAINT_TYPES = new Set([
  'coldCoverUntil', 'fullColdChain', 'noSplit', 'separateBooking',
  'feeExclusion', 'feeInclusion', 'allotment', 'carryOver',
]);

export function resolveThreads(mail, data, lexicon) {
  const byId = new Map(mail.map(m => [m.id, m]));
  const rootOf = (m) => {
    let cur = m;
    while (cur.replyTo && byId.has(cur.replyTo)) cur = byId.get(cur.replyTo);
    return cur.id;
  };
  const threads = new Map();
  for (const m of mail) {
    const root = rootOf(m);
    if (!threads.has(root)) threads.set(root, []);
    threads.get(root).push(m);
  }

  const offers = [];
  const issues = [];
  for (const [root, msgs] of threads) resolveOneThread(root, msgs, data, lexicon, offers, issues);
  return { offers, issues };
}

function resolveOneThread(root, msgs, data, lexicon, offers, issues) {
  const registry = new Map(); // 方案编号 → 报盘
  let threadOrigin = null;

  const nextIndex = () => Math.max(0, ...registry.keys()) + 1;

  for (const msg of msgs) {
    const facts = parseMail(msg, lexicon);
    const price = facts.find(f => f.type === 'price');
    const refs = facts.filter(f => f.type === 'optionRef');
    const labelRef = refs.find(r => !r.reference);
    const constraints = facts.filter(f => CONSTRAINT_TYPES.has(f.type));

    if (price) {
      // 新方案：自称编号优先，否则顺次登记
      const index = labelRef ? labelRef.index : nextIndex();
      if (labelRef && registry.has(index))
        issues.push({ mail: msg.id, level: 'note', text: `方案${index} 已登记，本信价格另立方案` });
      const offer = buildOffer(msg, facts, registry.has(index) ? nextIndex() : index, {
        root, data, threadOrigin, issues,
      });
      // 重复转寄：同一线程内路段与价格完全相同的报盘不重复登记
      const dup = [...registry.values()].find(o => o.signature === offer.signature);
      if (dup) {
        dup.provenance.push({ mail: msg.id, note: '重复转寄/重述，同一回执，不另计容量' });
        continue;
      }
      registry.set(offer.optionIndex, offer);
      offers.push(offer);
      threadOrigin ??= offer.legs[0]?.from ?? null;
      continue;
    }

    if (constraints.length === 0) continue; // 无实质内容的往来

    if (refs.length > 0) {
      // 改信：修订所指方案
      const target = registry.get(refs[0].index);
      if (!target) {
        issues.push({ mail: msg.id, level: 'ambiguity', text: `改信指向方案${refs[0].index}，但线程内未登记该方案` });
        markAmbiguous([...registry.values()], msg, `改信 ${msg.id} 指代不明，可能涉及本方案`);
        continue;
      }
      applyAmendment(target, msg, facts);
      continue;
    }

    // 无指代改信：不擅自套用，按涉及站点标记可能受影响的方案
    const sites = new Set(facts.filter(f => f.type === 'coldCoverUntil').map(f => f.site));
    const touched = [...registry.values()].filter(o =>
      o.legs.some(l => sites.has(l.from) || sites.has(l.to)));
    const affected = touched.length > 0 ? touched : [...registry.values()];
    if (affected.length === 0) {
      issues.push({ mail: msg.id, level: 'note', text: '改信到达时线程内尚无已登记方案，未套用' });
      continue;
    }
    markAmbiguous(affected, msg, `改信 ${msg.id} 未指明方案，可能涉及本方案`);
    issues.push({ mail: msg.id, level: 'ambiguity', text: `改信未指明方案，已标记 ${affected.map(o => o.id).join('、')} 待人工确认` });
  }

  // 解析「与前信方案N分开下单」的指向
  for (const offer of registry.values()) {
    offer.separateFrom = offer.separateFromIndices
      .map(i => registry.get(i)?.id)
      .filter(Boolean);
    delete offer.separateFromIndices;
  }
}

function markAmbiguous(affected, msg, note) {
  for (const offer of affected)
    offer.ambiguity = { mail: msg.id, note };
}

function buildOffer(msg, facts, optionIndex, ctx) {
  const { root, data, threadOrigin, issues } = ctx;
  const qualifiers = facts.filter(f => f.type === 'qualifier').map(f => f.key);
  const legs = [];
  for (const f of facts.filter(f => f.type === 'leg'))
    legs.push(resolveLeg(f.from, f.to, qualifiers, data.network, msg.id, issues));
  for (const f of facts.filter(f => f.type === 'viaRoute')) {
    if (!threadOrigin) {
      issues.push({ mail: msg.id, level: 'ambiguity', text: `经由 ${f.via} 的运程缺少前文起点` });
    } else {
      legs.push(resolveLeg(threadOrigin, f.via, qualifiers, data.network, msg.id, issues));
      legs.push(resolveLeg(f.via, f.to, qualifiers, data.network, msg.id, issues));
    }
  }

  const price = facts.find(f => f.type === 'price');
  const noSplit = facts.some(f => f.type === 'noSplit');
  const separateBooking = facts.some(f => f.type === 'separateBooking');
  const separateFromIndices = facts
    .filter(f => f.type === 'optionRef' && f.reference)
    .map(f => f.index);
  const feeExclusions = facts.filter(f => f.type === 'feeExclusion').map(f => f.item);
  const feeInclusions = facts.filter(f => f.type === 'feeInclusion').map(f => f.item);
  const coldCoverFact = facts.find(f => f.type === 'coldCoverUntil');

  const conditions = [];
  for (const f of facts.filter(f => f.type === 'schedule')) conditions.push({ text: `${f.text}班次`, mail: msg.id });
  if (noSplit) conditions.push({ text: '整程合价不可拆卖', mail: msg.id });
  if (separateBooking) conditions.push({ text: `与前信方案分开下单`, mail: msg.id });
  if (coldCoverFact) conditions.push({ text: `冷车只到${coldCoverFact.site}`, mail: msg.id });
  if (facts.some(f => f.type === 'fullColdChain')) conditions.push({ text: '全程冷接驳', mail: msg.id });
  for (const f of facts.filter(f => f.type === 'carryOver')) conditions.push({ text: f.text, mail: msg.id });

  const multiLegOnePrice = legs.length > 1;
  const separable = !noSplit && !multiLegOnePrice;
  const notes = [];
  if (multiLegOnePrice && !noSplit)
    notes.push('区间合价未说明可否拆卖，按不可拆处理');

  return {
    id: msg.id,
    thread: root,
    optionIndex,
    legs,
    price: { amount: price.amount, currency: price.currency, basisUnits: 1, scope: multiLegOnePrice ? '区间合价' : '单段' },
    allotments: [...new Set(facts.filter(f => f.type === 'allotment').map(f => f.id))],
    separable,
    separateFromIndices,
    coldCoverUntil: coldCoverFact?.site ?? null,
    fullColdChain: facts.some(f => f.type === 'fullColdChain'),
    coldClaims: facts.filter(f => f.type === 'coldClaim').map(f => f.note),
    feeExclusions,
    feeInclusions,
    feeScopeStated: feeExclusions.length > 0 || feeInclusions.length > 0,
    openItems: facts.filter(f => f.type === 'openItem').map(f => ({ text: f.text, mail: msg.id })),
    conditions,
    notes,
    amendments: [],
    ambiguity: null,
    provenance: [{ mail: msg.id, body: msg.body }],
    signature: JSON.stringify([legs.map(l => l.segment?.id ?? `${l.from}>${l.to}`), price.amount]),
  };
}

function applyAmendment(target, msg, facts) {
  const changes = [];
  const cold = facts.find(f => f.type === 'coldCoverUntil');
  if (cold) { target.coldCoverUntil = cold.site; changes.push(`冷车只到${cold.site}`); }
  if (facts.some(f => f.type === 'fullColdChain')) { target.fullColdChain = true; changes.push('全程冷接驳'); }
  for (const f of facts.filter(f => f.type === 'feeExclusion')) {
    if (!target.feeExclusions.includes(f.item)) target.feeExclusions.push(f.item);
    changes.push(`不含${f.item}`);
  }
  for (const f of facts.filter(f => f.type === 'allotment')) {
    if (!target.allotments.includes(f.id)) target.allotments.push(f.id);
  }
  if (target.feeExclusions.length > 0 || target.feeInclusions.length > 0) target.feeScopeStated = true;
  for (const f of facts.filter(f => f.type === 'carryOver'))
    target.conditions.push({ text: f.text, mail: msg.id });
  if (cold) target.conditions.push({ text: `冷车只到${cold.site}`, mail: msg.id });

  target.amendments.push({ mail: msg.id, changes, body: msg.body });
  target.provenance.push({ mail: msg.id, body: msg.body });
  // 改信可能推翻此前的温控承诺（如 through reefer 被收窄），保留原文供核对
}

function resolveLeg(from, to, qualifierKeys, network, mailId, issues) {
  const cands = network.filter(s => s.from === from && s.to === to);
  if (cands.length === 0) {
    issues.push({ mail: mailId, level: 'error', text: `路段 ${from}→${to} 不在网络资料中` });
    return { from, to, segment: null };
  }
  if (cands.length === 1) return { from, to, segment: cands[0] };
  for (const key of qualifierKeys) {
    const hit = cands.find(s => s.id.includes(key));
    if (hit) return { from, to, segment: hit };
  }
  issues.push({
    mail: mailId, level: 'note',
    text: `${from}→${to} 有 ${cands.map(s => s.id).join('/')} 两条路段，邮件未指明，暂按 ${cands[0].id} 计`,
  });
  return { from, to, segment: cands[0], defaulted: true };
}
