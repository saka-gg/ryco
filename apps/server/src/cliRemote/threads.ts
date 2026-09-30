/**
 * What `ryco remote threads` and `ryco remote send` do with a connected remote:
 * list its threads from one shell snapshot, and start a turn on a thread,
 * optionally printing the assistant's reply as it streams.
 */
import {
  CommandId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationEvent,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
  ThreadId,
} from "@ryco/contracts";
import { Deferred, Effect, Fiber, Option, Stream } from "effect";

import { CliRemoteError, type CliRemoteRpcClient as RemoteRpcClient } from "./remotes.ts";

export const loadRemoteShell = (client: RemoteRpcClient) =>
  client[ORCHESTRATION_WS_METHODS.subscribeShell]({}).pipe(
    Stream.filter((item) => item.kind === "snapshot"),
    Stream.take(1),
    Stream.runHead,
    Effect.flatMap((item) =>
      Option.isSome(item) && item.value.kind === "snapshot"
        ? Effect.succeed(item.value.snapshot)
        : Effect.fail(
            new CliRemoteError({
              message: "The remote closed the connection before sending its threads.",
            }),
          ),
    ),
  );

const threadState = (thread: OrchestrationThreadShell): string => {
  if (thread.hasPendingApprovals) return "needs approval";
  if (thread.hasPendingUserInput) return "needs input";
  const status = thread.session?.status;
  if (status === "running" || status === "starting") return "running";
  if (status === "error") return "error";
  return "idle";
};

/** One line per open thread, most recently updated first. */
export function formatRemoteThreads(
  snapshot: OrchestrationShellSnapshot,
  options: { readonly includeArchived?: boolean; readonly limit?: number } = {},
): string {
  const projects = new Map(snapshot.projects.map((project) => [project.id, project.title]));
  const threads = snapshot.threads
    .filter((thread) => options.includeArchived || thread.archivedAt === null)
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, options.limit ?? 50);
  if (threads.length === 0) return "No threads.";
  const stateWidth = Math.max(...threads.map((thread) => threadState(thread).length));
  return threads
    .map(
      (thread) =>
        `${thread.id}  ${threadState(thread).padEnd(stateWidth)}  ${projects.get(thread.projectId) ?? "?"} / ${thread.title}`,
    )
    .join("\n");
}

const TERMINAL_SESSION_STATUSES = new Set(["ready", "idle", "interrupted", "stopped", "error"]);

/**
 * Start a turn on an existing thread with the thread's own model and modes. With
 * `onAssistantText`, keep following the thread and hand over assistant text as
 * it streams until the turn ends; resolves to the session's final error, if any.
 */
export const sendToRemoteThread = (
  client: RemoteRpcClient,
  input: {
    readonly threadId: string;
    readonly text: string;
    readonly onAssistantText?: (text: string) => void;
  },
) =>
  Effect.gen(function* () {
    const snapshot = yield* loadRemoteShell(client);
    const thread = snapshot.threads.find((entry) => entry.id === input.threadId);
    if (!thread) {
      return yield* Effect.fail(
        new CliRemoteError({
          message: `No thread ${input.threadId} on this remote. List them with \`ryco remote threads\`.`,
        }),
      );
    }
    const threadId = ThreadId.make(thread.id);
    const follow = input.onAssistantText;
    const subscribed = yield* Deferred.make<void>();
    const reply =
      follow === undefined
        ? undefined
        : yield* Effect.forkScoped(
            followTurn(client, threadId, snapshot.snapshotSequence, follow, subscribed),
          );
    // Start the turn only once the thread subscription is live, so its first
    // `running` transition cannot slip past before anyone is listening.
    if (reply !== undefined) {
      yield* Deferred.await(subscribed).pipe(Effect.timeoutOption(10_000));
    }
    yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
      type: "thread.turn.start",
      commandId: CommandId.make(`cli:${crypto.randomUUID()}`),
      threadId,
      message: {
        messageId: MessageId.make(crypto.randomUUID()),
        role: "user",
        text: input.text,
        attachments: [],
      },
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      createdAt: new Date().toISOString(),
    });
    if (reply === undefined) return null;
    return yield* Fiber.join(reply);
  });

const followTurn = (
  client: RemoteRpcClient,
  threadId: ThreadId,
  afterSequence: number,
  onAssistantText: (text: string) => void,
  subscribed: Deferred.Deferred<void>,
) =>
  Effect.gen(function* () {
    let turnStarted = false;
    let finalError: string | null = null;
    const printed = new Set<string>();
    yield* client[ORCHESTRATION_WS_METHODS.subscribeThread]({ threadId }).pipe(
      Stream.tap(() => Deferred.succeed(subscribed, undefined)),
      Stream.filter((item) => item.kind === "event" && item.event.sequence > afterSequence),
      Stream.map((item) => (item as { readonly event: OrchestrationEvent }).event),
      Stream.takeUntil((event) => {
        if (event.type === "thread.message-sent" && event.payload.role === "assistant") {
          const { messageId, text, streaming } = event.payload;
          if (streaming) {
            printed.add(messageId);
            onAssistantText(text);
          } else if (!printed.has(messageId) && text.length > 0) {
            onAssistantText(text);
          }
          return false;
        }
        if (event.type !== "thread.session-set") return false;
        const status = event.payload.session.status;
        if (status === "running" || status === "starting") {
          turnStarted = true;
          return false;
        }
        if (turnStarted && TERMINAL_SESSION_STATUSES.has(status)) {
          finalError = status === "error" ? event.payload.session.lastError : null;
          return true;
        }
        return false;
      }),
      Stream.runDrain,
    );
    return finalError;
  });
