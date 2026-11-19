// 工作台视图：按询价组装可对比的方案，附原文承诺、费用责任、剩余条件与已占容量。

import { buildLexicon } from './parse.mjs';
import { resolveThreads } from './thread.mjs';
import { evaluateRequest } from './plans.mjs';
import { Ledger } from './ledger.mjs';

const STATUS_RANK = { 可锁位: 0, 需询位: 1, 需人工确认: 2, 不可售: 3 };
const LETTERS = 'ABCDEFGH';

export function buildWorkbench(data, ledger) {
  const lexicon = buildLexicon(data);
  const { offers, issues } = resolveThreads(data.mail, data, lexicon);
  ledger ??= new Ledger(data.allotments);
  const requests = data.requests.map(r => requestView(r, offers, data, ledger));
  return { offers, issues, requests, ledger };
}

function requestView(request, offers, data, ledger) {
  const { plans, inapplicable } = evaluateRequest(request, offers, data, ledger);
  plans.sort((a, b) =>
    (STATUS_RANK[a.status] - STATUS_RANK[b.status]) || (a.totalKnown - b.totalKnown));
  plans.forEach((p, i) => { p.letter = LETTERS[i] ?? `#${i + 1}`; });

  const presented = ledger.presentedOf(request.id);
  let presentedStatus = null;
  if (presented) {
    const current = plans.find(p => p.key === presented.planKey);
    const diffs = diffSnapshot(presented.snapshot, current);
    presentedStatus = {
      ...presented,
      stale: diffs.length > 0 || !current || current.status === '不可售',
      diffs: current ? diffs : [`原方案 ${presented.planKey} 当前已不可售或不存在`],
    };
    if (current && current.status === '不可售' && presentedStatus.diffs.length === 0)
      presentedStatus.diffs.push('原方案当前已不可售');
  }

  return {
    request, plans, inapplicable,
    locks: ledger.locksFor(request.id),
    presented: presentedStatus,
  };
}

// 客户所看版本的快照：金额、温控承诺、费用口径、路段构成
export function snapshotPlan(plan) {
  return {
    planKey: plan.key,
    totalKnown: plan.totalKnown,
    offers: plan.combo.map(o => ({
      id: o.id,
      amount: o.price.amount,
      legs: o.legs.map(l => l.segment?.id ?? `${l.from}→${l.to}`),
      coldCoverUntil: o.coldCoverUntil ?? null,
      feeExclusions: [...o.feeExclusions],
    })),
  };
}

export function diffSnapshot(snapshot, plan) {
  if (!plan) return [`原方案 ${snapshot.planKey} 当前不存在`];
  const diffs = [];
  if (snapshot.totalKnown !== plan.totalKnown)
    diffs.push(`已知合计 CNY ${snapshot.totalKnown} → ${plan.totalKnown}`);
  const now = snapshotPlan(plan);
  for (const prev of snapshot.offers) {
    const cur = now.offers.find(o => o.id === prev.id);
    if (!cur) { diffs.push(`${prev.id} 已不参与本方案`); continue; }
    if (cur.amount !== prev.amount) diffs.push(`${prev.id} 金额 CNY ${prev.amount} → ${cur.amount}`);
    if (cur.coldCoverUntil !== prev.coldCoverUntil)
      diffs.push(`${prev.id} 温控承诺 ${prev.coldCoverUntil ? `冷车只到${prev.coldCoverUntil}` : '全程/未限制'} → ${cur.coldCoverUntil ? `冷车只到${cur.coldCoverUntil}` : '全程/未限制'}`);
    if (cur.feeExclusions.join('|') !== prev.feeExclusions.join('|'))
      diffs.push(`${prev.id} 费用口径变化：不含 ${cur.feeExclusions.join('、') || '（无）'}`);
  }
  return diffs;
}

// ---------- 文本呈现 ----------

const yn = (ok) => (ok ? '✓' : '✗');

function renderLegs(plan) {
  const parts = [];
  plan.legs.forEach(({ offer, leg }, i) => {
    const seg = leg.segment;
    const price = offer.price.scope === '单段' ? ` CNY ${offer.price.amount}` : '';
    const receipt = offer.allotments.length > 0
      ? offer.allotments.map(id => {
          const c = plan.capacity.find(x => x.id === id);
          return c ? `回执${id}·余${c.available}` : `回执${id}`;
        }).join(',')
      : '无回执';
    parts.push(`${leg.from} —${seg?.id ?? '?'}(${offer.id}${price}·${receipt})→ ${leg.to}`);
    const t = plan.transfers[i];
    if (t) parts.push(`  ⇄ ${t.site} 换装 ${t.minutes} 分钟·${t.conditioned ? '有温控' : '无温控'}`);
  });
  return parts.join('\n  ');
}

export function renderPlan(plan) {
  const lines = [];
  const scope = plan.combo.some(o => !o.separable) ? '（整程合价·不可拆卖）' : '';
  lines.push(`方案 ${plan.letter}｜${plan.status}｜已知合计 CNY ${plan.totalKnown}${scope}`);
  lines.push(`  ${renderLegs(plan)}`);
  const t = plan.temperature;
  lines.push(`  温控：无温控 ${t.used}/${t.limit} 分钟 ${yn(t.used <= t.limit)}`);
  if (plan.reasons.length > 0) lines.push(`  原因：${plan.reasons.join('；')}`);
  if (plan.inquiry.length > 0) lines.push(`  待询位：${plan.inquiry.join('；')}`);
  if (plan.feeGaps.length > 0) lines.push(`  费用口径缺口：${plan.feeGaps.join('；')}`);
  if (plan.conditions.length > 0)
    lines.push(`  剩余条件：${plan.conditions.map(c => `${c.text}（${c.mail ?? c.offer}）`).join('；')}`);
  if (plan.coordination.length > 0) lines.push(`  待协调：${plan.coordination.join('；')}`);
  lines.push(`  原文依据：`);
  for (const offer of plan.combo) {
    for (const p of offer.provenance)
      lines.push(`    ${p.mail}「${p.body}」${p.note ? `（${p.note}）` : ''}`);
  }
  return lines.join('\n');
}

export function renderRequest(view) {
  const r = view.request;
  const lines = [];
  lines.push(`══ 询价 ${r.id} ══  ${r.from} → ${r.to} · 箱高 ${r.heightCm}cm · 无温控上限 ${r.maxUnconditionedMinutes} 分钟 · ${r.units} 单位`);
  for (const plan of view.plans) lines.push(renderPlan(plan));
  for (const item of view.inapplicable) lines.push(`  （不适用）${item.reason}`);
  if (view.plans.length === 0) lines.push('  无可组合方案，需人工协调');
  if (view.locks.length > 0)
    lines.push(`  已锁位：${view.locks.map(l => `${l.id}→方案${l.planKey}（${Object.entries(l.allotments).map(([k, v]) => `${k}×${v}`).join(',')}）`).join('；')}`);
  if (view.presented) {
    const p = view.presented;
    lines.push(p.stale
      ? `  ⚠ 客户所看版本已过时（${p.planKey}）：${p.diffs.join('；')}，需重报`
      : `  客户所看版本（${p.planKey}）与当前一致 ✓`);
  }
  return lines.join('\n');
}

export function renderCapacity(ledger) {
  const lines = ['══ 包舱容量 ══'];
  for (const [id, a] of ledger.allotments) {
    const holders = [...ledger.locks.values()]
      .filter(l => l.allotments[id])
      .map(l => `${l.requestId} 占 ${l.allotments[id]}`);
    lines.push(`  ${id}（${a.supplier}）余 ${ledger.available(id)}/${a.units}${holders.length ? `：${holders.join('；')}` : ''}`);
  }
  return lines.join('\n');
}

export function renderWorkbench(wb) {
  const parts = [];
  for (const view of wb.requests) parts.push(renderRequest(view));
  parts.push(renderCapacity(wb.ledger));
  if (wb.issues.length > 0) {
    parts.push(['══ 解析提示 ══', ...wb.issues.map(i => `  [${i.level}] ${i.mail}：${i.text}`)].join('\n'));
  }
  return parts.join('\n\n');
}

export function renderOffers(offers) {
  const lines = ['══ 有效报盘（含改信修订） ══'];
  for (const o of offers) {
    const legs = o.legs.map(l => `${l.from}→${l.to}(${l.segment?.id ?? '?'})`).join(' + ');
    lines.push(`${o.id}｜方案${o.optionIndex}｜${legs}｜CNY ${o.price.amount}（${o.price.scope}）｜${o.separable ? '可拆' : '不可拆'}｜回执 ${o.allotments.join(',') || '无'}`);
    if (o.coldCoverUntil) lines.push(`  温控限制：冷车只到${o.coldCoverUntil}`);
    if (o.feeExclusions.length) lines.push(`  费用：不含${o.feeExclusions.join('、')}`);
    if (!o.feeScopeStated) lines.push(`  费用：费项口径未说明`);
    for (const a of o.amendments) lines.push(`  改信 ${a.mail}：${a.changes.join('；')}`);
    if (o.ambiguity) lines.push(`  ⚠ ${o.ambiguity.note}`);
  }
  return lines.join('\n');
}
