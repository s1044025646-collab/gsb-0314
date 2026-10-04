// 无阻尼单摆物理核心：加速度、能量与速度 Verlet 单步推进。
// 角度约定：以竖直向下为零，逆时针为正，单位弧度；角度保持连续不折回。

export const INTEGRATOR_VERSION = 'velocity-verlet-1';

// 无量纲步长 omega0*dt = sqrt(g/L)*dt 的合理上限。
// 速度 Verlet 在该量级以内对单摆问题稳定且精度可用；超过则拒绝。
export const MAX_DIMENSIONLESS_DT = 0.25;
export const MAX_OMEGA = 1e6; // rad/s
export const MAX_TOTAL_STEPS = 10_000_000;
export const MAX_THETA0 = 1e6; // rad

export interface PendulumParams {
  L: number; // 摆长（米）
  m: number; // 摆球质量（千克）
  g: number; // 重力加速度（米/秒^2）
}

export interface StepState {
  theta: number; // 连续角度（不折回）
  omega: number; // 角速度
  n: number; // 已完成步数
}

export interface Energy {
  kinetic: number;
  potential: number;
  total: number;
}

export class ValidationError extends Error {
  code = 'INVALID_PARAMETER';
  constructor(
    message: string,
    public field: string,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function validateConfig(input: {
  L?: unknown;
  m?: unknown;
  g?: unknown;
  theta0?: unknown;
  omega0?: unknown;
  dt?: unknown;
  totalSteps?: unknown;
  sampleInterval?: unknown;
  maxSteps?: unknown;
}): {
  L: number;
  m: number;
  g: number;
  theta0: number;
  omega0: number;
  dt: number;
  totalSteps: number;
  sampleInterval: number;
  maxSteps: number;
} {
  const requirePositive = (key: 'L' | 'm' | 'g' | 'dt'): number => {
    const v = input[key];
    if (!isFiniteNumber(v)) {
      throw new ValidationError(`${key} 必须为有限数`, key);
    }
    if (v <= 0) {
      throw new ValidationError(`${key} 必须为正数`, key);
    }
    return v;
  };

  const L = requirePositive('L');
  const m = requirePositive('m');
  const g = requirePositive('g');
  const dt = requirePositive('dt');

  const theta0 = input.theta0;
  if (!isFiniteNumber(theta0)) {
    throw new ValidationError('theta0 必须为有限数', 'theta0');
  }
  if (Math.abs(theta0) > MAX_THETA0) {
    throw new ValidationError(`|theta0| 不能超过 ${MAX_THETA0}`, 'theta0');
  }

  const omega0 = input.omega0;
  if (!isFiniteNumber(omega0)) {
    throw new ValidationError('omega0 必须为有限数', 'omega0');
  }
  if (Math.abs(omega0) > MAX_OMEGA) {
    throw new ValidationError(`|omega0| 不能超过 ${MAX_OMEGA} rad/s`, 'omega0');
  }

  const totalSteps = input.totalSteps;
  if (!isFiniteNumber(totalSteps) || !Number.isInteger(totalSteps)) {
    throw new ValidationError('totalSteps 必须为非负整数', 'totalSteps');
  }
  if (totalSteps < 0 || totalSteps > MAX_TOTAL_STEPS) {
    throw new ValidationError(`totalSteps 范围为 0..${MAX_TOTAL_STEPS}`, 'totalSteps');
  }

  const sampleInterval = input.sampleInterval ?? 1;
  if (!isFiniteNumber(sampleInterval) || !Number.isInteger(sampleInterval) || sampleInterval < 1) {
    throw new ValidationError('sampleInterval 必须为 >=1 的整数', 'sampleInterval');
  }

  const maxSteps = input.maxSteps ?? 100_000;
  if (!isFiniteNumber(maxSteps) || !Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new ValidationError('maxSteps 必须为 >=1 的整数', 'maxSteps');
  }
  if (maxSteps > MAX_TOTAL_STEPS) {
    throw new ValidationError(`maxSteps 不能超过 ${MAX_TOTAL_STEPS}`, 'maxSteps');
  }

  // 无量纲步长限制：sqrt(g/L)*dt 过大时显式拒绝，防止过粗积分步。
  const dimensionless = Math.sqrt(g / L) * dt;
  if (dimensionless > MAX_DIMENSIONLESS_DT) {
    throw new ValidationError(
      `无量纲步长 sqrt(g/L)*dt=${dimensionless.toPrecision(4)} 超过上限 ${MAX_DIMENSIONLESS_DT}，请减小 dt 或检查 L/g`,
      'dt',
    );
  }

  return { L, m, g, theta0, omega0, dt, totalSteps, sampleInterval, maxSteps };
}

// 角加速度 alpha = -(g/L) sin(theta)
export function acceleration(theta: number, { g, L }: PendulumParams): number {
  return -(g / L) * Math.sin(theta);
}

export function energy(theta: number, omega: number, { L, m, g }: PendulumParams): Energy {
  const kinetic = 0.5 * m * L * L * omega * omega;
  const potential = m * g * L * (1 - Math.cos(theta));
  return { kinetic, potential, total: kinetic + potential };
}

// 速度 Verlet 单步：
// 1) 用当前角加速度把角速度推进半步 omega_half = omega + a(theta)*dt/2
// 2) 用半步角速度更新角度 theta_new = theta + omega_half*dt
// 3) 用新角度的加速度完成后半步 omega_new = omega_half + a(theta_new)*dt/2
// 末次加速度必须取自新角度，不能沿用旧角度。
export function verletStep(
  state: StepState,
  params: PendulumParams,
  dt: number,
): StepState {
  const aOld = acceleration(state.theta, params);
  const omegaHalf = state.omega + aOld * (dt / 2);
  const thetaNew = state.theta + omegaHalf * dt;
  const aNew = acceleration(thetaNew, params);
  const omegaNew = omegaHalf + aNew * (dt / 2);
  return { theta: thetaNew, omega: omegaNew, n: state.n + 1 };
}

// 将连续角度归一化到 [-pi, pi)，仅用于显示，不参与积分轨迹。
export function normalizeAngle(theta: number): number {
  const wrapped = ((theta + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  return wrapped - Math.PI;
}

// 相对初始总能量的偏差；初始总能量为零时改报绝对偏差。
export function energyDeviation(totalNow: number, totalInitial: number): {
  type: 'relative' | 'absolute';
  value: number;
} {
  const absolute = totalNow - totalInitial;
  // 初始总能量接近零（静止在最低点）时相对值无意义，改报绝对偏差。
  if (Math.abs(totalInitial) < 1e-12) {
    return { type: 'absolute', value: absolute };
  }
  return { type: 'relative', value: absolute / totalInitial };
}
