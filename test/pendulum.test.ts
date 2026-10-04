import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  INTEGRATOR_VERSION,
  acceleration,
  advanceState,
  initialState,
  initialTotalEnergy,
  normalizeConfig,
  velocityVerletStep,
} from "../src/physics.js";
import { PendulumStore } from "../src/store.js";

const tempDir = mkdtempSync(join(tmpdir(), "pendulum-test-"));
const stores: PendulumStore[] = [];

function makeStore(name: string): PendulumStore {
  const store = new PendulumStore(join(tempDir, `${name}.sqlite`));
  stores.push(store);
  return store;
}

afterEach(() => {
  stores.forEach((store) => store.close());
  stores.length = 0;
  rmSync(tempDir, { recursive: true, force: true });
  mkdirSync(tempDir, { recursive: true });
});

const base = {
  length: 1,
  mass: 2,
  gravity: 9.81,
  initialAngle: 0.3,
  initialAngularVelocity: 0,
  timeStep: 0.001,
  targetSteps: 1000,
  sampleInterval: 10,
};

test("速度 Verlet 首步严格按当前角加速度、半步速度、新角加速度顺序更新", () => {
  const config = normalizeConfig({
    ...base,
    initialAngle: 0.25,
    initialAngularVelocity: 0.4,
    timeStep: 0.01,
  });
  const state = initialState(config);
  const result = velocityVerletStep(state, config);

  const a0 = -(config.gravity / config.length) * Math.sin(config.initialAngle);
  const omegaHalf = config.initialAngularVelocity + 0.5 * a0 * config.timeStep;
  const theta1 = config.initialAngle + omegaHalf * config.timeStep;
  const a1 = -(config.gravity / config.length) * Math.sin(theta1);
  const omega1 = omegaHalf + 0.5 * a1 * config.timeStep;

  assert.equal(result.accelerationBefore, a0);
  assert.equal(result.halfStepAngularVelocity, omegaHalf);
  assert.equal(result.accelerationAfter, a1);
  assert.equal(result.state.angle, theta1);
  assert.equal(result.state.angularVelocity, omega1);
  assert.notEqual(a1, a0);
});

test("静止最低点保持不动且能量绝对偏差为零", () => {
  const config = normalizeConfig({
    ...base,
    initialAngle: 0,
    initialAngularVelocity: 0,
    targetSteps: 10,
    sampleInterval: 1,
  });
  const outcome = advanceState(initialState(config), config, 10, 0, { sampleInterval: 1 });
  assert.equal(outcome.state.angle, 0);
  assert.equal(outcome.state.angularVelocity, 0);
  assert.equal(outcome.samples.at(-1)?.energyErrorKind, "absolute");
  assert.equal(outcome.samples.at(-1)?.energyError, 0);
});

test("小幅摆动在一个线性近似周期附近回到同侧，并保持小幅能量误差", () => {
  const config = normalizeConfig({ ...base, sampleInterval: 1 });
  const period = 2 * Math.PI * Math.sqrt(config.length / config.gravity);
  const steps = Math.round(period / config.timeStep);
  const outcome = advanceState(
    initialState(config),
    { ...config, targetSteps: steps },
    steps,
    initialTotalEnergy(config),
    { sampleInterval: steps },
  );
  const final = outcome.samples.at(-1)!;
  assert.ok(Math.abs(final.angle - config.initialAngle) < 0.01);
  assert.ok(Math.abs(final.angularVelocity) < 0.05);
  assert.ok(final.energyError < 1e-4);
});

test("足够大的初速度可连续旋转，连续角度跨过 2pi，显示角度另行归一化", () => {
  const config = normalizeConfig({
    ...base,
    initialAngle: 0,
    initialAngularVelocity: 8,
    targetSteps: 1000,
    sampleInterval: 100,
  });
  const outcome = advanceState(initialState(config), config, 1000, initialTotalEnergy(config), {
    sampleInterval: 100,
  });
  const final = outcome.samples.at(-1)!;
  assert.ok(final.angle > 2 * Math.PI);
  assert.ok(Math.abs(final.displayAngle) <= Math.PI);
  assert.ok(final.energyError < 1e-4);
});

test("质量按比例改变能量但不改变角运动", () => {
  const light = normalizeConfig({ ...base, mass: 1 });
  const heavy = normalizeConfig({ ...base, mass: 3 });
  const a = advanceState(initialState(light), light, 500, initialTotalEnergy(light), {
    sampleInterval: 500,
  });
  const b = advanceState(initialState(heavy), heavy, 500, initialTotalEnergy(heavy), {
    sampleInterval: 500,
  });
  assert.equal(a.state.angle, b.state.angle);
  assert.equal(a.state.angularVelocity, b.state.angularVelocity);
  assert.equal(
    b.samples.at(-1)!.totalEnergy / a.samples.at(-1)!.totalEnergy,
    3,
  );
});

test("一次推进与分段推进、重开数据库后续算完全一致", () => {
  const oneShotStore = makeStore("one");
  const created = oneShotStore.createRun(base);
  oneShotStore.advance(created.id, 300);
  oneShotStore.close();

  const reopenedOne = new PendulumStore(join(tempDir, "one.sqlite"));
  stores.push(reopenedOne);
  const expected = reopenedOne.getRun(created.id);
  assert.equal(expected.integratorVersion, INTEGRATOR_VERSION);

  const segmentedStore = makeStore("split");
  const splitRun = segmentedStore.createRun(base);
  segmentedStore.advance(splitRun.id, 100);
  segmentedStore.close();

  const reopenedSplit = new PendulumStore(join(tempDir, "split.sqlite"));
  stores.push(reopenedSplit);
  reopenedSplit.advance(splitRun.id, 120);
  reopenedSplit.advance(splitRun.id, 80);

  const actual = reopenedSplit.getRun(splitRun.id);
  assert.deepEqual(actual.state, expected.state);
  assert.equal(actual.status, "paused");

  reopenedSplit.advance(splitRun.id, 700);
  assert.equal(reopenedSplit.getRun(splitRun.id).status, "completed");
});

test("采样间隔不跳过内部积分步，预算停止保持暂停且到达目标才完成", () => {
  const store = makeStore("samples");
  const run = store.createRun({ ...base, targetSteps: 100, sampleInterval: 7 });
  const result = store.advance(run.id, 50);
  assert.equal(result.run.status, "paused");
  assert.equal(result.run.state.completedSteps, 50);
  assert.deepEqual(
    result.samples.map((item) => item.completedSteps),
    [7, 14, 21, 28, 35, 42, 49],
  );
  store.advance(run.id, 100);
  const finalRun = store.getRun(run.id);
  assert.equal(finalRun.state.completedSteps, 100);
  assert.equal(finalRun.status, "completed");
  assert.equal(store.getSample(run.id, 100).completedSteps, 100);
});

test("时间由步数乘步长得到，末态反向角速度后可在给定容差内时间反演", () => {
  const steps = 120;
  const config = normalizeConfig({ ...base, timeStep: 0.001, targetSteps: steps });
  const forward = advanceState(initialState(config), config, steps, initialTotalEnergy(config), {
    sampleInterval: steps,
  });
  const reversedConfig = normalizeConfig({
    ...config,
    initialAngle: forward.state.angle,
    initialAngularVelocity: -forward.state.angularVelocity,
  });
  const backward = advanceState(
    initialState(reversedConfig),
    reversedConfig,
    steps,
    initialTotalEnergy(reversedConfig),
    { sampleInterval: steps },
  );
  assert.ok(Math.abs(backward.state.angle - config.initialAngle) < 1e-12);
  assert.ok(Math.abs(backward.state.angularVelocity - config.initialAngularVelocity) < 1e-12);
  assert.equal(backward.samples.at(-1)?.time, steps * config.timeStep);
});

test("较短时间内步长减半显著降低能量误差，且线性周期不被用于大幅运动真值", () => {
  const input = { ...base, initialAngle: 0.1, initialAngularVelocity: 0 };
  const duration = 1;
  const runFor = (timeStep: number) => {
    const steps = Math.round(duration / timeStep);
    const config = normalizeConfig({ ...input, timeStep, targetSteps: steps });
    return advanceState(initialState(config), config, steps, initialTotalEnergy(config), {
      sampleInterval: steps,
    });
  };
  const coarse = runFor(0.01);
  const fine = runFor(0.005);
  assert.ok(fine.samples.at(-1)!.energyError < coarse.samples.at(-1)!.energyError / 3);
  assert.ok(Math.abs(acceleration(0.5, { gravity: 9.81, length: 1 })) > 1e-9);
});

test("拒绝非有限、非正和过粗无量纲步长", () => {
  assert.throws(() => normalizeConfig({ ...base, length: 0 }), /L/);
  assert.throws(() => normalizeConfig({ ...base, mass: Infinity }), /质量/);
  assert.throws(() => normalizeConfig({ ...base, timeStep: 1 }), /无量纲/);
  assert.throws(() => normalizeConfig({ ...base, targetSteps: -1 }), /targetSteps/);
});
