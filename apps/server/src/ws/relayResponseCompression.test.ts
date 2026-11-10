import { inflateRawSync } from "node:zlib";

import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@ryco/contracts";
import { RELAY_MAX_RPC_MESSAGE_BYTES } from "@ryco/contracts/relay";
import {
  appendRelayCompressionAdvertisement,
  decodeCompressedRelayPayload,
  isCompressedRelayPayload,
  relayCompressionAdvertisement,
  relayCompressionPaddedLength,
} from "@ryco/shared/relayPayloadCompression";
import { describe, expect, it } from "vite-plus/test";

import { pageShellSnapshot } from "./context/shellSnapshotPages.ts";
import {
  RELAY_COMPRESSION_ALLOWLIST,
  RELAY_COMPRESSION_MAX_TRACKED_REQUESTS,
  RELAY_COMPRESSION_THRESHOLD_BYTES,
  type RelayCompressionTurnState,
  RelayResponseCompressor,
  deflateRelayRpcMessage,
} from "./relayResponseCompression.ts";

// Gate logic on hand-built messages. The same rules over real Effect-encoded
// RPC traffic are exercised in `relayResponseCompression.session.test.ts`.

const encoder = new TextEncoder();

function threads(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `thread-${index}`,
    projectId: "project-1",
    title: `Investigate flaky test ${index % 17}`,
    branch: `feature/thread-${index}`,
    archivedAt: null,
    updatedAt: "2026-10-15T09:00:00.000Z",
  }));
}

function chunk(requestId: string, values: ReadonlyArray<unknown>) {
  return { _tag: "Chunk", requestId, values };
}

function encoded(response: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(response));
}

function request(id: string, tag: string, payload: unknown = {}) {
  return { _tag: "Request", id, tag, payload, headers: [] };
}

/** A compressor whose client advertised, with `tags` requested as ids 1, 2, … */
function advertisedCompressor(
  tags: ReadonlyArray<string>,
  options: ConstructorParameters<typeof RelayResponseCompressor>[0] = {},
  payload: unknown = {},
): RelayResponseCompressor {
  const compressor = new RelayResponseCompressor(options);
  compressor.acceptInbound(appendRelayCompressionAdvertisement(encoder.encode("{}")));
  tags.forEach((tag, index) => compressor.admitInbound(request(String(index + 1), tag, payload)));
  return compressor;
}

function success(requestId: string, value: unknown) {
  return { _tag: "Exit", requestId, exit: { _tag: "Success", value } };
}

/** History items: `count` finished assistant messages of turn `turnId`, changed at `at`. */
function messages(count: number, turnId: string, at: string, streaming = false) {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${turnId}-${index}`,
    role: "assistant",
    text: `Ran the relay suite, case ${index % 13}: everything passed after the retry.`,
    turnId,
    streaming,
    createdAt: at,
    updatedAt: at,
  }));
}

function historyPage(items: ReadonlyArray<unknown>) {
  return {
    collection: "messages",
    snapshotSequence: 9,
    items,
    page: { oldestCursor: null, newestCursor: null, hasMoreBefore: true },
  };
}

function turnState(
  running: { readonly turnId: string; readonly requestedAt: string } | null | undefined,
): RelayCompressionTurnState {
  return { runningTurnOf: async () => running };
}

async function encode(
  compressor: RelayResponseCompressor,
  response: unknown,
): Promise<ReadonlyArray<Uint8Array>> {
  return compressor.encode(response, encoded(response), encoded);
}

function inflate(frame: Uint8Array): Uint8Array {
  const decoded = decodeCompressedRelayPayload(frame);
  if (decoded.kind !== "ok") throw new Error(decoded.reason);
  return new Uint8Array(inflateRawSync(decoded.body));
}

const begin = {
  kind: "snapshot-begin",
  snapshotSequence: 1,
  updatedAt: "x",
  projects: [{ id: "project-1", scripts: [{ command: "DATABASE_URL=postgres://u:pw@db psql" }] }],
  threadCount: 400,
  archivedThreadCount: 0,
};
const threadPage = { kind: "snapshot-threads", threads: threads(400) };
const end = { kind: "snapshot-end" };

describe("RelayResponseCompressor", () => {
  it("compresses nothing until the client advertised", async () => {
    const compressor = new RelayResponseCompressor();
    compressor.admitInbound(request("1", ORCHESTRATION_WS_METHODS.subscribeShell));
    const response = chunk("1", [threadPage]);
    expect(encoded(response).byteLength).toBeGreaterThan(RELAY_COMPRESSION_THRESHOLD_BYTES);
    expect(await encode(compressor, response)).toEqual([encoded(response)]);
    expect(compressor.advertised).toBe(false);
  });

  it("latches a versioned advertisement and hands the parser the message without it", () => {
    const message = encoder.encode('{"_tag":"Ping"}');
    const plain = new RelayResponseCompressor();
    expect(plain.acceptInbound(message)).toBe(message);
    expect(plain.advertised).toBe(false);

    const current = new RelayResponseCompressor();
    expect(current.acceptInbound(appendRelayCompressionAdvertisement(message))).toEqual(message);
    expect(current.advertised).toBe(true);

    // A future client that inflates versions 1 to 7 still gets version 1 here.
    const future = new RelayResponseCompressor();
    const advertised = appendRelayCompressionAdvertisement(
      message,
      relayCompressionAdvertisement(7),
    );
    expect(future.acceptInbound(advertised)).toEqual(message);
    expect(future.advertised).toBe(true);

    // Version 0 is no advertisement at all.
    const zero = new RelayResponseCompressor();
    const versionZero = Uint8Array.from([
      ...message,
      0x0a,
      0x0d,
      0x09,
      0x20,
      0x20,
      0x20,
      0x20,
      0x20,
    ]);
    zero.acceptInbound(versionZero);
    expect(zero.advertised).toBe(false);
  });

  it("compresses shell thread pages, the page that ends the snapshot included", async () => {
    const compressor = advertisedCompressor([ORCHESTRATION_WS_METHODS.subscribeShell]);
    for (const values of [[threadPage], [threadPage, end]]) {
      const response = chunk("1", values);
      const parts = await encode(compressor, response);
      expect(parts).toHaveLength(1);
      expect(isCompressedRelayPayload(parts[0]!)).toBe(true);
      expect(inflate(parts[0]!)).toEqual(encoded(response));
    }
  });

  it("splits snapshot-begin off the first page and never compresses project data", async () => {
    const compressor = advertisedCompressor([ORCHESTRATION_WS_METHODS.subscribeShell]);
    const parts = await encode(compressor, chunk("1", [begin, threadPage]));
    expect(parts).toHaveLength(2);
    expect(isCompressedRelayPayload(parts[0]!)).toBe(false);
    expect(JSON.parse(new TextDecoder().decode(parts[0]!))).toEqual(chunk("1", [begin]));
    expect(isCompressedRelayPayload(parts[1]!)).toBe(true);
    const tail = new TextDecoder().decode(inflate(parts[1]!));
    expect(JSON.parse(tail)).toEqual(chunk("1", [threadPage]));
    expect(tail).not.toContain("postgres://");
  });

  it("withholds exactly one client ack per split chunk", async () => {
    const compressor = advertisedCompressor([
      ORCHESTRATION_WS_METHODS.subscribeShell,
      ORCHESTRATION_WS_METHODS.subscribeShell,
    ]);
    await encode(compressor, chunk("1", [begin, threadPage]));
    expect(compressor.admitInbound({ _tag: "Ack", requestId: "2" })).toBe(true);
    expect(compressor.admitInbound({ _tag: "Ack", requestId: "1" })).toBe(false);
    expect(compressor.admitInbound({ _tag: "Ack", requestId: "1" })).toBe(true);
    expect(compressor.admitInbound({ _tag: "Ack", requestId: "1" })).toBe(true);
  });

  it("never compresses snapshot-begin alone, the unpaged snapshot, or events", async () => {
    const compressor = advertisedCompressor([ORCHESTRATION_WS_METHODS.subscribeShell]);
    const event = {
      kind: "thread-upserted",
      sequence: 2,
      thread: threads(1)[0],
      pad: "x".repeat(20_000),
    };
    for (const values of [
      [{ ...begin, pad: "y".repeat(30_000) }],
      [{ kind: "snapshot", snapshot: { projects: begin.projects, threads: threads(400) } }],
      [event],
      [threadPage, event],
      [begin, threadPage, event],
    ]) {
      const response = chunk("1", values);
      expect(await encode(compressor, response)).toEqual([encoded(response)]);
    }
  });

  it("compresses full provider lists, the config snapshot and settings, never a delta", async () => {
    const compressor = advertisedCompressor([WS_METHODS.subscribeServerConfig]);
    const providers = threads(400);
    for (const type of ["providerStatuses", "snapshot", "settingsUpdated"]) {
      const response = chunk("1", [{ version: 1, type, payload: { providers } }]);
      const [frame] = await encode(compressor, response);
      expect(isCompressedRelayPayload(frame!)).toBe(true);
      expect(inflate(frame!)).toEqual(encoded(response));
    }
    for (const values of [
      [{ version: 1, type: "providerStatusesDelta", payload: { providers } }],
      [{ version: 1, type: "keybindingsUpdated", payload: { providers } }],
      // Two classes in one batch: neither accepts it whole.
      [
        { version: 1, type: "providerStatuses", payload: { providers } },
        { version: 1, type: "providerStatusesDelta", payload: { providers } },
      ],
    ]) {
      const response = chunk("1", values);
      expect(await encode(compressor, response)).toEqual([encoded(response)]);
    }
    const getConfig = advertisedCompressor([WS_METHODS.serverGetConfig]);
    const [config] = await encode(getConfig, success("1", providers));
    expect(isCompressedRelayPayload(config!)).toBe(true);
  });

  it("compresses file-tree listings but never file contents or diffs", async () => {
    const entries = Array.from({ length: 2_000 }, (_, index) => ({
      path: `src/components/feature-${index % 40}/Widget${index}.tsx`,
      kind: "file",
      parentPath: `src/components/feature-${index % 40}`,
    }));
    const tree = advertisedCompressor([WS_METHODS.projectsListEntries]);
    const [listing] = await encode(tree, success("1", { entries, truncated: false }));
    expect(isCompressedRelayPayload(listing!)).toBe(true);
    for (const method of [
      WS_METHODS.projectsReadFile,
      WS_METHODS.projectsReadFileChunk,
      WS_METHODS.projectsSearchContent,
      ORCHESTRATION_WS_METHODS.getTurnDiff,
      ORCHESTRATION_WS_METHODS.getFullThreadDiff,
      WS_METHODS.sourceControlGetChangeRequestDiff,
    ]) {
      const response = success("1", { contents: JSON.stringify(entries) });
      expect(await encode(advertisedCompressor([method]), response)).toEqual([encoded(response)]);
    }
  });

  it("compresses thread windows with coarse padding, but never their failure", async () => {
    const compressor = advertisedCompressor([
      ORCHESTRATION_WS_METHODS.getThreadWindow,
      ORCHESTRATION_WS_METHODS.getThreadWindow,
      ORCHESTRATION_WS_METHODS.subscribeThreadWindow,
    ]);
    const window = success("1", {
      thread: { messages: messages(300, "turn-1", "2026-11-10T09:00:00.000Z") },
    });
    const [frame] = await encode(compressor, window);
    expect(isCompressedRelayPayload(frame!)).toBe(true);
    expect(inflate(frame!)).toEqual(encoded(window));
    const decoded = decodeCompressedRelayPayload(frame!);
    if (decoded.kind !== "ok") throw new Error(decoded.reason);
    const unpadded = 12 + decoded.body.byteLength;
    expect(frame!.byteLength).toBe(relayCompressionPaddedLength(unpadded, "coarse"));
    expect(frame!.byteLength % (16 * 1_024)).toBe(0);
    const failure = {
      _tag: "Exit",
      requestId: "2",
      exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { message: "x".repeat(40_000) } }] },
    };
    expect(await encode(compressor, failure)).toEqual([encoded(failure)]);
    const snapshot = chunk("3", [{ kind: "snapshot", snapshot: { threads: threads(400) } }]);
    expect(isCompressedRelayPayload((await encode(compressor, snapshot))[0]!)).toBe(true);
    const event = chunk("3", [{ kind: "event", event: { pad: "x".repeat(40_000) } }]);
    expect(await encode(compressor, event)).toEqual([encoded(event)]);
  });

  it("compresses a history page only when all of it belongs to turns that ended", async () => {
    const before = "2026-11-10T09:00:00.000Z";
    const after = "2026-11-10T09:30:00.000Z";
    const running = { turnId: "turn-9", requestedAt: "2026-11-10T09:10:00.000Z" };
    const compress = async (
      state: RelayCompressionTurnState | undefined,
      items: ReadonlyArray<unknown>,
      payload: unknown = { threadId: "thread-1" },
    ) => {
      const compressor = advertisedCompressor(
        [ORCHESTRATION_WS_METHODS.getThreadHistoryPage],
        state === undefined ? {} : { turnState: state },
        payload,
      );
      const [frame] = await encode(compressor, success("1", historyPage(items)));
      return isCompressedRelayPayload(frame!);
    };
    const old = messages(300, "turn-1", before);
    // No turn runs, or the page is older than the running one: compressed.
    expect(await compress(turnState(null), old)).toBe(true);
    expect(await compress(turnState(running), old)).toBe(true);
    // Anything of the running turn, anything changed after it began, or anything streaming: plain.
    expect(await compress(turnState(running), [...old, ...messages(1, "turn-9", before)])).toBe(
      false,
    );
    expect(await compress(turnState(running), [...old, ...messages(1, "turn-2", after)])).toBe(
      false,
    );
    expect(await compress(turnState(null), [...old, ...messages(1, "turn-1", before, true)])).toBe(
      false,
    );
    // Turn state unknown or unavailable, or no thread in the request: plain.
    expect(await compress(turnState(undefined), old)).toBe(false);
    expect(await compress(undefined, old)).toBe(false);
    expect(await compress(turnState(null), old, {})).toBe(false);
    // An item without a timestamp: plain.
    expect(await compress(turnState(null), [...old, { id: "x", turnId: "turn-1" }])).toBe(false);
  });

  it("leaves a large response of a method outside the allowlist alone", async () => {
    const compressor = advertisedCompressor([ORCHESTRATION_WS_METHODS.searchThreadMessages]);
    const response = {
      _tag: "Exit",
      requestId: "1",
      exit: { _tag: "Success", value: threads(400) },
    };
    expect(await encode(compressor, response)).toEqual([encoded(response)]);
  });

  it("keeps the default allowlist to the classes of docs/relay-e2ee-protocol.md §4.6.3", () => {
    expect(
      Object.fromEntries(
        Object.entries(RELAY_COMPRESSION_ALLOWLIST).map(([name, rules]) => [
          name,
          Object.keys(rules).toSorted(),
        ]),
      ),
    ).toEqual({
      shellSnapshotPages: [ORCHESTRATION_WS_METHODS.subscribeShell],
      providerStatuses: [WS_METHODS.subscribeServerConfig],
      serverConfig: [WS_METHODS.serverGetConfig, WS_METHODS.subscribeServerConfig].toSorted(),
      fileTree: [WS_METHODS.projectsListEntries],
      finishedHistoryPages: [ORCHESTRATION_WS_METHODS.getThreadHistoryPage],
      threadWindows: [
        ORCHESTRATION_WS_METHODS.getThreadWindow,
        ORCHESTRATION_WS_METHODS.subscribeThreadWindow,
      ].toSorted(),
    });
  });

  it("skips messages under the threshold and over the relay message limit", async () => {
    const compressor = advertisedCompressor([ORCHESTRATION_WS_METHODS.subscribeShell]);
    const small = chunk("1", [{ kind: "snapshot-threads", threads: threads(10) }]);
    expect(encoded(small).byteLength).toBeLessThan(RELAY_COMPRESSION_THRESHOLD_BYTES);
    expect(await encode(compressor, small)).toEqual([encoded(small)]);
    const huge = chunk("1", [
      { kind: "snapshot-threads", threads: [], pad: "y".repeat(RELAY_MAX_RPC_MESSAGE_BYTES) },
    ]);
    const hugeBytes = encoded(huge);
    // Identity rather than toEqual, which walks all 4 MiB element by element (~10 s).
    const sent = await compressor.encode(huge, hugeBytes, encoded);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe(hugeBytes);
  });

  it("compresses only what fits the channel's ceiling together with its frame", async () => {
    const response = chunk("1", [threadPage]);
    const bytes = encoded(response);
    const [frame] = await encode(
      advertisedCompressor([ORCHESTRATION_WS_METHODS.subscribeShell]),
      response,
    );
    // Just enough room for the message and its frame: compressed.
    const roomy = advertisedCompressor([ORCHESTRATION_WS_METHODS.subscribeShell], {
      maxMessageBytes: bytes.byteLength + frame!.byteLength,
    });
    expect(isCompressedRelayPayload((await encode(roomy, response))[0]!)).toBe(true);
    // One byte less, or a ceiling the message alone already fills: sent as it is,
    // and left to the channel's own too-large handling.
    for (const maxMessageBytes of [bytes.byteLength + frame!.byteLength - 1, bytes.byteLength]) {
      const tight = advertisedCompressor([ORCHESTRATION_WS_METHODS.subscribeShell], {
        maxMessageBytes,
      });
      expect(await encode(tight, response)).toEqual([bytes]);
    }
  });

  it("sends the original when compression saves less than 10%", async () => {
    // JSON text always compresses somewhat, so the deflate is stubbed to save 8%.
    const compressor = advertisedCompressor([ORCHESTRATION_WS_METHODS.subscribeShell], {
      deflate: async (message) => new Uint8Array(Math.floor(message.byteLength * 0.92)).fill(1),
    });
    const response = chunk("1", [threadPage]);
    expect(await encode(compressor, response)).toEqual([encoded(response)]);
    // Nor is a split made when its compressed half would not pay for itself.
    const split = chunk("1", [begin, threadPage]);
    expect(await encode(compressor, split)).toEqual([encoded(split)]);
    expect(compressor.admitInbound({ _tag: "Ack", requestId: "1" })).toBe(true);
  });

  it("compresses every message in a context of its own", async () => {
    const compressor = advertisedCompressor([ORCHESTRATION_WS_METHODS.subscribeShell]);
    const response = chunk("1", [threadPage]);
    const alone = await encode(compressor, response);
    await encode(
      compressor,
      chunk("1", [{ kind: "snapshot-threads", threads: threads(300).toReversed() }]),
    );
    expect(await encode(compressor, response)).toEqual(alone);
    const bytes = encoded(response);
    expect(await deflateRelayRpcMessage(bytes)).toEqual(await deflateRelayRpcMessage(bytes));
  });

  it("forgets a request at its exit, and lets a reused id start over", async () => {
    const compressor = advertisedCompressor([ORCHESTRATION_WS_METHODS.subscribeShell]);
    const exit = { _tag: "Exit", requestId: "1", exit: { _tag: "Success", value: null } };
    await encode(compressor, exit);
    const page = chunk("1", [threadPage]);
    expect(await encode(compressor, page)).toEqual([encoded(page)]);

    const reused = advertisedCompressor([ORCHESTRATION_WS_METHODS.subscribeShell]);
    reused.admitInbound(request("1", ORCHESTRATION_WS_METHODS.searchThreadMessages));
    expect(await encode(reused, page)).toEqual([encoded(page)]);
  });

  it("tracks at most RELAY_COMPRESSION_MAX_TRACKED_REQUESTS allowlisted requests", async () => {
    const compressor = advertisedCompressor([]);
    for (let id = 0; id < RELAY_COMPRESSION_MAX_TRACKED_REQUESTS + 5; id += 1) {
      compressor.admitInbound(request(`r${id}`, ORCHESTRATION_WS_METHODS.subscribeShell));
    }
    expect(compressor.trackedRequests).toBe(RELAY_COMPRESSION_MAX_TRACKED_REQUESTS);
    const overflow = chunk(`r${RELAY_COMPRESSION_MAX_TRACKED_REQUESTS}`, [threadPage]);
    expect(await encode(compressor, overflow)).toEqual([encoded(overflow)]);
    // An exit frees a slot for the next request.
    await encode(compressor, {
      _tag: "Exit",
      requestId: "r0",
      exit: { _tag: "Success", value: null },
    });
    compressor.admitInbound(request("late", ORCHESTRATION_WS_METHODS.subscribeShell));
    const late = await encode(compressor, chunk("late", [threadPage]));
    expect(isCompressedRelayPayload(late[0]!)).toBe(true);
  });

  it("sends the original when compression fails", async () => {
    const compressor = advertisedCompressor([ORCHESTRATION_WS_METHODS.subscribeShell], {
      deflate: () => Promise.reject(new Error("zlib unavailable")),
    });
    const response = chunk("1", [threadPage]);
    expect(await encode(compressor, response)).toEqual([encoded(response)]);
  });

  it("covers every page pageShellSnapshot produces", async () => {
    const compressor = advertisedCompressor([ORCHESTRATION_WS_METHODS.subscribeShell]);
    const snapshot = { snapshotSequence: 1, projects: [], threads: threads(6_000), updatedAt: "x" };
    const pages = pageShellSnapshot(snapshot as never, 256 * 1_024);
    expect(pages.length).toBeGreaterThan(2);
    for (const [index, page] of pages.entries()) {
      const parts = await encode(compressor, chunk("1", page));
      expect(parts).toHaveLength(index === 0 ? 2 : 1);
      expect(isCompressedRelayPayload(parts.at(-1)!)).toBe(true);
    }
  });
});
