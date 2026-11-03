import type {
  PullRequestAutoFixPauseReason,
  PullRequestWatchEndReason,
  SourceControlSetPullRequestWatchInput,
  SourceControlSetPullRequestWatchResult,
  ThreadId,
  ThreadPullRequestWatchEnded,
  ThreadPullRequestWatchShell,
  ThreadPullRequestWatchSummary,
} from "@ryco/contracts";

/**
 * What clients show of a thread's pull request watch, and the one request
 * shape every client sends to change it. The server decides everything; this
 * only words the shell summary (`ThreadPullRequestWatchSummary`) and imports
 * nothing from the server's decision rules.
 */

/** How the status line reads: in progress, needs the user, or plain. */
export type PullRequestWatchTone = "muted" | "active" | "warning";

export interface PullRequestWatchView {
  /** The status line, e.g. "Fixing CI · attempt 2 of 3". */
  readonly label: string;
  /** The same in a word or two, for a chip beside the pull request: "Fixing 2/3". */
  readonly shortLabel: string;
  readonly tone: PullRequestWatchTone;
  /** A second, quieter line; null when the status line says it all. */
  readonly detail: string | null;
  /** The Auto-fix CI switch is on (also while it is paused). */
  readonly autoFixOn: boolean;
  /** Auto-fix CI paused: turning it on again starts over. */
  readonly paused: boolean;
}

const WATCHING_NEWS = "wakes the agent on failures, reviews and conflicts";

const PAUSE_LABEL: Record<PullRequestAutoFixPauseReason, (maxAttempts: number) => string> = {
  "attempt-limit": (maxAttempts) =>
    `Auto-fix paused: checks still fail after ${maxAttempts} fix ${maxAttempts === 1 ? "attempt" : "attempts"}`,
  "no-push": () => "Auto-fix paused: the fix turn ended without a push",
  "start-failed": () => "Auto-fix paused: the fix turn did not start",
};

export function pullRequestWatchView(summary: ThreadPullRequestWatchSummary): PullRequestWatchView {
  const autoFix = summary.autoFix;
  if (autoFix === null) {
    return {
      label: `Watching · ${WATCHING_NEWS}`,
      shortLabel: "Watching",
      tone: "muted",
      detail: null,
      autoFixOn: false,
      paused: false,
    };
  }
  const alsoNews = summary.news ? `Also ${WATCHING_NEWS}` : null;
  switch (autoFix.status) {
    case "fixing":
      return {
        label: `Fixing CI · attempt ${autoFix.attempts} of ${autoFix.maxAttempts}`,
        shortLabel: `Fixing ${autoFix.attempts}/${autoFix.maxAttempts}`,
        tone: "active",
        detail: summary.delivering ? "Starting the fix turn" : "Waiting for the fix to be pushed",
        autoFixOn: true,
        paused: false,
      };
    case "paused":
      return {
        label: PAUSE_LABEL[autoFix.pauseReason ?? "attempt-limit"](autoFix.maxAttempts),
        shortLabel: "Auto-fix paused",
        tone: "warning",
        detail: alsoNews,
        autoFixOn: true,
        paused: true,
      };
    case "watching":
      return {
        // The switch beside it already says Auto-fix CI is on.
        label: "Watching the checks",
        shortLabel: "Auto-fix on",
        tone: "muted",
        detail:
          alsoNews ??
          `Starts a fix turn when checks fail, up to ${autoFix.maxAttempts} ${autoFix.maxAttempts === 1 ? "attempt" : "attempts"}`,
        autoFixOn: true,
        paused: false,
      };
  }
}

const ENDED_REASON: Record<PullRequestWatchEndReason, string> = {
  unwatched: "turned off",
  merged: "merged",
  closed: "closed",
  "comment-limit": "too many comment-only updates",
  unreadable: "could not read it several times in a row",
  settled: "the chat was settled",
  archived: "the chat was archived",
  trashed: "the chat was moved to Trash",
  stopped: "you stopped the chat",
  unlinked: "no longer linked to the workspace",
  "scope-changed": "the chat's permissions or checkout changed",
  rejected: "the chat kept refusing its updates",
  expired: "the chat could not take an update for a day",
};

/** "Stopped watching: merged". */
export function pullRequestWatchEndedLabel(reason: PullRequestWatchEndReason): string {
  return `Stopped watching: ${ENDED_REASON[reason]}`;
}

/** The pull request a watch control is about. */
export interface PullRequestWatchTarget {
  readonly number: number;
  /** The host URL when known: it tells pull requests of different repositories apart. */
  readonly url?: string | null | undefined;
}

/** Host URLs compare without case in the host, a trailing slash, a query or a fragment. */
export function samePullRequestUrl(left: string, right: string): boolean {
  return normalizePullRequestUrl(left) === normalizePullRequestUrl(right);
}

function normalizePullRequestUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/u, "")}`;
  } catch {
    return url.trim().replace(/\/+$/u, "");
  }
}

function matchesTarget(
  watch: Pick<ThreadPullRequestWatchSummary, "number" | "url">,
  target: PullRequestWatchTarget,
): boolean {
  if (watch.number !== target.number) return false;
  return !target.url || samePullRequestUrl(watch.url, target.url);
}

/**
 * One pull request's watch on a thread: the active one, else why the latest
 * one ended (ended entries carry no URL, so they match by number), else null.
 */
export function findPullRequestWatch(
  watches: ThreadPullRequestWatchShell | null | undefined,
  target: PullRequestWatchTarget,
):
  | { readonly kind: "active"; readonly watch: ThreadPullRequestWatchSummary }
  | { readonly kind: "ended"; readonly ended: ThreadPullRequestWatchEnded }
  | null {
  if (!watches) return null;
  const active = watches.active.find((watch) => matchesTarget(watch, target));
  if (active) return { kind: "active", watch: active };
  const ended = watches.ended.find((entry) => entry.number === target.number);
  return ended ? { kind: "ended", ended } : null;
}

/** Some thread actively watches the pull request (its watch then reports the checks passing). */
export function isPullRequestWatchedIn(
  threads: Iterable<{
    readonly id: ThreadId;
    readonly pullRequestWatches?: ThreadPullRequestWatchShell | undefined;
  }>,
  target: PullRequestWatchTarget,
): boolean {
  for (const thread of threads) {
    if (thread.pullRequestWatches?.active.some((watch) => matchesTarget(watch, target))) {
      return true;
    }
  }
  return false;
}

/**
 * What a client asks of a watch: Auto-fix CI on or off, Auto-fix CI on again
 * after a pause (it starts over), or stop watching altogether.
 */
export type PullRequestWatchAction = "auto-fix-on" | "auto-fix-off" | "resume" | "stop";

export function pullRequestWatchInput(
  input: PullRequestWatchTarget & { readonly threadId: ThreadId },
  action: PullRequestWatchAction,
): SourceControlSetPullRequestWatchInput {
  const target = {
    threadId: input.threadId,
    number: input.number,
    ...(input.url ? { url: input.url } : {}),
  };
  switch (action) {
    case "auto-fix-on":
    case "resume":
      return { ...target, autoFix: true };
    case "auto-fix-off":
      return { ...target, autoFix: false };
    case "stop":
      return { ...target, news: false, autoFix: false };
  }
}

/** The part of an environment's RPC client a watch control calls (an RPC client's `sourceControl`). */
export interface PullRequestWatchApi {
  readonly sourceControl: {
    readonly setPullRequestWatch: (
      input: SourceControlSetPullRequestWatchInput,
    ) => Promise<SourceControlSetPullRequestWatchResult>;
  };
}

export function setPullRequestWatch(
  api: PullRequestWatchApi,
  input: PullRequestWatchTarget & { readonly threadId: ThreadId },
  action: PullRequestWatchAction,
): Promise<SourceControlSetPullRequestWatchResult> {
  return api.sourceControl.setPullRequestWatch(pullRequestWatchInput(input, action));
}

/** The title of the notice a refused or failed change shows. */
export function pullRequestWatchFailureTitle(
  action: PullRequestWatchAction,
  number: number,
): string {
  return action === "stop"
    ? `Couldn't stop watching #${number}`
    : `Couldn't change Auto-fix CI for #${number}`;
}

/**
 * An Auto-fix CI switch change in flight. The switch shows it at once, and the
 * server's answer arrives later in the thread's shell.
 */
export interface PullRequestWatchSwitchRequest {
  /** The control that sent it (`pullRequestWatchControlKey`); another one ignores it. */
  readonly key: string;
  readonly autoFix: boolean;
  /** The watches the change saw: once the request went through, a newer shell is the answer. */
  readonly watches: ThreadPullRequestWatchShell | null | undefined;
  /** The server took the request. */
  readonly settled: boolean;
}

/** One control of one thread's watch of one pull request, on one environment. */
export function pullRequestWatchControlKey(input: {
  readonly environmentId: string | null;
  readonly threadId: string | null;
  readonly number: number | null;
}): string {
  return `${input.environmentId ?? ""}|${input.threadId ?? ""}|${input.number ?? ""}`;
}

/** The switch request an action makes; Stop moves no switch. */
export function pullRequestWatchSwitchRequest(
  action: PullRequestWatchAction,
  key: string,
  watches: ThreadPullRequestWatchShell | null | undefined,
): PullRequestWatchSwitchRequest | null {
  return action === "stop"
    ? null
    : { key, autoFix: action !== "auto-fix-off", watches, settled: false };
}

/** What a watch control shows: the same rules on every client. */
export interface PullRequestWatchControlState {
  /** The pull request's active watch on the thread, null when there is none. */
  readonly view: PullRequestWatchView | null;
  /** Why its latest watch ended (shells keep that for a day), when none is active. */
  readonly endedLabel: string | null;
  /** The Auto-fix CI switch is shown: a watch is on, or one may start. */
  readonly switchOffered: boolean;
  /** The Auto-fix CI switch: the request in flight, else the watch's own state. */
  readonly autoFixChecked: boolean;
  /**
   * The request no longer decides the switch, so the control drops it: the shell
   * agrees, it belongs to another control, or it went through and the shell moved
   * since (say the watch ended meanwhile). A failed request is dropped by its caller.
   */
  readonly requestDone: boolean;
}

export function pullRequestWatchControlState(input: {
  readonly watches: ThreadPullRequestWatchShell | null | undefined;
  readonly target: PullRequestWatchTarget | null;
  /** A watch may start: the pull request is open, and the thread takes one. */
  readonly startable: boolean;
  /**
   * Auto-fix CI can run for this thread: the pull request is its own workspace's (a fix turn
   * edits the chat's own checkout, so the server refuses one on a pull request another
   * workspace checks out). Unknown counts as yes; the server has the last word.
   */
  readonly autoFixHere?: boolean;
  readonly key: string;
  readonly request: PullRequestWatchSwitchRequest | null;
}): PullRequestWatchControlState {
  const found = input.target ? findPullRequestWatch(input.watches, input.target) : null;
  const view = found?.kind === "active" ? pullRequestWatchView(found.watch) : null;
  const autoFixOn = view?.autoFixOn ?? false;
  const { request } = input;
  const requestDone =
    request !== null &&
    (request.key !== input.key ||
      request.autoFix === autoFixOn ||
      (request.settled && request.watches !== input.watches));
  return {
    view,
    endedLabel: found?.kind === "ended" ? pullRequestWatchEndedLabel(found.ended.reason) : null,
    // A switch that is on always shows, so it can be turned off.
    switchOffered: (view !== null || input.startable) && (input.autoFixHere !== false || autoFixOn),
    autoFixChecked: request === null || requestDone ? autoFixOn : request.autoFix,
    requestDone,
  };
}

/** The server's reason for refusing a watch change, else the error's own message. */
export function pullRequestWatchErrorMessage(error: unknown): string | null {
  if (typeof error === "object" && error !== null) {
    const detail = (error as { readonly detail?: unknown }).detail;
    if (typeof detail === "string" && detail.trim().length > 0) return detail;
    const message = (error as { readonly message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) return message;
  }
  return null;
}
