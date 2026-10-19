const NODE_SWITCH_PREFIX = "ryco:node-switch:";

/**
 * Phases of a hosted node switch. The transport phases mirror the hosted relay
 * transport statuses by name; the rest are recorded by the hosted telemetry
 * (route, shell snapshot, mutation readiness) and by the thread view
 * (`content-painted`).
 */
export type NodeSwitchPhase =
  | "intent"
  | "route"
  | "requesting-ticket"
  | "connecting"
  | "authenticating"
  | "opening-channel"
  | "online"
  | "shell-accepted"
  | "mutation-ready"
  | "content-painted";

export type NodeSwitchOrigin = "press" | "route";

/** One switch as the external probe reads it. Phase values are ms since the intent. */
export interface NodeSwitchTimeline {
  readonly n: number;
  readonly phases: Readonly<Partial<Record<NodeSwitchPhase, number>>>;
  /** Hub session version of the switch, or null when unknown. */
  readonly hubSessionVersion: 1 | 2 | null;
  /** Whether the environment was already online and established at the intent. */
  readonly warm: boolean | null;
  readonly origin: NodeSwitchOrigin;
}

export interface NodeSwitchContext {
  readonly hubSessionVersion: 1 | 2 | null;
  readonly warm: boolean | null;
}

/** Switches kept for the probe; older ones leave the buffer with their marks and measures. */
export const NODE_SWITCH_TIMELINE_LIMIT = 20;

/** A second intent for the same environment inside this window is the same switch. */
export const NODE_SWITCH_DEDUPE_WINDOW_MS = 1_000;

interface ActiveSwitch {
  readonly n: number;
  readonly environmentId: string;
  readonly startedAt: number;
  readonly origin: NodeSwitchOrigin;
  readonly phases: Partial<Record<NodeSwitchPhase, number>>;
  hubSessionVersion: 1 | 2 | null;
  warm: boolean | null;
}

/** Oldest first; the last entry is the current switch. */
let switches: ActiveSwitch[] = [];
let lastSwitchNumber = 0;

function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function makeNodeSwitchName(phase: NodeSwitchPhase, n: number): string {
  return `${NODE_SWITCH_PREFIX}${phase}:${n}`;
}

function currentSwitch(): ActiveSwitch | null {
  return switches.length === 0 ? null : switches[switches.length - 1]!;
}

function recordMark(phase: NodeSwitchPhase, n: number): void {
  if (typeof performance === "undefined" || typeof performance.mark !== "function") return;
  try {
    performance.mark(makeNodeSwitchName(phase, n));
  } catch {
    // Instrumentation must never affect a node switch.
  }
}

function recordMeasure(phase: NodeSwitchPhase, n: number): void {
  if (typeof performance === "undefined" || typeof performance.measure !== "function") return;
  try {
    performance.measure(makeNodeSwitchName(phase, n), makeNodeSwitchName("intent", n));
  } catch {
    // The intent mark may have been cleared by someone else; nothing to measure from.
  }
}

/**
 * Clears the marks and measures of a switch that left the buffer. Names carry
 * the switch number, so this can never touch a newer switch's entries.
 */
function clearSwitchEntries(evicted: ActiveSwitch): void {
  const canClearMarks =
    typeof performance !== "undefined" && typeof performance.clearMarks === "function";
  const canClearMeasures =
    typeof performance !== "undefined" && typeof performance.clearMeasures === "function";
  if (!canClearMarks && !canClearMeasures) return;
  for (const phase of Object.keys(evicted.phases) as NodeSwitchPhase[]) {
    const name = makeNodeSwitchName(phase, evicted.n);
    try {
      if (canClearMarks) performance.clearMarks(name);
      if (canClearMeasures) performance.clearMeasures(name);
    } catch {
      // Best effort: stale entries are bounded by the buffer size anyway.
    }
  }
}

/**
 * Starts a node switch toward `environmentId`, unless one toward the same
 * environment started less than a second ago (a press followed by its route
 * publication counts once).
 */
export function markNodeSwitchIntent(environmentId: string, origin: NodeSwitchOrigin): void {
  const at = now();
  const current = currentSwitch();
  if (
    current !== null &&
    current.environmentId === environmentId &&
    at - current.startedAt < NODE_SWITCH_DEDUPE_WINDOW_MS
  ) {
    return;
  }
  lastSwitchNumber += 1;
  const started: ActiveSwitch = {
    n: lastSwitchNumber,
    environmentId,
    startedAt: at,
    origin,
    phases: { intent: 0 },
    hubSessionVersion: null,
    warm: null,
  };
  switches.push(started);
  if (switches.length > NODE_SWITCH_TIMELINE_LIMIT) {
    const evicted = switches.shift()!;
    clearSwitchEntries(evicted);
  }
  recordMark("intent", started.n);
}

/**
 * Records `phase` for the current switch the first time it is reached.
 * Ignored when no switch is current, when it targets another environment, or
 * when the phase was already recorded.
 *
 * A switch is complete once it is mutation-ready: later connection activity of
 * the same environment (a reconnect minutes afterwards) is not part of it, so
 * only `content-painted`, which can land after readiness, is still accepted.
 */
export function markNodeSwitchPhase(phase: NodeSwitchPhase, environmentId: string): void {
  const current = currentSwitch();
  if (current === null || current.environmentId !== environmentId) return;
  if (current.phases[phase] !== undefined) return;
  if (phase !== "content-painted" && current.phases["mutation-ready"] !== undefined) return;
  current.phases[phase] = now() - current.startedAt;
  recordMark(phase, current.n);
  recordMeasure(phase, current.n);
}

/** Annotates the current switch; later calls overwrite earlier ones. */
export function setNodeSwitchContext(context: NodeSwitchContext): void {
  const current = currentSwitch();
  if (current === null) return;
  current.hubSessionVersion = context.hubSessionVersion;
  current.warm = context.warm;
}

function snapshot(entry: ActiveSwitch): NodeSwitchTimeline {
  return Object.freeze({
    n: entry.n,
    phases: Object.freeze({ ...entry.phases }),
    hubSessionVersion: entry.hubSessionVersion,
    warm: entry.warm,
    origin: entry.origin,
  });
}

/** The recent switches, oldest first, the current one last. No ids or labels. */
export function readNodeSwitchTimelines(): ReadonlyArray<NodeSwitchTimeline> {
  return Object.freeze(switches.map(snapshot));
}

/** The current switch, if any. */
export function readNodeSwitchTimeline(): NodeSwitchTimeline | null {
  const current = currentSwitch();
  return current === null ? null : snapshot(current);
}

export function resetNodeSwitchInstrumentationForTests(): void {
  switches = [];
  lastSwitchNumber = 0;
}

// Read-only exposure for the external probe: a function, no data on the global.
try {
  Object.defineProperty(globalThis, "__rycoNodeSwitchTimelines", {
    value: readNodeSwitchTimelines,
    configurable: true,
  });
} catch {
  // A locked-down global leaves the marks and measures as the only readout.
}
