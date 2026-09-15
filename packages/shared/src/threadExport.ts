import {
  CONTEXT_HANDOFF_ACTIVITY_KIND,
  ContextHandoffActivityPayload,
  type OrchestrationThread,
} from "@ryco/contracts";
import { Schema } from "effect";

export type ThreadExportMessage = Pick<
  OrchestrationThread["messages"][number],
  "id" | "role" | "text" | "streaming" | "createdAt"
> & { readonly attachmentCount: number };
export interface ThreadExportActivity {
  readonly id: string;
  readonly createdAt: string;
  readonly kind: string;
  readonly summary: string;
  readonly boundary?: string;
}
export type ThreadExportSource = Pick<
  OrchestrationThread,
  | "id"
  | "projectId"
  | "title"
  | "branch"
  | "worktreePath"
  | "worktreeId"
  | "createdAt"
  | "updatedAt"
> & {
  readonly modelSelection: Pick<OrchestrationThread["modelSelection"], "instanceId" | "model">;
  readonly messages: readonly ThreadExportMessage[];
  readonly activities: readonly ThreadExportActivity[];
};
const decodeBoundary = Schema.decodeUnknownOption(ContextHandoffActivityPayload);
/** Retain only display fields; tool arguments, results and auth payloads never accumulate. */
export function projectThreadExportActivity(
  activity: OrchestrationThread["activities"][number],
): ThreadExportActivity {
  let boundary: string | undefined;
  if (activity.kind === CONTEXT_HANDOFF_ACTIVITY_KIND) {
    const decoded = decodeBoundary(activity.payload);
    if (decoded._tag === "Some") {
      const data = decoded.value;
      boundary = `${data.status}: ${data.sourceSelection.instanceId}/${data.sourceSelection.model} → ${data.targetSelection.instanceId}/${data.targetSelection.model}`;
    }
  }
  const known = ["tool.started", "tool.completed", "tool.denied"].includes(activity.kind);
  return {
    id: activity.id,
    createdAt: activity.createdAt,
    kind: known ? activity.kind : "boundary",
    summary: known ? activity.summary : "",
    ...(boundary ? { boundary } : {}),
  };
}

/** Export safety redactions preserve all other characters, including URL spelling. */
export function redactExportText(text: string): string {
  return text
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gu,
      "[redacted]",
    )
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;"']+/giu, "[redacted authorization]")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/gu,
      "[redacted]",
    )
    .replace(
      /\b((?:access[-_]?token|refresh[-_]?token|token|secret|password|passwd|credential|authorization|api[-_]?key|cookie|pairing[-_]?code|proof|ticket|signature)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/giu,
      "$1[redacted]",
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, "$1[redacted]@");
}

function fence(text: string): string {
  const safe = redactExportText(text);
  let size = 3;
  for (const match of safe.matchAll(/`+/gu)) size = Math.max(size, match[0].length + 1);
  const delimiter = "`".repeat(size);
  return `${delimiter}text\n${safe}\n${delimiter}`;
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const ordered = <T extends { createdAt: string; id: string }>(items: readonly T[]) =>
  items.toSorted((a, b) => compare(a.createdAt, b.createdAt) || compare(a.id, b.id));
const utc = (text: string) => new Date(text).toISOString();

export function threadExportFilename(title: string): string {
  const name = redactExportText(title)
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  return `ryco-${name || "conversation"}.md`;
}

export function serializeThreadMarkdown(thread: ThreadExportSource): string {
  const sections = [
    "# Retained Ryco conversation",
    "Complete retained message history at the source revision. Deleted or provider-only history is unavailable. Attachments are listed by count; binary content is not embedded. Tool events are condensed. Message text is preserved inside literal fences except recognizable secrets, replaced with [redacted] markers. Historical provider/model values are only available where recorded in handoff boundaries.",
    "## Metadata",
    fence(
      `Title: ${thread.title}\nThread: ${thread.id}\nProject: ${thread.projectId}\nCurrent provider instance: ${thread.modelSelection.instanceId}\nCurrent model: ${thread.modelSelection.model}\nCreated: ${utc(thread.createdAt)}\nUpdated: ${utc(thread.updatedAt)}\nBranch: ${thread.branch ?? "unavailable"}\nWorktree: ${thread.worktreePath ?? "unavailable"}\nWorktree ID: ${thread.worktreeId ?? "unavailable"}`,
    ),
    "## Messages",
  ];
  for (const message of ordered(thread.messages)) {
    sections.push(
      `### ${message.role === "user" ? "User" : "Assistant"} · ${utc(message.createdAt)}${message.streaming ? " · in progress at snapshot" : ""}`,
      fence(message.text),
    );
    if (message.attachmentCount)
      sections.push(`Attachments: ${message.attachmentCount} (not embedded).`);
  }
  if (!thread.messages.length) sections.push("No retained messages.");
  for (const activity of ordered(thread.activities)) {
    if (activity.boundary)
      sections.push(
        `### Provider/model boundary · ${utc(activity.createdAt)}`,
        fence(activity.boundary),
      );
  }
  sections.push("## Tool summaries");
  // Only public summary text from known lifecycle events; never traverse payloads.
  for (const activity of ordered(thread.activities)) {
    if (!["tool.started", "tool.completed", "tool.denied"].includes(activity.kind)) continue;
    const summary = Array.from(redactExportText(activity.summary));
    sections.push(
      `### ${activity.kind} · ${utc(activity.createdAt)}`,
      fence(summary.slice(0, 240).join("") + (summary.length > 240 ? "… [summary condensed]" : "")),
    );
  }
  return sections.join("\n\n") + "\n";
}
