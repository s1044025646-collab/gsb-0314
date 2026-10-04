#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { Store, type RunRow, type SampleRow } from './store.js';

const DATA_DIR = process.env.PENDULUM_DATA_DIR ?? join(process.cwd(), 'data');
const DB_PATH = join(DATA_DIR, 'pendulum.db');

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags.set(key, 'true');
      } else {
        flags.set(key, next);
        i++;
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

function num(flags: Map<string, string>, key: string): number | undefined {
  const v = flags.get(key);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${key} 必须是数字，收到: ${v}`);
  return n;
}

function loadConfig(flags: Map<string, string>): Record<string, number | string> {
  const file = flags.get('config');
  let cfg: Record<string, unknown> = {};
  if (file) {
    cfg = JSON.parse(readFileSync(resolve(file), 'utf8')) as Record<string, unknown>;
  }
  const keys = ['L', 'm', 'g', 'theta0', 'omega0', 'dt', 'totalSteps', 'sampleInterval', 'name'];
  for (const key of keys) {
    const v = num(flags, key);
    if (v !== undefined) cfg[key] = v;
  }
  if (typeof flags.get('name') === 'string' && flags.get('name') !== 'true') {
    cfg.name = flags.get('name');
  }
  return cfg as Record<string, number | string>;
}

function fmt(x: number, digits = 8): string {
  if (!Number.isFinite(x)) return String(x);
  const abs = Math.abs(x);
  if (abs !== 0 && (abs < 1e-3 || abs >= 1e6)) return x.toExponential(6);
  return x.toFixed(digits);
}

function printSamplesTable(samples: SampleRow[]): void {
  const header = ['n', 't', 'theta', 'theta[-pi,pi)', 'omega', 'K', 'U', 'E', 'dev'];
  console.log(header.join('\t'));
  for (const s of samples) {
    console.log(
      [
        s.n,
        fmt(s.t, 6),
        fmt(s.theta),
        fmt(s.theta_wrapped),
        fmt(s.omega),
        fmt(s.kinetic),
        fmt(s.potential),
        fmt(s.total),
        `${s.deviation_type === 'relative' ? 'rel' : 'abs'}:${fmt(s.deviation, 6)}`,
      ].join('\t'),
    );
  }
}

function printRun(r: RunRow): void {
  console.log(
    JSON.stringify(
      {
        id: r.id,
        name: r.name,
        params: { L: r.L, m: r.m, g: r.g, dt: r.dt },
        state: { theta: r.theta, omega: r.omega, n: r.n, t: r.n * r.dt },
        totalSteps: r.total_steps,
        sampleInterval: r.sample_interval,
        status: r.status,
        initialTotalEnergy: r.initial_total_energy,
        integratorVersion: r.integrator_version,
      },
      null,
      2,
    ),
  );
}

function exportTrajectory(store: Store, id: string, out: string): void {
  const samples = store.listSamples(id);
  const lower = out.toLowerCase();
  mkdirSync(dirname(resolve(out)), { recursive: true });
  if (lower.endsWith('.csv')) {
    const lines = ['n,t,theta,theta_wrapped,omega,kinetic,potential,total,deviation_type,deviation'];
    for (const s of samples) {
      lines.push(
        [s.n, s.t, s.theta, s.theta_wrapped, s.omega, s.kinetic, s.potential, s.total, s.deviation_type, s.deviation].join(','),
      );
    }
    writeFileSync(out, lines.join('\n'), 'utf8');
  } else {
    writeFileSync(out, JSON.stringify({ runId: id, samples }, null, 2), 'utf8');
  }
  console.log(`已导出 ${samples.length} 条采样到 ${out}`);
}

function usage(): void {
  console.log(`单摆速度 Verlet CLI

用法:
  pendulum create  --config cfg.json [--name 名称] [--totalSteps N] ...
  pendulum list
  pendulum get <runId>
  pendulum advance <runId> [--maxSteps N]
  pendulum pause <runId>
  pendulum resume <runId>
  pendulum step <runId> --n <步数>          查询指定已保存步
  pendulum samples <runId> [--limit N]
  pendulum energy <runId>
  pendulum export <runId> --out file.csv|file.json
  pendulum compare --config cfg.json --tEnd <秒>

配置文件字段: L,m,g,theta0,omega0,dt,totalSteps,sampleInterval
环境变量: PENDULUM_DATA_DIR（默认 ./data）
`);
}

function main(): void {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  const store = new Store(DB_PATH);
  try {
    switch (command) {
      case 'create': {
        const cfg = loadConfig(flags);
        printRun(store.createRun(cfg as never));
        break;
      }
      case 'list':
        for (const r of store.listRuns()) {
          console.log(`${r.id}\t${r.name}\t${r.status}\tn=${r.n}/${r.total_steps}\tt=${fmt(r.n * r.dt, 6)}`);
        }
        break;
      case 'get':
        printRun(store.getRunOrThrow(positional[1]!));
        break;
      case 'advance': {
        const maxSteps = num(flags, 'maxSteps') ?? 1000;
        const { run, newSamples } = store.advanceRun(positional[1]!, maxSteps);
        printSamplesTable(newSamples);
        printRun(run);
        break;
      }
      case 'pause':
        printRun(store.pauseRun(positional[1]!));
        break;
      case 'resume':
        printRun(store.resumeRun(positional[1]!));
        break;
      case 'step':
        console.log(JSON.stringify(store.getSample(positional[1]!, num(flags, 'n')!), null, 2));
        break;
      case 'samples':
        printSamplesTable(store.listSamples(positional[1]!, num(flags, 'limit')));
        break;
      case 'energy': {
        for (const s of store.listSamples(positional[1]!)) {
          console.log(
            `n=${s.n}\tt=${fmt(s.t, 6)}\tE=${fmt(s.total)}\t${s.deviation_type}=${fmt(s.deviation, 6)}`,
          );
        }
        break;
      }
      case 'export':
        exportTrajectory(store, positional[1]!, flags.get('out') ?? 'trajectory.json');
        break;
      case 'compare': {
        const cfg = loadConfig(flags);
        const tEnd = num(flags, 'tEnd');
        if (tEnd === undefined) throw new Error('compare 需要 --tEnd');
        const dt = Number(cfg.dt);
        const stepsCoarse = Math.round(tEnd / dt);
        const dtFine = dt / 2;
        const stepsFine = Math.round(tEnd / dtFine);
        const base = {
          L: cfg.L,
          m: cfg.m,
          g: cfg.g,
          theta0: cfg.theta0,
          omega0: cfg.omega0,
          sampleInterval: 1,
        };
        const c = store.createRun({ ...base, dt, totalSteps: stepsCoarse, name: 'compare-coarse' });
        const f = store.createRun({ ...base, dt: dtFine, totalSteps: stepsFine, name: 'compare-fine' });
        store.advanceRun(c.id, stepsCoarse);
        store.advanceRun(f.id, stepsFine);
        const maxAbs = (id: string) =>
          Math.max(...store.listSamples(id).map((s) => Math.abs(s.deviation)));
        const cMax = maxAbs(c.id);
        const fMax = maxAbs(f.id);
        const ce = store.getRunOrThrow(c.id);
        const fe = store.getRunOrThrow(f.id);
        console.log(
          JSON.stringify(
            {
              tEnd,
              coarse: { dt, steps: stepsCoarse, maxAbsEnergyDeviation: cMax },
              fine: { dt: dtFine, steps: stepsFine, maxAbsEnergyDeviation: fMax },
              deviationRatio: cMax / fMax,
              finalStateDifference: {
                theta: Math.abs(ce.theta - fe.theta),
                omega: Math.abs(ce.omega - fe.omega),
              },
            },
            null,
            2,
          ),
        );
        break;
      }
      default:
        usage();
        if (command) process.exitCode = 1;
    }
  } catch (err) {
    const e = err as Error & { code?: string };
    console.error(`错误 [${e.code ?? 'ERROR'}]: ${e.message}`);
    process.exitCode = 1;
  } finally {
    store.close();
  }
}

main();
