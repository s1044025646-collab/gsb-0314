import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/store.js';

const dir = join(process.cwd(), 'data-test');
const dbPath = join(dir, 'test.db');
let store: Store;

before(() => {
  rmSync(dir, { recursive: true, force: true });
  store = new Store(dbPath);
});

after(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('一次推进与分段推进加重启完全一致', () => {
  const cfg = { L: 1, m: 2, g: 9.81, theta0: 0.3, omega0: 0.4, dt: 0.005, totalSteps: 300, sampleInterval: 37 };
  const oneShot = store.createRun({ ...cfg, name: 'one-shot' });
  store.advanceRun(oneShot.id, 300);
  const a = store.getRunOrThrow(oneShot.id);

  const segmented = store.createRun({ ...cfg, name: 'segmented' });
  store.advanceRun(segmented.id, 100);
  store.pauseRun(segmented.id);
  // 重新打开数据库模拟进程重启后续算。
  store.close();
  store = new Store(dbPath);
  const reopened = store.getRunOrThrow(segmented.id);
  assert.equal(reopened.status, 'paused');
  store.resumeRun(segmented.id);
  store.advanceRun(segmented.id, 120); // 预算不足 -> paused
  assert.equal(store.getRunOrThrow(segmented.id).status, 'paused');
  store.resumeRun(segmented.id);
  store.advanceRun(segmented.id, 1000); // 到目标 -> completed
  const b = store.getRunOrThrow(segmented.id);

  assert.equal(b.status, 'completed');
  assert.equal(b.n, 300);
  assert.ok(Math.abs(a.theta - b.theta) < 1e-15, `dtheta=${Math.abs(a.theta - b.theta)}`);
  assert.ok(Math.abs(a.omega - b.omega) < 1e-15);

  // 采样集合一致（含第 0 步与目标步）。
  const sa = store.listSamples(oneShot.id);
  const sb = store.listSamples(segmented.id);
  assert.deepEqual(
    sa.map((x) => x.n),
    sb.map((x) => x.n),
  );
  const lastA = sa.at(-1)!;
  const lastB = sb.at(-1)!;
  assert.ok(Math.abs(lastA.theta - lastB.theta) < 1e-15);
  assert.equal(lastA.n, 300);
});

test('时间由 n*dt 得到，采样间隔不跳过内部步', () => {
  const run = store.createRun({
    L: 2,
    m: 1,
    g: 1.62,
    theta0: 0.1,
    omega0: 0,
    dt: 0.01,
    totalSteps: 250,
    sampleInterval: 50,
  });
  store.advanceRun(run.id, 250);
  const samples = store.listSamples(run.id);
  const ns = samples.map((s) => s.n);
  assert.deepEqual(ns, [0, 50, 100, 150, 200, 250]);
  assert.ok(Math.abs(samples[2]!.t - 1.0) < 1e-15);
});

test('查询未保存步返回 SAMPLE_NOT_FOUND；完成后拒绝推进', () => {
  const run = store.createRun({
    L: 1,
    m: 1,
    g: 9.81,
    theta0: 0,
    omega0: 0,
    dt: 0.01,
    totalSteps: 10,
    sampleInterval: 5,
  });
  store.advanceRun(run.id, 10);
  assert.throws(() => store.getSample(run.id, 3), /SAMPLE_NOT_FOUND|未保存/);
  assert.throws(() => store.advanceRun(run.id, 1), /完成/);
});

test('参数非法时不落库（原子创建）', () => {
  const before = store.listRuns().length;
  assert.throws(() =>
    store.createRun({ L: -1, m: 1, g: 9.81, theta0: 0, omega0: 0, dt: 0.01, totalSteps: 5 }),
  );
  assert.equal(store.listRuns().length, before);
});
