/**
 * A message box under a running agent's detail: what the person types reaches the agent at its
 * next step, without stopping it or the turn (`@ryco/client-runtime/state/session/subagentMessage`).
 * Shown only for agents whose provider can deliver one (Claude subagents today).
 */
import {
  describeSubagentMessageFailure,
  subagentMessageIdentity,
  type SubagentMessageAction,
} from "@ryco/client-runtime/state/session/subagentMessage";
import { BACKGROUND_TASK_MESSAGE_MAX_CHARS } from "@ryco/contracts";
import { SendHorizontalIcon } from "lucide-react";
import { useEffect, useState, type KeyboardEvent } from "react";

import type { RuntimeSubagent } from "../../threadWorkspaceViewModel";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

type SendState =
  | { readonly kind: "idle" }
  | { readonly kind: "sending" }
  | { readonly kind: "sent" }
  | { readonly kind: "failed"; readonly reason: string };

/** How long "Sent" stays before the hint returns. */
const SENT_NOTE_MS = 6_000;

export function AgentMessageBox({
  agent,
  action,
}: {
  agent: RuntimeSubagent;
  action: SubagentMessageAction;
}) {
  const identity = subagentMessageIdentity(agent, action.runtimeSessionId);
  const [text, setText] = useState("");
  const [state, setState] = useState<SendState>({ kind: "idle" });
  useEffect(() => {
    if (state.kind !== "sent") return;
    const timer = window.setTimeout(() => setState({ kind: "idle" }), SENT_NOTE_MS);
    return () => window.clearTimeout(timer);
  }, [state]);
  if (identity === null) return null;

  const trimmed = text.trim();
  const blocked = action.unavailableReason !== null;
  const canSend = !blocked && trimmed.length > 0 && state.kind !== "sending";
  const send = async () => {
    if (!canSend) return;
    setState({ kind: "sending" });
    try {
      await action.send(identity, trimmed);
      setText("");
      setState({ kind: "sent" });
    } catch (cause) {
      setState({ kind: "failed", reason: describeSubagentMessageFailure(cause) });
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };
  const note = blocked
    ? action.unavailableReason
    : state.kind === "failed"
      ? state.reason
      : state.kind === "sent"
        ? "Sent. The agent reads it at its next step."
        : "It reads your message at its next step; nothing stops.";

  return (
    <div className="space-y-1.5 border-t border-border/60 p-2.5" data-agent-message-box>
      <div className="flex items-end gap-1.5">
        <Textarea
          size="sm"
          value={text}
          maxLength={BACKGROUND_TASK_MESSAGE_MAX_CHARS}
          disabled={blocked}
          placeholder="Message this agent…"
          aria-label="Message this agent"
          className="min-w-0 flex-1"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <Button
          size="icon-sm"
          variant="outline"
          disabled={!canSend}
          aria-label="Send to agent"
          onClick={() => void send()}
        >
          <SendHorizontalIcon aria-hidden />
        </Button>
      </div>
      <p
        role={state.kind === "failed" ? "alert" : "status"}
        className={
          state.kind === "failed" || blocked
            ? "text-[11px] text-destructive"
            : "text-[11px] text-muted-foreground"
        }
      >
        {note}
      </p>
    </div>
  );
}
