import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as netCreateServer } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from './store.js';
import { ValidationError, validateConfig } from './physics.js';

const DATA_DIR = process.env.PENDULUM_DATA_DIR ?? join(process.cwd(), 'data');
const DB_PATH = join(DATA_DIR, 'pendulum.db');

interface RouteContext {
  store: Store;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

type Handler = (ctx: RouteContext) => unknown;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

function route(method: string, path: string, handler: Handler): Route {
  const keys: string[] = [];
  const pattern = new RegExp(
    '^' +
      path.replace(/:([A-Za-z]+)/g, (_, key: string) => {
        keys.push(key);
        return '([^/]+)';
      }) +
      '$',
  );
  return { method, pattern, keys, handler };
}

const routes: Route[] = [
  route('POST', '/api/runs', (ctx) => ctx.store.createRun(asObject(ctx.body))),
  route('GET', '/api/runs', (ctx) => ctx.store.listRuns()),
  route('GET', '/api/runs/:id', (ctx) => ctx.store.getRunOrThrow(ctx.params['id']!)),
  route('POST', '/api/runs/:id/advance', (ctx) => {
    const body = asObject(ctx.body);
    const maxSteps = body.maxSteps ?? 1000;
    return ctx.store.advanceRun(ctx.params['id']!, toPositiveInt(maxSteps, 'maxSteps'));
  }),
  route('POST', '/api/runs/:id/pause', (ctx) => ctx.store.pauseRun(ctx.params['id']!)),
  route('POST', '/api/runs/:id/resume', (ctx) => ctx.store.resumeRun(ctx.params['id']!)),
  route('GET', '/api/runs/:id/samples', (ctx) => {
    const limitRaw = ctx.query.get('limit');
    const limit = limitRaw === null ? undefined : toPositiveInt(Number(limitRaw), 'limit');
    return ctx.store.listSamples(ctx.params['id']!, limit);
  }),
  route('GET', '/api/runs/:id/steps/:n', (ctx) =>
    ctx.store.getSample(ctx.params['id']!, toNonNegativeInt(Number(ctx.params['n']), 'n')),
  ),
  route('GET', '/api/runs/:id/energy', (ctx) => {
    const samples = ctx.store.listSamples(ctx.params['id']!);
    return samples.map((s) => ({
      n: s.n,
      t: s.t,
      total: s.total,
      deviation_type: s.deviation_type,
      deviation: s.deviation,
    }));
  }),
  // 同初态步长对照：用 dt 与 dt/2 各自积分到相同时刻，比较末态与能量误差。
  route('POST', '/api/compare', (ctx) => {
    const cfg = asObject(ctx.body);
    const tEnd = toPositiveNumber(cfg.tEnd ?? cfg.time, 'tEnd');
    return buildComparison(ctx.store, cfg, tEnd);
  }),
];

function asObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    const err = new Error('请求体必须为 JSON 对象') as Error & { code: string };
    err.code = 'INVALID_BODY';
    throw err;
  }
  return body as Record<string, unknown>;
}

function toPositiveInt(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new ValidationError(`${field} 必须为 >=1 的整数`, field);
  }
  return v;
}

function toNonNegativeInt(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new ValidationError(`${field} 必须为非负整数`, field);
  }
  return v;
}

function toPositiveNumber(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw new ValidationError(`${field} 必须为正数`, field);
  }
  return v;
}

function buildComparison(store: Store, cfg: Record<string, unknown>, tEnd: number): unknown {
  const dt = toPositiveNumber(cfg.dt, 'dt');
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
  validateConfig({ ...base, dt, totalSteps: stepsCoarse });
  validateConfig({ ...base, dt: dtFine, totalSteps: stepsFine });
  const coarse = store.createRun({ ...base, dt, totalSteps: stepsCoarse, name: 'compare-coarse' });
  const fine = store.createRun({
    ...base,
    dt: dtFine,
    totalSteps: stepsFine,
    name: 'compare-fine',
  });
  store.advanceRun(coarse.id, stepsCoarse);
  store.advanceRun(fine.id, stepsFine);
  const cEnd = store.getRunOrThrow(coarse.id);
  const fEnd = store.getRunOrThrow(fine.id);
  const maxAbs = (runId: string): number =>
    Math.max(...store.listSamples(runId).map((s) => Math.abs(s.deviation)));
  const cMax = maxAbs(coarse.id);
  const fMax = maxAbs(fine.id);
  return {
    tEnd: stepsCoarse * dt,
    coarse: { dt, steps: stepsCoarse, runId: coarse.id, maxAbsEnergyDeviation: cMax },
    fine: {
      dt: dtFine,
      steps: stepsFine,
      runId: fine.id,
      maxAbsEnergyDeviation: fMax,
    },
    deviationRatio: cMax / fMax,
    finalStateDifference: {
      theta: Math.abs(cEnd.theta - fEnd.theta),
      omega: Math.abs(cEnd.omega - fEnd.omega),
    },
  };
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const json = JSON.stringify(payload, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(json);
}

function errorStatus(code: string | undefined): number {
  switch (code) {
    case 'INVALID_PARAMETER':
    case 'INVALID_BODY':
      return 400;
    case 'RUN_NOT_FOUND':
    case 'SAMPLE_NOT_FOUND':
      return 404;
    case 'RUN_COMPLETED':
      return 409;
    default:
      return 500;
  }
}

export function createApp(store: Store): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const parsed = new URL(req.url ?? '/', 'http://localhost');
    const routeMatch = routes.find(
      (r) => r.method === (req.method ?? '') && r.pattern.test(parsed.pathname),
    );
    if (!routeMatch) {
      send(res, 404, { error: { code: 'NOT_FOUND', message: '未找到该接口' } });
      return;
    }
    const match = parsed.pathname.match(routeMatch.pattern)!;
    const params: Record<string, string> = {};
    routeMatch.keys.forEach((key, i) => {
      params[key] = decodeURIComponent(match[i + 1]!);
    });

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      let body: unknown = {};
      if (chunks.length) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          send(res, 400, { error: { code: 'INVALID_BODY', message: '请求体不是合法 JSON' } });
          return;
        }
      }
      try {
        const result = routeMatch.handler({
          store,
          params,
          query: parsed.searchParams,
          body,
        });
        send(res, 200, result);
      } catch (err) {
        const e = err as Error & { code?: string };
        send(res, errorStatus(e.code), {
          error: { code: e.code ?? 'INTERNAL', message: e.message },
        });
      }
    });
  });
}

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = netCreateServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('无法获取空闲端口')));
      }
    });
    srv.on('error', reject);
  });
}

async function main(): Promise<void> {
  const store = new Store(DB_PATH);
  const app = createApp(store);
  const requested = process.env.PORT ? Number(process.env.PORT) : NaN;
  const port = Number.isFinite(requested) && requested > 0 ? requested : await findFreePort();
  app.listen(port, '127.0.0.1', () => {
    console.log(`单摆 Verlet 后端已启动: http://127.0.0.1:${port}`);
    console.log(`数据库: ${DB_PATH}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
