import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The render source hook under a minimal hook runtime (state slots and
// dependency-checked effects; no React renderer exists in this suite). What it
// proves: a page loads as its row mounts, a large page waits for a tap, a
// failed read retries on the reader's tap and by itself when the environment
// reconnects, a row keeps the page it shows when the cache drops it and across
// reconnects without reading it again, and an unmounted row stops its read.

const hoisted = vi.hoisted(() => ({
  status: { phase: "connected", connectedAt: "2026-10-07T10:00:00.000Z" } as {
    phase: string;
    connectedAt: string | null;
  },
  transport: undefined as
    | undefined
    | { readChunk: (input: { offset: number }) => Promise<unknown> },
  runtime: {
    slots: [] as unknown[],
    index: 0,
    effects: [] as Array<{ deps: ReadonlyArray<unknown>; cleanup?: () => void } | undefined>,
    effectIndex: 0,
    pending: [] as Array<() => void>,
  },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { runtime } = hoisted;
  return {
    ...actual,
    useState: <T>(initial: T | (() => T)) => {
      const slot = runtime.index++;
      if (!(slot in runtime.slots)) {
        runtime.slots[slot] = typeof initial === "function" ? (initial as () => T)() : initial;
      }
      const set = (next: T | ((current: T) => T)) => {
        runtime.slots[slot] =
          typeof next === "function" ? (next as (current: T) => T)(runtime.slots[slot] as T) : next;
      };
      return [runtime.slots[slot] as T, set] as const;
    },
    useEffect: (effect: () => (() => void) | void, deps: ReadonlyArray<unknown>) => {
      const slot = runtime.effectIndex++;
      const previous = runtime.effects[slot];
      if (previous && deps.every((dep, index) => Object.is(dep, previous.deps[index]))) return;
      runtime.pending.push(() => {
        previous?.cleanup?.();
        runtime.effects[slot] = { deps, cleanup: effect() ?? undefined };
      });
    },
  };
});
vi.mock("../../connection/environmentApi", () => ({
  readEnvironmentApi: () =>
    hoisted.transport === undefined ? undefined : { attachments: hoisted.transport },
}));
vi.mock("../../rpc/wsConnectionState", () => ({
  useWsConnectionStatusForEnvironment: () => hoisted.status,
}));

import {
  CHAT_ATTACHMENT_READ_CHUNK_BYTES,
  EnvironmentId,
  MessageId,
  ThreadId,
} from "@ryco/contracts";

import {
  acquireHtmlRenderSource,
  clearHtmlRenderSourceCache,
  HTML_RENDER_AUTO_LOAD_MAX_BYTES,
  htmlRenderSourceKey,
} from "./htmlRenderSource";
import { useHtmlRenderSource, type HtmlRenderSource } from "./useHtmlRenderSource";

const page = new TextEncoder().encode("<p>chart</p>");

function serving(bytes: Uint8Array) {
  const readChunk = vi.fn(async (input: { offset: number }) => {
    const chunk = bytes.subarray(input.offset, input.offset + CHAT_ATTACHMENT_READ_CHUNK_BYTES);
    return {
      dataBase64: Buffer.from(chunk).toString("base64"),
      offset: input.offset,
      totalBytes: bytes.length,
    };
  });
  return { readChunk };
}

let sizeBytes = page.length;
let attachmentId = "thread-1-abc-html";
let requested: boolean | undefined;

function render(): HtmlRenderSource {
  const { runtime } = hoisted;
  runtime.index = 0;
  runtime.effectIndex = 0;
  runtime.pending = [];
  const result = useHtmlRenderSource({
    environmentId: EnvironmentId.make("env-1"),
    threadId: ThreadId.make("thread-1"),
    messageId: MessageId.make("message-1"),
    attachmentId,
    sizeBytes,
    ...(requested === undefined ? {} : { requested }),
  });
  for (const run of runtime.pending) run();
  return result;
}

function unmount() {
  for (const effect of hoisted.runtime.effects) effect?.cleanup?.();
}

/** Lets settled reads deliver their state, then renders again. */
async function settle(): Promise<HtmlRenderSource> {
  await vi.waitFor(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return render();
}

beforeEach(() => {
  hoisted.runtime.slots = [];
  hoisted.runtime.effects = [];
  hoisted.status = { phase: "connected", connectedAt: "2026-10-07T10:00:00.000Z" };
  hoisted.transport = undefined;
  sizeBytes = page.length;
  attachmentId = "thread-1-abc-html";
  requested = undefined;
});

afterEach(() => {
  unmount();
  clearHtmlRenderSourceCache();
});

describe("useHtmlRenderSource", () => {
  it("loads the page as the row mounts", async () => {
    const transport = serving(page);
    hoisted.transport = transport;
    expect(render().status).toBe("loading");
    expect(await settle()).toEqual({ status: "ready", html: "<p>chart</p>" });
    expect(transport.readChunk).toHaveBeenCalledTimes(1);
  });

  it("retries a failed read when the environment reconnects", async () => {
    hoisted.status = { phase: "disconnected", connectedAt: null };
    expect(render().status).toBe("loading");
    const failed = await settle();
    expect(failed.status).toBe("failed");

    hoisted.transport = serving(page);
    hoisted.status = { phase: "connected", connectedAt: "2026-10-07T10:05:00.000Z" };
    expect(render().status).toBe("loading");
    expect(await settle()).toEqual({ status: "ready", html: "<p>chart</p>" });
  });

  it("retries a failed read on the reader's tap", async () => {
    const failing = vi.fn(async () => {
      throw new Error("boom");
    });
    hoisted.transport = { readChunk: failing };
    render();
    const failed = await settle();
    if (failed.status !== "failed") throw new Error(`expected failed, got ${failed.status}`);

    hoisted.transport = serving(page);
    failed.retry();
    expect(render().status).toBe("loading");
    expect(await settle()).toEqual({ status: "ready", html: "<p>chart</p>" });
  });

  it("waits for a tap before reading a large page", async () => {
    sizeBytes = HTML_RENDER_AUTO_LOAD_MAX_BYTES + 1;
    const transport = serving(page);
    hoisted.transport = transport;
    const idle = render();
    if (idle.status !== "idle") throw new Error(`expected idle, got ${idle.status}`);
    await settle();
    expect(transport.readChunk).not.toHaveBeenCalled();
    idle.load();
    expect(render().status).toBe("loading");
    await vi.waitFor(() => expect(transport.readChunk).toHaveBeenCalled());
  });

  it("reads a large page at once when the reader opened it", async () => {
    const large = new Uint8Array(HTML_RENDER_AUTO_LOAD_MAX_BYTES + 1).fill(0x61);
    sizeBytes = large.length;
    requested = true;
    const transport = serving(large);
    hoisted.transport = transport;
    expect(render().status).toBe("loading");
    await vi.waitFor(() => expect(render().status).toBe("ready"));
    expect(transport.readChunk).toHaveBeenCalled();
  });

  it("keeps the page it mounted with after the cache drops it", async () => {
    const transport = serving(page);
    hoisted.transport = transport;
    render();
    expect((await settle()).status).toBe("ready");
    // The row scrolls away and back: it mounts from the cache, without a read.
    unmount();
    hoisted.runtime.effects = [];
    hoisted.runtime.slots = [];
    expect(render()).toEqual({ status: "ready", html: "<p>chart</p>" });
    // Other rows' pages evict this one while it is still on screen.
    clearHtmlRenderSourceCache();
    expect(render()).toEqual({ status: "ready", html: "<p>chart</p>" });
    expect(await settle()).toEqual({ status: "ready", html: "<p>chart</p>" });
    expect(transport.readChunk).toHaveBeenCalledTimes(1);
  });

  it("takes a cached page as its own when the row is given another page", async () => {
    hoisted.transport = serving(page);
    render();
    expect((await settle()).status).toBe("ready");
    // Another row already read the second page.
    const other = new TextEncoder().encode("<p>table</p>");
    const otherTransport = serving(other);
    const reference = {
      threadId: ThreadId.make("thread-1"),
      messageId: MessageId.make("message-1"),
      attachmentId: "thread-1-def-html",
    };
    await acquireHtmlRenderSource({
      key: htmlRenderSourceKey("env-1", reference),
      reference,
      sizeBytes: other.length,
      currentTransport: () => otherTransport,
    }).promise;

    attachmentId = reference.attachmentId;
    sizeBytes = other.length;
    expect(render()).toEqual({ status: "ready", html: "<p>table</p>" });
    clearHtmlRenderSourceCache();
    expect(render()).toEqual({ status: "ready", html: "<p>table</p>" });
    expect(await settle()).toEqual({ status: "ready", html: "<p>table</p>" });
    expect(otherTransport.readChunk).toHaveBeenCalledTimes(1);
  });

  it("keeps a page on screen through a disconnect and a reconnect, reading it once", async () => {
    const transport = serving(page);
    hoisted.transport = transport;
    render();
    expect((await settle()).status).toBe("ready");
    // Not in the cache: evicted, or a page too large to keep.
    clearHtmlRenderSourceCache();

    hoisted.transport = undefined;
    hoisted.status = { phase: "disconnected", connectedAt: null };
    expect(render().status).toBe("ready");
    expect((await settle()).status).toBe("ready");

    hoisted.transport = transport;
    hoisted.status = { phase: "connected", connectedAt: "2026-10-07T10:05:00.000Z" };
    expect(render().status).toBe("ready");
    expect(await settle()).toEqual({ status: "ready", html: "<p>chart</p>" });
    expect(transport.readChunk).toHaveBeenCalledTimes(1);
  });

  it("keeps a large page the reader loaded through a reconnect, reading it once", async () => {
    const large = new Uint8Array(HTML_RENDER_AUTO_LOAD_MAX_BYTES + 1).fill(0x61);
    sizeBytes = large.length;
    const transport = serving(large);
    hoisted.transport = transport;
    const idle = render();
    if (idle.status !== "idle") throw new Error(`expected idle, got ${idle.status}`);
    idle.load();
    render();
    await vi.waitFor(() => expect(render().status).toBe("ready"));
    const reads = transport.readChunk.mock.calls.length;
    clearHtmlRenderSourceCache();

    hoisted.status = { phase: "connected", connectedAt: "2026-10-07T10:05:00.000Z" };
    expect(render().status).toBe("ready");
    expect((await settle()).status).toBe("ready");
    expect(transport.readChunk).toHaveBeenCalledTimes(reads);
  });

  it("stops reading when the row unmounts", async () => {
    let signalled: () => void = () => undefined;
    const readChunk = vi.fn(
      () =>
        new Promise((resolve) => {
          signalled = () =>
            resolve({ dataBase64: btoa("<p>chart</p>"), offset: 0, totalBytes: page.length });
        }),
    );
    hoisted.transport = { readChunk };
    render();
    await vi.waitFor(() => expect(readChunk).toHaveBeenCalledTimes(1));
    unmount();
    hoisted.runtime.effects = [];
    signalled();
    // A row mounting later starts over rather than finding a cancelled page cached.
    hoisted.runtime.slots = [];
    hoisted.transport = serving(page);
    expect(render().status).toBe("loading");
    expect(await settle()).toEqual({ status: "ready", html: "<p>chart</p>" });
  });
});
