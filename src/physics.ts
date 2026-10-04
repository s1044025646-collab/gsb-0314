export const INTEGRATOR_VERSION = "velocity-verlet-1";

export const LIMITS = {
  length: { min: 1e-9, max: 1e6 },
  mass: { min: 1e-12, max: 1e6 },
  gravity: { min: 1e-9, max: 1e5 },
  angle: { maxAbs: 1e6 },
  angularVelocity: { maxAbs: 1e4 },
  timeStep: { min: 1e-9, max: 100 },
  targetSteps: { max: 100_000_000 },
  sampleInterval: { min: 1, max: 100_000_000 },
  dimensionlessStep: { max: 0.1 },
} as const;

export interface PendulumConfig {
  length: number;
  mass: number;
  gravity: number;
  initialAngle: number;
  initialAngularVelocity: number;
  timeStep: number;
  targetSteps: number;
  sampleInterval: number;
}

export interface PendulumState {
  angle: number;
  angularVelocity: number;
  completedSteps: number;
}

export interface StepSample extends PendulumState {
  time: number;
  displayAngle: number;
  kineticEnergy: number;
  potentialEnergy: number;
  totalEnergy: number;
  energyDelta: number;
  energyError: number;
  energyErrorKind: "relative" | "absolute";
}

export interface StepResult {
  state: PendulumState;
  accelerationBefore: number;
  halfStepAngularVelocity: number;
  accelerationAfter: number;
  sample: StepSample;
}

export class ValidationError extends Error {
  code = "INVALID_PARAMETER";
  field: string;

  constructor(field: string, message: string) {
    super(message);
    this.field = field;
    this.name = "ValidationError";
  }
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function requireIntegerInRange(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  if (!isFiniteNumber(value) || !Number.isInteger(value)) {
    throw new ValidationError(field, `${field} 必须是有限整数`);
  }
  if (value < min || value > max) {
    throw new ValidationError(field, `${field} 必须位于 [${min}, ${max}]`);
  }
  return value;
}

export function normalizeConfig(input: Record<string, unknown>): PendulumConfig {
  const positive = (
    key: keyof PendulumConfig,
    label: string,
    min: number,
    max: number,
  ) => {
    const value = input[key];
    if (!isFiniteNumber(value)) {
      throw new ValidationError(key, `${label} 必须是有限数`);
    }
    if (value <= 0 || value < min || value > max) {
      throw new ValidationError(key, `${label} 必须为正数且位于 [${min}, ${max}]`);
    }
    return value;
  };

  const length = positive("length", "摆长 L", LIMITS.length.min, LIMITS.length.max);
  const mass = positive("mass", "质量 m", LIMITS.mass.min, LIMITS.mass.max);
  const gravity = positive("gravity", "重力加速度 g", LIMITS.gravity.min, LIMITS.gravity.max);
  const timeStep = positive("timeStep", "固定时间步长 dt", LIMITS.timeStep.min, LIMITS.timeStep.max);

  const initialAngle = input.initialAngle;
  if (!isFiniteNumber(initialAngle) || Math.abs(initialAngle) > LIMITS.angle.maxAbs) {
    throw new ValidationError("initialAngle", `初始角度必须是绝对值不超过 ${LIMITS.angle.maxAbs} 的有限数`);
  }

  const initialAngularVelocity = input.initialAngularVelocity;
  if (
    !isFiniteNumber(initialAngularVelocity) ||
    Math.abs(initialAngularVelocity) > LIMITS.angularVelocity.maxAbs
  ) {
    throw new ValidationError(
      "initialAngularVelocity",
      `初始角速度必须是绝对值不超过 ${LIMITS.angularVelocity.maxAbs} rad/s 的有限数`,
    );
  }

  const targetSteps = requireIntegerInRange(
    input.targetSteps,
    "targetSteps",
    0,
    LIMITS.targetSteps.max,
  );
  const providedSampleInterval = input.sampleInterval ?? 1;
  const sampleInterval = requireIntegerInRange(
    providedSampleInterval,
    "sampleInterval",
    LIMITS.sampleInterval.min,
    Math.max(LIMITS.sampleInterval.min, Math.min(targetSteps || 1, LIMITS.sampleInterval.max)),
  );

  const dimensionlessStep = Math.sqrt(gravity / length) * timeStep;
  if (dimensionlessStep > LIMITS.dimensionlessStep.max) {
    throw new ValidationError(
      "timeStep",
      `无量纲步长 sqrt(g/L)*dt=${dimensionlessStep.toExponential(3)} 超过上限 ${LIMITS.dimensionlessStep.max}；请减小 dt`,
    );
  }

  return {
    length,
    mass,
    gravity,
    initialAngle,
    initialAngularVelocity,
    timeStep,
    targetSteps,
    sampleInterval,
  };
}

export function acceleration(angle: number, config: Pick<PendulumConfig, "gravity" | "length">): number {
  return -(config.gravity / config.length) * Math.sin(angle);
}

export function kineticEnergy(mass: number, length: number, angularVelocity: number): number {
  return (mass * length * length * angularVelocity * angularVelocity) / 2;
}

export function potentialEnergy(
  mass: number,
  length: number,
  gravity: number,
  angle: number,
): number {
  return mass * gravity * length * (1 - Math.cos(angle));
}

export function normalizeAngle(angle: number): number {
  const wrapped = ((angle + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  return wrapped === -Math.PI ? Math.PI : wrapped;
}

export function makeSample(
  state: PendulumState,
  config: PendulumConfig,
  initialTotalEnergy: number,
): StepSample {
  const kinetic = kineticEnergy(config.mass, config.length, state.angularVelocity);
  const potential = potentialEnergy(config.mass, config.length, config.gravity, state.angle);
  const total = kinetic + potential;
  const energyDelta = total - initialTotalEnergy;
  const zeroInitial = Math.abs(initialTotalEnergy) < Number.EPSILON * Math.max(1, Math.abs(total));
  return {
    ...state,
    time: state.completedSteps * config.timeStep,
    displayAngle: normalizeAngle(state.angle),
    kineticEnergy: kinetic,
    potentialEnergy: potential,
    totalEnergy: total,
    energyDelta,
    energyError: zeroInitial
      ? Math.abs(energyDelta)
      : Math.abs(energyDelta) / Math.abs(initialTotalEnergy),
    energyErrorKind: zeroInitial ? "absolute" : "relative",
  };
}

export function initialState(config: PendulumConfig): PendulumState {
  return {
    angle: config.initialAngle,
    angularVelocity: config.initialAngularVelocity,
    completedSteps: 0,
  };
}

export function initialTotalEnergy(config: PendulumConfig): number {
  return (
    kineticEnergy(config.mass, config.length, config.initialAngularVelocity) +
    potentialEnergy(config.mass, config.length, config.gravity, config.initialAngle)
  );
}

export function velocityVerletStep(state: PendulumState, config: PendulumConfig): StepResult {
  const accelerationBefore = acceleration(state.angle, config);
  const halfStepAngularVelocity =
    state.angularVelocity + 0.5 * accelerationBefore * config.timeStep;
  const nextAngle = state.angle + halfStepAngularVelocity * config.timeStep;
  const accelerationAfter = acceleration(nextAngle, config);
  const nextAngularVelocity =
    halfStepAngularVelocity + 0.5 * accelerationAfter * config.timeStep;

  const nextState = {
    angle: nextAngle,
    angularVelocity: nextAngularVelocity,
    completedSteps: state.completedSteps + 1,
  };
  return {
    state: nextState,
    accelerationBefore,
    halfStepAngularVelocity,
    accelerationAfter,
    sample: makeSample(nextState, config, initialTotalEnergy(config)),
  };
}

export interface AdvanceOutcome {
  state: PendulumState;
  samples: StepSample[];
  reachedTarget: boolean;
}

export function advanceState(
  state: PendulumState,
  config: PendulumConfig,
  stepCount: number,
  startEnergy: number,
  options: { sampleInterval: number; includeFirst?: boolean } = { sampleInterval: 1 },
): AdvanceOutcome {
  if (!Number.isInteger(stepCount) || stepCount < 0) {
    throw new ValidationError("steps", "推进步数必须是非负整数");
  }
  if (
    !Number.isInteger(options.sampleInterval) ||
    options.sampleInterval < LIMITS.sampleInterval.min
  ) {
    throw new ValidationError("sampleInterval", "采样间隔必须是正整数");
  }

  const samples: StepSample[] = [];
  let current = state;
  if (options.includeFirst) {
    samples.push(makeSample(current, config, startEnergy));
  }

  for (let index = 1; index <= stepCount; index += 1) {
    const result = velocityVerletStep(current, config);
    current = result.state;
    const globalStep = current.completedSteps;
    if (globalStep % options.sampleInterval === 0 || globalStep === config.targetSteps) {
      samples.push(makeSample(current, config, startEnergy));
    }
  }

  return {
    state: current,
    samples,
    reachedTarget: current.completedSteps >= config.targetSteps,
  };
}
