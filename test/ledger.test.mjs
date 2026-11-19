import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.mjs';

const allotments = [
  { id: 'W3', units: 1, supplier: '中桥联运' },
  { id: 'W9', units: 2, supplier: '测试联运' },
];

test('锁位只按回执实际数量承诺，超量拒绝', () => {
  const ledger = new Ledger(allotments);
  ledger.lock({ requestId: 'Q1', planKey: 'p1', needs: { W3: 1 } });
  assert.equal(ledger.available('W3'), 0);
  assert.throws(() => ledger.lock({ requestId: 'Q2', planKey: 'p2', needs: { W3: 1 } }), /余量不足/);
});

test('无回执的包舱不能锁位', () => {
  const ledger = new Ledger(allotments);
  assert.throws(() => ledger.lock({ requestId: 'Q1', planKey: 'p1', needs: { W404: 1 } }), /无回执/);
});

test('撤销只释放本锁额度，已给另一客户的额度不会增加', () => {
  const ledger = new Ledger(allotments);
  const la = ledger.lock({ requestId: 'QA', planKey: 'p1', needs: { W9: 1 } });
  ledger.lock({ requestId: 'QB', planKey: 'p2', needs: { W9: 1 } });
  assert.equal(ledger.available('W9'), 0);
  ledger.revoke(la);
  assert.equal(ledger.available('W9'), 1); // 只回到 1
  const qbLocks = ledger.locksFor('QB');
  assert.equal(qbLocks.length, 1);
  assert.equal(qbLocks[0].allotments.W9, 1); // QB 仍只有自己那 1 单位
});

test('台账可序列化，恢复后容量一致', () => {
  const ledger = new Ledger(allotments);
  ledger.lock({ requestId: 'Q1', planKey: 'p1', needs: { W3: 1 } });
  ledger.present('Q1', 'p1', { planKey: 'p1', totalKnown: 3000, offers: [] });
  const restored = Ledger.fromJSON(JSON.parse(JSON.stringify(ledger.toJSON())), allotments);
  assert.equal(restored.available('W3'), 0);
  assert.equal(restored.presentedOf('Q1').snapshot.totalKnown, 3000);
});
