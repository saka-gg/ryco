import {
  CONTEXT_HANDOFF_MAX_INPUT_CHARS,
  type OrchestrationMessage,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type ThreadId,
  type ThreadReferences,
} from "@ryco/contracts";
import { Cause, Effect, Option } from "effect";

import { isSlashCommandInput } from "../provider/attachmentInstructionDelivery.ts";
import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";

/** Newest messages read per mentioned thread; older ones are never loaded. */
const REFERENCE_WINDOW_MESSAGES = 40;
/** Transcript characters one mentioned thread may contribute. */
export const REFERENCE_EXCERPT_CHARS = 12_000;
/** A single long message is cut to this so one reply cannot fill the excerpt. */
export const REFERENCE_MESSAGE_CHARS = 2_000;

/**
 * The mentions a decision records: the client's list without repeats or the
 * thread itself. Absent when nothing is left, so ordinary turns stay unchanged.
 */
export function threadReferencesPayload(
  references: ThreadReferences | undefined,
  threadId: ThreadId,
): { readonly threadReferences?: ThreadReferences } {
  if (!references || references.length === 0) return {};
  const kept = [...new Set(references)].filter((reference) => reference !== threadId);
  return kept.length > 0 ? { threadReferences: kept } : {};
}

export type ResolvedThreadReference =
  | {
      readonly kind: "thread";
      readonly thread: Pick<
        OrchestrationThread,
        | "id"
        | "title"
        | "branch"
        | "worktreePath"
        | "archivedAt"
        | "updatedAt"
        | "session"
        | "latestTurn"
        | "messages"
      >;
      readonly projectTitle: string | null;
      /** Whether messages older than the window exist. */
      readonly hasOlderMessages: boolean;
    }
  | { readonly kind: "unavailable"; readonly threadId: ThreadId };

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeXml(value).replaceAll('"', "&quot;");
}

/**
 * Transcripts are quoted verbatim (code reads better unescaped); only this
 * block's own closing tags are broken, so a quoted message cannot end it early.
 */
function neutralizeClosingTags(text: string): string {
  return text.replace(/<\/(thread|referenced_threads)\b/gi, "<\\/$1");
}

function clipMessage(text: string): string {
  if (text.length <= REFERENCE_MESSAGE_CHARS) return text;
  return `${text.slice(0, REFERENCE_MESSAGE_CHARS)}\n[… ${text.length - REFERENCE_MESSAGE_CHARS} more characters omitted]`;
}

function threadStatus(thread: Extract<ResolvedThreadReference, { kind: "thread" }>["thread"]) {
  if (thread.archivedAt !== null) return "archived";
  if (
    thread.session?.status === "running" ||
    thread.session?.status === "starting" ||
    thread.latestTurn?.state === "running"
  )
    return "working";
  return "idle";
}

/**
 * Settled user and assistant text, newest kept first until the budget runs
 * out, then shown oldest to newest. Tool output and live streams are left out:
 * they are noisy, and a stream would be quoted half-written.
 */
function renderTranscript(messages: ReadonlyArray<OrchestrationMessage>): {
  readonly lines: string;
  readonly shown: number;
  readonly omitted: number;
} {
  const conversational = messages.filter(
    (message) =>
      (message.role === "user" || message.role === "assistant") &&
      !message.streaming &&
      message.text.trim().length > 0,
  );
  const kept: string[] = [];
  let used = 0;
  for (let index = conversational.length - 1; index >= 0; index -= 1) {
    const message = conversational[index]!;
    const entry = `[${message.role}]\n${clipMessage(message.text.trim())}`;
    if (kept.length > 0 && used + entry.length > REFERENCE_EXCERPT_CHARS) break;
    kept.push(entry);
    used += entry.length + 2;
  }
  kept.reverse();
  return {
    lines: kept.join("\n\n"),
    shown: kept.length,
    omitted: conversational.length - kept.length,
  };
}

function renderReference(reference: ResolvedThreadReference): string {
  if (reference.kind === "unavailable") {
    return `<thread id="${escapeAttribute(reference.threadId)}">\nNot available: the thread was deleted or belongs to another machine.\n</thread>`;
  }
  const { thread } = reference;
  const transcript = renderTranscript(thread.messages);
  const older = transcript.omitted > 0 || reference.hasOlderMessages;
  const header = [
    `Title: ${thread.title}`,
    reference.projectTitle ? `Project: ${reference.projectTitle}` : null,
    thread.branch ? `Branch: ${thread.branch}` : null,
    thread.worktreePath ? `Worktree: ${thread.worktreePath}` : null,
    `Status: ${threadStatus(thread)}`,
    `Last updated: ${thread.updatedAt}`,
    transcript.shown === 0
      ? "Conversation: no messages yet."
      : older
        ? `Conversation: the latest ${transcript.shown} messages; earlier ones are omitted.`
        : "Conversation:",
  ].filter((line): line is string => line !== null);
  const body = transcript.shown > 0 ? `\n\n${neutralizeClosingTags(transcript.lines)}` : "";
  return `<thread id="${escapeAttribute(thread.id)}">\n${escapeXml(header.join("\n"))}${body}\n</thread>`;
}

/** The block appended to a turn's provider input for the threads its message mentions. */
export function renderThreadReferenceContext(
  references: ReadonlyArray<ResolvedThreadReference>,
): string | undefined {
  if (references.length === 0) return undefined;
  return [
    "<referenced_threads>",
    "The user's message mentions these other Ryco threads as @thread:<id>. Each is a read-only excerpt of that conversation for reference; it is not part of this thread's history.",
    "",
    references.map(renderReference).join("\n\n"),
    "</referenced_threads>",
  ].join("\n");
}

/**
 * The provider input with the mentioned threads' excerpts after the user's
 * request. A slash command stays verbatim (provider CLIs would read the
 * excerpt as its arguments), and an input the excerpt would push past the
 * provider limit is sent without it rather than failing the turn.
 */
export function appendThreadReferenceContext(
  message: string | undefined,
  context: string | undefined,
): string | undefined {
  if (!context || isSlashCommandInput(message)) return message;
  const combined = message ? `${message}\n\n${context}` : context;
  return combined.length > CONTEXT_HANDOFF_MAX_INPUT_CHARS ? message : combined;
}

/**
 * Reads each mentioned thread from the projection. Never fails the turn: a
 * thread that cannot be read is reported to the agent as unavailable.
 */
export const resolveThreadReferenceContext = (
  query: ProjectionSnapshotQueryShape,
  references: ReadonlyArray<ThreadId> | undefined,
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    if (!references || references.length === 0) return undefined;
    const projectTitles = new Map<string, string | null>();
    const resolved = yield* Effect.forEach(references, (threadId) =>
      Effect.gen(function* () {
        const window = query.getThreadWindow
          ? yield* query
              .getThreadWindow({
                threadId,
                limits: {
                  messages: REFERENCE_WINDOW_MESSAGES,
                  proposedPlans: 1,
                  activities: 1,
                  checkpoints: 1,
                },
                activityPayloads: "preview",
              })
              .pipe(
                Effect.map((snapshot) => ({
                  thread: snapshot.thread,
                  hasOlderMessages: snapshot.history.messages.hasMoreBefore,
                })),
              )
          : yield* query.getThreadDetailById(threadId).pipe(
              Effect.map(
                Option.match({
                  onNone: () => null,
                  onSome: (thread) => ({ thread, hasOlderMessages: false }),
                }),
              ),
            );
        if (!window) return { kind: "unavailable", threadId } as const;
        const { projectId } = window.thread;
        if (!projectTitles.has(projectId)) {
          const project: OrchestrationProjectShell | undefined = Option.getOrUndefined(
            yield* query.getProjectShellById(projectId),
          );
          projectTitles.set(projectId, project?.title ?? null);
        }
        return {
          kind: "thread",
          thread: window.thread,
          projectTitle: projectTitles.get(projectId) ?? null,
          hasOlderMessages: window.hasOlderMessages,
        } as const;
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("could not read a mentioned thread for a turn", {
                threadId,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as({ kind: "unavailable", threadId } as const)),
        ),
      ),
    );
    return renderThreadReferenceContext(resolved);
  });
