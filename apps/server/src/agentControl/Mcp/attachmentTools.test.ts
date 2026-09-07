import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { Effect, Option } from "effect";
import {
  AGENT_CONTROL_CAPABILITIES,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationMessage,
} from "@ryco/contracts";
import { withAssistantAttachmentTools } from "./attachmentTools.ts";
import type { AgentControlMcpTools } from "./tools.ts";
import type {
  AgentControlSessionRecord,
  AgentControlTurnAuthority,
} from "../Services/AgentControlSessionRegistry.ts";

const session: AgentControlSessionRecord = {
  sessionId: "session",
  threadId: ThreadId.make("thread"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeSessionId: RuntimeSessionId.make("runtime"),
  grantedCapabilities: [AGENT_CONTROL_CAPABILITIES.attachFile],
  issuedAt: "2026-09-07T00:00:00Z",
  injectionMode: "codex-http",
};
const base: AgentControlMcpTools = {
  descriptors: [],
  descriptorsFor: () => Effect.succeed([]),
  hasTool: () => false,
  isWriteTool: () => false,
  callTool: () => Effect.succeed({ content: [] }),
};
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ryco-mcp-file-"));
  roots.push(root);
  const cwd = path.join(root, "workspace");
  await fs.mkdir(cwd);
  await fs.writeFile(path.join(cwd, "report.pdf"), "%PDF-report");
  let authority: Option.Option<AgentControlTurnAuthority> = Option.some({
    sessionId: session.sessionId,
    threadId: session.threadId,
    turnId: TurnId.make("turn"),
    boundAt: session.issuedAt,
  });
  const messages: OrchestrationMessage[] = [];
  const dispatch = vi.fn((command: OrchestrationCommand) =>
    Effect.sync(() => {
      if (command.type === "thread.message.assistant.complete")
        messages.push({
          id: command.messageId,
          role: "assistant",
          text: command.text ?? "",
          turnId: command.turnId ?? null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
          attachments: [...(command.attachments ?? [])],
        });
      return { sequence: messages.length };
    }),
  );
  const authorize = vi.fn(() => Effect.void);
  const tools = await Effect.runPromise(
    withAssistantAttachmentTools(base, {
      attachmentsDir: path.join(root, "attachments"),
      registry: { getTurnAuthority: () => Effect.sync(() => authority) },
      policy: { authorize },
      engine: { dispatch },
      workspaceAccess: { assertExistingPath: () => Effect.succeed(cwd) },
      projections: {
        listThreadMessagesByTurn: () => Effect.sync(() => [...messages]),
        getThreadCheckpointContext: () =>
          Effect.succeed(
            Option.some({
              threadId: session.threadId,
              projectId: ProjectId.make("project"),
              workspaceRoot: cwd,
              worktreePath: null,
              checkpoints: [],
            }),
          ),
      },
    }),
  );
  return {
    tools,
    dispatch,
    messages,
    authorize,
    revoke: () => {
      authority = Option.none();
    },
  };
}
it("publishes an attachment once, with server-owned thread and turn identity", async () => {
  const { tools, dispatch, messages } = await fixture();
  const args = { path: "report.pdf", threadId: "other-thread" };
  const result = await Effect.runPromise(tools.callTool(session, "ryco_attach_file", args));
  expect(result.isError).toBeUndefined();
  expect(dispatch).toHaveBeenCalledWith(
    expect.objectContaining({
      threadId: session.threadId,
      turnId: "turn",
      attachments: [expect.objectContaining({ name: "report.pdf" })],
    }),
  );
  await Effect.runPromise(tools.callTool(session, "ryco_attach_file", args));
  expect(messages).toHaveLength(1);
});
it("hides the tool without the dedicated grant and rejects retired turns", async () => {
  const { tools, dispatch, revoke } = await fixture();
  expect(
    await Effect.runPromise(tools.descriptorsFor({ ...session, grantedCapabilities: [] })),
  ).toEqual([]);
  expect(tools.isWriteTool("ryco_attach_file")).toBe(true);
  revoke();
  expect(
    (await Effect.runPromise(tools.callTool(session, "ryco_attach_file", { path: "report.pdf" })))
      .isError,
  ).toBe(true);
  expect(dispatch).not.toHaveBeenCalled();
});
it("refuses invalid paths and bounds concurrent delivery requests", async () => {
  const { tools, messages, dispatch } = await fixture();
  expect(
    (await Effect.runPromise(tools.callTool(session, "ryco_attach_file", { path: "../outside" })))
      .isError,
  ).toBe(true);
  expect(dispatch).not.toHaveBeenCalled();
  const results = await Promise.all(
    Array.from({ length: 9 }, (_, index) =>
      Effect.runPromise(
        tools.callTool(session, "ryco_attach_file", {
          path: "report.pdf",
          name: `report-${index}.pdf`,
        }),
      ),
    ),
  );
  expect(results.filter((result) => result.isError)).toHaveLength(1);
  expect(messages).toHaveLength(8);
});

it("does not publish if turn authority is revoked during delivery", async () => {
  const { tools, dispatch, authorize, revoke } = await fixture();
  authorize.mockImplementation(() => Effect.sync(revoke));
  expect(
    (await Effect.runPromise(tools.callTool(session, "ryco_attach_file", { path: "report.pdf" })))
      .isError,
  ).toBe(true);
  expect(dispatch).not.toHaveBeenCalled();
});
