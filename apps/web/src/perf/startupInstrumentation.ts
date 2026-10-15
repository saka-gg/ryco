const STARTUP_PREFIX = "ryco:startup:";

export type StartupPhase =
  | "root-before-load-start"
  | "root-before-load-ready"
  /** The root shell chunk resolved inside `beforeLoad` (it was not already loaded). */
  | "root-shell-module-ready"
  | "primary-ws-open"
  /** The first raw shell-subscription frame arrived, before JSON/Schema decoding. */
  | "primary-shell-frame-received"
  /** The primary environment's last-known shell was painted from the local cache. */
  | "primary-shell-cache-hydrated"
  /** React committed the sidebar with that cached (not yet live) primary shell. */
  | "primary-cached-sidebar-committed"
  | "primary-shell-snapshot-received"
  | "primary-shell-snapshot-applied"
  | "primary-shell-usable"
  /** React committed the sidebar with the primary environment's bootstrapped shell. */
  | "primary-sidebar-committed"
  /** The frame holding that sidebar commit was presented (rAF, then a task). */
  | "primary-shell-painted"
  /** The frame holding the first committed thread view (the routed thread) was presented. */
  | "first-thread-painted";

/**
 * Measures recorded when their end phase is marked through
 * `measureStartupPhasesEndingAt` (`ryco:startup:<name>`). A null start
 * measures from navigation start. The external perf harness reads every
 * `ryco:startup:*` measure.
 */
export const STARTUP_MEASURES: ReadonlyArray<
  readonly [name: string, start: StartupPhase | null, end: StartupPhase]
> = [
  ["primary-sidebar-commit", "primary-shell-usable", "primary-sidebar-committed"],
  ["primary-shell-paint", "primary-sidebar-committed", "primary-shell-painted"],
  ["primary-shell-painted", null, "primary-shell-painted"],
  ["primary-cached-sidebar-committed", null, "primary-cached-sidebar-committed"],
];

const reachedPhases = new Set<StartupPhase>();
const phasesAwaitingPaint = new Set<StartupPhase>();
const phaseListeners = new Map<StartupPhase, Set<() => void>>();

function canUsePerformance(): boolean {
  return typeof performance !== "undefined" && typeof performance.mark === "function";
}

export function makeStartupMarkName(phase: StartupPhase): string {
  return `${STARTUP_PREFIX}${phase}`;
}

function notifyPhaseReached(phase: StartupPhase): void {
  if (reachedPhases.has(phase)) return;
  reachedPhases.add(phase);
  const listeners = phaseListeners.get(phase);
  if (!listeners) return;
  phaseListeners.delete(phase);
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A listener failure must never affect startup.
    }
  }
}

export function markStartupPhase(phase: StartupPhase): void {
  notifyPhaseReached(phase);
  if (!canUsePerformance()) return;
  try {
    performance.mark(makeStartupMarkName(phase));
  } catch {
    // Startup instrumentation must never affect startup behavior.
  }
}

/** Whether `phase` was marked in this document. */
export function hasReachedStartupPhase(phase: StartupPhase): boolean {
  return reachedPhases.has(phase);
}

/**
 * Runs `listener` once `phase` is marked (immediately when it already was).
 * Returns a cancel function. Used to order deferred work, such as idle chunk
 * preloads, behind the boot-critical phases.
 */
export function onStartupPhase(phase: StartupPhase, listener: () => void): () => void {
  if (reachedPhases.has(phase)) {
    listener();
    return () => undefined;
  }
  let listeners = phaseListeners.get(phase);
  if (!listeners) {
    listeners = new Set();
    phaseListeners.set(phase, listeners);
  }
  listeners.add(listener);
  return () => {
    phaseListeners.get(phase)?.delete(listener);
  };
}

export function measureStartupPhase(
  name: string,
  startPhase: StartupPhase,
  endPhase: StartupPhase,
): void {
  if (!canUsePerformance() || typeof performance.measure !== "function") return;
  try {
    performance.measure(`${STARTUP_PREFIX}${name}`, {
      start: makeStartupMarkName(startPhase),
      end: makeStartupMarkName(endPhase),
    });
  } catch {
    // Missing marks are expected on partial startup paths.
  }
}

/** Records every `STARTUP_MEASURES` entry ending at `endPhase` whose start is marked. */
export function measureStartupPhasesEndingAt(endPhase: StartupPhase): void {
  for (const [name, start, end] of STARTUP_MEASURES) {
    if (end !== endPhase) continue;
    if (start === null) measureFromNavigationStart(name, end);
    else if (reachedPhases.has(start)) measureStartupPhase(name, start, end);
  }
}

function measureFromNavigationStart(name: string, endPhase: StartupPhase): void {
  if (!canUsePerformance() || typeof performance.measure !== "function") return;
  try {
    performance.measure(`${STARTUP_PREFIX}${name}`, { end: makeStartupMarkName(endPhase) });
  } catch {
    // Missing marks are expected on partial startup paths.
  }
}

/**
 * Marks `phase` once the frame holding the current commit has been presented:
 * `requestAnimationFrame` runs before that frame's paint, and a MessageChannel
 * task queued from it runs after the paint.
 */
export function markStartupPhaseAfterPaint(phase: StartupPhase): void {
  if (reachedPhases.has(phase) || phasesAwaitingPaint.has(phase)) return;
  phasesAwaitingPaint.add(phase);
  const mark = () => {
    phasesAwaitingPaint.delete(phase);
    markStartupPhase(phase);
    measureStartupPhasesEndingAt(phase);
  };
  if (typeof requestAnimationFrame !== "function" || typeof MessageChannel !== "function") {
    globalThis.setTimeout(mark, 0);
    return;
  }
  requestAnimationFrame(() => {
    const channel = new MessageChannel();
    channel.port1.addEventListener(
      "message",
      () => {
        channel.port1.close();
        mark();
      },
      { once: true },
    );
    // `addEventListener` (unlike `onmessage`) does not start the port.
    channel.port1.start();
    channel.port2.postMessage(undefined);
  });
}

/**
 * `ORCHESTRATION_WS_METHODS.subscribeShell`, spelled out so this module stays
 * free of the contracts barrel (it is part of the boot graph); a unit test
 * pins the two together.
 */
export const SHELL_SUBSCRIPTION_RPC_TAG = "orchestration.subscribeShell";

/**
 * Transport hooks for the primary socket that mark `primary-shell-frame-received`
 * when the first shell-subscription chunk comes off the wire — before its JSON
 * parse and Schema decode, which run inside the RPC layer before
 * `primary-shell-snapshot-received` — so the decode shows up as
 * `ryco:startup:primary-shell-decode`. Both hooks stand down once marked, so
 * only the few frames before the first snapshot are inspected.
 */
export function createPrimaryShellFrameProbe<
  Socket extends Pick<EventTarget, "addEventListener" | "removeEventListener">,
>(
  createSocket: (url: string, protocols?: string | ReadonlyArray<string>) => Socket,
): {
  readonly onRequestStart: (info: { readonly id: string; readonly tag: string }) => void;
  readonly webSocketConstructor: (
    url: string,
    protocols?: string | ReadonlyArray<string>,
  ) => Socket;
} {
  let shellRequestPattern: RegExp | null = null;
  return {
    onRequestStart: (info) => {
      if (info.tag !== SHELL_SUBSCRIPTION_RPC_TAG) return;
      if (reachedPhases.has("primary-shell-frame-received")) return;
      const id = info.id.replace(/[^\w-]/g, "");
      shellRequestPattern = new RegExp(`"_tag":"Chunk","requestId":"?${id}"?[,}]`);
    },
    webSocketConstructor: (url, protocols) => {
      const socket = createSocket(url, protocols);
      if (reachedPhases.has("primary-shell-frame-received")) return socket;
      const onMessage = (event: Event) => {
        if (reachedPhases.has("primary-shell-frame-received")) {
          socket.removeEventListener("message", onMessage);
          return;
        }
        const data: unknown = (event as MessageEvent).data;
        if (shellRequestPattern === null || typeof data !== "string") return;
        if (!shellRequestPattern.test(data)) return;
        socket.removeEventListener("message", onMessage);
        markStartupPhase("primary-shell-frame-received");
      };
      socket.addEventListener("message", onMessage);
      return socket;
    },
  };
}

export function resetStartupPhasesForTests(): void {
  reachedPhases.clear();
  phasesAwaitingPaint.clear();
  phaseListeners.clear();
}
