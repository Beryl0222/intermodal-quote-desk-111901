import test from 'node:test';
import assert from 'node:assert/strict';
import { readInputs } from '../scripts/inspect.mjs';
import { buildLexicon } from '../src/parse.mjs';
import { resolveThreads } from '../src/thread.mjs';

const data = await readInputs();
const lexicon = buildLexicon(data);

test('方案登记：E1/E2/E4 依次为方案一/二/三，E3 修订方案二', () => {
  const { offers } = resolveThreads(data.mail, data, lexicon);
  assert.equal(offers.length, 3);
  const [opt1, opt2, opt3] = offers;
  assert.equal(opt1.id, 'E1');
  assert.deepEqual(opt1.legs.map(l => l.segment.id), ['rail']);
  assert.equal(opt1.price.amount, 3000);
  assert.deepEqual(opt1.allotments, ['W3']);

  assert.equal(opt2.id, 'E2');
  assert.deepEqual(opt2.legs.map(l => l.segment.id), ['rail', 'road']);
  assert.equal(opt2.separable, false); // no split
  assert.equal(opt2.coldCoverUntil, '东库'); // E3 修订生效
  assert.deepEqual(opt2.amendments.map(a => a.mail), ['E3']);

  assert.equal(opt3.id, 'E4');
  assert.deepEqual(opt3.legs.map(l => l.segment.id), ['road-east']); // 东线车限定词
  assert.deepEqual(opt3.separateFrom, ['E2']); // 和前信方案二分开下单
  assert.deepEqual(opt3.feeExclusions, ['装卸费']);
  assert.equal(opt3.feeScopeStated, true);
});

test('费项口径：E1/E2 只字未提费项，标记缺口', () => {
  const { offers } = resolveThreads(data.mail, data, lexicon);
  assert.equal(offers.find(o => o.id === 'E1').feeScopeStated, false);
  assert.equal(offers.find(o => o.id === 'E2').feeScopeStated, false);
});

test('重复转寄只算原来那次回执，不另立方案', () => {
  const forward = { id: 'E5', replyTo: 'E1', body: data.mail[0].body };
  const { offers } = resolveThreads([...data.mail, forward], data, lexicon);
  assert.equal(offers.length, 3);
  const opt1 = offers.find(o => o.id === 'E1');
  assert.ok(opt1.provenance.some(p => p.mail === 'E5' && p.note.includes('重复转寄')));
});

test('指代不明的改信：不擅自套用，只标记可能涉及的方案', () => {
  const vague = { id: 'E6', replyTo: 'E4', body: '冷车只到东库' };
  const { offers, issues } = resolveThreads([...data.mail, vague], data, lexicon);
  // 本线程方案都触及东库，全部被标记；温控承诺保持原样（未擅自套用）
  assert.ok(offers.every(o => o.ambiguity?.mail === 'E6'));
  assert.equal(offers.find(o => o.id === 'E4').coldCoverUntil, null);
  assert.ok(issues.some(i => i.level === 'ambiguity' && i.mail === 'E6'));
});

test('完全不共享条件与能力的其他线程报价不受歧义改信影响', () => {
  const vague = { id: 'E6', replyTo: 'E4', body: '冷车只到东库' };
  const other = { id: 'F1', body: '西场到东库铁路 3200 元，用 W7。' };
  const { offers } = resolveThreads([...data.mail, vague, other], data, lexicon);
  assert.equal(offers.find(o => o.id === 'F1').ambiguity, null);
});

test('用户例句「是前封第二种，但冷车只到东库」能修订方案二', () => {
  const mail = [
    data.mail[0],
    data.mail[1],
    { id: 'E3b', replyTo: 'E2', body: '是前封第二种，但冷车只到东库' },
  ];
  const { offers } = resolveThreads(mail, data, lexicon);
  assert.equal(offers.find(o => o.id === 'E2').coldCoverUntil, '东库');
});
