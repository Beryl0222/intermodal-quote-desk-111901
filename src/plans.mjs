// 方案组合与校验：路径枚举 → 报盘精确覆盖 → 限界/温控/拆卖/相容/费项/货量/容量。
// 不相容的链路即使每段各自有效，也判不可售；合价未说明可否拆卖时按不可拆处理。

export function enumeratePaths(from, to, network) {
  const paths = [];
  const walk = (node, acc, seen) => {
    if (node === to) { paths.push(acc); return; }
    for (const seg of network.filter(s => s.from === node && !seen.has(s.id))) {
      walk(seg.to, [...acc, seg], new Set([...seen, seg.id]));
    }
  };
  walk(from, [], new Set());
  return paths;
}

// 用报盘的连续路段精确拼出路径（不多不少）；同一报盘只用一次
export function* coverages(path, offers) {
  if (path.length === 0) { yield []; return; }
  for (const offer of offers) {
    if (offer.legs.length === 0 || offer.legs.length > path.length) continue;
    const segs = offer.legs.map(l => l.segment?.id);
    const head = path.slice(0, segs.length).map(s => s.id);
    if (segs.some((s, i) => s !== head[i])) continue;
    for (const rest of coverages(path.slice(segs.length), offers)) {
      if (rest.includes(offer)) continue;
      yield [offer, ...rest];
    }
  }
}

function legCovered(offer, legIndexInOffer) {
  if (!offer.coldCoverUntil) return true; // 无明确限制时不计罚（规则见 README）
  const until = offer.legs.findIndex(l => l.to === offer.coldCoverUntil);
  if (until === -1) return true;
  return legIndexInOffer <= until;
}

export function evaluateCombo(request, path, combo, data, ledger) {
  const reasons = [];       // 不可售原因
  const inquiry = [];       // 需询位原因
  const coordination = [];  // 仍需人工协调的部分
  const feeGaps = [];
  const conditions = [];

  // 路段 → 报盘 映射（按覆盖顺序）
  const legInfos = [];
  for (const offer of combo)
    for (let i = 0; i < offer.legs.length; i++)
      legInfos.push({ offer, leg: offer.legs[i], legIndexInOffer: i });

  // 限界
  for (const { leg } of legInfos) {
    if (!leg.segment) { reasons.push(`路段 ${leg.from}→${leg.to} 不在网络资料中`); continue; }
    if (request.heightCm > leg.segment.maxCm)
      reasons.push(`箱高 ${request.heightCm}cm 超 ${leg.segment.id} 限界 ${leg.segment.maxCm}cm`);
  }

  // 温控：无温控换装分钟 + 明确无冷接驳路段的行驶分钟
  let uncond = 0;
  const tempParts = [];
  for (const { offer, leg, legIndexInOffer } of legInfos) {
    if (!leg.segment) continue;
    if (!legCovered(offer, legIndexInOffer)) {
      uncond += leg.segment.travelMinutes;
      tempParts.push(`${leg.from}→${leg.to} 段冷车只到${offer.coldCoverUntil}（${leg.segment.travelMinutes} 分钟）`);
    }
  }
  const transfers = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const t = data.transfers.find(x =>
      x.site === path[i].to && x.inbound === path[i].id && x.outbound === path[i + 1].id);
    if (!t) {
      reasons.push(`${path[i].to} 无 ${path[i].id}→${path[i + 1].id} 换装资料，链路不相容`);
      continue;
    }
    transfers.push(t);
    if (!t.conditioned) { uncond += t.minutes; tempParts.push(`${t.site} 换装 ${t.minutes} 分钟无温控`); }
  }
  if (uncond > request.maxUnconditionedMinutes)
    reasons.push(`无温控合计 ${uncond} 分钟 > 上限 ${request.maxUnconditionedMinutes} 分钟（${tempParts.join('；')}）`);

  // 「全程冷接驳」承诺与换装资料交叉验证
  for (const offer of combo) {
    if (!offer.fullColdChain) continue;
    const clash = transfers.find(t => !t.conditioned);
    if (clash)
      coordination.push(`${offer.id} 承诺全程冷接驳，但 ${clash.site} 换装资料为无温控 ${clash.minutes} 分钟，需人工核实`);
  }

  // 货量：报价金额只对原询价货量有效
  for (const offer of combo) {
    if (offer.price.basisUnits !== request.units)
      reasons.push(`${offer.id} 按 ${offer.price.basisUnits} 单位报出，本询价 ${request.units} 单位，金额不能沿用`);
  }

  // 相容：声明「与前信方案分开下单」的报盘不得与该方案同单
  const ids = new Set(combo.map(o => o.id));
  for (const offer of combo)
    for (const other of offer.separateFrom)
      if (ids.has(other)) reasons.push(`${offer.id} 须与 ${other} 分开下单，不能同组`);

  // 容量：同一包舱在多个报盘中出现只算一份需求
  const needs = {};
  for (const offer of combo)
    for (const id of offer.allotments)
      needs[id] = Math.max(needs[id] ?? 0, request.units);
  const capacity = Object.entries(needs).map(([id, need]) => {
    const rec = ledger.allotments.get(id);
    const available = ledger.available(id);
    const entry = { id, need, available, supplier: rec?.supplier ?? null, ok: available >= need };
    if (!rec) inquiry.push(`${id} 无回执记录`);
    else if (!entry.ok) inquiry.push(`${id} 余 ${available}，需 ${need}`);
    return entry;
  });
  const missingReceipts = combo.filter(o => o.allotments.length === 0);
  for (const o of missingReceipts)
    inquiry.push(`${o.id}（${o.legs.map(l => `${l.from}→${l.to}`).join('、')}）无包舱回执，需询位`);

  // 费用口径
  for (const offer of combo) {
    if (!offer.feeScopeStated) feeGaps.push(`${offer.id} CNY ${offer.price.amount} 未说明费项口径`);
    for (const item of offer.feeExclusions) feeGaps.push(`${offer.id} 不含${item}`);
  }
  if (feeGaps.length > 0) coordination.push(`费项口径待与供应商确认：${feeGaps.join('；')}`);
  for (const o of missingReceipts)
    coordination.push(`${o.legs.map(l => `${l.from}→${l.to}`).join('、')} 需向供应商询位后才能锁`);

  // 剩余条件（含前文待办的补足情况）
  for (const offer of combo) {
    for (const c of offer.conditions) conditions.push({ ...c, offer: offer.id });
    for (const item of offer.openItems) {
      const lastTo = offer.legs.at(-1)?.to;
      if (request.to === lastTo) {
        conditions.push({ text: `${item.text}（本询价止于${lastTo}，不涉及）`, mail: item.mail, offer: offer.id });
        continue;
      }
      const filler = combo.find(o => o !== offer && o.legs.some(l => l.from === lastTo));
      conditions.push({
        text: filler ? `${item.text} → 已由 ${filler.id} 补足` : `${item.text}（未补足）`,
        mail: item.mail, offer: offer.id,
      });
    }
    for (const n of offer.notes) conditions.push({ text: n, offer: offer.id });
  }

  const ambiguous = combo.filter(o => o.ambiguity);
  for (const o of ambiguous) coordination.push(`${o.id}：${o.ambiguity.note}`);

  let status;
  if (reasons.length > 0) status = '不可售';
  else if (ambiguous.length > 0) status = '需人工确认';
  else if (inquiry.length > 0) status = '需询位';
  else status = '可锁位';

  return {
    request, path, combo, status,
    reasons, inquiry, coordination, feeGaps, conditions,
    legs: legInfos, transfers,
    temperature: { used: uncond, limit: request.maxUnconditionedMinutes },
    capacity, missingReceipts,
    totalKnown: combo.reduce((s, o) => s + o.price.amount, 0),
    currency: 'CNY',
    key: `${combo.map(o => o.id).join('+')}@${path.map(s => s.id).join(',')}`,
  };
}

// 与本询价路径相关、但未进入任何组合的报盘：说明为何不适用
export function inapplicable(request, paths, offers, usedOfferIds) {
  const pathSegs = new Set(paths.flat().map(s => s.id));
  const list = [];
  for (const offer of offers) {
    if (usedOfferIds.has(offer.id) || offer.legs.length === 0) continue;
    const segs = offer.legs.map(l => l.segment?.id ?? `${l.from}→${l.to}`);
    if (!segs.some(s => pathSegs.has(s))) continue;
    const reason = !offer.separable
      ? `${offer.id} 为${offer.price.scope}（${segs.join('→')}），不可拆卖，不能只为部分区段下单`
      : `${offer.id} 覆盖 ${segs.join('→')}，与本询价路径不匹配`;
    list.push({ offer, reason });
  }
  return list;
}

export function evaluateRequest(request, offers, data, ledger) {
  const paths = enumeratePaths(request.from, request.to, data.network);
  const plans = [];
  for (const path of paths)
    for (const combo of coverages(path, offers))
      plans.push(evaluateCombo(request, path, combo, data, ledger));
  const used = new Set(plans.flatMap(p => p.combo.map(o => o.id)));
  return { paths, plans, inapplicable: inapplicable(request, paths, offers, used) };
}
