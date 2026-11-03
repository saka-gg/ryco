/**
 * The servers each thread started, and their safe stop (docs/thread-servers.md). The RPC handlers
 * import this module with the first `threads.subscribeLocalServers` or `threads.stopLocalServer`:
 * nothing here is needed at boot, and the server's boot chunks have a size budget
 * (`serverBundleBoundaries.test.ts`).
 *
 * One process-wide monitor scans only while a client follows a thread: right away, then every
 * 3 s, and not at all once the last subscription closes (its caches are dropped then, since pids
 * can be reused). A scan lists the loopback and wildcard TCP listeners, reads each listener's
 * thread marker once per process (pid and start time), and probes page titles only for servers
 * of the threads followed now.
 *
 * A stop names a server by pid, start time and port. It scans again without caches, requires the
 * same process still listening on that port and attributed to that thread, reads the process
 * table fresh (failing closed), refuses a process group shared with this server, its ancestors,
 * an agent CLI or a terminal shell, then sends SIGTERM to the group and SIGKILL after 3 s only
 * while one of the group's original members is still in it (T3 Code's rule).
 *
 * @module threadLocalServerMonitor
 */
import {
  THREAD_LOCAL_SERVERS_MAX,
  ThreadId,
  type ThreadLocalServer,
  type ThreadLocalServerList,
  ThreadLocalServersError,
  ThreadStopLocalServerError,
  type ThreadStopLocalServerFailureReason,
  type ThreadStopLocalServerInput,
  type ThreadStopLocalServerResult,
} from "@ryco/contracts";
import { Effect, Queue, Schema, Stream } from "effect";

import {
  isSharedProcessGroup,
  listenerOrigin,
  type LocalListener,
  type ProcessTable,
  readLocalListeners,
  readProcessTable,
  readThreadMarkers,
  signalProcessGroup,
  stoppableProcessGroup,
} from "./localServerScan.ts";
import {
  allowsTitleProbe,
  makeTitleProbe,
  TITLE_CONCURRENCY,
  type TitleProbe,
} from "./localServerTitles.ts";

export const SCAN_INTERVAL_MS = 3_000;
export const STOP_GRACE_MS = 3_000;
export const STOP_POLL_MS = 250;
/** Threads one connection follows at once; more are refused with `limit`. */
export const MAX_SUBSCRIPTIONS_PER_CONNECTION = 16;
/** Lists queued for a slow client; older ones are dropped, each list is complete. */
const LIST_BUFFER = 4;

/** What the monitor reads and signals; tests replace it. */
export interface LocalServerHost {
  readonly platform: NodeJS.Platform;
  readonly serverPid: number;
  readonly listListeners: () => Promise<ReadonlyArray<LocalListener> | null>;
  readonly readProcessTable: () => Promise<ProcessTable>;
  readonly readThreadMarkers: (
    pids: ReadonlyArray<number>,
  ) => Promise<ReadonlyMap<number, string | null>>;
  readonly signalGroup: (group: number, signal: "SIGTERM" | "SIGKILL") => "sent" | "gone";
  readonly titles: TitleProbe;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

export const systemLocalServerHost = (): LocalServerHost => ({
  platform: process.platform,
  serverPid: process.pid,
  listListeners: readLocalListeners,
  readProcessTable,
  readThreadMarkers: (pids) => readThreadMarkers(pids),
  signalGroup: signalProcessGroup,
  titles: makeTitleProbe(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms).unref?.();
    }),
  now: Date.now,
});

/** One port's server as a scan found it, before titles. */
interface AttributedServer {
  readonly threadId: string;
  readonly pid: number;
  readonly startTimeMs: number;
  readonly port: number;
  readonly host: string;
  readonly processName: string | null;
  readonly origin: ThreadLocalServer["origin"];
}

interface Snapshot {
  readonly table: ProcessTable;
  /** Every listening pid on each local port. */
  readonly listenersByPort: ReadonlyMap<number, ReadonlyArray<LocalListener>>;
  readonly markers: ReadonlyMap<number, string | null>;
  readonly servers: ReadonlyArray<AttributedServer>;
}

const EMPTY_SNAPSHOT: Snapshot = {
  table: new Map(),
  listenersByPort: new Map(),
  markers: new Map(),
  servers: [],
};

const hostRank = (host: string) => (host === "*" ? 0 : host.startsWith("127.") ? 1 : 2);

/**
 * The servers a scan attributes, one per port. A port is attributed only when every process
 * listening on it carries the same thread (a forked server's workers share its socket); its
 * server is the one whose parent is not among them.
 */
export function attributeListeners(input: {
  readonly listeners: ReadonlyArray<LocalListener>;
  readonly table: ProcessTable;
  readonly markers: ReadonlyMap<number, string | null>;
  readonly serverPid: number;
}): {
  readonly listenersByPort: ReadonlyMap<number, ReadonlyArray<LocalListener>>;
  readonly servers: ReadonlyArray<AttributedServer>;
} {
  const listenersByPort = new Map<number, LocalListener[]>();
  for (const listener of input.listeners) {
    if (listener.pid === input.serverPid || !input.table.has(listener.pid)) continue;
    const onPort = listenersByPort.get(listener.port) ?? [];
    onPort.push(listener);
    listenersByPort.set(listener.port, onPort);
  }
  const servers: AttributedServer[] = [];
  for (const [port, listeners] of listenersByPort) {
    const pids = new Set(listeners.map((listener) => listener.pid));
    const threads = new Set([...pids].map((pid) => input.markers.get(pid) ?? null));
    const [threadId] = threads;
    if (threads.size !== 1 || threadId === null || threadId === undefined) continue;
    const pid =
      [...pids]
        .filter((each) => !pids.has(input.table.get(each)?.ppid ?? 0))
        .toSorted((a, b) => a - b)[0] ?? [...pids].toSorted((a, b) => a - b)[0]!;
    const row = input.table.get(pid)!;
    const own = listeners.filter((listener) => listener.pid === pid);
    const host = own
      .map((listener) => listener.host)
      .toSorted((a, b) => hostRank(a) - hostRank(b))[0]!;
    servers.push({
      threadId,
      pid,
      startTimeMs: row.startTimeMs,
      port,
      host,
      processName: own[0]?.processName ?? null,
      origin: listenerOrigin(input.table, pid, input.serverPid),
    });
  }
  return { listenersByPort, servers: servers.toSorted((a, b) => a.port - b.port) };
}

type Listener = (list: ThreadLocalServerList) => void;

export interface ThreadLocalServerMonitor {
  /** Calls `listener` with the thread's list after the next scan and whenever it changes. */
  readonly subscribe: (threadId: ThreadId, listener: Listener) => () => void;
  readonly stop: (input: ThreadStopLocalServerInput) => Promise<ThreadStopLocalServerResult>;
  /** Threads followed now, for tests. */
  readonly followedThreads: () => ReadonlyArray<string>;
}

const isStopFailure = Schema.is(ThreadStopLocalServerError);

const stopFailure = (reason: ThreadStopLocalServerFailureReason) =>
  new ThreadStopLocalServerError({
    reason,
    message:
      reason === "not-found"
        ? "That server is no longer running."
        : reason === "identity-changed"
          ? "That process is no longer the server that was listed."
          : reason === "not-attributed"
            ? "That server does not belong to this thread."
            : reason === "shared-group"
              ? "That server shares its process group with the agent, a terminal or Ryco itself, so it cannot be stopped from here."
              : reason === "unsupported"
                ? "Stopping servers is not supported on this computer."
                : "The server could not be stopped.",
  });

export function makeThreadLocalServerMonitor(
  host: LocalServerHost,
  options: { readonly intervalMs?: number } = {},
): ThreadLocalServerMonitor {
  const intervalMs = options.intervalMs ?? SCAN_INTERVAL_MS;
  const listeners = new Map<string, Set<Listener>>();
  const lastSent = new Map<Listener, string>();
  /** Each listener process's marker, by pid and start time: an environment never changes. */
  const markerCache = new Map<string, string | null>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Scans run one at a time; a stop's scan waits for a periodic one. */
  let scanChain: Promise<unknown> = Promise.resolve();
  let tickRunning = false;
  let tickAgain = false;

  const following = () => listeners.size > 0;

  const scanUnlocked = async (forget?: number): Promise<Snapshot> => {
    const found = await host.listListeners();
    // A failed listing is not an empty one: the tick keeps the last lists, a stop refuses.
    if (found === null) throw new Error("Could not list the listening sockets.");
    if (found.length === 0) return { ...EMPTY_SNAPSHOT };
    const table = await host.readProcessTable();
    const keyOf = (pid: number) => `${pid}:${table.get(pid)?.startTimeMs ?? 0}`;
    const pids = [...new Set(found.map((listener) => listener.pid))].filter(
      (pid) => pid !== host.serverPid && table.has(pid),
    );
    if (forget !== undefined) markerCache.delete(keyOf(forget));
    const unread = pids.filter((pid) => !markerCache.has(keyOf(pid)));
    const read = unread.length > 0 ? await host.readThreadMarkers(unread) : new Map();
    // Only answers are kept: a pid that could not be read now is read again on the next scan
    // (until then it is not attributed).
    for (const pid of unread) {
      if (read.has(pid)) markerCache.set(keyOf(pid), read.get(pid) ?? null);
    }
    const current = new Set(pids.map(keyOf));
    for (const key of markerCache.keys()) if (!current.has(key)) markerCache.delete(key);
    const markers = new Map(pids.map((pid) => [pid, markerCache.get(keyOf(pid)) ?? null]));
    const attributed = attributeListeners({
      listeners: found,
      table,
      markers,
      serverPid: host.serverPid,
    });
    return { table, markers, ...attributed };
  };

  const scan = (forget?: number): Promise<Snapshot> => {
    const run = scanChain.then(() => scanUnlocked(forget));
    scanChain = run.catch(() => undefined);
    return run;
  };

  const withTitles = async (
    servers: ReadonlyArray<AttributedServer>,
  ): Promise<ReadonlyArray<ThreadLocalServer & { readonly threadId: string }>> => {
    // Per followed thread only the servers it is sent: its lowest ports, up to the list's cap.
    const shown = new Map<string, number>();
    const wanted = servers.filter((server) => {
      if (!listeners.has(server.threadId)) return false;
      const count = shown.get(server.threadId) ?? 0;
      shown.set(server.threadId, count + 1);
      return count < THREAD_LOCAL_SERVERS_MAX;
    });
    const titled: Array<ThreadLocalServer & { readonly threadId: string }> = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(TITLE_CONCURRENCY, wanted.length) }, async () => {
        while (next < wanted.length) {
          const server = wanted[next++]!;
          const pageTitle = allowsTitleProbe(server.processName)
            ? await host.titles.title(`${server.pid}:${server.startTimeMs}:${server.port}`, server)
            : null;
          titled.push({
            threadId: server.threadId,
            pid: server.pid,
            startTimeMs: server.startTimeMs,
            port: server.port,
            host: server.host,
            url: `http://localhost:${server.port}/`,
            processName: server.processName,
            pageTitle,
            origin: server.origin,
          });
        }
      }),
    );
    return titled.toSorted((a, b) => a.port - b.port);
  };

  const listFor = (
    threadId: string,
    servers: ReadonlyArray<ThreadLocalServer & { readonly threadId: string }>,
    scannedAt: string,
  ): ThreadLocalServerList => ({
    threadId: ThreadId.make(threadId),
    servers: servers
      .filter((server) => server.threadId === threadId)
      .slice(0, THREAD_LOCAL_SERVERS_MAX)
      .map(({ threadId: _threadId, ...server }) => server),
    scannedAt,
  });

  const publish = (servers: ReadonlyArray<ThreadLocalServer & { readonly threadId: string }>) => {
    const scannedAt = new Date(host.now()).toISOString();
    for (const [threadId, threadListeners] of listeners) {
      const list = listFor(threadId, servers, scannedAt);
      const fingerprint = JSON.stringify(list.servers);
      for (const listener of threadListeners) {
        if (lastSent.get(listener) === fingerprint) continue;
        lastSent.set(listener, fingerprint);
        listener(list);
      }
    }
  };

  const schedule = () => {
    if (timer !== null || !following()) return;
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, intervalMs);
    timer.unref?.();
  };

  /** Scans and publishes; a call during a scan runs one more after it. */
  const tick = async (): Promise<void> => {
    if (!following()) return;
    if (tickRunning) {
      tickAgain = true;
      return;
    }
    tickRunning = true;
    try {
      do {
        tickAgain = false;
        try {
          const snapshot = await scan();
          if (following()) publish(await withTitles(snapshot.servers));
        } catch {
          // A failed read (ps or lsof over its limits) keeps the last lists; the next tick retries.
        }
      } while (tickAgain && following());
    } finally {
      tickRunning = false;
      // The last follower may have left during the scan, which then refilled the caches.
      if (following()) schedule();
      else release();
    }
  };

  const release = () => {
    if (following()) return;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    markerCache.clear();
    host.titles.clear();
  };

  const subscribe: ThreadLocalServerMonitor["subscribe"] = (threadId, listener) => {
    const threadListeners = listeners.get(threadId) ?? new Set();
    threadListeners.add(listener);
    listeners.set(threadId, threadListeners);
    void tick();
    return () => {
      lastSent.delete(listener);
      const current = listeners.get(threadId);
      if (!current?.delete(listener)) return;
      if (current.size === 0) listeners.delete(threadId);
      release();
    };
  };

  const stop: ThreadLocalServerMonitor["stop"] = async (input) => {
    if (host.platform === "win32") throw stopFailure("unsupported");
    if (input.pid <= 1 || input.pid === host.serverPid) throw stopFailure("not-found");
    try {
      // The pid comes from a client: its listener, identity and thread are read again now.
      const snapshot = await scan(input.pid).catch(() => {
        throw stopFailure("signal-failed");
      });
      const onPort = snapshot.listenersByPort.get(input.port) ?? [];
      if (!onPort.some((listener) => listener.pid === input.pid)) throw stopFailure("not-found");
      if (snapshot.table.get(input.pid)?.startTimeMs !== input.startTimeMs) {
        throw stopFailure("identity-changed");
      }
      const attributed = snapshot.servers.find((server) => server.port === input.port);
      if (
        snapshot.markers.get(input.pid) !== input.threadId ||
        attributed?.threadId !== input.threadId
      ) {
        throw stopFailure("not-attributed");
      }
      // A fresh table, failing closed: an empty one must never read as everything having exited.
      const table = await host.readProcessTable().catch(() => {
        throw stopFailure("signal-failed");
      });
      const row = table.get(input.pid);
      if (row === undefined) return { stopped: true, escalated: false };
      if (row.startTimeMs !== input.startTimeMs) throw stopFailure("identity-changed");
      const group = stoppableProcessGroup(table, input.pid, host.serverPid);
      if (group === null) throw stopFailure("shared-group");
      const members = [...table.values()]
        .filter((each) => each.pgid === group)
        .map((each) => ({ pid: each.pid, startTimeMs: each.startTimeMs }));
      const signal = (name: "SIGTERM" | "SIGKILL") => {
        try {
          return host.signalGroup(group, name);
        } catch {
          throw stopFailure("signal-failed");
        }
      };
      if (signal("SIGTERM") === "gone") return { stopped: true, escalated: false };
      // While one of the group's original members is still in it, the group has not been reused,
      // so SIGKILL reaches only the job that ignored SIGTERM.
      const deadline = host.now() + STOP_GRACE_MS;
      let latest = table;
      while (host.now() < deadline) {
        await host.sleep(STOP_POLL_MS);
        const read = await host.readProcessTable().catch(() => null);
        // Without a table the group cannot be told apart from a reused one: no SIGKILL.
        if (read === null) return { stopped: false, escalated: false };
        latest = read;
        const running = members.some(
          (member) =>
            latest.get(member.pid)?.pgid === group &&
            latest.get(member.pid)?.startTimeMs === member.startTimeMs,
        );
        if (!running) return { stopped: true, escalated: false };
      }
      // Something joined the group that must not be signaled: leave it running.
      if (isSharedProcessGroup(latest, group, host.serverPid)) {
        return { stopped: false, escalated: false };
      }
      return signal("SIGKILL") === "gone"
        ? { stopped: true, escalated: false }
        : { stopped: true, escalated: true };
    } finally {
      // Followers see the server leave now rather than on the next tick; without any, the
      // stop's own reads are not kept.
      void tick();
      release();
    }
  };

  return {
    subscribe,
    stop,
    followedThreads: () => [...listeners.keys()],
  };
}

let systemMonitor: ThreadLocalServerMonitor | null = null;

/** The node's one monitor, created with the first subscription or stop. */
export function threadLocalServerMonitor(): ThreadLocalServerMonitor {
  systemMonitor ??= makeThreadLocalServerMonitor(systemLocalServerHost());
  return systemMonitor;
}

const supported = (platform: NodeJS.Platform) => platform === "darwin" || platform === "linux";

/**
 * `threads.subscribeLocalServers`: the thread's list after the first scan, then each change.
 * `connection` counts this connection's subscriptions, which are capped.
 */
export function streamThreadLocalServers(
  input: { readonly threadId: ThreadId },
  connection: { active: number },
  monitor: ThreadLocalServerMonitor = threadLocalServerMonitor(),
  platform: NodeJS.Platform = process.platform,
): Stream.Stream<ThreadLocalServerList, ThreadLocalServersError> {
  if (!supported(platform)) {
    return Stream.fail(
      new ThreadLocalServersError({
        reason: "unsupported",
        message: "Listing a thread's servers is not supported on this computer.",
      }),
    );
  }
  return Stream.callback<ThreadLocalServerList, ThreadLocalServersError>(
    (queue) =>
      Effect.acquireRelease(
        Effect.suspend(() => {
          if (connection.active >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
            return Effect.fail(
              new ThreadLocalServersError({
                reason: "limit",
                message: "This connection already follows as many threads' servers as it may.",
              }),
            );
          }
          connection.active += 1;
          const unsubscribe = monitor.subscribe(input.threadId, (list) => {
            Queue.offerUnsafe(queue, list);
          });
          return Effect.succeed(unsubscribe);
        }),
        (unsubscribe) =>
          Effect.sync(() => {
            connection.active -= 1;
            unsubscribe();
          }),
      ),
    { bufferSize: LIST_BUFFER, strategy: "sliding" },
  );
}

/** `threads.stopLocalServer`. */
export function stopThreadLocalServer(
  input: ThreadStopLocalServerInput,
  monitor: ThreadLocalServerMonitor = threadLocalServerMonitor(),
): Effect.Effect<ThreadStopLocalServerResult, ThreadStopLocalServerError> {
  return Effect.tryPromise({
    try: () => monitor.stop(input),
    catch: (cause) => (isStopFailure(cause) ? cause : stopFailure("signal-failed")),
  });
}
