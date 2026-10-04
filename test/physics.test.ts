import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceleration,
  energy,
  energyDeviation,
  normalizeAngle,
  validateConfig,
  verletStep,
  MAX_DIMENSIONLESS_DT,
  type PendulumParams,
  type StepState,
} from '../src/physics.js';

const params: PendulumParams = { L: 1, m: 1, g: 9.81 };

test('手算单步：严格按半步顺序', () => {
  const dt = 0.01;
  const theta = 0.1;
  const omega = 0;
  const aOld = acceleration(theta, params);
  const omegaHalf = omega + (aOld * dt) / 2;
  const thetaNew = theta + omegaHalf * dt;
  const aNew = acceleration(thetaNew, params);
  const omegaNew = omegaHalf + (aNew * dt) / 2;

  const got = verletStep({ theta, omega, n: 0 }, params, dt);
  assert.ok(Math.abs(got.theta - thetaNew) < 1e-15);
  assert.ok(Math.abs(got.omega - omegaNew) < 1e-15);
  assert.equal(got.n, 1);

  // 与显式欧拉不同（欧拉末加速度取旧角），确保不是欧拉换名。
  const eulerOmega = omega + aOld * dt;
  const eulerTheta = theta + omega * dt;
  assert.ok(Math.abs(got.omega - eulerOmega) > 1e-8);
  assert.ok(Math.abs(got.theta - eulerTheta) > 1e-8);
});

test('静止在最低点保持不动', () => {
  let s: StepState = { theta: 0, omega: 0, n: 0 };
  for (let i = 0; i < 1000; i++) s = verletStep(s, params, 0.01);
  assert.ok(Math.abs(s.theta) < 1e-15);
  assert.ok(Math.abs(s.omega) < 1e-15);
  assert.equal(s.n, 1000);
});

test('小角度往复：越过平衡位置且回到同侧（周期量级）', () => {
  const dt = 0.001;
  const T = 2 * Math.PI * Math.sqrt(params.L / params.g);
  let s: StepState = { theta: 0.05, omega: 0, n: 0 };
  let crossed = false;
  const steps = Math.round(T / dt);
  let prev = s.theta;
  for (let i = 0; i < steps; i++) {
    s = verletStep(s, params, dt);
    if (prev > 0 && s.theta < 0) crossed = true;
    prev = s.theta;
  }
  assert.ok(crossed, '小角度应往复越过最低点');
  // 一个线性近似周期后回到初始角度附近（有限精度参考，非大幅摆动真值）。
  assert.ok(Math.abs(s.theta - 0.05) < 2e-3, `theta=${s.theta}`);
});

test('初速足够大时连续转过完整圆周（角度不折回且持续增长）', () => {
  // 越过最高点所需 omega > sqrt(4g/L)（U(pi)=2mgL）。
  const dt = 0.001;
  let s: StepState = { theta: 0, omega: 1.1 * Math.sqrt(4 * params.g / params.L), n: 0 };
  const maxTurns = 3;
  let direction = 0;
  let prev = s.theta;
  while (s.n < 20000 && s.theta < maxTurns * 2 * Math.PI) {
    s = verletStep(s, params, dt);
    if (s.theta > prev) direction++;
    prev = s.theta;
  }
  assert.ok(s.theta >= maxTurns * 2 * Math.PI, `theta=${s.theta}`);
  assert.equal(direction, s.n, '旋转状态角度应单调增加（连续不折回）');
  assert.ok(Math.abs(normalizeAngle(s.theta)) <= Math.PI);
});

test('质量改变不影响运动，但能量按质量成比例', () => {
  const p2: PendulumParams = { L: 1, m: 3, g: 9.81 };
  let a: StepState = { theta: 0.2, omega: 0.5, n: 0 };
  let b: StepState = { theta: 0.2, omega: 0.5, n: 0 };
  for (let i = 0; i < 500; i++) {
    a = verletStep(a, params, 0.01);
    b = verletStep(b, p2, 0.01);
  }
  assert.ok(Math.abs(a.theta - b.theta) < 1e-14);
  assert.ok(Math.abs(a.omega - b.omega) < 1e-14);
  const ea = energy(a.theta, a.omega, params);
  const eb = energy(b.theta, b.omega, p2);
  assert.ok(Math.abs(eb.total / ea.total - 3) < 1e-12);
});

test('能量误差：步长减半，最大相对偏差约按二阶缩小', () => {
  function maxDeviation(dt: number): number {
    let s: StepState = { theta: 0.4, omega: 0.3, n: 0 };
    const e0 = energy(s.theta, s.omega, params).total;
    let worst = 0;
    const steps = Math.round(2 / dt);
    for (let i = 0; i < steps; i++) {
      s = verletStep(s, params, dt);
      worst = Math.max(worst, Math.abs(energyDeviation(energy(s.theta, s.omega, params).total, e0).value));
    }
    return worst;
  }
  const coarse = maxDeviation(0.01);
  const fine = maxDeviation(0.005);
  // 速度 Verlet 能量误差为 O(dt^2)：比值应接近 4，给宽松区间。
  const ratio = coarse / fine;
  assert.ok(ratio > 2.5 && ratio < 6, `ratio=${ratio}`);
});

test('时间反演：末态反转角速度后继续相同步数回到初态', () => {
  const dt = 0.005;
  const steps = 1234;
  let s: StepState = { theta: 0.3, omega: 0.8, n: 0 };
  const initial = { ...s };
  for (let i = 0; i < steps; i++) s = verletStep(s, params, dt);
  s.omega = -s.omega;
  for (let i = 0; i < steps; i++) s = verletStep(s, params, dt);
  assert.ok(Math.abs(s.theta - initial.theta) < 1e-11, `dtheta=${Math.abs(s.theta - initial.theta)}`);
  assert.ok(Math.abs(s.omega + initial.omega) < 1e-11);
});

test('初始总能量为零时改报绝对偏差', () => {
  const dev = energyDeviation(1e-16, 0);
  assert.equal(dev.type, 'absolute');
  assert.ok(Math.abs(dev.value - 1e-16) < 1e-30);
  assert.equal(energyDeviation(10.5, 10).type, 'relative');
});

test('参数校验：有限数、正数与无量纲步长上限', () => {
  const valid = { L: 1, m: 1, g: 9.81, theta0: 0, omega0: 0, dt: 0.01, totalSteps: 10 };
  assert.doesNotThrow(() => validateConfig(valid));
  assert.throws(() => validateConfig({ ...valid, L: 0 }), /L/);
  assert.throws(() => validateConfig({ ...valid, m: -1 }), /m/);
  assert.throws(() => validateConfig({ ...valid, g: NaN }), /g/);
  assert.throws(() => validateConfig({ ...valid, omega0: Infinity }), /omega0/);
  assert.throws(() => validateConfig({ ...valid, totalSteps: 1.5 }), /totalSteps/);
  const tooCoarse = { ...valid, dt: 1 };
  assert.throws(
    () => validateConfig(tooCoarse),
    new RegExp(String(MAX_DIMENSIONLESS_DT)),
  );
});

test('规定时间由步数乘步长得到，不做浮点累加', () => {
  // n*dt 形式由存储层保证；此处验证连续角度不会被折回污染轨迹。
  let s: StepState = { theta: 3 * Math.PI - 0.01, omega: 0, n: 0 };
  const after = verletStep(s, params, 0.001);
  assert.ok(Math.abs(after.theta) > Math.PI, '角度保持连续，不折回');
});
