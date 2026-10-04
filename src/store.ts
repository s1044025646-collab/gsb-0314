import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  energy,
  energyDeviation,
  INTEGRATOR_VERSION,
  normalizeAngle,
  validateConfig,
  verletStep,
  type PendulumParams,
} from './physics.js';

export type RunStatus = 'active' | 'paused' | 'completed';

export interface RunRow {
  id: string;
  name: string;
  L: number;
  m: number;
  g: number;
  dt: number;
  total_steps: number;
  sample_interval: number;
  theta: number;
  omega: number;
  n: number;
  status: RunStatus;
  initial_total_energy: number;
  integrator_version: string;
  created_at: string;
  updated_at: string;
}

export interface SampleRow {
  run_id: string;
  n: number;
  t: number;
  theta: number;
  theta_wrapped: number;
  omega: number;
  kinetic: number;
  potential: number;
  total: number;
  deviation_type: 'relative' | 'absolute';
  deviation: number;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec('PRAGMA foreign_keys=ON;');
    this.initSchema();
  }

  close(): void {
    this.db.close();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        L REAL NOT NULL,
        m REAL NOT NULL,
        g REAL NOT NULL,
        dt REAL NOT NULL,
        total_steps INTEGER NOT NULL,
        sample_interval INTEGER NOT NULL,
        theta REAL NOT NULL,
        omega REAL NOT NULL,
        n INTEGER NOT NULL,
        status TEXT NOT NULL,
        initial_total_energy REAL NOT NULL,
        integrator_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS samples (
        run_id TEXT NOT NULL REFERENCES runs(id),
        n INTEGER NOT NULL,
        t REAL NOT NULL,
        theta REAL NOT NULL,
        theta_wrapped REAL NOT NULL,
        omega REAL NOT NULL,
        kinetic REAL NOT NULL,
        potential REAL NOT NULL,
        total REAL NOT NULL,
        deviation_type TEXT NOT NULL,
        deviation REAL NOT NULL,
        PRIMARY KEY (run_id, n)
      );
      CREATE INDEX IF NOT EXISTS idx_samples_run ON samples(run_id, n);
    `);
  }

  createRun(input: Record<string, unknown>): RunRow {
    const cfg = validateConfig(input);
    const id = randomUUID();
    const now = new Date().toISOString();
    const params: PendulumParams = { L: cfg.L, m: cfg.m, g: cfg.g };
    const e0 = energy(cfg.theta0, cfg.omega0, params);
    const status: RunStatus = cfg.totalSteps === 0 ? 'completed' : 'active';

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO runs (id,name,L,m,g,dt,total_steps,sample_interval,theta,omega,n,status,
             initial_total_energy,integrator_version,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          (input.name as string | undefined) ?? id.slice(0, 8),
          cfg.L,
          cfg.m,
          cfg.g,
          cfg.dt,
          cfg.totalSteps,
          cfg.sampleInterval,
          cfg.theta0,
          cfg.omega0,
          0,
          status,
          e0.total,
          INTEGRATOR_VERSION,
          now,
          now,
        );
      if (cfg.totalSteps >= 0) {
        this.insertSample(id, 0, cfg.dt, cfg.theta0, cfg.omega0, params, e0.total);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.getRunOrThrow(id);
  }

  private insertSample(
    runId: string,
    n: number,
    dt: number,
    theta: number,
    omega: number,
    params: PendulumParams,
    e0: number,
  ): void {
    const e = energy(theta, omega, params);
    const dev = energyDeviation(e.total, e0);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO samples
           (run_id,n,t,theta,theta_wrapped,omega,kinetic,potential,total,deviation_type,deviation)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        runId,
        n,
        n * dt,
        theta,
        normalizeAngle(theta),
        omega,
        e.kinetic,
        e.potential,
        e.total,
        dev.type,
        dev.value,
      );
  }

  getRun(id: string): RunRow | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as
      | RunRow
      | undefined;
    return row;
  }

  getRunOrThrow(id: string): RunRow {
    const run = this.getRun(id);
    if (!run) {
      const err = new Error(`运行 ${id} 不存在`) as Error & { code: string };
      err.code = 'RUN_NOT_FOUND';
      throw err;
    }
    return run;
  }

  listRuns(): RunRow[] {
    return this.db.prepare('SELECT * FROM runs ORDER BY created_at').all() as unknown as RunRow[];
  }

  // 推进最多 maxSteps 个内部积分步。采样间隔不跳过任何内部步。
  // 返回推进后状态及本次新写入的采样。计算预算耗尽且未达目标 -> paused。
  advanceRun(id: string, maxSteps: number): { run: RunRow; newSamples: SampleRow[] } {
    if (!Number.isInteger(maxSteps) || maxSteps < 1) {
      const err = new Error('maxSteps 必须为 >=1 的整数') as Error & { code: string };
      err.code = 'INVALID_PARAMETER';
      throw err;
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const run = this.getRunOrThrow(id);
      if (run.status === 'completed') {
        const err = new Error('运行已完成，不能继续推进') as Error & { code: string };
        err.code = 'RUN_COMPLETED';
        throw err;
      }
      const params: PendulumParams = { L: run.L, m: run.m, g: run.g };
      let { theta, omega, n } = run;
      const remaining = run.total_steps - n;
      const steps = Math.min(maxSteps, remaining);
      const newSamples: SampleRow[] = [];

      for (let k = 0; k < steps; k++) {
        const next = verletStep({ theta, omega, n }, params, run.dt);
        theta = next.theta;
        omega = next.omega;
        n = next.n;
        const atInterval = n % run.sample_interval === 0;
        const atTarget = n === run.total_steps;
        if (atInterval || atTarget) {
          this.insertSample(run.id, n, run.dt, theta, omega, params, run.initial_total_energy);
        }
      }

      const reachedTarget = n >= run.total_steps;
      const budgetExhausted = steps < remaining;
      const status: RunStatus = reachedTarget
        ? 'completed'
        : budgetExhausted
          ? 'paused'
          : run.status === 'paused'
            ? 'paused'
            : 'active';
      this.db
        .prepare(
          'UPDATE runs SET theta=?,omega=?,n=?,status=?,updated_at=? WHERE id=?',
        )
        .run(theta, omega, n, status, new Date().toISOString(), run.id);

      const startN = n - steps;
      const fetched = this.db
        .prepare('SELECT * FROM samples WHERE run_id=? AND n>? ORDER BY n')
        .all(run.id, startN) as unknown as SampleRow[];
      newSamples.push(...fetched);

      this.db.exec('COMMIT');
      return { run: this.getRunOrThrow(run.id), newSamples };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  pauseRun(id: string): RunRow {
    const run = this.getRunOrThrow(id);
    if (run.status === 'completed') {
      const err = new Error('运行已完成，不能暂停') as Error & { code: string };
      err.code = 'RUN_COMPLETED';
      throw err;
    }
    this.db
      .prepare('UPDATE runs SET status=?,updated_at=? WHERE id=?')
      .run('paused', new Date().toISOString(), id);
    return this.getRunOrThrow(id);
  }

  resumeRun(id: string): RunRow {
    const run = this.getRunOrThrow(id);
    if (run.status === 'completed') {
      const err = new Error('运行已完成，不能重启') as Error & { code: string };
      err.code = 'RUN_COMPLETED';
      throw err;
    }
    // 重启沿用保存的 theta/omega/n 与固定步长，不按显示时刻重新初始化。
    this.db
      .prepare('UPDATE runs SET status=?,updated_at=? WHERE id=?')
      .run('active', new Date().toISOString(), id);
    return this.getRunOrThrow(id);
  }

  getSample(id: string, n: number): SampleRow {
    this.getRunOrThrow(id);
    const row = this.db
      .prepare('SELECT * FROM samples WHERE run_id=? AND n=?')
      .get(id, n) as SampleRow | undefined;
    if (!row) {
      const err = new Error(`运行 ${id} 未保存第 ${n} 步采样（受采样间隔限制）`) as Error & {
        code: string;
      };
      err.code = 'SAMPLE_NOT_FOUND';
      throw err;
    }
    return row;
  }

  listSamples(id: string, limit?: number): SampleRow[] {
    this.getRunOrThrow(id);
    if (limit !== undefined) {
      return this.db
        .prepare('SELECT * FROM samples WHERE run_id=? ORDER BY n DESC LIMIT ?')
        .all(id, limit)
        .reverse() as unknown as SampleRow[];
    }
    return this.db
      .prepare('SELECT * FROM samples WHERE run_id=? ORDER BY n')
      .all(id) as unknown as SampleRow[];
  }
}

