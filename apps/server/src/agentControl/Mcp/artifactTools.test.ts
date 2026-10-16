import {
  AGENT_CONTROL_CAPABILITIES,
  MessageId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  type ChatAttachment,
  type OrchestrationMessage,
} from "@ryco/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

import type { AgentControlSessionRecord } from "../Services/AgentControlSessionRegistry.ts";
import {
  LIST_ARTIFACTS_TOOL_NAME,
  listMessageArtifacts,
  withArtifactTools,
} from "./artifactTools.ts";
import type { AgentControlMcpTools } from "./tools.ts";

const session: AgentControlSessionRecord = {
  sessionId: "session",
  threadId: ThreadId.make("thread"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeSessionId: RuntimeSessionId.make("runtime"),
  grantedCapabilities: [AGENT_CONTROL_CAPABILITIES.read],
  issuedAt: "2026-10-16T00:00:00Z",
  injectionMode: "codex-http",
};
const base: AgentControlMcpTools = {
  descriptors: [],
  descriptorsFor: () => Effect.succeed([]),
  hasTool: () => false,
  isWriteTool: () => false,
  callTool: () => Effect.succeed({ content: [] }),
};

const page = (id: string, title: string): ChatAttachment => ({
  type: "file",
  id,
  name: `${title}.html`,
  mimeType: "text/html",
  sizeBytes: 10,
  htmlRender: { title, height: 400 },
});
const csv: ChatAttachment = {
  type: "file",
  id: "thread-csv",
  name: "export.csv",
  mimeType: "text/csv",
  sizeBytes: 4,
};
const message = (
  id: string,
  role: OrchestrationMessage["role"],
  attachments: ReadonlyArray<ChatAttachment>,
): OrchestrationMessage =>
  ({
    id: MessageId.make(id),
    role,
    text: " ",
    attachments,
    turnId: null,
    streaming: false,
    createdAt: "2026-10-16T12:00:00.000Z",
    updatedAt: "2026-10-16T12:00:00.000Z",
  }) as OrchestrationMessage;

describe("listMessageArtifacts", () => {
  it("lists pages and files with the ids a handover takes, never the user's uploads", () => {
    const handoff = { threadId: ThreadId.make("parent"), messageId: MessageId.make("source") };
    const artifacts = listMessageArtifacts([
      message("m3", "assistant", [page("thread-chart", "Chart"), csv]),
      message("m2", "user", [csv, { ...page("thread-copy", "Mockup"), handoff } as ChatAttachment]),
    ]);
    expect(artifacts).toEqual([
      expect.objectContaining({ artifactId: "m3:thread-chart", kind: "page", title: "Chart" }),
      expect.objectContaining({ artifactId: "m3:thread-csv", kind: "file", name: "export.csv" }),
      expect.objectContaining({
        artifactId: "m2:thread-copy",
        kind: "page",
        handedOverFrom: { threadId: "parent", messageId: "source" },
      }),
    ]);
  });
});

describe("ryco_list_artifacts", () => {
  const make = (enabled = true) => {
    const read = vi.fn((_input: { readonly threadId: ThreadId; readonly limit: number }) =>
      Effect.succeed([message("m1", "assistant", [page("thread-chart", "Chart")])]),
    );
    const tools = withArtifactTools(base, {
      policy: { authorize: () => Effect.void, isEnabled: Effect.succeed(enabled) },
      projections: { listThreadArtifactMessages: read },
    });
    return { tools, read };
  };

  it("lists only the calling session's own thread", async () => {
    const { tools, read } = make();
    const result = await Effect.runPromise(
      tools.callTool(session, LIST_ARTIFACTS_TOOL_NAME, { limit: 500 }),
    );
    expect(read).toHaveBeenCalledExactlyOnceWith({ threadId: "thread", limit: 50 });
    expect(result.structuredContent).toEqual({
      threadId: "thread",
      artifacts: [expect.objectContaining({ artifactId: "m1:thread-chart", title: "Chart" })],
    });
    expect(tools.isWriteTool(LIST_ARTIFACTS_TOOL_NAME)).toBe(false);
  });

  it("is offered to sessions that may read, while Agent Control is enabled", async () => {
    const names = async (enabled: boolean, record: AgentControlSessionRecord) =>
      (await Effect.runPromise(make(enabled).tools.descriptorsFor(record))).map(
        (tool) => tool.name,
      );
    expect(await names(true, session)).toEqual([LIST_ARTIFACTS_TOOL_NAME]);
    expect(await names(false, session)).toEqual([]);
    expect(await names(true, { ...session, grantedCapabilities: [] })).toEqual([]);
  });
});
