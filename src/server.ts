import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { createServer as createNetServer } from "node:net";
import { resolve } from "node:path";
import {
  PendulumConfig,
  StepSample,
  ValidationError,
  advanceState,
  initialState,
  initialTotalEnergy,
  normalizeConfig,
} from "./physics.js";
import { ConflictError, NotFoundError, PendulumStore } from "./store.js";

const DATA_DB = process.env.PENDULUM_DB ?? resolve("data/pendulum.sqlite");

interface JsonRecord {
  [key: string]: unknown;
}

export function createApp(dbPath = DATA_DB): { server: Server; store: PendulumStore } {
  const store = new PendulumStore(dbPath);

  const server = createServer(async (request, response) => {
    try {
      await route(request, response, store);
    } catch (error) {
      sendError(response, error);
    }
  });

  return { server, store };
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  store: PendulumStore,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const pathParts = url.pathname.split("/").filter(Boolean);
  const method = request.method ?? "GET";

  if (method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { ok: true, service: "pendulum-verlet-backend" });
    return;
  }

  if (method === "POST" && url.pathname === "/api/runs") {
    const body = await readJson(request);
    sendJson(response, 201, { run: store.createRun(body) });
    return;
  }

  if (method === "POST" && url.pathname === "/api/runs/compare") {
    const body = await readJson(request);
    sendJson(response, 200, compareStepSizes(body));
    return;
  }

  const runId = pathParts[2];
  if (
    method === "GET" &&
    pathParts.length === 4 &&
    pathParts[0] === "api" &&
    pathParts[1] === "runs" &&
    runId
  ) {
    if (pathParts[3] === "state") {
      sendJson(response, 200, { run: store.getRun(runId) });
      return;
    }
    if (pathParts[3] === "trajectory") {
      const samples = store.getSamples(runId);
      if (url.searchParams.get("format") === "csv") {
        sendCsv(response, samples);
      } else {
        sendJson(response, 200, { run: store.getRun(runId), samples });
      }
      return;
    }
    if (pathParts[3] === "energy") {
      sendJson(response, 200, store.getEnergySummary(runId));
      return;
    }
  }

  if (
    method === "POST" &&
    pathParts.length === 4 &&
    pathParts[0] === "api" &&
    pathParts[1] === "runs" &&
    runId &&
    pathParts[3] === "advance"
  ) {
    const body = await readJson(request);
    sendJson(response, 200, store.advance(runId, body.steps));
    return;
  }

  if (
    method === "POST" &&
    pathParts.length === 4 &&
    pathParts[0] === "api" &&
    pathParts[1] === "runs" &&
    runId &&
    pathParts[3] === "pause"
  ) {
    sendJson(response, 200, { run: store.pause(runId) });
    return;
  }

  if (
    method === "GET" &&
    pathParts.length === 5 &&
    pathParts[0] === "api" &&
    pathParts[1] === "runs" &&
    runId &&
    pathParts[3] === "steps"
  ) {
    const step = Number(pathParts[4]);
    sendJson(response, 200, { sample: store.getSample(runId, step) });
    return;
  }

  sendJson(response, 404, { error: { code: "NOT_FOUND", message: "接口不存在" } });
}

function compareStepSizes(input: JsonRecord): {
  duration: number;
  coarse: ComparisonResult;
  fine: ComparisonResult;
} {
  const base = input.config;
  if (!base || typeof base !== "object" || Array.isArray(base)) {
    throw new ValidationError("config", "config 必须是配置对象");
  }
  const duration = input.duration;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
    throw new ValidationError("duration", "对照时长必须是正数");
  }
  const coarseDt = input.coarseTimeStep;
  const fineDt = input.fineTimeStep;
  if (typeof coarseDt !== "number" || typeof fineDt !== "number" || fineDt >= coarseDt) {
    throw new ValidationError("fineTimeStep", "细步长必须小于粗步长");
  }
  return {
    duration,
    coarse: simulate(base as JsonRecord, duration, coarseDt),
    fine: simulate(base as JsonRecord, duration, fineDt),
  };
}

interface ComparisonResult {
  timeStep: number;
  steps: number;
  final: StepSample;
  maxEnergyError: number;
  maxAbsoluteEnergyDelta: number;
}

function simulate(base: JsonRecord, duration: number, timeStep: number): ComparisonResult {
  const steps = Math.round(duration / timeStep);
  if (!Number.isFinite(steps) || steps < 1) {
    throw new ValidationError("timeStep", "对照时长至少要包含一个步长");
  }
  const config: PendulumConfig = normalizeConfig({
    ...base,
    timeStep,
    targetSteps: steps,
    sampleInterval: 1,
  });
  const energy = initialTotalEnergy(config);
  const result = advanceState(initialState(config), config, steps, energy, { sampleInterval: 1 });
  const maxError = result.samples.reduce((max, item) => Math.max(max, item.energyError), 0);
  const maxDelta = result.samples.reduce((max, item) => Math.max(max, Math.abs(item.energyDelta)), 0);
  return {
    timeStep,
    steps,
    final: result.samples.at(-1)!,
    maxEnergyError: maxError,
    maxAbsoluteEnergyDelta: maxDelta,
  };
}

async function readJson(request: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error();
    }
    return parsed as JsonRecord;
  } catch {
    throw new ValidationError("body", "请求体必须是 JSON 对象");
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value, null, 2));
}

function sendCsv(response: ServerResponse, samples: StepSample[]): void {
  const header = "step,time,angle,displayAngle,angularVelocity,kineticEnergy,potentialEnergy,totalEnergy,energyDelta,energyError,energyErrorKind";
  const lines = samples.map((item) => [
    item.completedSteps,
    item.time,
    item.angle,
    item.displayAngle,
    item.angularVelocity,
    item.kineticEnergy,
    item.potentialEnergy,
    item.totalEnergy,
    item.energyDelta,
    item.energyError,
    item.energyErrorKind,
  ].join(","));
  response.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": "attachment; filename=trajectory.csv",
  });
  response.end([header, ...lines].join("\n"));
}

function sendError(response: ServerResponse, error: unknown): void {
  if (error instanceof ValidationError) {
    sendJson(response, 400, { error: { code: error.code, field: error.field, message: error.message } });
    return;
  }
  if (error instanceof NotFoundError) {
    sendJson(response, 404, { error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof ConflictError) {
    sendJson(response, 409, { error: { code: error.code, message: error.message } });
    return;
  }
  const message = error instanceof Error ? error.message : "未知错误";
  sendJson(response, 500, { error: { code: "INTERNAL_ERROR", message } });
}

export function findFreePort(preferred?: number): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.on("error", reject);
    server.listen(preferred ?? 0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolvePort(address.port);
        } else {
          reject(new Error("无法取得空闲端口"));
        }
      });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const requestedPort = process.env.PORT ? Number(process.env.PORT) : undefined;
  const port = await findFreePort(requestedPort);
  const app = createApp();
  app.server.listen(port, "127.0.0.1", () => {
    console.log(`单摆 Verlet API 已启动: http://127.0.0.1:${port}`);
    console.log(`SQLite 数据库: ${DATA_DB}`);
  });
}
