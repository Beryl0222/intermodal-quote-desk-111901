// 报价工作台命令行：
//   node src/cli.mjs                     渲染全部询价的工作台
//   node src/cli.mjs offers              查看有效报盘与改信修订
//   node src/cli.mjs lock Q1 A           把方案 A 的确认容量锁给 Q1
//   node src/cli.mjs revoke L1           撤销锁位（只释放本锁额度）
//   node src/cli.mjs present Q1 A        记录客户所看版本，之后改信可检出过时
//   node src/cli.mjs reset               清空本地锁位/出示记录
// 选项：--data <inputs.json>  --state <state.json>

import { readFile, writeFile, rm } from 'node:fs/promises';
import { buildWorkbench, renderWorkbench, renderOffers, snapshotPlan } from './workbench.mjs';
import { Ledger } from './ledger.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : fallback;
};
const command = args.filter((a, i) =>
  !a.startsWith('--') && args[i - 1] !== '--data' && args[i - 1] !== '--state');

const dataPath = opt('--data', new URL('../data/inputs.json', import.meta.url).pathname);
const statePath = opt('--state', 'workbench-state.json');
const data = JSON.parse(await readFile(dataPath, 'utf8'));

async function loadLedger() {
  try {
    const json = JSON.parse(await readFile(statePath, 'utf8'));
    return Ledger.fromJSON(json, data.allotments);
  } catch {
    return new Ledger(data.allotments);
  }
}

async function saveLedger(ledger) {
  await writeFile(statePath, JSON.stringify(ledger.toJSON(), null, 2), 'utf8');
}

const findPlan = (wb, reqId, ref) => {
  const view = wb.requests.find(v => v.request.id === reqId);
  if (!view) throw new Error(`未知询价 ${reqId}`);
  const plan = view.plans.find(p => p.letter === ref || p.key === ref);
  if (!plan) throw new Error(`${reqId} 无方案 ${ref}`);
  return plan;
};

const [cmd, ...rest] = command;

try {
  if (cmd === 'offers') {
    const wb = buildWorkbench(data, await loadLedger());
    console.log(renderOffers(wb.offers));
  } else if (cmd === 'lock') {
    const ledger = await loadLedger();
    const wb = buildWorkbench(data, ledger);
    const plan = findPlan(wb, rest[0], rest[1]);
    if (plan.status !== '可锁位')
      throw new Error(`方案 ${plan.letter} 当前为「${plan.status}」，不能锁位：${[...plan.reasons, ...plan.inquiry].join('；')}`);
    const needs = Object.fromEntries(plan.capacity.map(c => [c.id, c.need]));
    const lockId = ledger.lock({ requestId: rest[0], planKey: plan.key, needs });
    await saveLedger(ledger);
    console.log(`已锁位 ${lockId}：${rest[0]} 方案${plan.letter}（${plan.key}）`);
  } else if (cmd === 'revoke') {
    const ledger = await loadLedger();
    if (!ledger.revoke(rest[0])) throw new Error(`无锁位 ${rest[0]}`);
    await saveLedger(ledger);
    console.log(`已撤销 ${rest[0]}（只释放本锁额度）`);
  } else if (cmd === 'present') {
    const ledger = await loadLedger();
    const wb = buildWorkbench(data, ledger);
    const plan = findPlan(wb, rest[0], rest[1]);
    if (plan.status === '不可售') throw new Error(`方案 ${plan.letter} 不可售，不能向客户出示`);
    ledger.present(rest[0], plan.key, snapshotPlan(plan));
    await saveLedger(ledger);
    console.log(`已记录 ${rest[0]} 客户所看版本：方案${plan.letter}（${plan.key}）`);
  } else if (cmd === 'reset') {
    await rm(statePath, { force: true });
    console.log('已清空锁位与出示记录');
  } else if (!cmd) {
    const wb = buildWorkbench(data, await loadLedger());
    console.log(renderWorkbench(wb));
  } else {
    console.error(`未知命令：${cmd}`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`错误：${err.message}`);
  process.exitCode = 1;
}
