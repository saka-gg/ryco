import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import {
  pullRequestWatchControlKey,
  pullRequestWatchControlState,
  pullRequestWatchErrorMessage,
  pullRequestWatchFailureTitle,
  pullRequestWatchInput,
  pullRequestWatchSwitchRequest,
  type PullRequestWatchAction,
  type PullRequestWatchControlState,
  type PullRequestWatchSwitchRequest,
} from "@ryco/client-runtime/state/threads";
import { useState } from "react";

import { readEnvironmentApi } from "../../connection/environmentApi";
import type { ThreadHeaderPullRequestWatch } from "./threadHeaderModel";

/** The task sheet's pull request watch controls: what they show, and the one action they send. */
export interface PullRequestWatchControl extends PullRequestWatchControlState {
  /** The pull request the controls act on. */
  readonly number: number;
  /** A change goes through right now. */
  readonly ready: boolean;
  readonly pending: boolean;
  /** Why the last change of this pull request's controls failed, until the next one. */
  readonly error: string | null;
  /** The watched pull request is another workspace's, so Auto-fix CI is not offered here. */
  readonly autoFixElsewhere: boolean;
  readonly run: (action: PullRequestWatchAction) => void;
}

/** A failed change, kept for the control that sent it (`pullRequestWatchControlKey`). */
interface PullRequestWatchFailure {
  readonly key: string;
  readonly message: string;
}

/**
 * One thread's server-side watch of its pull request, for the task sheet: the
 * Auto-fix CI switch, Resume and Stop watching. The same rules as the web's
 * pull request page and Crown (`pullRequestWatchControlState`); the switch
 * follows a change at once and the thread's shell answers it. Null when the
 * header has no pull request watch to offer.
 */
export function usePullRequestWatchControl(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly watch: ThreadHeaderPullRequestWatch | null;
  /** The node takes changes now (connected, not read-only, not a cached view). */
  readonly ready: boolean;
}): PullRequestWatchControl | null {
  const { environmentId, threadId, watch, ready } = input;
  const [requested, setRequested] = useState<PullRequestWatchSwitchRequest | null>(null);
  // The control whose change is in flight, and the last failure: both belong to one
  // pull request, so another one the header moves to neither waits for nor shows them.
  const [sending, setSending] = useState<string | null>(null);
  const [failure, setFailure] = useState<PullRequestWatchFailure | null>(null);

  const key = pullRequestWatchControlKey({
    environmentId,
    threadId,
    number: watch?.target.number ?? null,
  });
  const state = pullRequestWatchControlState({
    watches: watch?.watches,
    target: watch?.target ?? null,
    startable: watch?.startable ?? false,
    autoFixHere: !(watch?.otherWorkspace ?? false),
    key,
    request: requested,
  });
  if (state.requestDone) setRequested(null);
  if (watch === null) return null;
  const pending = sending === key;

  const run = (action: PullRequestWatchAction) => {
    if (!ready || pending) return;
    const title = pullRequestWatchFailureTitle(action, watch.target.number);
    // Read on press, never in render: the compiler would keep a render-time read. The
    // facade's method is optional (hand-built test doubles leave it out): absence is offline.
    const send = readEnvironmentApi(environmentId)?.sourceControl.setPullRequestWatch;
    if (send === undefined) {
      setFailure({ key, message: `${title}. Reconnect to this machine and try again.` });
      return;
    }
    const request = pullRequestWatchSwitchRequest(action, key, watch.watches);
    if (request !== null) setRequested(request);
    setFailure(null);
    setSending(key);
    const done = () => setSending((current) => (current === key ? null : current));
    send(pullRequestWatchInput({ threadId, ...watch.target }, action)).then(
      () => {
        done();
        setRequested((current) =>
          current === null || current.key !== key ? current : { ...current, settled: true },
        );
      },
      (error: unknown) => {
        done();
        setRequested((current) => (current?.key === key ? null : current));
        const reason = pullRequestWatchErrorMessage(error);
        setFailure({ key, message: reason === null ? `${title}.` : `${title}: ${reason}` });
      },
    );
  };

  return {
    ...state,
    number: watch.target.number,
    ready,
    pending,
    error: failure?.key === key ? failure.message : null,
    autoFixElsewhere: watch.otherWorkspace && !state.switchOffered,
    run,
  };
}
