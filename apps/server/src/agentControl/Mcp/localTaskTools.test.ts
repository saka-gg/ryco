import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import {
  AGENT_CONTROL_CAPABILITIES,
  AGENT_CONTROL_LOCAL_TASK_MCP_TOOLS,
  AGENT_CONTROL_MCP_TOOLS,
  AgentControlProposal,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type AgentControlActionPlan,
  type AgentControlCapability,
} from "@ryco/contracts";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { LocalTaskService, makeLocalTaskService } from "../../tasks/LocalTaskService.ts";
import type { AgentControlSessionRecord } from "../Services/AgentControlSessionRegistry.ts";
import { withLocalTaskTools } from "./localTaskTools.ts";
import type { AgentControlMcpToolResult, AgentControlMcpTools } from "./tools.ts";

const TOOLS = AGENT_CONTROL_LOCAL_TASK_MCP_TOOLS;
const now = "2026-10-19T09:00:00.000Z";
const projectId = ProjectId.make("project");
const otherProjectId = ProjectId.make("other-project");
const MODEL = { instanceId: "codex", model: "gpt-5" };

const ALL_GRANTS = [
  AGENT_CONTROL_CAPABILITIES.readLocalTasks,
  AGENT_CONTROL_CAPABILITIES.manageLocalTasks,
  AGENT_CONTROL_CAPABILITIES.createThreads,
];
const session = (
  grants: ReadonlyArray<AgentControlCapability> = ALL_GRANTS,
): AgentControlSessionRecord => ({
  sessionId: "lease-caller",
  issuedAt: now,
  threadId: ThreadId.make("caller"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeSessionId: RuntimeSessionId.make("caller-runtime"),
  grantedCapabilities: grants,
  injectionMode: "codex-http",
});

const proposalFor = (plan: AgentControlActionPlan) =>
  Schema.decodeUnknownSync(AgentControlProposal)({
    proposalId: "proposal-delete",
    requestId: "request",
    principal: {
      kind: "provider-session",
      threadId: "caller",
      providerInstanceId: "codex",
      runtimeSessionId: "caller-runtime",
      turnId: "caller-turn",
    },
    planVersion: 1,
    plan,
    planDigest: "a".repeat(64),
    riskTags: [],
    promptSummary: null,
    status: "pending-user-approval",
    createdAt: now,
    updatedAt: now,
    expiresAt: now,
    decidedAt: null,
    result: null,
  });

// The service and the tools share the node's one task-file store.
const taskFilesDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-task-files-"));
const layer = Layer.effect(LocalTaskService, makeLocalTaskService({ taskFilesDir })).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);

const setup = (options: { readonly grants?: ReadonlyArray<AgentControlCapability> } = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const id of [projectId, otherProjectId])
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES (${id}, ${id}, '/tmp/project', '[]', ${now}, ${now})`;
    const tasks = yield* LocalTaskService;
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-ws-"));
    let enabled = true;
    let authority = true;
    const baseCalls: Array<{ readonly name: string; readonly args: unknown }> = [];
    const submitted: AgentControlActionPlan[] = [];
    const base: AgentControlMcpTools = {
      descriptors: [],
      descriptorsFor: () => Effect.succeed([]),
      hasTool: (name) => name === AGENT_CONTROL_MCP_TOOLS.createThreads,
      isWriteTool: (name) => name === AGENT_CONTROL_MCP_TOOLS.createThreads,
      callTool: (_session, name, args) =>
        Effect.sync((): AgentControlMcpToolResult => {
          baseCalls.push({ name, args });
          // A request id the node has seen with another plan.
          if ((args as { readonly requestId?: string }).requestId === "used")
            return {
              content: [
                { type: "text", text: "Request ID was already used with a different plan." },
              ],
              isError: true,
            };
          return { content: [{ type: "text", text: "{}" }], structuredContent: { receipt: "ok" } };
        }),
    };
    const tools = withLocalTaskTools(base, {
      policy: {
        isEnabled: Effect.sync(() => enabled),
        authorize: (input) =>
          enabled && input.grantedCapabilities.includes(input.requiredCapability)
            ? Effect.void
            : (Effect.fail({ _tag: "AgentControlCapabilityDeniedError" }) as never),
      },
      registry: {
        getTurnAuthority: (sessionId) =>
          Effect.succeed(
            authority
              ? Option.some({
                  sessionId,
                  threadId: ThreadId.make("caller"),
                  turnId: TurnId.make("caller-turn"),
                  boundAt: now,
                })
              : Option.none(),
          ),
      },
      validator: {
        validateSubmission: (input: {
          readonly session: AgentControlSessionRecord;
          readonly authority: { readonly turnId: TurnId };
        }) =>
          Effect.succeed({
            kind: "provider-session",
            threadId: input.session.threadId,
            providerInstanceId: input.session.providerInstanceId,
            runtimeSessionId: input.session.runtimeSessionId,
            turnId: input.authority.turnId,
          }),
      } as never,
      proposals: {
        getProposal: () => Effect.die("unused"),
        submit: (input: { readonly plan: AgentControlActionPlan }) =>
          Effect.sync(() => {
            submitted.push(input.plan);
            return { proposal: proposalFor(input.plan), replayed: false };
          }),
      } as never,
      tasks,
      projections: {
        getThreadShellById: (threadId) =>
          Effect.succeed(
            threadId === "caller"
              ? Option.some({ id: threadId, projectId, title: "Caller" } as never)
              : threadId === "linked"
                ? Option.some({ id: threadId, projectId, title: "Old investigation" } as never)
                : Option.none(),
          ),
        getThreadCheckpointContext: (threadId) =>
          Effect.succeed(
            Option.some({
              threadId,
              projectId,
              workspaceRoot: workspace,
              worktreePath: null,
              checkpoints: [],
            }),
          ),
      },
      workspaceAccess: { assertExistingPath: (input) => Effect.succeed(input.path) },
      taskFilesDir,
    });
    const call = (name: string, args: unknown, caller = session(options.grants)) =>
      tools.callTool(caller, name, args);
    const value = <T = Record<string, unknown>>(result: AgentControlMcpToolResult) => {
      assert.isUndefined(result.isError, result.content[0]?.text);
      return result.structuredContent as T;
    };
    const failure = (result: AgentControlMcpToolResult) => {
      assert.isTrue(result.isError);
      return result.content[0]?.text ?? "";
    };
    return {
      tools,
      tasks,
      call,
      value,
      failure,
      workspace,
      taskFilesDir,
      baseCalls,
      submitted,
      disable: () => (enabled = false),
      revokeAuthority: () => (authority = false),
    };
  });

type TaskResult = {
  readonly task: {
    readonly taskId: string;
    readonly revision: number;
    readonly title: string;
    readonly state: string;
    readonly projectId: string | null;
    readonly links: ReadonlyArray<unknown>;
    readonly files: ReadonlyArray<{ readonly fileId: string; readonly name: string }>;
  };
};

describe("local task tools", () => {
  it.effect("are offered by grant: reads, changes, and starting chats with thread creation", () =>
    Effect.gen(function* () {
      const harness = yield* setup();
      const names = (grants: ReadonlyArray<AgentControlCapability>) =>
        harness.tools
          .descriptorsFor(session(grants))
          .pipe(Effect.map((tools) => tools.map((tool) => tool.name).toSorted()));
      assert.deepEqual(yield* names([AGENT_CONTROL_CAPABILITIES.readLocalTasks]), [
        TOOLS.list,
        TOOLS.read,
      ]);
      assert.notInclude(
        yield* names([
          AGENT_CONTROL_CAPABILITIES.readLocalTasks,
          AGENT_CONTROL_CAPABILITIES.manageLocalTasks,
        ]),
        TOOLS.startChat,
      );
      assert.deepEqual(yield* names(ALL_GRANTS), Object.values(TOOLS).toSorted());
      assert.isTrue(harness.tools.isWriteTool(TOOLS.update));
      assert.isFalse(harness.tools.isWriteTool(TOOLS.list));
      harness.disable();
      assert.deepEqual(yield* names(ALL_GRANTS), []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("creates, lists, reads, edits and completes tasks", () =>
    Effect.gen(function* () {
      const harness = yield* setup();
      const created = harness.value<TaskResult>(
        yield* harness.call(TOOLS.create, {
          requestId: "req-1",
          title: "Fix the login loop",
          notes: "After the cookie expires.",
          priority: "high",
          projectId,
          links: [{ kind: "pr", number: 746, title: "Fix login" }],
        }),
      );
      assert.equal(created.task.title, "Fix the login loop");
      assert.equal(created.task.projectId, projectId);
      assert.deepEqual(created.task.links, [{ kind: "pr", number: 746, title: "Fix login" }]);
      // A retry of the request answers with the same task; another payload under it is refused.
      const retried = harness.value<TaskResult>(
        yield* harness.call(TOOLS.create, {
          requestId: "req-1",
          title: "Fix the login loop",
          notes: "After the cookie expires.",
          priority: "high",
          projectId,
          links: [{ kind: "pr", number: 746, title: "Fix login" }],
        }),
      );
      assert.equal(retried.task.taskId, created.task.taskId);
      assert.include(
        harness.failure(yield* harness.call(TOOLS.create, { requestId: "req-1", title: "Other" })),
        "Request ID was already used",
      );

      const listed = harness.value<{
        readonly tasks: ReadonlyArray<{ readonly taskId: string; readonly notesPreview: string }>;
        readonly total: number;
      }>(yield* harness.call(TOOLS.list, { query: "login" }));
      assert.equal(listed.total, 1);
      assert.equal(listed.tasks[0]?.notesPreview, "After the cookie expires.");

      const done = harness.value<TaskResult>(
        yield* harness.call(TOOLS.update, {
          taskId: created.task.taskId,
          expectedRevision: created.task.revision,
          state: "done",
        }),
      );
      assert.equal(done.task.state, "done");
      // A stale revision says how to recover.
      assert.include(
        harness.failure(
          yield* harness.call(TOOLS.update, {
            taskId: created.task.taskId,
            expectedRevision: created.task.revision,
            title: "Stale",
          }),
        ),
        "ryco_read_local_task",
      );
      const open = harness.value<{ readonly total: number }>(yield* harness.call(TOOLS.list, {}));
      assert.equal(open.total, 0);
      const all = harness.value<{ readonly total: number }>(
        yield* harness.call(TOOLS.list, { state: "done" }),
      );
      assert.equal(all.total, 1);
      const read = harness.value<TaskResult>(
        yield* harness.call(TOOLS.read, { taskId: created.task.taskId }),
      );
      assert.equal(read.task.revision, done.task.revision);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("changes nothing without the exact active turn or the grant", () =>
    Effect.gen(function* () {
      const harness = yield* setup();
      assert.include(
        harness.failure(
          yield* harness.call(
            TOOLS.create,
            { requestId: "req", title: "Nope" },
            session([AGENT_CONTROL_CAPABILITIES.readLocalTasks]),
          ),
        ),
        "Capability denied",
      );
      harness.revokeAuthority();
      assert.include(
        harness.failure(yield* harness.call(TOOLS.create, { requestId: "req", title: "Nope" })),
        "Exact active-turn",
      );
      // Reads need no turn.
      harness.value(yield* harness.call(TOOLS.list, {}));
      assert.equal((yield* harness.tasks.list({})).tasks.length, 0);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("adds a workspace file once, refuses paths outside it, and removes it", () =>
    Effect.gen(function* () {
      const harness = yield* setup();
      fs.mkdirSync(path.join(harness.workspace, "notes"));
      fs.writeFileSync(path.join(harness.workspace, "notes", "plan.md"), "# Plan\n");
      const created = harness.value<TaskResult>(
        yield* harness.call(TOOLS.create, { requestId: "req", title: "With a file" }),
      );
      const added = harness.value<TaskResult & { readonly fileId: string }>(
        yield* harness.call(TOOLS.addFile, {
          taskId: created.task.taskId,
          expectedRevision: created.task.revision,
          path: "notes/plan.md",
        }),
      );
      assert.deepEqual(
        added.task.files.map((file) => file.name),
        ["plan.md"],
      );
      assert.isTrue(fs.existsSync(path.join(harness.taskFilesDir, added.fileId)));
      // The same file again names the same task file: nothing is added twice.
      const again = harness.value<TaskResult>(
        yield* harness.call(TOOLS.addFile, {
          taskId: created.task.taskId,
          expectedRevision: added.task.revision,
          path: "notes/plan.md",
        }),
      );
      assert.lengthOf(again.task.files, 1);
      for (const outside of ["../secret.txt", "/etc/hosts"])
        harness.failure(
          yield* harness.call(TOOLS.addFile, {
            taskId: created.task.taskId,
            expectedRevision: again.task.revision,
            path: outside,
          }),
        );
      const removed = harness.value<TaskResult>(
        yield* harness.call(TOOLS.removeFile, {
          taskId: created.task.taskId,
          expectedRevision: again.task.revision,
          fileId: added.fileId,
        }),
      );
      assert.lengthOf(removed.task.files, 0);
      assert.isFalse(fs.existsSync(path.join(harness.taskFilesDir, added.fileId)));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("starts a task's chat through thread creation, with the task as the message", () =>
    Effect.gen(function* () {
      const harness = yield* setup();
      const created = harness.value<TaskResult>(
        yield* harness.call(TOOLS.create, {
          requestId: "req",
          title: "Fix the login loop",
          notes: "After the cookie expires.",
          links: [{ kind: "thread", threadId: "linked" }],
        }),
      );
      harness.value(
        yield* harness.call(TOOLS.startChat, {
          requestId: "start-1",
          taskId: created.task.taskId,
          modelSelection: MODEL,
          runtimeMode: "approval-required",
          envMode: "worktree",
        }),
      );
      assert.deepEqual(harness.baseCalls, [
        {
          name: AGENT_CONTROL_MCP_TOOLS.createThreads,
          args: {
            requestId: "start-1",
            entries: [
              {
                // A task without a project starts in the caller's.
                projectId,
                title: "Fix the login loop",
                prompt:
                  "Fix the login loop\n\nAfter the cookie expires.\n\nLinked:\n- @thread:linked (Old investigation)",
                modelSelection: MODEL,
                runtimeMode: "approval-required",
                envMode: "worktree",
                localTaskId: created.task.taskId,
              },
            ],
          },
        },
      ]);
      const done = harness.value<TaskResult>(
        yield* harness.call(TOOLS.update, {
          taskId: created.task.taskId,
          expectedRevision: created.task.revision,
          state: "done",
        }),
      );
      assert.include(
        harness.failure(
          yield* harness.call(TOOLS.startChat, {
            requestId: "start-2",
            taskId: done.task.taskId,
            modelSelection: MODEL,
            runtimeMode: "approval-required",
            envMode: "worktree",
          }),
        ),
        "Reopen it",
      );
      assert.lengthOf(harness.baseCalls, 1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("pages lists, and explains deleted requests, other projects and reused starts", () =>
    Effect.gen(function* () {
      const harness = yield* setup();
      for (const requestId of ["a", "b", "c"])
        harness.value(yield* harness.call(TOOLS.create, { requestId, title: `Task ${requestId}` }));
      type Listed = {
        readonly tasks: ReadonlyArray<{ readonly title: string }>;
        readonly total: number;
        readonly nextOffset?: number;
      };
      const first = harness.value<Listed>(yield* harness.call(TOOLS.list, { limit: 2 }));
      assert.deepEqual([first.tasks.length, first.total, first.nextOffset], [2, 3, 2]);
      const rest = harness.value<Listed>(
        yield* harness.call(TOOLS.list, { limit: 2, offset: first.nextOffset }),
      );
      assert.deepEqual([rest.tasks.length, rest.nextOffset], [1, undefined]);

      // The request's task was deleted since: a retry can't bring it back, and says so.
      const gone = harness.value<TaskResult>(
        yield* harness.call(TOOLS.create, { requestId: "gone", title: "Gone" }),
      );
      yield* harness.tasks.remove({ taskId: gone.task.taskId, expectedRevision: 0 });
      assert.include(
        harness.failure(yield* harness.call(TOOLS.create, { requestId: "gone", title: "Gone" })),
        "was deleted",
      );

      // Chats are created in the caller's project only: another project's task says why.
      const elsewhere = harness.value<TaskResult>(
        yield* harness.call(TOOLS.create, {
          requestId: "elsewhere",
          title: "Elsewhere",
          projectId: otherProjectId,
        }),
      );
      const start = (requestId: string, taskId: string) =>
        harness.call(TOOLS.startChat, {
          requestId,
          taskId,
          modelSelection: MODEL,
          runtimeMode: "approval-required",
          envMode: "local",
        });
      assert.include(
        harness.failure(yield* start("start-elsewhere", elsewhere.task.taskId)),
        "another project",
      );
      assert.lengthOf(harness.baseCalls, 0);

      // A start retried after the task changed: the first try may have started the chat.
      const here = harness.value<TaskResult>(
        yield* harness.call(TOOLS.create, { requestId: "here", title: "Here" }),
      );
      assert.include(
        harness.failure(yield* start("used", here.task.taskId)),
        "ryco_read_local_task",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("asks the user to delete a task, deleting nothing itself", () =>
    Effect.gen(function* () {
      const harness = yield* setup();
      const created = harness.value<TaskResult>(
        yield* harness.call(TOOLS.create, { requestId: "req", title: "Old idea" }),
      );
      const receipt = harness.value<{ readonly receipt: { readonly status: string } }>(
        yield* harness.call(TOOLS.proposeDelete, {
          requestId: "delete-1",
          taskId: created.task.taskId,
          expectedRevision: created.task.revision,
        }),
      );
      assert.equal(receipt.receipt.status, "pending-user-approval");
      assert.deepEqual(harness.submitted, [
        {
          kind: "deleteLocalTask",
          taskId: created.task.taskId,
          expectedRevision: created.task.revision,
          title: "Old idea",
        },
      ]);
      assert.equal((yield* harness.tasks.get(created.task.taskId)).title, "Old idea");
    }).pipe(Effect.provide(layer)),
  );
});
