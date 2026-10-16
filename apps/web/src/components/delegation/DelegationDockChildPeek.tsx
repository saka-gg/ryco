import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  type PendingApproval,
  type PendingUserInput,
} from "@ryco/client-runtime/state/session";
import {
  selectThreadDetailLoaded,
  threadForkReplyExcerpt,
} from "@ryco/client-runtime/state/threads";
import {
  buildPendingUserInputAnswers,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "@ryco/client-runtime/state/user-input";
import {
  ORCHESTRATION_WS_METHODS,
  type ApprovalRequestId,
  type ApprovalResponseIdentity,
  type EnvironmentId,
  type MessageId,
  type ThreadId,
} from "@ryco/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import { retainThreadDetailSubscription } from "../../environments/runtime/service";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { useChatSessionActions } from "../../hooks/useChatSessionActions";
import { useStore, type AppState } from "../../store";
import { ApprovalCard } from "../chat/ApprovalCard";
import type { DelegationDockChild } from "./delegationDock.logic";

const PREVIEW_MAX_CHARS = 220;
const NO_PENDING: {
  readonly approvals: ReadonlyArray<PendingApproval>;
  readonly inputs: ReadonlyArray<PendingUserInput>;
} = { approvals: [], inputs: [] };

/** The child's latest reply: its latest turn's message, else the newest assistant message loaded. */
function selectLatestReplyText(
  state: AppState,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  assistantMessageId: MessageId | null,
): string | null {
  const environmentState = state.environmentStateById[environmentId];
  const messages = environmentState?.messageByThreadId[threadId];
  if (!messages) return null;
  const latest = assistantMessageId ? messages[assistantMessageId]?.text : undefined;
  if (latest?.trim()) return latest;
  const ids = environmentState?.messageIdsByThreadId[threadId] ?? [];
  for (let index = ids.length - 1; index >= 0; index -= 1) {
    const message = messages[ids[index]!];
    if (message?.role === "assistant" && message.text.trim()) return message.text;
  }
  return null;
}

/**
 * The expanded child row: its latest reply, or the question or approval it
 * waits on, answered here for the child's own thread. The child's detail is
 * retained only while this is open (no `view`, so no history recovery).
 */
export function DelegationDockChildPeek(props: {
  readonly environmentId: EnvironmentId;
  readonly child: DelegationDockChild;
  readonly modelLabel: string | null;
  readonly threadHref: string;
  readonly onOpenThread: () => void;
}) {
  const { environmentId } = props;
  const thread = props.child.thread;
  const threadId = thread.id;
  useEffect(() => {
    const release = retainThreadDetailSubscription(environmentId, threadId);
    return () => release({ immediately: true });
  }, [environmentId, threadId]);

  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const loaded = useStore((state) => selectThreadDetailLoaded(state, threadRef));
  const assistantMessageId = thread.latestTurn?.assistantMessageId ?? null;
  const reply = useStore((state) =>
    selectLatestReplyText(state, environmentId, threadId, assistantMessageId),
  );
  const activityIds = useStore(
    (state) => state.environmentStateById[environmentId]?.activityIdsByThreadId[threadId],
  );
  const activityById = useStore(
    (state) => state.environmentStateById[environmentId]?.activityByThreadId[threadId],
  );
  const waiting = thread.hasPendingApprovals || thread.hasPendingUserInput;
  const pending = useMemo(() => {
    if (!waiting || !activityIds || !activityById) return NO_PENDING;
    const activities = activityIds.flatMap((id) => {
      const activity = activityById[id];
      return activity ? [activity] : [];
    });
    return {
      approvals: derivePendingApprovals(activities),
      inputs: derivePendingUserInputs(activities),
    };
  }, [activityById, activityIds, waiting]);

  const [error, setError] = useState<string | null>(null);
  const setThreadError = useCallback((_target: ThreadId | null, message: string | null) => {
    setError(message);
  }, []);
  const actions = useChatSessionActions({
    environmentId,
    activeThreadId: threadId,
    setThreadError,
  });
  const dispatchCapability = useHostedRpcCapability(ORCHESTRATION_WS_METHODS.dispatchCommand);

  const input = pending.inputs[0];
  const approval = pending.approvals[0];
  return (
    <div
      className="delegation-dock-rise mt-0.5 mr-1.5 mb-1.5 ml-8 border-l-2 border-border px-2.5 pt-1 pb-1.5 text-xs text-muted-foreground"
      data-testid="delegation-dock-peek"
    >
      {input ? (
        <DelegationDockAnswer
          key={input.requestId}
          input={input}
          disabled={
            !dispatchCapability.allowed ||
            actions.respondingUserInputRequestIds.includes(input.requestId)
          }
          onRespond={actions.respondToUserInput}
        />
      ) : approval ? (
        <ApprovalCard
          approval={approval}
          pendingCount={pending.approvals.length}
          isResponding={actions.respondingRequestIds.includes(approval.requestId)}
          onRespondToApproval={actions.respondToApproval}
        />
      ) : (
        <>
          <div className="text-foreground">
            {reply
              ? threadForkReplyExcerpt(reply, PREVIEW_MAX_CHARS)
              : loaded
                ? "No reply yet."
                : "Loading…"}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {props.modelLabel ? (
              <>
                <span>{props.modelLabel}</span>
                <span aria-hidden>·</span>
              </>
            ) : null}
            <a
              className="text-(--chat-link) hover:underline"
              href={props.threadHref}
              onClick={(event) => {
                event.preventDefault();
                props.onOpenThread();
              }}
            >
              Open thread ↗
            </a>
          </div>
        </>
      )}
      {error ? (
        <p role="alert" className="mt-1.5 text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const ANSWER_BUTTON =
  "rounded-[7px] px-2.5 py-[3px] text-[11.5px] whitespace-nowrap disabled:opacity-50";

/**
 * A child's question, answered without leaving this thread: the same drafts
 * and answers as the composer's question panel, in the dock's compact form.
 */
function DelegationDockAnswer(props: {
  readonly input: PendingUserInput;
  readonly disabled: boolean;
  readonly onRespond: (
    requestId: ApprovalRequestId,
    answers: Record<string, unknown>,
    identity?: ApprovalResponseIdentity,
  ) => Promise<void>;
}) {
  const { input } = props;
  const [drafts, setDrafts] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const answers = buildPendingUserInputAnswers(input.questions, drafts);
  const locked =
    props.disabled || input.responseState === "submitting" || input.responseState === "uncertain";
  const lastIndex = input.questions.length - 1;
  const submit = () => {
    if (answers && !locked) void props.onRespond(input.requestId, answers, input.userInputIdentity);
  };
  // Not a <form>: the dock lives inside the composer's form, and Enter here
  // must answer the child, never send the composer.
  return (
    <div role="group" aria-label="Answer the delegated thread">
      <fieldset disabled={locked} className="min-w-0">
        {input.questions.map((question, index) => (
          <div key={question.id} className={index > 0 ? "mt-2" : undefined}>
            <div className="text-foreground">{question.question}</div>
            {question.options.length > 0 ? (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {question.options.map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    aria-pressed={
                      drafts[question.id]?.selectedOptionLabels?.includes(option.label) ?? false
                    }
                    className={`${ANSWER_BUTTON} border border-border hover:bg-foreground/9 aria-pressed:bg-foreground/9 aria-pressed:text-foreground`}
                    onClick={() =>
                      setDrafts((current) => ({
                        ...current,
                        [question.id]: togglePendingUserInputOptionSelection(
                          question,
                          current[question.id],
                          option.label,
                        ),
                      }))
                    }
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <input
                aria-label={`Answer: ${question.question}`}
                placeholder="Answer here; it goes to the delegated thread"
                value={drafts[question.id]?.customAnswer ?? ""}
                onChange={(event) =>
                  setDrafts((current) => ({
                    ...current,
                    [question.id]: setPendingUserInputCustomAnswer(
                      current[question.id],
                      event.target.value,
                    ),
                  }))
                }
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  event.stopPropagation();
                  submit();
                }}
                className="min-w-40 flex-1 rounded-[7px] border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-ring"
              />
              {index === lastIndex ? (
                <button
                  type="button"
                  disabled={!answers}
                  onClick={submit}
                  className={`${ANSWER_BUTTON} bg-primary text-primary-foreground`}
                >
                  Send
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </fieldset>
      {input.responseState === "uncertain" ? (
        <p role="status" className="mt-1.5">
          Delivery is unconfirmed. This answer will not be resent automatically.
        </p>
      ) : null}
    </div>
  );
}
