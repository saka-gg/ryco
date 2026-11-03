/**
 * How much running agents at a lower CPU priority keeps a busy server responsive.
 *
 *   node apps/server/scripts/measure-agent-priority.ts [--phase-seconds 30] [--agents 2*cores]
 *     [--rounds 3] [--server-duty 0.3] [--increment 5] [--interval 20] [--url <http url>]
 *
 * Synthetic by default: a Node "server" (HTTP returning a 200-thread JSON snapshot, plus a
 * background duty cycle of `--server-duty` of every 10 ms standing in for event ingestion) runs at
 * the caller's priority. A forked client at the same priority sends one keep-alive GET every
 * `--interval` ms. CPU-saturating "agent" process groups (`sh` running one busy loop itself and one
 * in a subshell, so the grandchild proves inheritance) run either unchanged ("nice0") or through
 * the production launch plan of `@ryco/shared/processPriority` ("nice<increment>"). Phases:
 * baseline (no agents), then ABBA rounds of both modes, 1.5 s warm-up each.
 *
 * With `--url` the client measures that server instead (for example an isolated real Ryco node);
 * the synthetic server, its duty cycle and the event-loop numbers are skipped.
 *
 * Reports per phase: HTTP latency p50/p95/p99/max (client side), event-loop delay p50/p99/max
 * beyond the 10 ms sampling interval (synthetic server only), machine busy %, and the niceness
 * values seen across one agent's process group; then the median of each metric per mode.
 */
import { execFileSync, fork, spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import os from "node:os";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  AGENT_NICE_INCREMENT,
  applyAgentLaunchPlan,
  planAgentLaunch,
  resolveNiceExecutable,
} from "@ryco/shared/processPriority";

function runClient(): void {
  const target = process.env.MEASURE_AGENT_PRIORITY_URL ?? "";
  const intervalMs = Number(process.env.MEASURE_AGENT_PRIORITY_INTERVAL ?? 20);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  let samples: number[] = [];
  let running = false;
  const tick = () => {
    if (!running) return;
    const startedAt = performance.now();
    http
      .get(target, { agent }, (response) => {
        response.resume();
        response.on("end", () => {
          samples.push(performance.now() - startedAt);
          setTimeout(tick, intervalMs);
        });
      })
      .on("error", () => setTimeout(tick, intervalMs));
  };
  process.on("message", (message) => {
    if (message === "start") {
      samples = [];
      running = true;
      tick();
    } else if (message === "stop") {
      running = false;
      process.send?.({ samples });
    } else if (message === "exit") {
      process.exit(0);
    }
  });
}

function readArgs() {
  const args = process.argv.slice(2);
  const value = (name: string): string | undefined => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const cores = os.availableParallelism();
  return {
    cores,
    phaseSeconds: Number(value("phase-seconds") ?? 30),
    agents: Number(value("agents") ?? cores * 2),
    rounds: Number(value("rounds") ?? 3),
    serverDuty: Number(value("server-duty") ?? 0.3),
    increment: Number(value("increment") ?? AGENT_NICE_INCREMENT),
    intervalMs: Number(value("interval") ?? 20),
    url: value("url"),
  };
}

const RESOLUTION_MS = 10;
const WARMUP_MS = 1_500;
const BURN = "(while :; do :; done) & while :; do :; done";

const percentile = (values: ReadonlyArray<number>, p: number): number => {
  if (values.length === 0) return Number.NaN;
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
};
const median = (values: ReadonlyArray<number>): number => percentile(values, 50);
const round2 = (value: number) => Math.round(value * 100) / 100;

const cpuTotals = () =>
  os.cpus().reduce(
    (totals, cpu) => {
      const times = cpu.times;
      const busy = times.user + times.nice + times.sys + times.irq;
      return { busy: totals.busy + busy, all: totals.all + busy + times.idle };
    },
    { busy: 0, all: 0 },
  );

/** The distinct niceness values of every process in a group (agent, its children). */
const groupNiceValues = (pgid: number): string => {
  try {
    const pids = execFileSync("pgrep", ["-g", String(pgid)], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map(Number);
    return [...new Set(pids.map((pid) => os.getPriority(pid)))]
      .toSorted((left, right) => left - right)
      .join(",");
  } catch {
    return "";
  }
};

interface PhaseResult {
  readonly phase: string;
  readonly mode: string;
  readonly requests: number;
  readonly httpP50: number;
  readonly httpP95: number;
  readonly httpP99: number;
  readonly httpMax: number;
  readonly eldP50: number | null;
  readonly eldP99: number | null;
  readonly eldMax: number | null;
  readonly busyPct: number;
  readonly agentGroupNice: string;
}

async function runCoordinator(): Promise<void> {
  const options = readArgs();
  const niceExecutable = resolveNiceExecutable();
  if (process.platform === "win32" || niceExecutable === null) {
    throw new Error("This measurement needs POSIX and an absolute nice executable.");
  }

  let server: http.Server | undefined;
  let duty: ReturnType<typeof setInterval> | undefined;
  let sink = 0;
  let url = options.url;
  if (url === undefined) {
    const snapshot = {
      threads: Array.from({ length: 200 }, (_, index) => ({
        id: `t${index}`,
        title: `Thread ${index}`,
        n: index,
      })),
    };
    const syntheticServer = http.createServer((_request, response) => {
      const body = JSON.stringify(snapshot);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(body);
    });
    server = syntheticServer;
    await new Promise<void>((resolve) => syntheticServer.listen(0, "127.0.0.1", resolve));
    const address = syntheticServer.address();
    if (address === null || typeof address === "string") throw new Error("No loopback port");
    url = `http://127.0.0.1:${address.port}/`;
    // `serverDuty` of each 10 ms is synchronous work, standing in for ingestion/projection.
    duty = setInterval(() => {
      const end = performance.now() + options.serverDuty * RESOLUTION_MS;
      while (performance.now() < end) sink = (sink * 1_103_515_245 + 12_345) | 0;
    }, RESOLUTION_MS);
  }

  const client = fork(fileURLToPath(import.meta.url), [], {
    env: {
      ...process.env,
      MEASURE_AGENT_PRIORITY_ROLE: "client",
      MEASURE_AGENT_PRIORITY_URL: url,
      MEASURE_AGENT_PRIORITY_INTERVAL: String(options.intervalMs),
    },
  });

  /** The burner argv a real agent launch would get: unchanged (increment 0) or through nice. */
  const burnerArgv = (increment: number) =>
    applyAgentLaunchPlan(
      planAgentLaunch({
        enabled: increment > 0,
        platform: process.platform,
        shell: false,
        niceExecutable,
        commandResolves: true,
        dyldEnvironment: false,
        increment,
      }),
      "/bin/sh",
      ["-c", BURN],
    );

  const runPhase = async (phase: string, increment: number | null): Promise<PhaseResult> => {
    const children: ChildProcess[] = [];
    if (increment !== null) {
      const argv = burnerArgv(increment);
      for (let index = 0; index < options.agents; index++) {
        // Detached like the Effect spawner's agents: each is its own process group.
        children.push(spawn(argv.command, [...argv.args], { detached: true, stdio: "ignore" }));
      }
    }
    await new Promise((resolve) => setTimeout(resolve, WARMUP_MS));
    const firstPid = children[0]?.pid;
    const agentGroupNice = firstPid === undefined ? "" : groupNiceValues(firstPid);
    const cpuBefore = cpuTotals();
    const eventLoopDelay = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
    eventLoopDelay.enable();
    client.send("start");
    await new Promise((resolve) => setTimeout(resolve, options.phaseSeconds * 1_000));
    const samples = await new Promise<number[]>((resolve) => {
      client.once("message", (message) => resolve((message as { samples: number[] }).samples));
      client.send("stop");
    });
    eventLoopDelay.disable();
    const cpuAfter = cpuTotals();
    for (const child of children) {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    const beyondInterval = (nanos: number) =>
      server ? round2(Math.max(0, nanos / 1e6 - RESOLUTION_MS)) : null;
    return {
      phase,
      mode: increment === null ? "baseline" : `nice${increment}`,
      requests: samples.length,
      httpP50: round2(percentile(samples, 50)),
      httpP95: round2(percentile(samples, 95)),
      httpP99: round2(percentile(samples, 99)),
      httpMax: round2(Math.max(...samples)),
      eldP50: beyondInterval(eventLoopDelay.percentile(50)),
      eldP99: beyondInterval(eventLoopDelay.percentile(99)),
      eldMax: beyondInterval(eventLoopDelay.max),
      busyPct: Math.round(
        (100 * (cpuAfter.busy - cpuBefore.busy)) / (cpuAfter.all - cpuBefore.all),
      ),
      agentGroupNice,
    };
  };

  const results: PhaseResult[] = [await runPhase("baseline", null)];
  const modes = [0, options.increment];
  for (let round = 0; round < options.rounds; round++) {
    const order = round % 2 === 0 ? modes : modes.toReversed();
    for (const increment of order) {
      results.push(await runPhase(`nice${increment}#${round + 1}`, increment));
    }
  }
  if (duty) clearInterval(duty);
  client.send("exit");
  server?.close();

  const medians = ["baseline", ...modes.map((increment) => `nice${increment}`)].map((mode) => {
    const phases = results.filter((result) => result.mode === mode);
    const pick = (key: keyof PhaseResult) =>
      phases.some((phase) => phase[key] === null)
        ? null
        : round2(median(phases.map((phase) => Number(phase[key]))));
    return {
      mode,
      phases: phases.length,
      httpP95: pick("httpP95"),
      httpP99: pick("httpP99"),
      eldP99: pick("eldP99"),
      busyPct: pick("busyPct"),
      agentGroupNice: phases.map((phase) => phase.agentGroupNice).join(" "),
    };
  });

  console.log(
    JSON.stringify({
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      cores: options.cores,
      loadAverage: os.loadavg().map(round2),
      serverNice: os.getPriority(),
      niceExecutable,
      agents: options.agents,
      busyProcesses: options.agents * 2,
      oversubscription: round2((options.agents * 2) / options.cores),
      phaseSeconds: options.phaseSeconds,
      rounds: options.rounds,
      increment: options.increment,
      target: options.url ?? "synthetic",
      serverDuty: options.url === undefined ? options.serverDuty : null,
      sink,
    }),
  );
  console.table(results);
  console.table(medians);
}

// Last, so every module-level constant above is initialized before either role runs.
if (process.env.MEASURE_AGENT_PRIORITY_ROLE === "client") {
  runClient();
} else {
  await runCoordinator();
}
