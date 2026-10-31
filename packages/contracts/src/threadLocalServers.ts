import * as Schema from "effect/Schema";

import { IsoDateTime, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * The local servers a thread started (docs/thread-servers.md).
 *
 * Every agent session and thread terminal runs with `RYCO_THREAD_ID` set to its thread, and every
 * process it starts inherits it, so a dev server stays attributed after its launching shell exits.
 * The node lists the loopback and wildcard TCP listeners whose launch environment carries the
 * thread's id, and stops one only after checking again that it is still that thread's server.
 */

/** At most this many servers per thread are listed, lowest port first. */
export const THREAD_LOCAL_SERVERS_MAX = 32;
/** Page titles are cut to this many characters. */
export const THREAD_LOCAL_SERVER_TITLE_MAX_CHARS = 200;

const Port = PositiveInt.check(Schema.isLessThanOrEqualTo(65_535));

/**
 * Where the server runs from:
 * - `terminal`: under one of the thread's terminals;
 * - `agent`: under one of the node's agent processes;
 * - `unknown`: its launching process is gone (a backgrounded or daemonized server).
 */
export const ThreadLocalServerOrigin = Schema.Literals(["agent", "terminal", "unknown"]);
export type ThreadLocalServerOrigin = typeof ThreadLocalServerOrigin.Type;

export const ThreadLocalServer = Schema.Struct({
  pid: PositiveInt,
  /** The process's start time (whole seconds); with `pid` it names one process. */
  startTimeMs: PositiveInt,
  port: Port,
  /** The address it listens on as the system reports it (`127.0.0.1`, `[::1]`, `*`). */
  host: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  /** `http://localhost:<port>/`: on the node's machine, not necessarily the client's. */
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  /** The executable's short name only, never its arguments. */
  processName: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  /** The page's title, for a server that answers `GET /` with HTML. */
  pageTitle: Schema.NullOr(
    TrimmedNonEmptyString.check(Schema.isMaxLength(THREAD_LOCAL_SERVER_TITLE_MAX_CHARS)),
  ),
  origin: ThreadLocalServerOrigin,
});
export type ThreadLocalServer = typeof ThreadLocalServer.Type;

/** One thread's servers, sent first on subscription and then whenever they change. */
export const ThreadLocalServerList = Schema.Struct({
  threadId: ThreadId,
  servers: Schema.Array(ThreadLocalServer).check(Schema.isMaxLength(THREAD_LOCAL_SERVERS_MAX)),
  scannedAt: IsoDateTime,
});
export type ThreadLocalServerList = typeof ThreadLocalServerList.Type;

export const ThreadSubscribeLocalServersInput = Schema.Struct({ threadId: ThreadId });
export type ThreadSubscribeLocalServersInput = typeof ThreadSubscribeLocalServersInput.Type;

/**
 * `unsupported`: the node cannot list servers (Windows). `limit`: the connection already follows
 * as many threads as it may.
 */
export const ThreadLocalServersFailureReason = Schema.Literals(["unsupported", "limit"]);
export type ThreadLocalServersFailureReason = typeof ThreadLocalServersFailureReason.Type;

export class ThreadLocalServersError extends Schema.TaggedError<ThreadLocalServersError>()(
  "ThreadLocalServersError",
  {
    message: TrimmedNonEmptyString,
    reason: ThreadLocalServersFailureReason,
  },
) {}

/** The server to stop, as the list named it. */
export const ThreadStopLocalServerInput = Schema.Struct({
  threadId: ThreadId,
  pid: PositiveInt,
  startTimeMs: PositiveInt,
  port: Port,
});
export type ThreadStopLocalServerInput = typeof ThreadStopLocalServerInput.Type;

export const ThreadStopLocalServerResult = Schema.Struct({
  /** Its process group is gone. */
  stopped: Schema.Boolean,
  /** It outlived the grace period after SIGTERM and was sent SIGKILL. */
  escalated: Schema.Boolean,
});
export type ThreadStopLocalServerResult = typeof ThreadStopLocalServerResult.Type;

/**
 * - `not-found`: nothing listens on that port with that pid any more.
 * - `identity-changed`: the pid now names another process (it was reused).
 * - `not-attributed`: the listener does not belong to this thread.
 * - `shared-group`: its process group also holds the node, one of its ancestors, an agent CLI or
 *   a terminal shell, which a stop must never signal.
 * - `unsupported`: the node cannot stop servers (Windows).
 * - `signal-failed`: the process table could not be read or the signal was refused.
 */
export const ThreadStopLocalServerFailureReason = Schema.Literals([
  "not-found",
  "identity-changed",
  "not-attributed",
  "shared-group",
  "unsupported",
  "signal-failed",
]);
export type ThreadStopLocalServerFailureReason = typeof ThreadStopLocalServerFailureReason.Type;

export class ThreadStopLocalServerError extends Schema.TaggedError<ThreadStopLocalServerError>()(
  "ThreadStopLocalServerError",
  {
    message: TrimmedNonEmptyString,
    reason: ThreadStopLocalServerFailureReason,
  },
) {}
