import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  componentName,
  createRenderCounter,
  type Fiber,
  type HookSlot,
  installRenderCounterDevHook,
  RENDER_COUNTER_GLOBAL,
  type RenderCounterControl,
  type RenderCounterDeps,
} from "./renderCounter";

// Fiber tags and the PerformedWork flag, as React 19 defines them. The counter
// reads exactly these; if React renumbers them these fixtures stop matching it.
const FUNCTION = 0;
const CLASS = 1;
const HOST = 5;
const FORWARD_REF = 11;
const MEMO = 14;
const SIMPLE_MEMO = 15;
const PERFORMED_WORK = 1;
// A flag React keeps across clones (Placement-free static bits are irrelevant here).
const UNRELATED_FLAG = 4;

interface MutableFiber {
  tag: number;
  type: unknown;
  flags: number;
  alternate: MutableFiber | null;
  child: MutableFiber | null;
  sibling: MutableFiber | null;
  memoizedProps: Record<string, unknown> | null;
  memoizedState: unknown;
}

function fiber(
  tag: number,
  type: unknown,
  options: Partial<Omit<MutableFiber, "tag" | "type">> = {},
): MutableFiber {
  return {
    tag,
    type,
    flags: 0,
    alternate: null,
    child: null,
    sibling: null,
    memoizedProps: {},
    memoizedState: null,
    ...options,
  };
}

function children(parent: MutableFiber, ...kids: ReadonlyArray<MutableFiber>): MutableFiber {
  parent.child = kids[0] ?? null;
  kids.forEach((kid, index) => {
    kid.sibling = kids[index + 1] ?? null;
  });
  return parent;
}

const named = (name: string) => Object.defineProperty(() => null, "name", { value: name });

/** A hook list from `[memoizedState, hasQueue]` pairs. */
function hooks(...slots: ReadonlyArray<readonly [unknown, boolean]>): HookSlot | null {
  let next: HookSlot | null = null;
  for (const [memoizedState, hasQueue] of slots.toReversed()) {
    next = { memoizedState, queue: hasQueue ? { pending: null } : null, next };
  }
  return next;
}

/**
 * A fiber that rendered in this commit, with the previous commit's copy as its
 * alternate. Both share one props object unless the test passes its own.
 */
function rerendered(
  tag: number,
  type: unknown,
  previous: Partial<MutableFiber>,
  next: Partial<MutableFiber>,
): MutableFiber {
  const props = {};
  const alternate = fiber(tag, type, { memoizedProps: props, ...previous });
  return fiber(tag, type, { memoizedProps: props, flags: PERFORMED_WORK, alternate, ...next });
}

function rootOf(...kids: ReadonlyArray<MutableFiber>): Fiber {
  return children(fiber(3, null), ...kids);
}

function counterWithClock(start = 1_000) {
  let now = start;
  const opened: string[] = [];
  let reloads = 0;
  const deps: RenderCounterDeps = {
    now: () => now,
    openUrl: (url) => opened.push(url),
    reload: () => {
      reloads += 1;
    },
  };
  return {
    counter: createRenderCounter(deps),
    advance: (ms: number) => {
      now += ms;
    },
    opened,
    reloads: () => reloads,
  };
}

function record(root: Fiber) {
  const { counter } = counterWithClock();
  counter.control.start();
  counter.recordCommit(root);
  return counter.control.stop();
}

describe("render counter walk", () => {
  it("counts components that did work and ignores host fibers and components that did not", () => {
    const report = record(
      rootOf(
        children(
          fiber(FUNCTION, named("Screen"), { flags: PERFORMED_WORK }),
          children(
            fiber(HOST, "RCTView", { flags: PERFORMED_WORK }),
            fiber(FUNCTION, named("Row"), { flags: PERFORMED_WORK }),
            fiber(FUNCTION, named("Idle"), { flags: UNRELATED_FLAG }),
          ),
        ),
      ),
    );

    expect(report.components).toEqual([
      { key: "Row", count: 1 },
      { key: "Screen", count: 1 },
    ]);
    expect(report.totalRenders).toBe(2);
    expect(report.commits).toBe(1);
  });

  it("does not descend into a bailed-out subtree whose fibers keep stale flags", () => {
    const staleChild = fiber(FUNCTION, named("Stale"), { flags: PERFORMED_WORK });
    const previous = fiber(FUNCTION, named("Parent"), { child: staleChild });
    const parent = fiber(FUNCTION, named("Parent"), { alternate: previous, child: staleChild });

    expect(record(rootOf(parent)).components).toEqual([]);
  });

  it("descends into a reconciled host fiber and attributes same-props renders to the rendered ancestor", () => {
    const sameProps = { label: "a" };
    const child = rerendered(
      FUNCTION,
      named("Child"),
      { memoizedProps: sameProps },
      // A new props object with the same values: the parent re-rendered and recreated it.
      { memoizedProps: { label: "a" } },
    );
    const host = fiber(HOST, "RCTView", {
      alternate: fiber(HOST, "RCTView"),
      child,
    });
    const parent = rerendered(FUNCTION, named("Parent"), {}, {});
    children(parent, host);

    expect(record(rootOf(parent)).causes).toEqual([
      { key: "Child parent-same-props<-Parent", count: 1 },
      { key: "Parent context", count: 1 },
    ]);
  });

  it("names the nearest rendered ancestor through components that did not render", () => {
    const child = rerendered(FUNCTION, named("Leaf"), { memoizedProps: {} }, { memoizedProps: {} });
    // Reached (its child list was cloned) but it did no work itself.
    const passThrough = fiber(FUNCTION, named("Provider"), {
      alternate: fiber(FUNCTION, named("Provider")),
      child,
    });

    expect(record(rootOf(passThrough)).causes).toEqual([
      { key: "Leaf parent-same-props<-root", count: 1 },
    ]);
  });

  it("finds the cause of each render", () => {
    const effect = { create: () => undefined, deps: [], tag: 9, destroy: undefined };
    const report = record(
      rootOf(
        fiber(FUNCTION, named("Mounted"), { flags: PERFORMED_WORK }),
        rerendered(
          FUNCTION,
          named("Stateful"),
          { memoizedState: hooks(["same", true], [1, true]) },
          { memoizedState: hooks(["same", true], [2, true]) },
        ),
        rerendered(
          FUNCTION,
          named("Props"),
          { memoizedProps: { title: "a", count: 1, fixed: true } },
          { memoizedProps: { title: "b", count: 2, fixed: true } },
        ),
        rerendered(
          FUNCTION,
          named("Removed"),
          { memoizedProps: { gone: 1 } },
          { memoizedProps: {} },
        ),
        rerendered(
          FUNCTION,
          named("Consumer"),
          { memoizedState: hooks([{ value: 1 }, false], [effect, false]) },
          // Memo/ref slots and effects change without a queue: never a state cause.
          { memoizedState: hooks([{ value: 2 }, false], [{ ...effect }, false]) },
        ),
        rerendered(
          FUNCTION,
          named("EffectInQueueSlot"),
          { memoizedState: hooks([effect, true]) },
          { memoizedState: hooks([{ ...effect }, true]) },
        ),
        rerendered(
          CLASS,
          named("Legacy"),
          { memoizedState: { open: false } },
          {
            memoizedState: { open: true },
          },
        ),
      ),
    );

    expect(Object.fromEntries(report.causes.map(({ key, count }) => [key, count]))).toEqual({
      "Mounted mount": 1,
      "Stateful state#1": 1,
      "Props props:title,count": 1,
      "Removed props:gone": 1,
      "Consumer context": 1,
      "EffectInQueueSlot context": 1,
      "Legacy state": 1,
    });
  });

  it("lists at most four changed props", () => {
    const report = record(
      rootOf(
        rerendered(
          FUNCTION,
          named("Wide"),
          { memoizedProps: { a: 1, b: 1, c: 1, d: 1, e: 1 } },
          { memoizedProps: { a: 2, b: 2, c: 2, d: 2, e: 2 } },
        ),
      ),
    );
    expect(report.causes).toEqual([{ key: "Wide props:a,b,c,d", count: 1 }]);
  });

  it("counts a memo() with a compare function once, as the component it wraps", () => {
    const inner = named("Card");
    const memoType = { $$typeof: Symbol.for("react.memo"), type: inner, compare: () => false };
    const innerFiber = rerendered(
      FUNCTION,
      inner,
      { memoizedProps: { id: 1 } },
      {
        memoizedProps: { id: 2 },
      },
    );
    const memoFiber = rerendered(MEMO, memoType, {}, {});
    children(memoFiber, innerFiber);

    expect(record(rootOf(memoFiber)).components).toEqual([{ key: "Card", count: 1 }]);
  });

  it("resolves display names", () => {
    const render = named("FieldImpl");
    expect(
      [
        fiber(FUNCTION, Object.assign(named("Inner"), { displayName: "Shown" })),
        fiber(SIMPLE_MEMO, named("Plain")),
        fiber(MEMO, { $$typeof: Symbol.for("react.memo"), type: named("MemoInner") }),
        fiber(FORWARD_REF, { $$typeof: Symbol.for("react.forward_ref"), render }),
        fiber(FUNCTION, Object.assign(named("x"), { displayName: "Memo(Forget(Row))" })),
        fiber(FUNCTION, Object.assign(named("x"), { displayName: "withTheme(Row)" })),
        fiber(FUNCTION, named("")),
        fiber(HOST, "RCTText"),
      ].map((node) => componentName(node)),
    ).toEqual([
      "Shown",
      "Plain",
      "MemoInner",
      "FieldImpl",
      "Row",
      "withTheme(Row)",
      "(anonymous)",
      null,
    ]);
  });

  it("walks long sibling lists and deep trees without recursion", () => {
    let deepest = fiber(FUNCTION, named("Leaf"), { flags: PERFORMED_WORK });
    for (let depth = 0; depth < 20_000; depth += 1) {
      deepest = children(fiber(HOST, "RCTView", { flags: PERFORMED_WORK }), deepest);
    }
    const siblings = Array.from({ length: 5_000 }, () =>
      fiber(FUNCTION, named("Item"), { flags: PERFORMED_WORK }),
    );

    const report = record(rootOf(deepest, ...siblings));
    expect(report.components).toEqual([
      { key: "Item", count: 5_000 },
      { key: "Leaf", count: 1 },
    ]);
  });
});

describe("render counter control", () => {
  it("counts commits only inside a window and resets on start", () => {
    const { counter, advance } = counterWithClock();
    const tree = () => rootOf(fiber(FUNCTION, named("Row"), { flags: PERFORMED_WORK }));

    counter.recordCommit(tree());
    counter.control.start();
    expect(counter.control.status()).toMatchObject({ recording: true });
    counter.recordCommit(tree());
    counter.recordCommit(tree());
    advance(250);
    const first = counter.control.stop();
    counter.recordCommit(tree());

    expect(first).toEqual({
      commits: 2,
      totalRenders: 2,
      windowMs: 250,
      components: [{ key: "Row", count: 2 }],
      causes: [{ key: "Row mount", count: 2 }],
      walkErrors: 0,
    });
    expect(counter.control.status()).toMatchObject({ recording: false });

    counter.control.start();
    advance(10);
    expect(counter.control.stop()).toEqual({
      commits: 0,
      totalRenders: 0,
      windowMs: 10,
      components: [],
      causes: [],
      walkErrors: 0,
    });
  });

  it("sorts by count, then by name", () => {
    const report = record(
      rootOf(
        fiber(FUNCTION, named("B"), { flags: PERFORMED_WORK }),
        fiber(FUNCTION, named("C"), { flags: PERFORMED_WORK }),
        fiber(FUNCTION, named("C"), { flags: PERFORMED_WORK }),
        fiber(FUNCTION, named("A"), { flags: PERFORMED_WORK }),
      ),
    );
    expect(report.components.map(({ key }) => key)).toEqual(["C", "A", "B"]);
  });

  it("opens links and reloads through its dependencies", () => {
    const { counter, opened, reloads } = counterWithClock();
    expect(counter.control.open("ryco-dev://settings")).toBe(true);
    expect(counter.control.reload()).toBe(true);
    expect(opened).toEqual(["ryco-dev://settings"]);
    expect(reloads()).toBe(1);
  });

  it("counts a walk that throws instead of throwing", () => {
    const { counter } = counterWithClock();
    const broken = Object.defineProperty(fiber(3, null), "child", {
      get: () => {
        throw new Error("renamed fiber field");
      },
    });
    counter.control.start();
    expect(() => counter.recordCommit(broken)).not.toThrow();
    expect(counter.control.status()).toEqual({ installed: false, recording: true, walkErrors: 1 });
    // The window reports it, so a driver can reject its incomplete counts.
    expect(counter.control.stop()).toMatchObject({ commits: 1, walkErrors: 1 });

    // The next window starts clean; the status keeps the total since install.
    counter.control.start();
    counter.recordCommit(rootOf(fiber(FUNCTION, named("Row"), { flags: PERFORMED_WORK })));
    expect(counter.control.stop()).toMatchObject({ commits: 1, totalRenders: 1, walkErrors: 0 });
    expect(counter.control.status().walkErrors).toBe(1);
  });
});

describe("installRenderCounterDevHook", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const deps: RenderCounterDeps = { now: () => 0, openUrl: () => {}, reload: () => {} };
  const controlOf = (host: Record<string, unknown>) =>
    host[RENDER_COUNTER_GLOBAL] as RenderCounterControl;

  it("wraps the DevTools commit callback once and always calls through", () => {
    const original = vi.fn(function (this: unknown) {
      return "original result";
    });
    const hook: Record<string, unknown> = { onCommitFiberRoot: original };
    const host: Record<string, unknown> = { __REACT_DEVTOOLS_GLOBAL_HOOK__: hook };

    installRenderCounterDevHook(host, { deps });
    const wrapped = hook.onCommitFiberRoot;
    installRenderCounterDevHook(host, { deps });
    expect(hook.onCommitFiberRoot).toBe(wrapped);
    expect(Object.keys(host)).toEqual(["__REACT_DEVTOOLS_GLOBAL_HOOK__"]);

    const control = controlOf(host);
    expect(control.version).toBe(1);
    expect(control.status()).toEqual({ installed: true, recording: false, walkErrors: 0 });

    const root = { current: rootOf(fiber(FUNCTION, named("App"), { flags: PERFORMED_WORK })) };
    const commit = hook.onCommitFiberRoot as (...args: unknown[]) => unknown;
    expect(commit.call(hook, 7, root, 3, false)).toBe("original result");
    control.start();
    expect(commit.call(hook, 7, root, 3, false)).toBe("original result");
    expect(control.stop()).toMatchObject({ commits: 1, components: [{ key: "App", count: 1 }] });

    expect(original).toHaveBeenCalledTimes(2);
    expect(original.mock.calls[1]).toEqual([7, root, 3, false]);
    expect(original.mock.contexts[1]).toBe(hook);
  });

  it("calls through when the walk throws and reports it", () => {
    const original = vi.fn(() => "ok");
    const hook: Record<string, unknown> = { onCommitFiberRoot: original };
    const host: Record<string, unknown> = { __REACT_DEVTOOLS_GLOBAL_HOOK__: hook };
    installRenderCounterDevHook(host, { deps });
    const control = controlOf(host);
    control.start();

    const commit = hook.onCommitFiberRoot as (...args: unknown[]) => unknown;
    expect(commit.call(hook, 1, null)).toBe("ok");
    expect(commit.call(hook, 1, { current: undefined })).toBe("ok");
    expect(original).toHaveBeenCalledTimes(2);
    expect(control.status()).toEqual({ installed: true, recording: true, walkErrors: 2 });
  });

  it("waits for a hook that appears late", () => {
    vi.useFakeTimers();
    const host: Record<string, unknown> = {};
    installRenderCounterDevHook(host, { deps, retryIntervalMs: 50, retryLimitMs: 5_000 });
    expect(controlOf(host).status().installed).toBe(false);

    const hook: Record<string, unknown> = { onCommitFiberRoot: () => undefined };
    vi.advanceTimersByTime(100);
    host.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
    vi.advanceTimersByTime(50);
    expect(controlOf(host).status().installed).toBe(true);
    expect(hook.__rycoRenderCounter).toBe(true);
  });

  it("gives up after the retry budget and reports that it is not installed", () => {
    vi.useFakeTimers();
    const host: Record<string, unknown> = {};
    installRenderCounterDevHook(host, { deps, retryIntervalMs: 50, retryLimitMs: 200 });
    vi.advanceTimersByTime(10_000);
    expect(vi.getTimerCount()).toBe(0);

    host.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { onCommitFiberRoot: () => undefined };
    vi.advanceTimersByTime(10_000);
    expect(controlOf(host).status()).toEqual({
      installed: false,
      recording: false,
      walkErrors: 0,
    });
  });
});
