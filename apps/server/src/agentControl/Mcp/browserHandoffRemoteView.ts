/**
 * Remote view of a handed-off Ryco browser tab (`nodeBrowser/handoffTabs.ts`): the owner sees and
 * drives the one desktop tab an agent handed to them, from the phone or another browser, while the
 * hand-off is pending.
 *
 * Two gates, both on every still, input batch and streamed frame:
 * - the node's: the tab id stands for a user action request this node knows, still pending, of the
 *   browser surface, recorded with `remoteView`, with its target tab (`gate`);
 * - the desktop's: its own pending hand-off of that tab for that request, with the Ryco browser
 *   still enabled (`apps/desktop/src/computerUse/browserHandoffs.ts`, `remoteGate`).
 * Only the node reaches the desktop's bridge (its bearer token). The hand-off's viewer token is no
 * third check: `view` returns it to the node; it marks the hand-off's generation, so a token from
 * an earlier hand-off or desktop process is refused as stale instead of serving the new one.
 * When the request resolves, expires, its tab closes or its thread is removed, the next call or
 * frame finds one of them closed: the stream ends with `tabGone`, input is refused.
 *
 * The owner role is checked by the callers (the RPC handlers, the frame route, the relay tunnel);
 * agents never reach this module (no Agent Control tool calls it). Loaded on the first remote view.
 *
 * @module agentControl/Mcp/browserHandoffRemoteView
 */
import {
  NODE_BROWSER_STILL_MAX_BASE64,
  NodeBrowserRpcError,
  type NodeBrowserInputRequest,
  type NodeBrowserStill,
} from "@ryco/contracts/node-browser";
import {
  BrowserHandoffBridgeResponse,
  type BrowserHandoffBridgeRequest,
} from "@ryco/contracts/browser-handoff";
import type { ThreadId, UserActionRequestId } from "@ryco/contracts";
import {
  encodeNodeBrowserFrame,
  NODE_BROWSER_FRAME_CLOSE,
  NODE_BROWSER_FRAME_PARAMS,
} from "@ryco/shared/nodeBrowserFrame";
import { userActionRequestIdOfRemoteViewTab } from "@ryco/shared/userActionRequests";
import { Deferred, Duration, Effect, Queue, Schema } from "effect";

import type { HandoffTabSource } from "../../nodeBrowser/handoffTabs.ts";
import {
  readViewerClient,
  serveViewerSocket,
  type ViewerOutput,
} from "../../nodeBrowser/nodeBrowserViewerSocket.ts";
import {
  currentUserActionRequest,
  findOpenUserActionRequest,
  type UserActionRequestDeps,
} from "../../userActionRequests/userActionRequests.ts";

/** At most this many streamed frames per second of a changing page. */
const FRAME_MIN_INTERVAL_MS = 120;
/** How often an unchanged page is looked at again. */
const UNCHANGED_POLL_MS = 300;
/** Bridge failures in a row before a stream gives up. */
const MAX_FAILURES = 10;

const notFound = () =>
  new NodeBrowserRpcError({
    code: "not-found",
    message: "This tab is no longer handed to you.",
    retryable: false,
  });
const failed = (message: string) =>
  new NodeBrowserRpcError({ code: "failed", message, retryable: true });

interface Gated {
  readonly threadId: ThreadId;
  readonly requestId: UserActionRequestId;
  readonly tab: string;
}

export type HandoffBridgePost = (
  request: BrowserHandoffBridgeRequest,
) => Effect.Effect<unknown, { readonly _tag: string }>;

const decodeResponse = Schema.decodeUnknownEffect(BrowserHandoffBridgeResponse);

const clampInt = (value: string | null, fallback: number, min: number, max: number) => {
  const parsed = value === null ? Number.NaN : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

export function makeHandoffTabSource(deps: {
  readonly post: HandoffBridgePost;
  readonly requests: UserActionRequestDeps;
}): HandoffTabSource {
  const bridge = (request: BrowserHandoffBridgeRequest) =>
    deps.post(request).pipe(
      Effect.flatMap(decodeResponse),
      Effect.mapError(() => failed("The desktop is not reachable.")),
    );

  /** The node's gate: a pending, remote-viewable browser request with this tab. */
  const gate = (tabId: string): Effect.Effect<Gated, NodeBrowserRpcError> =>
    Effect.gen(function* () {
      const requestId = userActionRequestIdOfRemoteViewTab(tabId) as UserActionRequestId | null;
      if (requestId === null) return yield* Effect.fail(notFound());
      const open = findOpenUserActionRequest(requestId);
      if (open === undefined) return yield* Effect.fail(notFound());
      const current = yield* currentUserActionRequest(deps.requests, open.threadId, requestId);
      if (
        current === undefined ||
        current.status !== "pending" ||
        current.surface !== "browser" ||
        !current.remoteView ||
        current.target === null
      ) {
        return yield* Effect.fail(notFound());
      }
      return { threadId: open.threadId, requestId, tab: current.target };
    });

  // The desktop's viewer token (a generation marker) per request; refreshed once when stale.
  const viewers = new Map<string, string>();
  const view = (gated: Gated, refresh: boolean) =>
    Effect.gen(function* () {
      const known = viewers.get(gated.requestId);
      if (known !== undefined && !refresh) return known;
      const answer = yield* bridge({ op: "view", requestId: gated.requestId, tab: gated.tab });
      if (answer.status !== "viewing") {
        viewers.delete(gated.requestId);
        return yield* Effect.fail(notFound());
      }
      viewers.set(gated.requestId, answer.viewer);
      if (viewers.size > 64) {
        const oldest = viewers.keys().next().value;
        if (oldest !== undefined) viewers.delete(oldest);
      }
      return answer.viewer;
    });

  /** One bridge call with the viewer token; a stale token is refreshed and the call retried once. */
  const withViewer = <A>(
    gated: Gated,
    call: (viewer: string) => Effect.Effect<BrowserHandoffBridgeResponse, NodeBrowserRpcError>,
    read: (answer: BrowserHandoffBridgeResponse) => A | undefined,
  ): Effect.Effect<A, NodeBrowserRpcError> =>
    Effect.gen(function* () {
      for (const refresh of [false, true]) {
        const answer = yield* call(yield* view(gated, refresh));
        if (answer.status === "stale") continue;
        if (answer.status === "gone") {
          viewers.delete(gated.requestId);
          return yield* Effect.fail(notFound());
        }
        const value = read(answer);
        if (value === undefined) return yield* Effect.fail(failed("Unexpected desktop answer."));
        return value;
      }
      return yield* Effect.fail(notFound());
    });

  const frame = (
    gated: Gated,
    options: { maxWidth: number; maxHeight: number; quality: number; since?: string | undefined },
  ) =>
    withViewer(
      gated,
      (viewer) =>
        bridge({
          op: "frame",
          requestId: gated.requestId,
          tab: gated.tab,
          viewer,
          maxWidth: options.maxWidth,
          maxHeight: options.maxHeight,
          quality: options.quality,
          ...(options.since === undefined ? {} : { since: options.since }),
        }),
      (answer) => (answer.status === "frame" || answer.status === "unchanged" ? answer : undefined),
    );

  let stillSeq = 0;

  const still: HandoffTabSource["still"] = (request) =>
    Effect.gen(function* () {
      const gated = yield* gate(request.tabId);
      const answer = yield* frame(gated, request);
      if (answer.status !== "frame") return yield* Effect.fail(failed("No frame yet."));
      if (answer.jpeg.length > NODE_BROWSER_STILL_MAX_BASE64) {
        return yield* Effect.fail(failed("The frame is too large."));
      }
      stillSeq += 1;
      const result: NodeBrowserStill = {
        mimeType: "image/jpeg",
        width: Math.max(1, Math.min(3840, Math.round(answer.width))),
        height: Math.max(1, Math.min(2400, Math.round(answer.height))),
        cssWidth: Math.max(1, Math.min(3840, Math.round(answer.cssWidth))),
        cssHeight: Math.max(1, Math.min(2160, Math.round(answer.cssHeight))),
        seq: stillSeq,
        bytesBase64: answer.jpeg,
      };
      return result;
    });

  const input: HandoffTabSource["input"] = (request: NodeBrowserInputRequest) =>
    Effect.gen(function* () {
      const gated = yield* gate(request.tabId);
      yield* withViewer(
        gated,
        (viewer) =>
          bridge({
            op: "input",
            requestId: gated.requestId,
            tab: gated.tab,
            viewer,
            events: request.events,
          }),
        (answer) => (answer.status === "accepted" ? true : undefined),
      );
    });

  const command: HandoffTabSource["command"] = (tabId, type) =>
    Effect.gen(function* () {
      const gated = yield* gate(tabId);
      if (type !== "resize") {
        return yield* Effect.fail(
          new NodeBrowserRpcError({
            code: "failed",
            message: "Only the desktop can navigate a handed-off tab.",
            retryable: false,
          }),
        );
      }
      const answer = yield* bridge({ op: "view", requestId: gated.requestId, tab: gated.tab });
      if (answer.status !== "viewing") return yield* Effect.fail(notFound());
      viewers.set(gated.requestId, answer.viewer);
      const viewport = {
        width: Math.max(1, Math.round(answer.cssWidth)),
        height: Math.max(1, Math.round(answer.cssHeight)),
      };
      return {
        tab: {
          id: tabId,
          scope: "",
          url: "",
          title: "",
          loading: false,
          canGoBack: false,
          canGoForward: false,
          state: "live" as const,
          viewport,
          dialog: null,
          error: null,
        },
      };
    });

  const serveViewer: HandoffTabSource["serveViewer"] = (socket, params) =>
    Effect.gen(function* () {
      const client = yield* readViewerClient(socket.pull);
      const tabId = params.get(NODE_BROWSER_FRAME_PARAMS.tab) ?? "";
      const size = {
        maxWidth: clampInt(params.get(NODE_BROWSER_FRAME_PARAMS.maxWidth), 1280, 64, 4096),
        maxHeight: clampInt(params.get(NODE_BROWSER_FRAME_PARAMS.maxHeight), 800, 64, 4096),
        quality: clampInt(params.get(NODE_BROWSER_FRAME_PARAMS.quality), 60, 20, 80),
      };
      const output = yield* Queue.dropping<ViewerOutput>(8);
      const close = (code: number, reason: string) =>
        Queue.offer(output, { _tag: "close", code, reason });
      const produce = Effect.gen(function* () {
        let since: string | undefined;
        let seq = 0;
        let failures = 0;
        while (true) {
          // Both gates, on every frame: the stream ends the moment either closes.
          const result = yield* gate(tabId).pipe(
            Effect.flatMap((gated) => frame(gated, { ...size, since })),
            Effect.result,
          );
          if (result._tag === "Failure") {
            if (result.failure.code === "not-found") {
              return yield* close(NODE_BROWSER_FRAME_CLOSE.tabGone, result.failure.message);
            }
            failures += 1;
            if (failures >= MAX_FAILURES) {
              return yield* close(NODE_BROWSER_FRAME_CLOSE.unavailable, "desktop unreachable");
            }
            yield* Effect.sleep(Duration.millis(500));
            continue;
          }
          failures = 0;
          const answer = result.success;
          if (answer.status === "unchanged") {
            yield* Effect.sleep(Duration.millis(UNCHANGED_POLL_MS));
            continue;
          }
          seq += 1;
          since = answer.fingerprint;
          const acked = yield* Deferred.make<void>();
          yield* Queue.offer(output, {
            _tag: "frame",
            data: encodeNodeBrowserFrame({
              seq,
              cssWidth: answer.cssWidth,
              cssHeight: answer.cssHeight,
              jpeg: Buffer.from(answer.jpeg, "base64"),
            }),
            ack: Deferred.succeed(acked, undefined).pipe(Effect.asVoid),
          });
          // One frame in flight: the next is taken once the viewer has this one.
          yield* Deferred.await(acked);
          yield* Effect.sleep(Duration.millis(FRAME_MIN_INTERVAL_MS));
        }
      });
      yield* Effect.forkScoped(produce);
      yield* serveViewerSocket(socket, client, output);
    }).pipe(Effect.ignore);

  return { still, input, command, serveViewer };
}
