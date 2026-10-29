import type {
  EnvironmentId,
  ProviderInstanceId,
  ProviderSignInState,
  ProviderSignInWireEvent,
} from "@ryco/contracts";
import { isUnknownUnionMember } from "@ryco/contracts/base-schemas";

import type { WsRpcClient } from "../../rpc/wsRpcClient.ts";
import { isAuthRpcError, isUnsupportedRpcError } from "../../rpc/wsTransport.ts";

/** The sign-in methods of one connection: `readEnvironmentConnection(id)?.client.providerSignIn`. */
export type ProviderSignInApi = WsRpcClient["providerSignIn"];

/** Largest `input` a node takes in one `provider.signIn.respond`. */
export const PROVIDER_SIGN_IN_INPUT_CHUNK = 4_096;
/** A terminal resize goes out once the size stops changing for this long. */
export const PROVIDER_SIGN_IN_RESIZE_DEBOUNCE_MS = 100;
/** Raw terminal output kept for a terminal that mounts late; the node keeps as much. */
const OUTPUT_TAIL = 32 * 1024;
/** Readable transcript `transcriptText` answers with. */
const TRANSCRIPT_TAIL = 16 * 1024;

export const PROVIDER_SIGN_IN_FORBIDDEN = "Only an owner of this node can sign its providers in.";
const FOLLOW_FAILED = "Could not follow the sign-in on this node. Try again.";
const START_FAILED = "Could not start the sign-in. Check the connection and try again.";
const CANCEL_FAILED = "Could not cancel the sign-in. Check the connection and try again.";
const INPUT_FAILED = "Could not send input to the sign-in. Try again.";

export interface ProviderSignInSnapshot {
  /** What the node last reported; `null` until it reports, and while nothing follows it. */
  readonly state: ProviderSignInState | null;
  /** The node has no sign-in methods (an older Ryco). */
  readonly unsupported: boolean;
  /** The node refused this session: sign-in is for owners. */
  readonly forbidden: boolean;
  /** A start or cancel this client sent that the node has not answered yet. */
  readonly pending: "start" | "cancel" | null;
  /** Why the last thing this client did failed; the next action clears it. */
  readonly error: string | null;
  /**
   * A flow this followed went idle without ending: the node restarted, which ends every flow
   * without a word. Seen across a pause in following too (a dropped connection, a closed
   * surface). Cleared by the next flow.
   */
  readonly interrupted: boolean;
}

/** Terminal output as it arrives: `reset` replaces everything shown before, otherwise it appends. */
export interface ProviderSignInOutput {
  readonly reset: boolean;
  /**
   * Output that was live before: the tail a node resends to a new subscription. Queries in it were
   * answered (or timed out) back then, so a terminal must not answer them again.
   */
  readonly replay: boolean;
  readonly data: string;
}

const EMPTY: ProviderSignInSnapshot = {
  state: null,
  unsupported: false,
  forbidden: false,
  pending: null,
  error: null,
  interrupted: false,
};

const RUNNING: ReadonlySet<ProviderSignInState["phase"]> = new Set([
  "starting",
  "waiting",
  "verifying",
]);

/** Whether the state is a flow that has not ended. */
export function isProviderSignInRunning(state: ProviderSignInState | null): boolean {
  return state !== null && state.flowId !== null && RUNNING.has(state.phase);
}

/** Whether the state is a terminal flow waiting for the user, so input and size apply. */
export function isProviderSignInTerminalWaiting(state: ProviderSignInState | null): boolean {
  const interaction = state?.interaction;
  return (
    state?.phase === "waiting" &&
    state.flowId !== null &&
    interaction != null &&
    !isUnknownUnionMember(interaction) &&
    interaction.type === "terminal"
  );
}

/** A node's own refusal (`ProviderSignInError`) is written for people; anything else is not. */
function signInErrorMessage(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const { _tag, message } = error as { readonly _tag?: unknown; readonly message?: unknown };
  return _tag === "ProviderSignInError" && typeof message === "string" && message.trim()
    ? message
    : null;
}

/** Splits input into chunks a node takes, never between the halves of a surrogate pair. */
function chunkInput(data: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < data.length) {
    let end = Math.min(start + PROVIDER_SIGN_IN_INPUT_CHUNK, data.length);
    const last = data.charCodeAt(end - 1);
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    chunks.push(data.slice(start, end));
    start = end;
  }
  return chunks;
}

// CSI, OSC (ended by BEL or ST) and the remaining two-byte escapes.
const TERMINAL_ESCAPE =
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/gu;
// Everything below space except tab and newline; carriage returns are read first.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f]/gu;

/** Terminal output as plain lines: escapes gone, a carriage return rewriting its line. */
function readableTranscript(output: string): string {
  return output
    .replace(TERMINAL_ESCAPE, "")
    .split(/\r?\n/u)
    .map((line) => line.slice(line.lastIndexOf("\r") + 1).replace(CONTROL_CHARACTERS, ""))
    .join("\n");
}

interface Transcript {
  readonly flowId: string | null;
  /** The retained tail of the flow's output. */
  readonly text: string;
  /** Flow offset just past `text`. */
  readonly end: number;
}

const NO_TRANSCRIPT: Transcript = { flowId: null, text: "", end: 0 };

interface Following {
  /** The stream ended for good, or was stopped. */
  stopped: boolean;
  stop: () => void;
}

/**
 * Follows one instance's sign-in on one node and drives it. The node owns the flow, which
 * outlives this client; this keeps what the node last reported, a terminal flow's output, and
 * the input still to go out.
 *
 * Following is ref-counted: `attach` subscribes on its connection's api and the last detach stops
 * (deferred, so a re-running effect hands the stream over) and forgets the state, keeping only
 * whether a flow was under way. It never reconnects: the connection layer owns that, and its
 * transport re-subscribes by itself. Every subscription starts with the node's current state and,
 * for a running terminal flow, the retained output (`reset`), which replaces what this kept;
 * output the old subscription left is dropped until then.
 *
 * Input goes out in order, one call at a time in chunks the node takes; what is left is dropped
 * when the flow changes or a send fails. A resize goes out once the size settles, the last one
 * winning. Messages never carry what the user typed or the node printed.
 */
export function createProviderSignInController(instanceId: ProviderInstanceId) {
  let snapshot: ProviderSignInSnapshot = EMPTY;
  const listeners = new Set<() => void>();
  const outputListeners = new Set<(output: ProviderSignInOutput) => void>();

  let api: ProviderSignInApi | null = null;
  let attachments = 0;
  let teardownScheduled = false;
  let following: Following | null = null;
  /** Bumped by every streamed state, so an RPC answer can tell whether the stream spoke since. */
  let streamRevision = 0;
  /**
   * Following stopped (a dropped connection, a closed surface) while a flow ran or after one was
   * interrupted. The next follow's first state settles it: an idle one means the node dropped the
   * flow meanwhile, which is the only way a restart shows.
   */
  let stoppedDuringFlow = false;

  let transcript = NO_TRANSCRIPT;
  /** The flow whose output a re-subscription's `reset` will resend. */
  let awaitingResetFor: string | null = null;

  const inputQueue: { readonly flowId: string; readonly data: string }[] = [];
  let sendingInput = false;
  let pendingSize: { readonly cols: number; readonly rows: number } | null = null;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  let sentSize: { readonly flowId: string; readonly cols: number; readonly rows: number } | null =
    null;

  const notify = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // One failing listener must not stop the others or the stream.
      }
    }
  };

  const publish = (patch: Partial<ProviderSignInSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    notify();
  };

  const emitOutput = (output: ProviderSignInOutput) => {
    for (const listener of outputListeners) {
      try {
        listener(output);
      } catch {
        // A terminal that failed to write must not stop the stream.
      }
    }
  };

  const clearTranscript = () => {
    awaitingResetFor = null;
    if (transcript.flowId === null && transcript.text === "") return;
    transcript = NO_TRANSCRIPT;
    emitOutput({ reset: true, replay: false, data: "" });
  };

  const applyState = (state: ProviderSignInState) => {
    const previous = snapshot.state;
    if (previous !== null && JSON.stringify(previous) === JSON.stringify(state)) return;
    if (state.flowId !== transcript.flowId && transcript.flowId !== null) clearTranscript();
    if (!isProviderSignInTerminalWaiting(state)) inputQueue.length = 0;
    if (state.flowId !== previous?.flowId) sentSize = null;
    const carried = previous === null && stoppedDuringFlow;
    stoppedDuringFlow = false;
    publish({
      state,
      unsupported: false,
      forbidden: false,
      interrupted:
        state.phase === "idle" &&
        (snapshot.interrupted || carried || isProviderSignInRunning(previous)),
      // A new flow, or one that ended, makes an earlier failure moot.
      ...(state.flowId !== previous?.flowId || state.phase !== previous?.phase
        ? { error: null }
        : {}),
    });
  };

  const applyOutput = (event: Extract<ProviderSignInWireEvent, { type: "output" }>) => {
    if (event.reset === true) {
      awaitingResetFor = null;
      transcript = {
        flowId: event.flowId,
        text: event.data.slice(-OUTPUT_TAIL),
        end: event.offset + event.data.length,
      };
      emitOutput({ reset: true, replay: true, data: event.data });
      return;
    }
    if (event.flowId === awaitingResetFor) return;
    const newFlow = event.flowId !== transcript.flowId;
    const start = newFlow ? 0 : transcript.end;
    const eventEnd = event.offset + event.data.length;
    if (!newFlow && eventEnd <= start) return;
    // Output the stream already delivered is skipped; a gap is shown as it is.
    const data = newFlow ? event.data : event.data.slice(Math.max(0, start - event.offset));
    transcript = {
      flowId: event.flowId,
      text: ((newFlow ? "" : transcript.text) + data).slice(-OUTPUT_TAIL),
      end: eventEnd,
    };
    emitOutput({ reset: newFlow, replay: false, data });
  };

  const follow = (current: ProviderSignInApi): Following => {
    const entry: Following = { stopped: false, stop: () => undefined };
    let failure: "unsupported" | "forbidden" | string = FOLLOW_FAILED;
    const unsubscribe = current.subscribe(
      { instanceId },
      (event) => {
        if (entry.stopped || isUnknownUnionMember(event)) return;
        if (event.type === "state") {
          streamRevision += 1;
          applyState(event.state);
        } else {
          applyOutput(event);
        }
      },
      {
        onResubscribe: () => {
          if (!entry.stopped) awaitingResetFor = transcript.flowId;
        },
        classifyFailure: (error) => {
          failure = isUnsupportedRpcError(error)
            ? "unsupported"
            : isAuthRpcError(error)
              ? "forbidden"
              : (signInErrorMessage(error) ?? FOLLOW_FAILED);
          return failure === "unsupported" ? "unsupported" : "failed";
        },
        onError: () => {
          if (entry.stopped) return;
          entry.stopped = true;
          clearTranscript();
          publish(
            failure === "unsupported"
              ? { state: null, unsupported: true }
              : failure === "forbidden"
                ? { state: null, forbidden: true }
                : { error: failure },
          );
        },
      },
    );
    entry.stop = () => {
      entry.stopped = true;
      unsubscribe();
    };
    return entry;
  };

  const stopFollowing = () => {
    following?.stop();
    following = null;
  };

  /** Follows the attached api, again too once its stream ended for good. */
  const ensureFollowing = () => {
    if (api !== null && attachments > 0 && (following === null || following.stopped)) {
      following = follow(api);
    }
  };

  /** Answers an RPC answer only when no streamed state arrived while it was out. */
  const applyAnswer = (state: ProviderSignInState, revision: number) => {
    if (revision === streamRevision) applyState(state);
  };

  const fail = (error: unknown, fallback: string) => {
    if (isUnsupportedRpcError(error)) publish({ unsupported: true, error: null });
    else if (isAuthRpcError(error)) publish({ forbidden: true, error: null });
    else publish({ error: signInErrorMessage(error) ?? fallback });
  };

  const pumpInput = async () => {
    if (sendingInput) return;
    sendingInput = true;
    try {
      for (;;) {
        const item = inputQueue.shift();
        const current = api;
        if (item === undefined || current === null) return;
        if (
          item.flowId !== snapshot.state?.flowId ||
          !isProviderSignInTerminalWaiting(snapshot.state)
        ) {
          inputQueue.length = 0;
          return;
        }
        try {
          await current.respond({
            instanceId,
            flowId: item.flowId,
            action: { type: "input", data: item.data },
          });
        } catch (error) {
          inputQueue.length = 0;
          fail(error, INPUT_FAILED);
          return;
        }
      }
    } finally {
      sendingInput = false;
    }
  };

  const flushResize = () => {
    resizeTimer = null;
    const size = pendingSize;
    const state = snapshot.state;
    const current = api;
    pendingSize = null;
    if (size === null || current === null || !isProviderSignInTerminalWaiting(state)) return;
    const flowId = state!.flowId!;
    if (sentSize?.flowId === flowId && sentSize.cols === size.cols && sentSize.rows === size.rows) {
      return;
    }
    sentSize = { flowId, ...size };
    current.respond({ instanceId, flowId, action: { type: "resize", ...size } }).catch(() => {
      // The next resize sends again; a flow that ended has no size to keep.
      if (sentSize?.flowId === flowId) sentSize = null;
    });
  };

  return {
    instanceId,
    getSnapshot: (): ProviderSignInSnapshot => snapshot,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Raw output deltas of a terminal flow. */
    onOutput(listener: (output: ProviderSignInOutput) => void): () => void {
      outputListeners.add(listener);
      return () => {
        outputListeners.delete(listener);
      };
    },
    /**
     * The retained raw output of the current flow, for a terminal that mounts late. It was live
     * before that terminal existed, so the terminal takes it as a replay.
     */
    output: (): string => transcript.text,
    /** The current flow's output as plain text, its last 16 KiB. */
    transcriptText: (): string => readableTranscript(transcript.text).slice(-TRANSCRIPT_TAIL),
    /**
     * Follows the instance on `next`'s connection until the returned detach runs. Another api
     * than the one followed (a new connection) takes over; the last state stays until it reports.
     */
    attach(next: ProviderSignInApi): () => void {
      attachments += 1;
      if (api !== next) {
        stopFollowing();
        api = next;
        streamRevision += 1;
        // The new subscription resends a running terminal flow's output.
        awaitingResetFor = transcript.flowId;
      }
      ensureFollowing();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        attachments -= 1;
        if (attachments > 0 || teardownScheduled) return;
        teardownScheduled = true;
        void Promise.resolve().then(() => {
          teardownScheduled = false;
          if (attachments > 0) return;
          stopFollowing();
          api = null;
          // An answer still out belongs to the stream that stopped.
          streamRevision += 1;
          inputQueue.length = 0;
          pendingSize = null;
          if (resizeTimer !== null) clearTimeout(resizeTimer);
          resizeTimer = null;
          sentSize = null;
          transcript = NO_TRANSCRIPT;
          awaitingResetFor = null;
          // The state goes (a stale code must not show), but not that a flow was under way.
          stoppedDuringFlow ||= snapshot.interrupted || isProviderSignInRunning(snapshot.state);
          snapshot = EMPTY;
          notify();
        });
      };
    },
    /** Whether the registry may drop this controller: nothing follows or waits on it. */
    canDispose: (): boolean =>
      attachments === 0 && !teardownScheduled && listeners.size === 0 && snapshot.pending === null,
    /**
     * Follows again after the stream ended for good, clearing why it ended. For a stream that
     * failed before the node reported anything, so there is no state to start from.
     */
    retryFollowing(): void {
      if (api === null || attachments === 0) return;
      if (snapshot.error !== null) publish({ error: null });
      ensureFollowing();
    },
    /** Starts a sign-in, or joins the one running: the node answers its state either way. */
    async start(): Promise<void> {
      const current = api;
      if (current === null || snapshot.pending !== null) return;
      ensureFollowing();
      const revision = streamRevision;
      stoppedDuringFlow = false;
      publish({ pending: "start", error: null, interrupted: false });
      try {
        applyAnswer(await current.start({ instanceId }), revision);
      } catch (error) {
        fail(error, START_FAILED);
      } finally {
        publish({ pending: null });
      }
    },
    /** Cancels the running flow; the node reports `cancelled` once its process is gone. */
    async cancel(): Promise<void> {
      const current = api;
      const flowId = snapshot.state?.flowId ?? null;
      if (current === null || flowId === null || snapshot.pending !== null) return;
      if (!isProviderSignInRunning(snapshot.state)) return;
      publish({ pending: "cancel", error: null });
      try {
        await current.respond({ instanceId, flowId, action: { type: "cancel" } });
      } catch (error) {
        fail(error, CANCEL_FAILED);
      } finally {
        publish({ pending: null });
      }
    },
    /** Types into a terminal flow: queued, in order, in chunks the node takes. */
    sendInput(data: string): void {
      const state = snapshot.state;
      if (data.length === 0 || !isProviderSignInTerminalWaiting(state)) return;
      const flowId = state!.flowId!;
      for (const chunk of chunkInput(data)) inputQueue.push({ flowId, data: chunk });
      void pumpInput();
    },
    /** Sizes a terminal flow once the size settles; the last size wins. */
    resize(cols: number, rows: number): void {
      if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
      pendingSize = {
        cols: Math.min(500, Math.max(1, Math.round(cols))),
        rows: Math.min(200, Math.max(1, Math.round(rows))),
      };
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(flushResize, PROVIDER_SIGN_IN_RESIZE_DEBOUNCE_MS);
    },
  };
}

export type ProviderSignInController = ReturnType<typeof createProviderSignInController>;

const MAX_CONTROLLERS = 64;
const controllers = new Map<string, ProviderSignInController>();

/**
 * The one controller of an instance on a node, shared by every surface that shows it, so a
 * remount keeps its queued input and two surfaces follow one stream.
 */
export function getProviderSignInController(
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
): ProviderSignInController {
  const key = JSON.stringify([environmentId, instanceId]);
  let controller = controllers.get(key);
  if (controller) return controller;
  if (controllers.size >= MAX_CONTROLLERS) {
    for (const [entry, candidate] of controllers) {
      if (candidate.canDispose()) controllers.delete(entry);
      if (controllers.size < MAX_CONTROLLERS) break;
    }
  }
  controller = createProviderSignInController(instanceId);
  controllers.set(key, controller);
  return controller;
}
