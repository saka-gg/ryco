import type { Part } from "@opencode-ai/sdk/v2";
import {
  ProviderItemId,
  RuntimeSubagentId,
  type RuntimeSubagentStatus,
  type SubagentRef,
} from "@ryco/contracts";

export interface OpenCodeTaskTransition {
  readonly type: "started" | "updated" | "completed";
  readonly subagent: SubagentRef;
  readonly status: RuntimeSubagentStatus;
  readonly summary?: string;
  readonly eventKey: string;
}

interface TaskState {
  ref: SubagentRef;
  callId: string | undefined;
  status: RuntimeSubagentStatus;
  summary: string | undefined;
  readonly seenCalls: Set<string>;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
const terminal = (status: RuntimeSubagentStatus) =>
  status === "completed" || status === "failed" || status === "stopped";

function resultText(output: string): string | undefined {
  const result = output.match(/<task_result>\s*([\s\S]*?)\s*<\/task_result>/)?.[1];
  return text(
    result ??
      output
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("task_id:"))
        .join("\n"),
  );
}

/** Native Task lifecycle state stays here; clients consume the shared subagent events. */
export class OpenCodeTaskLifecycle {
  private readonly tasks = new Map<string, TaskState>();
  private readonly calls = new Map<string, TaskState>();
  private readonly sessions = new Map<string, TaskState>();
  private readonly emitted = new Set<string>();
  private readonly notifications = new Set<string>();

  values(): Iterable<SubagentRef> {
    return Array.from(this.tasks.values(), (task) => task.ref);
  }

  hasSession(id: string): boolean {
    return this.sessions.has(id);
  }

  refForSession(id: string): SubagentRef | undefined {
    return this.sessions.get(id)?.ref;
  }

  private transition(
    task: TaskState,
    type: OpenCodeTaskTransition["type"],
    source: string,
  ): OpenCodeTaskTransition[] {
    // Metadata is part of the key: late model/linkage enrichment must reach the panel,
    // while exact SDK replays must not append duplicate lifecycle activities.
    const eventKey = JSON.stringify([
      task.ref.subagentId,
      task.callId ?? source,
      type,
      task.status,
      task.summary,
      task.ref,
    ]);
    if (this.emitted.has(eventKey)) return [];
    this.emitted.add(eventKey);
    return [
      {
        type,
        subagent: task.ref,
        status: task.status,
        ...(task.summary ? { summary: task.summary } : {}),
        eventKey,
      },
    ];
  }

  stop(): OpenCodeTaskTransition[] {
    return Array.from(this.tasks.values()).flatMap((task) => {
      if (terminal(task.status)) return [];
      task.status = "stopped";
      return this.transition(task, "completed", "stop");
    });
  }

  project(part: Part, existingRef?: SubagentRef): OpenCodeTaskTransition[] {
    if (part.type === "text") {
      if (part.synthetic !== true) return [];
      const envelope = part.text.match(
        /<task id="([^"]+)" state="(completed|error|interrupted|cancelled)">/,
      );
      const sessionId = text(envelope?.[1]);
      if (!sessionId) return [];
      const notificationKey = JSON.stringify([part.sessionID, part.id, part.text]);
      if (this.notifications.has(notificationKey)) return [];
      this.notifications.add(notificationKey);
      let task = this.sessions.get(sessionId);
      if (task && terminal(task.status)) return [];
      const events: OpenCodeTaskTransition[] = [];
      if (!task) {
        task = {
          ref: existingRef ?? this.makeRef(sessionId, part.sessionID),
          callId: undefined,
          status: "running",
          summary: undefined,
          seenCalls: new Set(),
        };
        this.tasks.set(String(task.ref.subagentId), task);
        this.sessions.set(sessionId, task);
        events.push(...this.transition(task, "started", part.id));
      }
      task.status =
        envelope?.[2] === "error"
          ? "failed"
          : envelope?.[2] === "completed"
            ? "completed"
            : "stopped";
      task.summary =
        task.status === "failed"
          ? text(part.text.match(/<task_error>\s*([\s\S]*?)\s*<\/task_error>/)?.[1])
          : resultText(part.text);
      return [...events, ...this.transition(task, "completed", part.id)];
    }
    if (part.type !== "tool" || part.tool.toLowerCase() !== "task") return [];
    const callKey = JSON.stringify([part.sessionID, part.callID]);
    const previousCall = this.calls.get(callKey);
    const metadata = "metadata" in part.state ? record(part.state.metadata) : {};
    const input = record(part.state.input);
    const output = part.state.status === "completed" ? part.state.output : "";
    const sessionId =
      text(metadata.sessionId) ??
      text(metadata.sessionID) ??
      text(input.task_id) ??
      text(metadata.jobId) ??
      text(output.match(/<task id="([^"]+)"/)?.[1]) ??
      text(output.match(/(?:^|\n)\s*task_id:\s*(\S+)/)?.[1]);
    if (part.state.status === "pending" && !sessionId && !previousCall) return [];
    let task = previousCall ?? (sessionId ? this.sessions.get(sessionId) : undefined);
    if (!task && !sessionId && part.state.status !== "error") return [];
    if (task && task.callId !== undefined && task.callId !== callKey && task.seenCalls.has(callKey))
      return [];
    if (
      task &&
      task.callId === callKey &&
      task.status !== "starting" &&
      part.state.status === "pending"
    )
      return [];
    const newTask = !task;
    if (!task) {
      task = {
        ref: existingRef ?? this.makeRef(sessionId, part.sessionID, part.callID),
        callId: callKey,
        status: "starting",
        summary: undefined,
        seenCalls: new Set(),
      };
      this.tasks.set(String(task.ref.subagentId), task);
    }
    const reopen = task.callId !== undefined && task.callId !== callKey;
    // A notification may arrive before its tool part. Binding that part enriches
    // the terminal row; it must not resurrect a completed background operation.
    const terminalBeforeTool = task.callId === undefined && terminal(task.status);
    const priorRef = task.ref;
    const priorStatus = task.status;
    if (reopen) {
      task.status = "starting";
      task.summary = undefined;
    }
    task.callId = callKey;
    task.seenCalls.add(callKey);
    this.calls.set(callKey, task);
    const modelRecord = record(metadata.model);
    const provider = text(modelRecord.providerID);
    const model = text(modelRecord.modelID);
    task.ref = {
      ...task.ref,
      ...(sessionId ? { providerSessionId: sessionId, providerThreadId: sessionId } : {}),
      ...(text(input.description) ? { description: text(input.description)! } : {}),
      ...(text(input.subagent_type) ? { label: text(input.subagent_type)! } : {}),
      ...(provider && model ? { model: `${provider}/${model}` } : {}),
      parentProviderItemId: ProviderItemId.make(part.callID),
      metadata: {
        ...task.ref.metadata,
        ...metadata,
        source: "opencode.task",
        parentSessionId: part.sessionID,
      },
    };
    if (sessionId) this.sessions.set(sessionId, task);
    const outputState = output.match(/<task id="[^"]+" state="([^"]+)">/)?.[1];
    const interrupted = outputState === "interrupted" || outputState === "cancelled";
    const background = metadata.background === true || outputState === "running";
    const events: OpenCodeTaskTransition[] = [];
    if (newTask) events.push(...this.transition(task, "started", part.id));
    if (!terminalBeforeTool && (!terminal(task.status) || reopen)) {
      task.status = interrupted
        ? "stopped"
        : part.state.status === "error"
          ? "failed"
          : part.state.status === "completed" && !background
            ? "completed"
            : part.state.status === "pending"
              ? "starting"
              : "running";
      task.summary =
        part.state.status === "error"
          ? text(part.state.error)
          : task.status === "completed"
            ? resultText(output)
            : undefined;
      events.push(
        ...this.transition(task, terminal(task.status) ? "completed" : "updated", part.id),
      );
    } else if (
      JSON.stringify(priorRef) !== JSON.stringify(task.ref) ||
      priorStatus !== task.status
    ) {
      events.push(...this.transition(task, "updated", part.id));
    }
    return events;
  }

  private makeRef(
    sessionId: string | undefined,
    parentSessionId: string,
    callId?: string,
  ): SubagentRef {
    return {
      subagentId: RuntimeSubagentId.make(
        sessionId ? `opencode:session:${sessionId}` : `opencode:task:${parentSessionId}:${callId}`,
      ),
      origin: "native",
      capability: "summary",
      ...(sessionId ? { providerSessionId: sessionId, providerThreadId: sessionId } : {}),
      metadata: { source: "opencode.task", parentSessionId },
    };
  }
}
