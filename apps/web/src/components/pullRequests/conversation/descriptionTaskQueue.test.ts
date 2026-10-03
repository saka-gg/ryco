import { describe, expect, it } from "vitest";

import {
  createDescriptionTaskQueue,
  DESCRIPTION_CHANGED_MESSAGE,
  type DescriptionTaskHost,
} from "./descriptionTaskQueue";
import { setTaskState } from "./markdownTasks";

const BODY = "- [ ] One\n- [ ] Two\n- [ ] Three";
const ONE = 3;
const TWO = 13;
const THREE = 23;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

interface FakeHost {
  server: string;
  reads: number;
  readonly saves: string[];
  readonly held: Array<{ readonly body: string; readonly release: () => void }>;
  failNextSave: Error | null;
  readonly api: DescriptionTaskHost;
}

/** A host whose body is `server`, with each save held until released. */
function fakeHost(initial: string): FakeHost {
  const host: FakeHost = {
    server: initial,
    reads: 0,
    saves: [],
    held: [],
    failNextSave: null,
    api: {
      readFresh: async () => {
        host.reads += 1;
        return host.server;
      },
      save: (body) => {
        host.saves.push(body);
        if (host.failNextSave) {
          const error = host.failNextSave;
          host.failNextSave = null;
          return Promise.reject(error);
        }
        const gate = deferred<void>();
        host.held.push({
          body,
          release: () => {
            host.server = body;
            gate.resolve();
          },
        });
        return gate.promise;
      },
    },
  };
  return host;
}

describe("createDescriptionTaskQueue", () => {
  it("serializes saves and folds clicks made meanwhile into the next one", async () => {
    const queue = createDescriptionTaskQueue(() => "failed");
    const host = fakeHost(BODY);
    queue.toggle("pr", { base: BODY, offset: ONE, checked: true }, host.api);
    await flush();
    expect(host.saves).toEqual([setTaskState(BODY, ONE, true)]);

    // Two more clicks while the first save is in flight: shown, not yet sent.
    queue.toggle("pr", { base: BODY, offset: TWO, checked: true }, host.api);
    queue.toggle("pr", { base: BODY, offset: THREE, checked: true }, host.api);
    await flush();
    expect(host.saves).toHaveLength(1);
    expect(queue.snapshot("pr").pending.map((toggle) => toggle.offset)).toEqual([ONE, TWO, THREE]);

    host.held[0]?.release();
    await flush();
    // The next save re-read the body the first one left and carries both clicks.
    expect(host.reads).toBe(2);
    expect(host.saves[1]).toBe("- [x] One\n- [x] Two\n- [x] Three");
    expect(queue.snapshot("pr").pending.map((toggle) => toggle.offset)).toEqual([TWO, THREE]);

    host.held[1]?.release();
    await flush();
    expect(queue.snapshot("pr")).toEqual({ pending: [], error: null });
    expect(host.saves).toHaveLength(2);
  });

  it("saves onto the host's current body, keeping a teammate's ticks", async () => {
    const queue = createDescriptionTaskQueue(() => "failed");
    const host = fakeHost(setTaskState(BODY, THREE, true));
    queue.toggle("pr", { base: BODY, offset: ONE, checked: true }, host.api);
    await flush();
    expect(host.saves).toEqual(["- [x] One\n- [ ] Two\n- [x] Three"]);
  });

  it("refuses to save over a description edited since it loaded", async () => {
    const queue = createDescriptionTaskQueue(() => "failed");
    const edited = "Context from a bot\n\n- [ ] One\n- [ ] Two\n- [ ] Three";
    const host = fakeHost(edited);
    const unsubscribe = queue.subscribe("pr", () => {});
    queue.toggle("pr", { base: BODY, offset: ONE, checked: true }, host.api);
    await flush();
    expect(host.saves).toEqual([]);
    expect(queue.snapshot("pr")).toEqual({ pending: [], error: DESCRIPTION_CHANGED_MESSAGE });

    // A click on the reloaded body saves again and clears the message.
    const offset = edited.indexOf("[ ] One") + 1;
    queue.toggle("pr", { base: edited, offset, checked: true }, host.api);
    expect(queue.snapshot("pr").error).toBeNull();
    await flush();
    expect(host.saves).toEqual([setTaskState(edited, offset, true)]);
    unsubscribe();
  });

  it("drops the queue and reports the error when a save fails", async () => {
    const queue = createDescriptionTaskQueue((error) => `failed: ${(error as Error).message}`);
    const host = fakeHost(BODY);
    host.failNextSave = new Error("offline");
    const unsubscribe = queue.subscribe("pr", () => {});
    queue.toggle("pr", { base: BODY, offset: TWO, checked: true }, host.api);
    expect(queue.snapshot("pr").pending).toHaveLength(1);
    await flush();
    expect(queue.snapshot("pr")).toEqual({ pending: [], error: "failed: offline" });
    unsubscribe();
    // Nobody watches any more: the entry (and its message) is released.
    expect(queue.snapshot("pr")).toEqual({ pending: [], error: null });
  });

  it("keeps pull requests apart and notifies subscribers", async () => {
    const queue = createDescriptionTaskQueue(() => "failed");
    const first = fakeHost(BODY);
    const second = fakeHost(BODY);
    let notified = 0;
    const unsubscribe = queue.subscribe("b", () => {
      notified += 1;
    });
    queue.toggle("a", { base: BODY, offset: ONE, checked: true }, first.api);
    queue.toggle("b", { base: BODY, offset: TWO, checked: true }, second.api);
    await flush();
    expect(first.saves).toEqual([setTaskState(BODY, ONE, true)]);
    expect(second.saves).toEqual([setTaskState(BODY, TWO, true)]);
    expect(notified).toBeGreaterThan(0);
    unsubscribe();
  });
});
