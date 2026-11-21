import {
  USER_ACTION_DECLINE_LABEL,
  USER_ACTION_DONE_LABEL,
  userActionAnswerInput,
  userActionRequestFailureText,
  userActionRequestLabel,
} from "@ryco/client-runtime/userActionRequests";
import {
  ThreadId,
  UserActionRequestId,
  type EnvironmentId,
  type ProjectBrowserTab,
} from "@ryco/contracts";
import * as Schema from "effect/Schema";
import { HandIcon } from "lucide-react";
import { useState } from "react";

import { readEnvironmentApi } from "~/environmentApi";
import { isDesktopOwnBackend } from "./useBrowserMode";

const isUserActionRequestId = Schema.is(UserActionRequestId);

/**
 * Over a tab an agent handed to the user: what it asks, and Done / Won't do right where the user
 * acts. The answer goes to the desktop's own node (agent tabs belong to it); a panel showing
 * another node's workspace points to the thread's card instead.
 */
export function BrowserHandoffBanner({
  environmentId,
  handoff,
}: {
  environmentId: EnvironmentId | null;
  handoff: NonNullable<ProjectBrowserTab["handoff"]>;
}) {
  const [sending, setSending] = useState<"done" | "declined" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const local = environmentId !== null && isDesktopOwnBackend(environmentId);
  const answer = (choice: "done" | "declined") => {
    const send =
      environmentId === null
        ? undefined
        : readEnvironmentApi(environmentId)?.threads?.answerUserActionRequest;
    if (!send || !isUserActionRequestId(handoff.request)) {
      setError("Answer on the thread's card.");
      return;
    }
    setSending(choice);
    setError(null);
    send(userActionAnswerInput(ThreadId.make(handoff.thread), handoff.request, choice)).then(
      () => setSending(null),
      (failure: unknown) => {
        setError(userActionRequestFailureText(failure));
        setSending(null);
      },
    );
  };
  return (
    <div
      role="status"
      aria-label="Browser tab handed to you"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-accent/40 px-3 py-2 text-xs"
    >
      <HandIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="font-medium">
        {userActionRequestLabel({ surface: "browser", need: handoff.need })}
      </span>
      <span className="min-w-0 flex-1 basis-48 text-muted-foreground">{handoff.message}</span>
      {local ? (
        <span className="flex items-center gap-2">
          <button
            type="button"
            disabled={sending !== null}
            onClick={() => answer("done")}
            className="rounded bg-primary px-2 py-1 text-primary-foreground disabled:opacity-50"
          >
            {sending === "done" ? "Finishing…" : USER_ACTION_DONE_LABEL}
          </button>
          <button
            type="button"
            disabled={sending !== null}
            onClick={() => answer("declined")}
            className="text-muted-foreground disabled:opacity-50"
          >
            {sending === "declined" ? "Declining…" : USER_ACTION_DECLINE_LABEL}
          </button>
        </span>
      ) : (
        <span className="text-muted-foreground">Answer on the thread&apos;s card.</span>
      )}
      {error !== null ? (
        <span role="alert" className="basis-full text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}
