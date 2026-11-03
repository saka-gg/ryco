import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ThreadId, type ThreadLocalServerList } from "@ryco/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { LocalListener, ProcessRow } from "./localServerScan.ts";
import {
  type LocalServerHost,
  makeThreadLocalServerMonitor,
  systemLocalServerHost,
} from "./threadLocalServerMonitor.ts";

const SERVER_PID = 500;
const THREAD = ThreadId.make("thread-1");
const OTHER = ThreadId.make("thread-2");

const row = (pid: number, ppid: number, pgid: number, startTimeMs = 1_000 + pid): ProcessRow => ({
  pid,
  ppid,
  pgid,
  stat: "S",
  hasTty: false,
  startTimeMs,
});

/**
 * A machine: this server (500) under launchd, its agent CLI (510, the server's group), and the
 * processes a test adds. `markers` is each process's RYCO_THREAD_ID.
 */
function fakeHost(input: {
  readonly listeners: Array<LocalListener>;
  readonly processes: Array<ProcessRow>;
  readonly markers: Record<number, string>;
  readonly titles?: Record<number, string>;
}) {
  let processes = new Map<number, ProcessRow>(
    [row(500, 1, 500), row(510, 500, 500), ...input.processes].map((each) => [each.pid, each]),
  );
  let clock = 0;
  const signals: Array<readonly [number, string]> = [];
  const markerReads: Array<ReadonlyArray<number>> = [];
  const titleProbes: Array<number> = [];
  /** What a group's processes do when signaled; default: they exit on SIGTERM. */
  let onSignal = (group: number, _signal: string) => {
    processes = new Map([...processes].filter(([, each]) => each.pgid !== group));
  };
  const host: LocalServerHost = {
    platform: "darwin",
    serverPid: SERVER_PID,
    listListeners: async () => input.listeners.filter((listener) => processes.has(listener.pid)),
    readProcessTable: async () => new Map(processes),
    readThreadMarkers: async (pids) => {
      markerReads.push(pids);
      return new Map(pids.map((pid) => [pid, input.markers[pid] ?? null]));
    },
    signalGroup: (group, signal) => {
      signals.push([group, signal]);
      if (![...processes.values()].some((each) => each.pgid === group)) return "gone";
      onSignal(group, signal);
      return "sent";
    },
    titles: {
      title: async (key) => {
        const pid = Number(key.split(":")[0]);
        titleProbes.push(pid);
        return input.titles?.[pid] ?? null;
      },
      clear: () => undefined,
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  return {
    host,
    signals,
    markerReads,
    titleProbes,
    setProcesses: (next: Array<ProcessRow>) => {
      processes = new Map(
        [row(500, 1, 500), row(510, 500, 500), ...next].map((each) => [each.pid, each]),
      );
    },
    ignoreSigterm: () => {
      onSignal = (group, signal) => {
        if (signal === "SIGKILL") {
          processes = new Map([...processes].filter(([, each]) => each.pgid !== group));
        }
      };
    },
  };
}

const listener = (pid: number, port: number, host = "127.0.0.1"): LocalListener => ({
  pid,
  processName: "node",
  host,
  port,
});

/** Collects a thread's lists until `count` arrived. */
function follow(monitor: ReturnType<typeof makeThreadLocalServerMonitor>, threadId: ThreadId) {
  const lists: Array<ThreadLocalServerList> = [];
  const stop = monitor.subscribe(threadId, (list) => lists.push(list));
  return { lists, stop };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("thread local server monitor", () => {
  // The agent's tool shell (520, own group) runs a dev server (521) on 5173 for thread-1; another
  // thread's server listens on 3000; an unattributed process on 8080.
  const machine = () =>
    fakeHost({
      listeners: [
        listener(521, 5173),
        listener(521, 5173, "[::1]"),
        listener(610, 3000),
        listener(700, 8080),
      ],
      processes: [row(520, 510, 520), row(521, 520, 520), row(610, 1, 610), row(700, 1, 700)],
      markers: { 520: THREAD, 521: THREAD, 610: OTHER },
      titles: { 521: "My App" },
    });

  it("lists only the followed thread's servers, with titles probed only for those", async () => {
    const fake = machine();
    const monitor = makeThreadLocalServerMonitor(fake.host, { intervalMs: 60_000 });
    const followed = follow(monitor, THREAD);
    await settle();
    expect(followed.lists).toHaveLength(1);
    expect(followed.lists[0]).toMatchObject({
      threadId: THREAD,
      servers: [
        {
          pid: 521,
          startTimeMs: 1_521,
          port: 5173,
          host: "127.0.0.1",
          url: "http://localhost:5173/",
          processName: "node",
          pageTitle: "My App",
          origin: "agent",
        },
      ],
    });
    // Neither the other thread's server nor the unattributed listener was probed.
    expect(fake.titleProbes).toEqual([521]);
    followed.stop();
  });

  it("reads each process's marker once while followed and drops the cache when unfollowed", async () => {
    const fake = machine();
    const monitor = makeThreadLocalServerMonitor(fake.host, { intervalMs: 60_000 });
    const first = follow(monitor, THREAD);
    await settle();
    const second = follow(monitor, OTHER);
    await settle();
    // The second scan read no marker again: every listener's process was already known.
    expect(fake.markerReads).toEqual([[521, 610, 700]]);
    expect(second.lists[0]?.servers.map((server) => server.port)).toEqual([3000]);
    first.stop();
    second.stop();
    expect(monitor.followedThreads()).toEqual([]);
    const again = follow(monitor, THREAD);
    await settle();
    expect(fake.markerReads).toEqual([
      [521, 610, 700],
      [521, 610, 700],
    ]);
    again.stop();
  });

  it("sends a list again only when it changed", async () => {
    const fake = machine();
    const monitor = makeThreadLocalServerMonitor(fake.host, { intervalMs: 60_000 });
    const followed = follow(monitor, THREAD);
    await settle();
    // A second subscriber triggers another scan: the first one's unchanged list is not resent.
    const other = follow(monitor, OTHER);
    await settle();
    expect(followed.lists).toHaveLength(1);
    fake.setProcesses([row(610, 1, 610), row(700, 1, 700)]);
    const third = follow(monitor, OTHER);
    await settle();
    expect(followed.lists.map((list) => list.servers.length)).toEqual([1, 0]);
    followed.stop();
    other.stop();
    third.stop();
  });

  it("reads a marker again after a failed read instead of hiding the server", async () => {
    const fake = machine();
    let reads = 0;
    const monitor = makeThreadLocalServerMonitor(
      {
        ...fake.host,
        // The first read fails (`ps` timed out): it answers for no pid.
        readThreadMarkers: (pids) => {
          reads += 1;
          return reads === 1 ? Promise.resolve(new Map()) : fake.host.readThreadMarkers(pids);
        },
      },
      { intervalMs: 60_000 },
    );
    const followed = follow(monitor, THREAD);
    await settle();
    expect(followed.lists.map((list) => list.servers.length)).toEqual([0]);
    // The next scan (here: another follower's) reads it again and finds the server.
    const other = follow(monitor, OTHER);
    await settle();
    expect(reads).toBe(2);
    expect(followed.lists.map((list) => list.servers.length)).toEqual([0, 1]);
    followed.stop();
    other.stop();
  });

  it("keeps the last list when the listeners cannot be read, and a stop then refuses", async () => {
    const fake = machine();
    let listings = 0;
    const monitor = makeThreadLocalServerMonitor(
      {
        ...fake.host,
        listListeners: () => {
          listings += 1;
          return listings === 1 ? fake.host.listListeners() : Promise.resolve(null);
        },
      },
      { intervalMs: 60_000 },
    );
    const followed = follow(monitor, THREAD);
    await settle();
    const other = follow(monitor, OTHER);
    await settle();
    expect(listings).toBe(2);
    // No empty list was sent in between: the server did not vanish.
    expect(followed.lists.map((list) => list.servers.length)).toEqual([1]);
    await expect(
      monitor.stop({ threadId: THREAD, pid: 521, startTimeMs: 1_521, port: 5173 }),
    ).rejects.toMatchObject({ reason: "signal-failed" });
    expect(fake.signals).toEqual([]);
    followed.stop();
    other.stop();
  });

  it("probes titles only for the servers it lists", async () => {
    const ports = Array.from({ length: 40 }, (_, index) => 6000 + index);
    const fake = fakeHost({
      listeners: ports.map((port, index) => listener(900 + index, port)),
      processes: ports.map((_, index) => row(900 + index, 1, 900 + index)),
      markers: Object.fromEntries(ports.map((_, index) => [900 + index, THREAD])),
    });
    const monitor = makeThreadLocalServerMonitor(fake.host, { intervalMs: 60_000 });
    const followed = follow(monitor, THREAD);
    await settle();
    expect(followed.lists[0]?.servers.map((server) => server.port)).toEqual(ports.slice(0, 32));
    expect(fake.titleProbes.toSorted((a, b) => a - b)).toEqual(
      ports.slice(0, 32).map((_, index) => 900 + index),
    );
    followed.stop();
  });

  it("attributes a port only when every process on it carries the same thread", async () => {
    const fake = fakeHost({
      // A forked server: master 800 and worker 801 share the socket.
      listeners: [
        listener(800, 9000),
        listener(801, 9000),
        listener(810, 9100),
        listener(811, 9100),
      ],
      processes: [row(800, 1, 800), row(801, 800, 800), row(810, 1, 810), row(811, 1, 811)],
      markers: { 800: THREAD, 801: THREAD, 810: THREAD, 811: OTHER },
    });
    const monitor = makeThreadLocalServerMonitor(fake.host, { intervalMs: 60_000 });
    const followed = follow(monitor, THREAD);
    await settle();
    expect(followed.lists[0]?.servers.map((server) => [server.port, server.pid])).toEqual([
      [9000, 800],
    ]);
    followed.stop();
  });

  describe("stop", () => {
    const input = { threadId: THREAD, pid: 521, startTimeMs: 1_521, port: 5173 };

    it("sends SIGTERM to the server's own group and reports it stopped", async () => {
      const fake = machine();
      const monitor = makeThreadLocalServerMonitor(fake.host, { intervalMs: 60_000 });
      await expect(monitor.stop(input)).resolves.toEqual({ stopped: true, escalated: false });
      expect(fake.signals).toEqual([[520, "SIGTERM"]]);
    });

    it("sends SIGKILL after the grace period only while an original member is still in the group", async () => {
      const fake = machine();
      fake.ignoreSigterm();
      const monitor = makeThreadLocalServerMonitor(fake.host, { intervalMs: 60_000 });
      await expect(monitor.stop(input)).resolves.toEqual({ stopped: true, escalated: true });
      expect(fake.signals).toEqual([
        [520, "SIGTERM"],
        [520, "SIGKILL"],
      ]);
    });

    it("never sends SIGKILL to a group whose members left, even if its id was reused", async () => {
      const fake = machine();
      // SIGTERM ends the job; a new process (another start time) then reuses pid 521 in group 520.
      const monitor = makeThreadLocalServerMonitor(
        {
          ...fake.host,
          signalGroup: (group, signal) => {
            fake.signals.push([group, signal]);
            fake.setProcesses([row(521, 1, 520, 99_999)]);
            return "sent";
          },
        },
        { intervalMs: 60_000 },
      );
      await expect(monitor.stop(input)).resolves.toEqual({ stopped: true, escalated: false });
      expect(fake.signals).toEqual([[520, "SIGTERM"]]);
    });

    it("refuses a reused pid", async () => {
      const fake = machine();
      const monitor = makeThreadLocalServerMonitor(fake.host, { intervalMs: 60_000 });
      await expect(monitor.stop({ ...input, startTimeMs: 1_000 })).rejects.toMatchObject({
        _tag: "ThreadStopLocalServerError",
        reason: "identity-changed",
      });
      expect(fake.signals).toEqual([]);
    });

    it("refuses an unattributed listener and another thread's server", async () => {
      const fake = machine();
      const monitor = makeThreadLocalServerMonitor(fake.host, { intervalMs: 60_000 });
      await expect(
        monitor.stop({ threadId: THREAD, pid: 700, startTimeMs: 1_700, port: 8080 }),
      ).rejects.toMatchObject({ reason: "not-attributed" });
      await expect(
        monitor.stop({ threadId: THREAD, pid: 610, startTimeMs: 1_610, port: 3000 }),
      ).rejects.toMatchObject({ reason: "not-attributed" });
      expect(fake.signals).toEqual([]);
    });

    it("refuses a pid that does not listen on that port, the server and init", async () => {
      const fake = machine();
      const monitor = makeThreadLocalServerMonitor(fake.host, { intervalMs: 60_000 });
      await expect(monitor.stop({ ...input, port: 5174 })).rejects.toMatchObject({
        reason: "not-found",
      });
      await expect(
        monitor.stop({ ...input, pid: SERVER_PID, startTimeMs: 1_500 }),
      ).rejects.toMatchObject({ reason: "not-found" });
      await expect(monitor.stop({ ...input, pid: 1 })).rejects.toMatchObject({
        reason: "not-found",
      });
      expect(fake.signals).toEqual([]);
    });

    it("refuses a server in the agent CLI's group", async () => {
      // The agent ran the server without a group of its own: it shares the server's group.
      const fake = fakeHost({
        listeners: [listener(522, 5173)],
        processes: [row(522, 510, 500)],
        markers: { 522: THREAD },
      });
      const monitor = makeThreadLocalServerMonitor(fake.host, { intervalMs: 60_000 });
      await expect(
        monitor.stop({ threadId: THREAD, pid: 522, startTimeMs: 1_522, port: 5173 }),
      ).rejects.toMatchObject({ reason: "shared-group" });
      expect(fake.signals).toEqual([]);
    });

    it("reads the marker again instead of trusting the cache", async () => {
      const fake = machine();
      const monitor = makeThreadLocalServerMonitor(fake.host, { intervalMs: 60_000 });
      const followed = follow(monitor, THREAD);
      await settle();
      await monitor.stop(input);
      expect(fake.markerReads[1]).toEqual([521]);
      followed.stop();
    });

    it("fails closed when the fresh process table cannot be read", async () => {
      const fake = machine();
      let reads = 0;
      const monitor = makeThreadLocalServerMonitor(
        {
          ...fake.host,
          // The scan's read succeeds; the stop's own fresh read fails.
          readProcessTable: () => {
            reads += 1;
            return reads === 1 ? fake.host.readProcessTable() : Promise.reject(new Error("ps"));
          },
        },
        { intervalMs: 60_000 },
      );
      await expect(monitor.stop(input)).rejects.toMatchObject({ reason: "signal-failed" });
      expect(reads).toBe(2);
      expect(fake.signals).toEqual([]);
    });

    it("is unsupported on Windows", async () => {
      const fake = machine();
      const monitor = makeThreadLocalServerMonitor(
        { ...fake.host, platform: "win32" },
        { intervalMs: 60_000 },
      );
      await expect(monitor.stop(input)).rejects.toMatchObject({ reason: "unsupported" });
    });
  });
});

const hasLsof = ["/usr/sbin/lsof", "/usr/bin/lsof"].some((path) => existsSync(path));
// A test run from a Ryco thread inherits that thread's marker; these servers must not.
const { RYCO_THREAD_ID: _inheritedMarker, ...inheritedEnv } = process.env;

/**
 * The real host: `lsof`, `ps` (and `ps -E` on macOS, `/proc` on Linux), the title probe and a
 * group stop, against servers this test starts the way an agent's backgrounded job runs.
 */
describe.runIf((process.platform === "darwin" || process.platform === "linux") && hasLsof)(
  "thread local server monitor on this machine",
  () => {
    const children: Array<number> = [];
    let directory: string | null = null;

    afterEach(async () => {
      for (const pid of children.splice(0)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      if (directory) await rm(directory, { recursive: true, force: true });
      directory = null;
    });

    /**
     * Starts `node server.js <args>` in the background of a detached `sh`, which exits at once:
     * the server is reparented and keeps the shell's process group, like a job an agent's tool
     * shell put in the background. Resolves with its pid and port.
     */
    const startServer = async (env: Record<string, string>, args: ReadonlyArray<string> = []) => {
      directory ??= await mkdtemp(path.join(os.tmpdir(), "ryco-thread-servers-"));
      const script = path.join(directory, "server.cjs");
      await writeFile(
        script,
        [
          'const http = require("node:http");',
          "const server = http.createServer((_request, response) => {",
          '  response.writeHead(200, { "content-type": "text/html" });',
          '  response.end("<title>Thread server</title>");',
          "});",
          'server.listen(0, "127.0.0.1", () => {',
          "  process.stdout.write(`${process.pid} ${server.address().port}\\n`);",
          "});",
          "setTimeout(() => process.exit(0), 60_000);",
        ].join("\n"),
      );
      const quoted = [process.execPath, script, ...args].map((arg) => `'${arg}'`).join(" ");
      const shell = spawn("/bin/sh", ["-c", `${quoted} &`], {
        detached: true,
        env: { ...inheritedEnv, ...env },
        stdio: ["ignore", "pipe", "ignore"],
      });
      const line = await new Promise<string>((resolve, reject) => {
        let output = "";
        shell.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes("\n")) resolve(output.trim());
        });
        shell.on("error", reject);
      });
      shell.stdout.destroy();
      const [pid, port] = line.split(" ").map(Number);
      children.push(pid!);
      return { pid: pid!, port: port! };
    };

    it("lists a thread's server by its environment, probes its title and stops its group", async () => {
      const threadId = ThreadId.make(`thread-system-${process.pid}`);
      const marked = await startServer({ RYCO_THREAD_ID: threadId });
      // Spelling the marker out in the arguments attributes nothing.
      const spoofed = await startServer({}, [`RYCO_THREAD_ID=${threadId}`]);
      const monitor = makeThreadLocalServerMonitor(systemLocalServerHost(), {
        intervalMs: 60_000,
      });
      const list = await new Promise<ThreadLocalServerList>((resolve) => {
        const stop = monitor.subscribe(threadId, (next) => {
          stop();
          resolve(next);
        });
      });
      expect(list.servers.map((server) => server.port)).toEqual([marked.port]);
      expect(list.servers[0]).toMatchObject({
        pid: marked.pid,
        host: "127.0.0.1",
        pageTitle: "Thread server",
        // Its launching shell exited: nothing of this test process is above it any more.
        origin: "unknown",
      });
      expect(list.servers.some((server) => server.port === spoofed.port)).toBe(false);

      const server = list.servers[0]!;
      await expect(
        monitor.stop({
          threadId,
          pid: server.pid,
          startTimeMs: server.startTimeMs,
          port: server.port,
        }),
      ).resolves.toEqual({ stopped: true, escalated: false });
      expect(() => process.kill(marked.pid, 0)).toThrow();
      // The other server was in its own group and keeps running.
      expect(() => process.kill(spoofed.pid, 0)).not.toThrow();
    }, 30_000);
  },
);
