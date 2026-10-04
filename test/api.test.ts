import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import type { Server } from 'node:http';

const dir = join(process.cwd(), 'data-test-api');
const dbPath = join(dir, 'api.db');
let store: Store;
let server: Server;
let base: string;

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

before(async () => {
  rmSync(dir, { recursive: true, force: true });
  store = new Store(dbPath);
  server = createApp(store);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('完整 API 生命周期：创建、推进、暂停、重启、查询、对照、错误码', async () => {
  const created = await call('POST', '/api/runs', {
    L: 1, m: 1, g: 9.81, theta0: 0.2, omega0: 0, dt: 0.01, totalSteps: 50, sampleInterval: 10,
  });
  assert.equal(created.status, 200);
  const id = created.json.id;

  const adv = await call('POST', `/api/runs/${id}/advance`, { maxSteps: 20 });
  assert.equal(adv.status, 200);
  assert.equal(adv.json.run.status, 'paused');
  assert.equal(adv.json.run.n, 20);

  await call('POST', `/api/runs/${id}/resume`);
  const adv2 = await call('POST', `/api/runs/${id}/advance`, { maxSteps: 1000 });
  assert.equal(adv2.json.run.status, 'completed');

  const step = await call('GET', `/api/runs/${id}/steps/30`);
  assert.equal(step.status, 200);
  assert.equal(step.json.n, 30);
  assert.ok(Math.abs(step.json.t - 0.3) < 1e-15);

  const energyReport = await call('GET', `/api/runs/${id}/energy`);
  assert.ok(Array.isArray(energyReport.json));

  const badStep = await call('GET', `/api/runs/${id}/steps/31`);
  assert.equal(badStep.status, 404);
  assert.equal(badStep.json.error.code, 'SAMPLE_NOT_FOUND');

  const invalid = await call('POST', '/api/runs', {
    L: 0, m: 1, g: 9.81, theta0: 0, omega0: 0, dt: 0.01, totalSteps: 5,
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error.code, 'INVALID_PARAMETER');

  const notFound = await call('GET', '/api/runs/does-not-exist');
  assert.equal(notFound.status, 404);

  const compare = await call('POST', '/api/compare', {
    L: 1, m: 1, g: 9.81, theta0: 0.3, omega0: 0.2, dt: 0.01, tEnd: 1,
  });
  assert.equal(compare.status, 200);
  assert.ok(compare.json.fine.maxAbsEnergyDeviation < compare.json.coarse.maxAbsEnergyDeviation);
  assert.ok(compare.json.deviationRatio > 2.5);
});
