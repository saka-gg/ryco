/**
 * Development-only React render counter, driven by
 * `apps/mobile/scripts/measure-renders.mts` through Metro's Hermes inspector.
 *
 * `index.ts` loads this module only under `__DEV__ &&
 * process.env.EXPO_PUBLIC_RYCO_RENDER_COUNTER === "1"`: Metro folds `__DEV__`
 * away before it collects dependencies, so a release bundle never contains it,
 * and the flag keeps it off in ordinary dev sessions. It has no UI, no
 * persistence and no telemetry; the only way to read it is the inspector.
 *
 * It wraps the React DevTools hook's commit callback and walks each committed
 * fiber tree. That reads React internals (fiber tags, the `PerformedWork` flag,
 * the hook list), which `renderCounter.test.ts` pins: a React upgrade that
 * changes them breaks those tests, not the app. A walk that throws anyway is
 * caught and counted in `status().walkErrors`; React's commit always proceeds.
 *
 * What counts as a render: a component fiber that did work in this commit and
 * was committed. A function component React called and then bailed out of
 * (same props and state) is not counted; neither is a render React threw away.
 */

/** The fiber fields the walk reads. It never writes to a fiber. */
export interface Fiber {
  readonly tag: number;
  readonly type: unknown;
  readonly flags: number;
  readonly alternate: Fiber | null;
  readonly child: Fiber | null;
  readonly sibling: Fiber | null;
  readonly memoizedProps: Readonly<Record<string, unknown>> | null;
  readonly memoizedState: unknown;
}

/** One entry of a function component's hook list (`fiber.memoizedState`). */
export interface HookSlot {
  readonly memoizedState: unknown;
  /** Non-null only for the hooks that can schedule a render (useState, useReducer, useSyncExternalStore). */
  readonly queue: unknown;
  readonly next: HookSlot | null;
}

export interface RenderCount {
  readonly key: string;
  readonly count: number;
}

/** One recording window. This is the wire shape the measure-renders script decodes. */
export interface RenderCounterReport {
  readonly commits: number;
  readonly totalRenders: number;
  readonly windowMs: number;
  /** Renders per component, most first, then by name. */
  readonly components: ReadonlyArray<RenderCount>;
  /** Renders per `<Component> <cause>`, most first, then by key. */
  readonly causes: ReadonlyArray<RenderCount>;
  /**
   * Commits in this window whose walk threw. The counts of a window with any
   * are incomplete, and the fiber assumptions no longer hold.
   */
  readonly walkErrors: number;
}

export interface RenderCounterStatus {
  readonly installed: boolean;
  readonly recording: boolean;
  /** Commits whose walk threw since the counter was installed. */
  readonly walkErrors: number;
}

/** What the driver calls through `globalThis.__rycoRenderCounter`. */
export interface RenderCounterControl {
  readonly version: 1;
  status(): RenderCounterStatus;
  /** Resets the counts and starts recording. */
  start(): true;
  /** Stops recording and returns the window. */
  stop(): RenderCounterReport;
  /** Opens an app link in-process, so a driver needs no simctl or adb access. */
  open(url: string): true;
  /** Reloads the JS app after the inspector reply has gone out. */
  reload(): true;
}

export interface RenderCounter {
  readonly control: RenderCounterControl;
  /** Counts one committed tree while recording. Never throws. */
  recordCommit(rootCurrent: Fiber): void;
  markInstalled(): void;
}

export interface RenderCounterDeps {
  now(): number;
  openUrl(url: string): void;
  reload(): void;
}

export const RENDER_COUNTER_GLOBAL = "__rycoRenderCounter";

// React fiber tags (ReactWorkTags) of the components the counter reports.
// MemoComponent (14), the fiber of a `memo()` with a compare function or around
// a `forwardRef`, is walked through but not counted: whenever it does work, the
// component it wraps renders as its child fiber and is counted there.
const FUNCTION_COMPONENT = 0;
const CLASS_COMPONENT = 1;
const FORWARD_REF = 11;
const SIMPLE_MEMO_COMPONENT = 15;
const COMPONENT_TAGS: ReadonlySet<number> = new Set([
  FUNCTION_COMPONENT,
  CLASS_COMPONENT,
  FORWARD_REF,
  SIMPLE_MEMO_COMPONENT,
]);
// Tags whose `memoizedState` is a hook list.
const HOOK_TAGS: ReadonlySet<number> = new Set([
  FUNCTION_COMPONENT,
  FORWARD_REF,
  SIMPLE_MEMO_COMPONENT,
]);
// ReactFiberFlags.PerformedWork. React clears it whenever it clones a fiber, so
// a reached fiber that carries it did work in this commit.
const PERFORMED_WORK = 1;
const MAX_HOOK_SLOTS = 800;
const MAX_CHANGED_PROPS = 4;
const ANONYMOUS = "(anonymous)";
// The wrappers React DevTools and the React Compiler put around a name.
const WRAPPER = /^(?:Memo|Forget)\(/u;

interface NamedType {
  readonly displayName?: unknown;
  readonly name?: unknown;
  readonly type?: NamedType | null;
  readonly render?: NamedType | null;
}

const nonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/** A component's display name; `null` for host fibers (a string type) and missing types. */
export function componentName(fiber: Fiber): string | null {
  const type = fiber.type;
  if (type === null || (typeof type !== "object" && typeof type !== "function")) return null;
  const outer = type as NamedType;
  const inner = outer.type ?? outer.render ?? outer;
  const raw =
    nonEmptyString(outer.displayName) ??
    nonEmptyString(inner.displayName) ??
    nonEmptyString(inner.name);
  if (raw === null) return ANONYMOUS;
  // `Memo(Forget(Name))` → `Name`; a name that only contains parentheses keeps them.
  let name = raw;
  let wrappers = 0;
  for (let match = WRAPPER.exec(name); match !== null; match = WRAPPER.exec(name)) {
    name = name.slice(match[0].length);
    wrappers += 1;
  }
  while (wrappers > 0 && name.endsWith(")")) {
    name = name.slice(0, -1);
    wrappers -= 1;
  }
  return name || ANONYMOUS;
}

function isEffectObject(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "create" in value &&
    "deps" in value &&
    "tag" in value
  );
}

/** The index of the first state hook whose value changed, or -1. */
function changedStateSlot(previous: Fiber, next: Fiber): number {
  let before = previous.memoizedState as HookSlot | null;
  let after = next.memoizedState as HookSlot | null;
  for (let index = 0; before && after && index < MAX_HOOK_SLOTS; index += 1) {
    // Memo, callback and ref slots change because something upstream did; only
    // a slot with an update queue is a cause of its own.
    if (
      after.queue !== null &&
      after.queue !== undefined &&
      !isEffectObject(after.memoizedState) &&
      !Object.is(before.memoizedState, after.memoizedState)
    ) {
      return index;
    }
    before = before.next;
    after = after.next;
  }
  return -1;
}

function changedPropKeys(
  previous: Readonly<Record<string, unknown>> | null,
  next: Readonly<Record<string, unknown>> | null,
): ReadonlyArray<string> {
  const before = previous ?? {};
  const after = next ?? {};
  const keys = new Set([...Object.keys(after), ...Object.keys(before)]);
  return [...keys].filter((key) => !Object.is(before[key], after[key]));
}

/** Why a rendered component fiber rendered in this commit. */
export function renderCause(fiber: Fiber, renderedAncestor: string): string {
  const previous = fiber.alternate;
  if (previous === null) return "mount";
  if (HOOK_TAGS.has(fiber.tag)) {
    const slot = changedStateSlot(previous, fiber);
    if (slot >= 0) return `state#${slot}`;
  } else if (fiber.tag === CLASS_COMPONENT && previous.memoizedState !== fiber.memoizedState) {
    return "state";
  }
  if (previous.memoizedProps !== fiber.memoizedProps) {
    const keys = changedPropKeys(previous.memoizedProps, fiber.memoizedProps);
    return keys.length > 0
      ? `props:${keys.slice(0, MAX_CHANGED_PROPS).join(",")}`
      : `parent-same-props<-${renderedAncestor}`;
  }
  return "context";
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function sortedCounts(counts: ReadonlyMap<string, number>): ReadonlyArray<RenderCount> {
  return [...counts]
    .map(([key, count]) => ({ key, count }))
    .toSorted((left, right) => right.count - left.count || (left.key < right.key ? -1 : 1));
}

/**
 * Walks one committed tree and counts the components that rendered in it. A
 * subtree React bailed out of keeps `child === alternate.child`; its fibers carry
 * flags from older commits, so the walk does not descend into it.
 */
function walkCommit(
  rootCurrent: Fiber,
  counts: Map<string, number>,
  causes: Map<string, number>,
): void {
  // Iterative, so a deep tree cannot overflow the JS stack inside React's commit.
  const pending: Array<{ readonly fiber: Fiber | null; readonly ancestor: string }> = [
    { fiber: rootCurrent.child, ancestor: "root" },
  ];
  for (let entry = pending.pop(); entry !== undefined; entry = pending.pop()) {
    for (let node = entry.fiber; node !== null; node = node.sibling) {
      const name = COMPONENT_TAGS.has(node.tag) ? componentName(node) : null;
      const rendered = name !== null && (node.flags & PERFORMED_WORK) === PERFORMED_WORK;
      if (rendered) {
        increment(counts, name);
        increment(causes, `${name} ${renderCause(node, entry.ancestor)}`);
      }
      const bailedOut = node.alternate !== null && node.child === node.alternate.child && !rendered;
      if (node.child !== null && !bailedOut) {
        pending.push({ fiber: node.child, ancestor: rendered ? name : entry.ancestor });
      }
    }
  }
}

export function createRenderCounter(deps: RenderCounterDeps): RenderCounter {
  let installed = false;
  let recording = false;
  let walkErrors = 0;
  let commits = 0;
  let windowWalkErrors = 0;
  let startedAt: number | null = null;
  let counts = new Map<string, number>();
  let causes = new Map<string, number>();

  const control: RenderCounterControl = {
    version: 1,
    status: () => ({ installed, recording, walkErrors }),
    start: () => {
      commits = 0;
      windowWalkErrors = 0;
      counts = new Map();
      causes = new Map();
      startedAt = deps.now();
      recording = true;
      return true;
    },
    stop: () => {
      const windowMs = startedAt === null ? 0 : deps.now() - startedAt;
      recording = false;
      startedAt = null;
      const components = sortedCounts(counts);
      return {
        commits,
        totalRenders: components.reduce((total, entry) => total + entry.count, 0),
        windowMs,
        components,
        causes: sortedCounts(causes),
        walkErrors: windowWalkErrors,
      };
    },
    open: (url) => {
      deps.openUrl(url);
      return true;
    },
    reload: () => {
      deps.reload();
      return true;
    },
  };

  return {
    control,
    recordCommit: (rootCurrent) => {
      if (!recording) return;
      commits += 1;
      try {
        walkCommit(rootCurrent, counts, causes);
      } catch {
        walkErrors += 1;
        windowWalkErrors += 1;
      }
    },
    markInstalled: () => {
      installed = true;
    },
  };
}

interface DevToolsHook {
  onCommitFiberRoot?: unknown;
  __rycoRenderCounter?: true;
}

type CommitFiberRoot = (
  id: unknown,
  root: { readonly current: Fiber },
  ...rest: unknown[]
) => unknown;

export interface InstallRenderCounterOptions {
  /** How often to look for the DevTools hook while it is missing. */
  readonly retryIntervalMs?: number;
  /** When to give up looking; `status().installed` then stays false. */
  readonly retryLimitMs?: number;
  readonly deps?: RenderCounterDeps;
}

function reactNativeDeps(): RenderCounterDeps {
  return {
    now: () => Date.now(),
    // Required lazily so the module loads under Vitest without React Native.
    openUrl: (url) => {
      const { Linking } = require("react-native") as typeof import("react-native");
      void Linking.openURL(url);
    },
    // Deferred so the inspector's reply to `reload()` goes out first.
    reload: () => {
      const { DevSettings } = require("react-native") as typeof import("react-native");
      setTimeout(() => DevSettings.reload(), 100);
    },
  };
}

/**
 * Installs the counter on `host` (the JS global) as `__rycoRenderCounter` and
 * wraps the DevTools hook's commit callback once. React Native installs the
 * hook before the entry module runs, so the bounded retry only covers a slow
 * start; after it, `status().installed` stays false and the driver says so.
 */
export function installRenderCounterDevHook(
  host: Record<string, unknown> = globalThis,
  options: InstallRenderCounterOptions = {},
): void {
  if (host[RENDER_COUNTER_GLOBAL] !== undefined) return;
  const retryIntervalMs = options.retryIntervalMs ?? 50;
  const retryLimitMs = options.retryLimitMs ?? 5_000;
  const counter = createRenderCounter(options.deps ?? reactNativeDeps());
  Object.defineProperty(host, RENDER_COUNTER_GLOBAL, {
    configurable: true,
    enumerable: false,
    writable: true,
    value: counter.control,
  });

  let waitedMs = 0;
  const wrapHook = (): void => {
    const hook = host.__REACT_DEVTOOLS_GLOBAL_HOOK__ as DevToolsHook | undefined;
    if (!hook || typeof hook.onCommitFiberRoot !== "function") {
      if (waitedMs >= retryLimitMs) return;
      waitedMs += retryIntervalMs;
      setTimeout(wrapHook, retryIntervalMs);
      return;
    }
    if (hook.__rycoRenderCounter !== true) {
      const original = hook.onCommitFiberRoot as CommitFiberRoot;
      const wrapped: CommitFiberRoot = function (this: unknown, id, root, ...rest) {
        // A missing root reaches the walk, which counts it as a walk error.
        counter.recordCommit((root as { readonly current?: Fiber } | null)?.current as Fiber);
        return original.call(this, id, root, ...rest);
      };
      hook.onCommitFiberRoot = wrapped;
      hook.__rycoRenderCounter = true;
    }
    counter.markInstalled();
  };
  wrapHook();
}
