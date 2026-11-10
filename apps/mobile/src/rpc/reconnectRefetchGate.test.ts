import type { EnvironmentId } from "@ryco/contracts";
import { KEY_SEP } from "@ryco/client-runtime/rpc";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { createMobileQueryCache } from "./mobileQueryCache";
import { createReconnectRefetchGate, type ReconnectRefetchTarget } from "./reconnectRefetchGate";

const ENV = "env-1" as EnvironmentId;

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface Pending {
  readonly id: string;
  readonly resolve: (value: string) => void;
}

const cache = createMobileQueryCache("reconnect-gate-test");
let pending: Pending[] = [];
const reads: string[] = [];
const query = cache.defineQuery<{ readonly id: string }, string>({
  label: "screen",
  staleTime: 60_000,
  retainedKeyLimit: 8,
  isEnabled: () => true,
  buildKey: (input) => `${ENV}${KEY_SEP}${input.id}`,
  resolveEnvironmentId: () => ENV,
  run: (input) => {
    reads.push(input.id);
    return new Promise<string>((resolve) => pending.push({ id: input.id, resolve }));
  },
});

function answerAll(value: (id: string) => string): void {
  const current = pending;
  pending = [];
  for (const read of current) read.resolve(value(read.id));
}

/**
 * One mounted screen as `useMobileQuery` drives it: a watch, the gate on every
 * connection change, and the gate on focus. `legacy` replays the previous rule
 * (every mounted screen reads again at once, without a fence).
 */
function mountScreen(id: string, connection: object, options: { readonly legacy?: boolean } = {}) {
  const gate = createReconnectRefetchGate<object>();
  const key = query.keyOf({ id });
  const release = query.watch({ id });
  const target: ReconnectRefetchTarget = options.legacy
    ? { fence: () => undefined, refresh: query.refresh }
    : query;
  gate.onConnection(connection, true, target, key);
  return {
    key,
    release,
    connect: (next: object | null, focused: boolean) =>
      gate.onConnection(next, options.legacy ? true : focused, target, key),
    focus: (connected: boolean) => gate.onFocus(connected, target, key),
  };
}

beforeEach(() => {
  cache.resetForTests();
  pending = [];
  reads.length = 0;
});

describe("reconnect refetch gate", () => {
  it("reads only the focused screen of a stack of 4 at once, the others once on focus", async () => {
    const first = {};
    const stack = ["home", "project", "pull-request", "file"].map((id) => mountScreen(id, first));
    answerAll((id) => `${id}@1`);
    await flush();
    reads.length = 0;

    // Two reconnects while the file screen (top of the stack) is on view.
    const second = {};
    stack.forEach((screen, index) => screen.connect(second, index === stack.length - 1));
    const third = {};
    stack.forEach((screen, index) => screen.connect(third, index === stack.length - 1));
    answerAll((id) => `${id}@3`);
    await flush();
    expect(reads).toEqual(["file", "file"]);

    // Back down the stack: each screen reads exactly once when it shows again.
    reads.length = 0;
    for (const screen of stack.slice(0, -1).toReversed()) screen.focus(true);
    stack[2]?.focus(true);
    answerAll((id) => `${id}@3`);
    await flush();
    expect(reads).toEqual(["pull-request", "project", "home"]);

    for (const screen of stack) screen.release();
  });

  it("legacy rule for comparison: every screen of the stack reads at once", async () => {
    const first = {};
    const stack = ["home", "project", "pull-request", "file"].map((id) =>
      mountScreen(id, first, { legacy: true }),
    );
    answerAll((id) => `${id}@1`);
    await flush();
    reads.length = 0;
    const second = {};
    for (const screen of stack) screen.connect(second, false);
    expect(reads).toEqual(["home", "project", "pull-request", "file"]);
    answerAll((id) => `${id}@2`);
    await flush();
    for (const screen of stack) screen.release();
  });

  it("fences a read of the replaced client on a screen below the top", async () => {
    const screen = mountScreen("below", {});
    // The first read (replaced client) is still in flight at the reconnect.
    screen.connect({}, false);
    expect(query.getSnapshot(screen.key)).toMatchObject({ isFetching: false, data: null });
    answerAll(() => "stale");
    await flush();
    expect(query.getSnapshot(screen.key).data).toBeNull();
    expect(reads).toEqual(["below"]);

    screen.focus(true);
    answerAll(() => "fresh");
    await flush();
    expect(query.getSnapshot(screen.key).data).toBe("fresh");
    expect(reads).toEqual(["below", "below"]);
    screen.release();
  });

  it("keeps the read owed when the screen comes into focus offline", async () => {
    const screen = mountScreen("offline", {});
    answerAll(() => "old");
    await flush();
    reads.length = 0;
    screen.connect({}, false);
    screen.focus(false);
    expect(reads).toEqual([]);
    screen.focus(true);
    expect(reads).toEqual(["offline"]);
    answerAll(() => "new");
    await flush();
    screen.release();
  });

  it("does not read for a first look, an unchanged connection or going offline", () => {
    const connection = {};
    const screen = mountScreen("steady", connection);
    reads.length = 0;
    screen.connect(connection, true);
    screen.connect(null, true);
    screen.focus(true);
    expect(reads).toEqual([]);
    screen.release();
  });
});
