#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PendulumStore } from "../store.js";
import {
  StepSample,
  advanceState,
  initialState,
  initialTotalEnergy,
  normalizeConfig,
  velocityVerletStep,
} from "../physics.js";

const dbPath = process.env.PENDULUM_DB ?? resolve("data/pendulum.sqlite");
const [command, ...rest] = process.argv.slice(2);

function usage(): never {
  console.error(`用法:
  pendulum import --config config.json
  pendulum advance <runId> <steps>
  pendulum pause <runId>
  pendulum state <runId>
  pendulum step <runId> <step>
  pendulum export <runId> [--out file.json|file.csv]
  pendulum energy <runId>
  pendulum compare --config config.json --duration <秒> --coarse-dt <dt> --fine-dt <dt>
  pendulum handcheck --config config.json

环境变量:
  PENDULUM_DB   SQLite 文件路径，默认 data/pendulum.sqlite
`);
  process.exit(1);
}

function option(name: string): string | undefined {
  const index = rest.indexOf(name);
  return index >= 0 ? rest[index + 1] : undefined;
}

function loadConfig(path = option("--config") ?? "config.json"): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as Record<string, unknown>;
}

function printTable(samples: StepSample[]): void {
  console.log(
    "step       time       angle      display    omega      KE         PE         E          rel/abs err",
  );
  for (const item of samples) {
    console.log(
      [
            String(item.completedSteps).padStart(4),
            item.time.toFixed(6).padStart(10),
            item.angle.toFixed(9).padStart(10),
            item.displayAngle.toFixed(9).padStart(10),
            item.angularVelocity.toExponential(4).padStart(10),
            item.kineticEnergy.toExponential(4).padStart(10),
            item.potentialEnergy.toExponential(4).padStart(10),
            item.totalEnergy.toExponential(4).padStart(10),
            item.energyError.toExponential(4).padStart(10),
      ].join(" "),
    );
  }
}

async function main(): Promise<void> {
  if (!command) usage();
  const store = new PendulumStore(dbPath);
  try {
    if (command === "import") {
      const run = store.createRun(loadConfig());
      console.log(JSON.stringify(run, null, 2));
      return;
    }

    if (command === "advance") {
      const runId = rest[0];
      const steps = Number(rest[1]);
      if (!runId) usage();
      const result = store.advance(runId, steps);
      console.log(`advanced=${result.advancedSteps} status=${result.run.status} stoppedByBudget=${result.stoppedByBudget}`);
      printTable(result.samples);
      console.log(`runId=${result.run.id}`);
      return;
    }

    if (command === "state") {
      if (!rest[0]) usage();
      console.log(JSON.stringify(store.getRun(rest[0]), null, 2));
      return;
    }

    if (command === "pause") {
      if (!rest[0]) usage();
      console.log(JSON.stringify(store.pause(rest[0]), null, 2));
      return;
    }

    if (command === "step") {
      if (!rest[0] || rest[1] === undefined) usage();
      console.log(JSON.stringify(store.getSample(rest[0], Number(rest[1])), null, 2));
      return;
    }

    if (command === "energy") {
      if (!rest[0]) usage();
      console.log(JSON.stringify(store.getEnergySummary(rest[0]), null, 2));
      return;
    }

    if (command === "export") {
      const runId = rest[0];
      if (!runId) usage();
      const samples = store.getSamples(runId);
      const out = option("--out");
      const isCsv = out?.toLowerCase().endsWith(".csv");
      if (isCsv) {
        const header = "step,time,angle,displayAngle,angularVelocity,kineticEnergy,potentialEnergy,totalEnergy,energyDelta,energyError,energyErrorKind";
        const csv = [header, ...samples.map((s) => [
          s.completedSteps, s.time, s.angle, s.displayAngle, s.angularVelocity,
          s.kineticEnergy, s.potentialEnergy, s.totalEnergy, s.energyDelta,
          s.energyError, s.energyErrorKind,
        ].join(","))].join("\n");
        if (out) writeFileSync(resolve(out), csv, "utf8"); else console.log(csv);
      } else {
        const json = JSON.stringify({ run: store.getRun(runId), samples }, null, 2);
        if (out) writeFileSync(resolve(out), json, "utf8"); else console.log(json);
      }
      return;
    }

    if (command === "handcheck") {
      const config = normalizeConfig(loadConfig());
      const result = velocityVerletStep(initialState(config), config);
      console.log(JSON.stringify({
        order: [
          "a_n=-(g/L)sin(theta_n)",
          "omega_half=omega_n+0.5*a_n*dt",
          "theta_np1=theta_n+omega_half*dt",
          "a_np1=-(g/L)sin(theta_np1)",
          "omega_np1=omega_half+0.5*a_np1*dt",
        ],
        result,
      }, null, 2));
      return;
    }

    if (command === "compare") {
      const base = loadConfig();
      const duration = Number(option("--duration"));
      const coarse = Number(option("--coarse-dt"));
      const fine = Number(option("--fine-dt"));
      const simulate = (timeStep: number) => {
        const steps = Math.round(duration / timeStep);
        const config = normalizeConfig({ ...base, timeStep, targetSteps: steps, sampleInterval: 1 });
        const outcome = advanceState(
          initialState(config),
          config,
          steps,
          initialTotalEnergy(config),
          { sampleInterval: 1 },
        );
        return {
          timeStep,
          steps,
          final: outcome.samples.at(-1),
          maxError: Math.max(...outcome.samples.map((sample) => sample.energyError)),
        };
      };
      console.log(JSON.stringify({ coarse: simulate(coarse), fine: simulate(fine) }, null, 2));
      return;
    }

    usage();
  } finally {
    store.close();
  }
}

main().catch((error: Error & { code?: string }) => {
  console.error(`${error.code ?? "ERROR"}: ${error.message}`);
  process.exitCode = 1;
});
