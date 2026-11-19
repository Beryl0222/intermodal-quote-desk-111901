import test from 'node:test';
import assert from 'node:assert/strict';
import { readInputs } from '../scripts/inspect.mjs';
import { buildWorkbench, snapshotPlan, renderWorkbench } from '../src/workbench.mjs';
import { Ledger } from '../src/ledger.mjs';

const data = await readInputs();

test('工作台：每条询价给出真正可选择的方案与不可售原因', () => {
  const wb = buildWorkbench(data);
  const [q1, q2, q3] = wb.requests;
  assert.deepEqual(q1.plans.map(p => p.status), ['需询位', '不可售']);
  assert.deepEqual(q2.plans.map(p => p.status), ['可锁位']);
  assert.deepEqual(q3.plans.map(p => p.status), ['需询位', '不可售']);
  // 原文承诺进入报价判断
  const text = renderWorkbench(wb);
  assert.ok(text.includes('Option two: through reefer'));
  assert.ok(text.includes('不含装卸费'));
  assert.ok(text.includes('费用口径缺口'));
});

test('锁位后其他询价的同包舱方案显示余量不足', () => {
  const ledger = new Ledger(data.allotments);
  const wb1 = buildWorkbench(data, ledger);
  const q2plan = wb1.requests[1].plans[0];
  ledger.lock({ requestId: 'Q2', planKey: q2plan.key, needs: { W3: 1 } });
  const wb2 = buildWorkbench(data, ledger);
  const q1a = wb2.requests[0].plans[0];
  assert.ok(q1a.inquiry.some(g => g.includes('W3 余 0')));
  assert.ok(renderWorkbench(wb2).includes('W3（中桥联运）余 0/1'));
});

test('改信到达后，客户所看版本被检出过时并给出差异', () => {
  // 改信 E3 到达前：方案二温控未收窄，对宽松客户（上限 150 分钟）可锁位
  const preData = { ...data, mail: data.mail.slice(0, 2) };
  const laxReq = { id: 'Q9', from: '西场', to: '河苑', heightCm: 250, maxUnconditionedMinutes: 150, units: 1 };
  const pre = buildWorkbench({ ...preData, requests: [laxReq] });
  const plan = pre.requests[0].plans.find(p => p.key.startsWith('E2@'));
  assert.equal(plan.status, '可锁位');
  pre.ledger.present('Q9', plan.key, snapshotPlan(plan));

  // E3/E4 到达后：同一回执线程推进，旧版本过时
  const post = buildWorkbench({ ...data, requests: [laxReq] }, pre.ledger);
  const presented = post.requests[0].presented;
  assert.ok(presented.stale);
  assert.ok(presented.diffs.some(d => d.includes('冷车只到东库')));
});

test('锁定方案被改信击穿时，工作台给出可换方案与待协调项', () => {
  const laxReq = { id: 'Q9', from: '西场', to: '河苑', heightCm: 250, maxUnconditionedMinutes: 35, units: 1 };
  const pre = buildWorkbench({ ...data, mail: data.mail.slice(0, 2), requests: [laxReq] });
  const plan = pre.requests[0].plans.find(p => p.key.startsWith('E2@'));
  assert.equal(plan.status, '可锁位'); // 改信前仅换装 30 分钟无温控
  pre.ledger.lock({ requestId: 'Q9', planKey: plan.key, needs: { W3: 1 } });
  pre.ledger.present('Q9', plan.key, snapshotPlan(plan));

  const post = buildWorkbench({ ...data, requests: [laxReq] }, pre.ledger);
  const view = post.requests[0];
  const broken = view.plans.find(p => p.key === plan.key);
  assert.equal(broken.status, '不可售'); // E3 后 120 分钟无温控
  const alt = view.plans.find(p => p.key.startsWith('E1+'));
  assert.ok(alt && alt.status !== '不可售'); // 可换方案仍在
  assert.ok(view.presented.stale);
});
