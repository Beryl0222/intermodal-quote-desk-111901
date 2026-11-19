// 包舱台账：只按供应商实际给出的数量承诺。
// 同一包舱出现在多封邮件/多条路线描述里，容量只算一份；
// 锁位只消耗、撤销只释放本锁占用的额度，不会把已给别的客户的额度加回。

export class Ledger {
  #seq = 0;

  constructor(allotments = []) {
    this.allotments = new Map(allotments.map(a => [a.id, { ...a }]));
    this.locks = new Map();      // lockId → { id, requestId, planKey, allotments: {W3: 1} }
    this.presented = new Map();  // requestId → { planKey, snapshot }
  }

  available(id) {
    const a = this.allotments.get(id);
    if (!a) return 0;
    let used = 0;
    for (const lock of this.locks.values()) used += lock.allotments[id] ?? 0;
    return a.units - used;
  }

  // needs: { 包舱编号: 单位数 }。只能锁有确切回执且余量足够的容量。
  lock({ requestId, planKey, needs }) {
    for (const [id, n] of Object.entries(needs)) {
      if (!this.allotments.has(id)) throw new Error(`${id} 无回执，不能锁位`);
      if (this.available(id) < n) throw new Error(`${id} 余量不足（余 ${this.available(id)}，需 ${n}）`);
    }
    const id = `L${++this.#seq}`;
    this.locks.set(id, { id, requestId, planKey, allotments: { ...needs } });
    return id;
  }

  // 只释放本锁占用的额度；其他客户已占的额度不受影响、也不会增加
  revoke(lockId) {
    return this.locks.delete(lockId);
  }

  locksFor(requestId) {
    return [...this.locks.values()].filter(l => l.requestId === requestId);
  }

  present(requestId, planKey, snapshot) {
    this.presented.set(requestId, { planKey, snapshot });
  }

  presentedOf(requestId) {
    return this.presented.get(requestId) ?? null;
  }

  toJSON() {
    return {
      locks: [...this.locks.values()],
      presented: Object.fromEntries(this.presented),
      seq: this.#seq,
    };
  }

  static fromJSON(json, allotments) {
    const ledger = new Ledger(allotments);
    for (const lock of json.locks ?? []) {
      ledger.locks.set(lock.id, lock);
      ledger.#seq = Math.max(ledger.#seq, Number(String(lock.id).slice(1)) || 0);
    }
    ledger.presented = new Map(Object.entries(json.presented ?? {}));
    return ledger;
  }
}
