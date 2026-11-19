import test from 'node:test';
import assert from 'node:assert/strict';
import { readInputs } from '../scripts/inspect.mjs';
import { buildLexicon, parseMail } from '../src/parse.mjs';

const data = await readInputs();
const lexicon = buildLexicon(data);
const byId = Object.fromEntries(data.mail.map(m => [m.id, m]));

test('价格：中文「元」与英文 CNY 都能识别', () => {
  const e1 = parseMail(byId.E1, lexicon);
  assert.deepEqual(e1.find(f => f.type === 'price'), { type: 'price', amount: 3000, currency: 'CNY', span: '3000 元' });
  const e2 = parseMail(byId.E2, lexicon);
  assert.equal(e2.find(f => f.type === 'price').amount, 4200);
});

test('路段：中文直达与英文 via 经由', () => {
  const e1 = parseMail(byId.E1, lexicon);
  assert.deepEqual(e1.filter(f => f.type === 'leg').map(l => [l.from, l.to]), [['西场', '东库']]);
  const e2 = parseMail(byId.E2, lexicon);
  const via = e2.find(f => f.type === 'viaRoute');
  assert.deepEqual([via.via, via.to], ['东库', '河苑']);
});

test('约束：no split、分开下单、不含装卸费、全程冷接驳、另询、班次', () => {
  assert.ok(parseMail(byId.E2, lexicon).some(f => f.type === 'noSplit'));
  const e4 = parseMail(byId.E4, lexicon);
  assert.ok(e4.some(f => f.type === 'separateBooking'));
  assert.deepEqual(e4.filter(f => f.type === 'feeExclusion').map(f => f.item), ['装卸费']);
  assert.ok(e4.some(f => f.type === 'fullColdChain'));
  assert.ok(parseMail(byId.E1, lexicon).some(f => f.type === 'openItem'));
  assert.ok(parseMail(byId.E1, lexicon).some(f => f.type === 'schedule'));
});

test('改信语义：cold cover only until / 冷车只到', () => {
  const e3 = parseMail(byId.E3, lexicon);
  assert.equal(e3.find(f => f.type === 'coldCoverUntil').site, '东库');
  // 用户给出的典型改信句式
  const zh = parseMail({ id: 'X', body: '是前封第二种，但冷车只到东库' }, lexicon);
  assert.equal(zh.find(f => f.type === 'coldCoverUntil').site, '东库');
  assert.deepEqual(zh.find(f => f.type === 'optionRef'), { type: 'optionRef', index: 2, reference: true, span: '第二种' });
});

test('选项引用：自称（Option two）与指代前文（前信方案二）区分开', () => {
  const e2 = parseMail(byId.E2, lexicon);
  assert.deepEqual(e2.find(f => f.type === 'optionRef'), { type: 'optionRef', index: 2, reference: false, span: 'Option two' });
  const e4 = parseMail(byId.E4, lexicon);
  const ref = e4.find(f => f.type === 'optionRef');
  assert.equal(ref.index, 2);
  assert.equal(ref.reference, true);
});

test('回执编号：资料内编号与形似编号都能抓到，且不重复', () => {
  const e3 = parseMail(byId.E3, lexicon);
  assert.deepEqual(e3.filter(f => f.type === 'allotment').map(f => f.id), ['W3']);
});
