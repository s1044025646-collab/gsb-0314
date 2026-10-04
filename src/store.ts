import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  INTEGRATOR_VERSION,
  LIMITS,
  PendulumConfig,
  PendulumState,
  StepSample,
  ValidationError,
  advanceState,
  initialState,
  initialTotalEnergy,
  makeSample,
  normalizeConfig,
} from "./physics.js";

export type RunStatus = "paused" | "completed";

export interface RunRecord {
  id: string;
  status: RunStatus;
  config: PendulumConfig;
  state: PendulumState;
  initialTotalEnergy: number;
  integratorVersion: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdvanceSummary {
  run: RunRecord;
  samples: StepSample[];
  advancedSteps: number;
  stoppedByBudget: boolean;
}

interface RunRow {
  id: string;
  status: RunStatus;
  config_json: string;
  angle: number;
  angular_velocity: number;
  completed_steps: number;
  initial_total_energy: number;
  integrator_version: string;
  created_at: string;
  updated_at: string;
}

interface SampleRow {
  step: number;
  time: number;
  angle: number;
  display_angle: number;
  angular_velocity: number;
  kinetic_energy: number;
  potential_energy: number;
  total_energy: number;
  energy_delta: number;
  energy_error: number;
  energy_error_kind: "relative" | "absolute";
}

export class NotFoundError extends Error {
  code = "NOT_FOUND";
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  code = "CONFLICT";
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class PendulumStore {
  private readonly db: DatabaseSync;
  private open = true;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK(status IN ('paused','completed')),
        config_json TEXT NOT NULL,
        angle REAL NOT NULL,
        angular_velocity REAL NOT NULL,
        completed_steps INTEGER NOT NULL,
        initial_total_energy REAL NOT NULL,
        integrator_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS samples (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        step INTEGER NOT NULL,
        time REAL NOT NULL,
        angle REAL NOT NULL,
        display_angle REAL NOT NULL,
        angular_velocity REAL NOT NULL,
        kinetic_energy REAL NOT NULL,
        potential_energy REAL NOT NULL,
        total_energy REAL NOT NULL,
        energy_delta REAL NOT NULL,
        energy_error REAL NOT NULL,
        energy_error_kind TEXT NOT NULL CHECK(energy_error_kind IN ('relative','absolute')),
        PRIMARY KEY(run_id, step)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_samples_run_step ON samples(run_id, step);
    `);
  }

  close(): void {
    if (this.open) {
      this.db.close();
      this.open = false;
    }
  }

  createRun(input: Record<string, unknown>): RunRecord {
    const config = normalizeConfig(input);
    const id = createId();
    const now = new Date().toISOString();
    const state = initialState(config);
    const startEnergy = initialTotalEnergy(config);
    const sample = makeSample(state, config, startEnergy);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO runs (
            id,status,config_json,angle,angular_velocity,completed_steps,
            initial_total_energy,integrator_version,created_at,updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          config.targetSteps === 0 ? "completed" : "paused",
          JSON.stringify(config),
          state.angle,
          state.angularVelocity,
          state.completedSteps,
          startEnergy,
          INTEGRATOR_VERSION,
          now,
          now,
        );
      this.insertSample(id, sample);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getRun(id);
  }

  advance(runId: string, requestedSteps: unknown): AdvanceSummary {
    if (
      typeof requestedSteps !== "number" ||
      !Number.isInteger(requestedSteps) ||
      requestedSteps < 1 ||
      requestedSteps > LIMITS.targetSteps.max
    ) {
      throw new ValidationError("steps", "本次推进步数必须是不小于 1 的整数");
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.getRowForUpdate(runId);
      if (row.status === "completed") {
        throw new ConflictError("运行已达到目标步数；请创建新运行或重启为新初态");
      }

      const config = parseConfig(row.config_json);
      const state: PendulumState = {
        angle: row.angle,
        angularVelocity: row.angular_velocity,
        completedSteps: row.completed_steps,
      };
      const remaining = config.targetSteps - state.completedSteps;
      const stepCount = Math.min(requestedSteps, remaining);
      const outcome = advanceState(state, config, stepCount, row.initial_total_energy, {
        sampleInterval: config.sampleInterval,
      });

      for (const sample of outcome.samples) {
        this.insertSample(runId, sample);
      }
      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE runs SET angle=?, angular_velocity=?, completed_steps=?, status=?, updated_at=? WHERE id=?`,
        )
        .run(
          outcome.state.angle,
          outcome.state.angularVelocity,
          outcome.state.completedSteps,
          outcome.reachedTarget ? "completed" : "paused",
          now,
          runId,
        );
      this.db.exec("COMMIT");
      return {
        run: this.getRun(runId),
        samples: outcome.samples,
        advancedSteps: stepCount,
        stoppedByBudget: !outcome.reachedTarget,
      };
    } catch (error) {
      if (this.db.isTransaction) {
        this.db.exec("ROLLBACK");
      }
      throw error;
    }
  }

  getRun(runId: string): RunRecord {
    return this.toRecord(this.requireRow(runId));
  }

  pause(runId: string): RunRecord {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.requireRow(runId);
      if (row.status === "completed") {
        throw new ConflictError("已完成运行不能暂停");
      }
      this.db
        .prepare(`UPDATE runs SET status='paused', updated_at=? WHERE id=? AND status='paused'`)
        .run(new Date().toISOString(), runId);
      this.db.exec("COMMIT");
      return this.getRun(runId);
    } catch (error) {
      if (this.db.isTransaction) {
        this.db.exec("ROLLBACK");
      }
      throw error;
    }
  }

  getSample(runId: string, step: unknown): StepSample {
    const stepNumber = typeof step === "number" ? step : Number(step);
    if (!Number.isInteger(stepNumber) || stepNumber < 0) {
      throw new ValidationError("step", "已保存步号必须是非负整数");
    }
    this.getRun(runId);
    const row = this.db
      .prepare(`SELECT * FROM samples WHERE run_id=? AND step=?`)
      .get(runId, stepNumber) as unknown as SampleRow | undefined;
    if (!row) {
      throw new NotFoundError(`运行 ${runId} 未保存第 ${stepNumber} 步（检查采样间隔）`);
    }
    return toSample(row);
  }

  getSamples(runId: string): StepSample[] {
    this.getRun(runId);
    const rows = this.db
      .prepare(`SELECT * FROM samples WHERE run_id=? ORDER BY step`)
      .all(runId) as unknown as SampleRow[];
    return rows.map(toSample);
  }

  getEnergySummary(runId: string): {
    initialTotalEnergy: number;
    latest: StepSample;
    maxAbsoluteError: number;
    maxRelativeOrAbsoluteError: number;
    sampleCount: number;
  } {
    const run = this.getRun(runId);
    const rows = this.db
      .prepare(
        `SELECT * FROM samples WHERE run_id=? ORDER BY energy_error DESC LIMIT 1`,
      )
      .all(runId) as unknown as SampleRow[];
    const all = this.getSamples(runId);
    const maxDelta = all.reduce((max, item) => Math.max(max, Math.abs(item.energyDelta)), 0);
    return {
      initialTotalEnergy: run.initialTotalEnergy,
      latest: all.at(-1)!,
      maxAbsoluteError: maxDelta,
      maxRelativeOrAbsoluteError: rows[0]?.energy_error ?? 0,
      sampleCount: all.length,
    };
  }

  private insertSample(runId: string, sample: StepSample): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO samples (
          run_id,step,time,angle,display_angle,angular_velocity,
          kinetic_energy,potential_energy,total_energy,energy_delta,energy_error,energy_error_kind
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        runId,
        sample.completedSteps,
        sample.time,
        sample.angle,
        sample.displayAngle,
        sample.angularVelocity,
        sample.kineticEnergy,
        sample.potentialEnergy,
        sample.totalEnergy,
        sample.energyDelta,
        sample.energyError,
        sample.energyErrorKind,
      );
  }

  private requireRow(runId: string): RunRow {
    const row = this.db.prepare(`SELECT * FROM runs WHERE id=?`).get(runId) as RunRow | undefined;
    if (!row) {
      throw new NotFoundError(`未找到运行 ${runId}`);
    }
    return row;
  }

  private getRowForUpdate(runId: string): RunRow {
    return this.requireRow(runId);
  }

  private toRecord(row: RunRow): RunRecord {
    return {
      id: row.id,
      status: row.status,
      config: parseConfig(row.config_json),
      state: {
        angle: row.angle,
        angularVelocity: row.angular_velocity,
        completedSteps: row.completed_steps,
      },
      initialTotalEnergy: row.initial_total_energy,
      integratorVersion: row.integrator_version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

function parseConfig(text: string): PendulumConfig {
  return normalizeConfig(JSON.parse(text) as Record<string, unknown>);
}

function toSample(row: SampleRow): StepSample {
  return {
    completedSteps: row.step,
    time: row.time,
    angle: row.angle,
    displayAngle: row.display_angle,
    angularVelocity: row.angular_velocity,
    kineticEnergy: row.kinetic_energy,
    potentialEnergy: row.potential_energy,
    totalEnergy: row.total_energy,
    energyDelta: row.energy_delta,
    energyError: row.energy_error,
    energyErrorKind: row.energy_error_kind,
  };
}

function createId(): string {
  return globalThis.crypto.randomUUID();
}
