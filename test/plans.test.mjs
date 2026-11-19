import test from 'node:test';
import assert from 'node:assert/strict';
import { readInputs } from '../scripts/inspect.mjs';
import { buildLexicon } from '../src/parse.mjs';
import { resolveThreads } from '../src/thread.mjs';
import { evaluateRequest } from '../src/plans.mjs';
import { Ledger } from '../src/ledger.mjs';

const data = await readInputs();
const lexicon = buildLexicon(data);
const { offers } = resolveThreads(data.mail, data, lexicon);
const req = (id) => data.requests.find(r => r.id === id);

test('Q1：E1+E4 冷链方案可报价（东线段需询位），方案二温控不达不可售', () => {
  const { plans } = evaluateRequest(req('Q1'), offers, data, new Ledger(data.allotments));
  assert.equal(plans.length, 2);
  const [a, b] = [plans.find(p => p.key.startsWith('E1+')), plans.find(p => p.key.startsWith('E2@'))];
  assert.equal(a.status, '需询位');
  assert.equal(a.totalKnown, 4750);
  assert.equal(a.temperature.used, 0); // 东库换装 20 分钟有温控
  assert.ok(a.feeGaps.some(g => g.includes('未说明费项')) && a.feeGaps.some(g => g.includes('装卸费')));
  assert.ok(a.inquiry.some(g => g.includes('E4')));
  assert.equal(b.status, '不可售');
  assert.ok(b.reasons.some(r => r.includes('120 分钟')));
});

test('Q2：E1 可锁位；方案二整程合价不可拆卖，列为不适用', () => {
  const { plans, inapplicable } = evaluateRequest(req('Q2'), offers, data, new Ledger(data.allotments));
  assert.equal(plans.length, 1);
  assert.equal(plans[0].status, '可锁位');
  assert.equal(plans[0].totalKnown, 3000);
  assert.ok(inapplicable.some(i => i.offer.id === 'E2' && i.reason.includes('不可拆卖')));
});

test('Q3：箱高 252 走东线车（限界 260）成立；若 262 则无可售链路', () => {
  const ok = evaluateRequest(req('Q3'), offers, data, new Ledger(data.allotments));
  assert.equal(ok.plans.find(p => p.key.startsWith('E1+')).status, '需询位');
  const tall = { ...req('Q3'), id: 'QX', heightCm: 262 };
  const res = evaluateRequest(tall, offers, data, new Ledger(data.allotments));
  assert.ok(res.plans.every(p => p.status === '不可售')); // 东线超限界，公路线温控不达
});

test('货量不符时不能沿用原对象的金额', () => {
  const twoUnits = { ...req('Q2'), id: 'QY', units: 2 };
  const { plans } = evaluateRequest(twoUnits, offers, data, new Ledger(data.allotments));
  assert.ok(plans.every(p => p.status === '不可售'));
  assert.ok(plans[0].reasons.some(r => r.includes('金额不能沿用')));
});

test('容量被其他客户占住后，同包舱方案转为需询位', () => {
  const ledger = new Ledger(data.allotments);
  ledger.lock({ requestId: 'Q2', planKey: 'E1@rail', needs: { W3: 1 } });
  const { plans } = evaluateRequest(req('Q1'), offers, data, ledger);
  const a = plans.find(p => p.key.startsWith('E1+'));
  assert.equal(a.status, '需询位');
  assert.ok(a.inquiry.some(g => g.includes('W3 余 0')));
});

test('歧义改信波及的方案需人工确认，不共享条件的方案仍可售', () => {
  const vague = { id: 'E6', replyTo: 'E4', body: '冷车只到东库' };
  const other = { id: 'F1', body: '西场到东库铁路 3200 元，用 W7。' };
  const allot = [...data.allotments, { id: 'W7', units: 1, supplier: '测试联运' }];
  const data2 = { ...data, mail: [...data.mail, vague, other], allotments: allot };
  const { offers: offers2 } = resolveThreads(data2.mail, data2, buildLexicon(data2));
  const { plans } = evaluateRequest(req('Q2'), offers2, data2, new Ledger(allot));
  assert.equal(plans.find(p => p.key.startsWith('E1@')).status, '需人工确认');
  assert.equal(plans.find(p => p.key.startsWith('F1@')).status, '可锁位');
});
