import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AGENT_CONTROL_ACTION_CAPABILITIES,
  AGENT_CONTROL_CAPABILITIES,
  AGENT_CONTROL_TERMINAL_MCP_TOOL,
  AgentControlProposalId,
  OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  CommandId,
  type AgentControlCapability,
  type AgentControlProposal,
  type AgentControlProposalStatus,
  type RuntimeMode,
} from "@ryco/contracts";
import { Effect, Exit, Layer, ManagedRuntime, Option, Schema, Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import * as NodePTY from "../../terminal/Layers/NodePTY.ts";
import { makeTerminalManagerWithOptions } from "../../terminal/Layers/Manager.ts";
import type { TerminalManagerShape } from "../../terminal/Services/Manager.ts";
import { PtyAdapter } from "../../terminal/Services/PTY.ts";
import { NO_DELEGATION_LIMITS } from "../../orchestration/delegationLimits.ts";
import { AgentControlCapabilityDeniedError } from "../Errors.ts";
import type { AgentControlPolicyShape } from "../Services/AgentControlPolicy.ts";
import type {
  AgentControlSessionRecord,
  AgentControlTurnAuthority,
} from "../Services/AgentControlSessionRegistry.ts";
import { withTerminalTools } from "./terminalTools.ts";
import { threadWakeSource, waitUntil } from "../eventDrivenWait.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineLive } from "../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../../orchestration/ThreadBackgroundLiveness.ts";
import { findThreadInArray } from "../../orchestration/threadIndex.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { ProjectAvatarStore } from "../../project/Services/ProjectAvatarStore.ts";
import {
  answerUserActionRequest,
  readThreadUserActionRequests,
  userActionRequestIdFor,
  type UserActionWaitDeps,
} from "../../userActionRequests/userActionRequests.ts";
import { userActionRequestHints } from "@ryco/shared/userActionHints";
import {
  submitAgentControlMutation,
  type AgentControlMcpToolDeps,
  type AgentControlMcpToolResult,
  type AgentControlMcpTools,
} from "./tools.ts";

const T0 = "2026-11-21T00:00:00.000Z";
const THREAD = ThreadId.make("thread-term");
const GRANTS: ReadonlyArray<AgentControlCapability> = [AGENT_CONTROL_CAPABILITIES.controlTerminals];

const session: AgentControlSessionRecord = {
  sessionId: "session-term",
  threadId: THREAD,
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeSessionId: RuntimeSessionId.make("runtime-term"),
  grantedCapabilities: GRANTS,
  issuedAt: T0,
  injectionMode: "codex-http",
};

const authority: AgentControlTurnAuthority = {
  sessionId: session.sessionId,
  threadId: THREAD,
  turnId: TurnId.make("turn-1"),
  boundAt: T0,
};

const threadShell = (runtimeMode: RuntimeMode) =>
  Schema.decodeUnknownSync(OrchestrationThreadShell)({
    id: THREAD,
    projectId: "project-1",
    title: "Terminal thread",
    modelSelection: { instanceId: "codex", model: "gpt-5.6" },
    runtimeMode,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: T0,
    updatedAt: T0,
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  });

const baseTools: AgentControlMcpTools = {
  descriptors: [],
  descriptorsFor: () => Effect.succeed([]),
  hasTool: () => false,
  isWriteTool: () => false,
  callTool: () => Effect.succeed({ content: [{ type: "text", text: "base" }], isError: true }),
};

const policy: AgentControlPolicyShape = {
  isEnabled: Effect.succeed(true),
  delegationLimits: Effect.succeed(NO_DELEGATION_LIMITS),
  requireEnabled: () => Effect.void,
  requiredCapabilityForAction: (kind) => AGENT_CONTROL_ACTION_CAPABILITIES[kind],
  authorize: (input) =>
    input.grantedCapabilities.includes(input.requiredCapability)
      ? Effect.void
      : Effect.fail(
          new AgentControlCapabilityDeniedError({
            operation: input.operation,
            capability: input.requiredCapability,
          }),
        ),
};

const textOf = (result: AgentControlMcpToolResult) =>
  result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");

const SECRET = "hunter2-very-private";

/** Resolves once the terminal's output shows `text` (its output events, not a timer). */
const outputShows = (terminals: TerminalManagerShape, terminalId: string, text: string) =>
  new Promise<void>((resolve) => {
    let seen = "";
    let stop: (() => void) | undefined;
    void Effect.runPromise(
      terminals.subscribe((event) =>
        Effect.sync(() => {
          if (event.type !== "output" || event.terminalId !== terminalId) return;
          seen = (seen + event.data).slice(-4_000);
          if (!seen.includes(text)) return;
          stop?.();
          resolve();
        }),
      ),
    ).then((unsubscribe) => {
      stop = unsubscribe;
    });
  });

/** Tools on `terminals` for a thread whose checkout is `<root>/work` (agent terminals only). */
const toolsForRoot = (terminals: TerminalManagerShape, root: string) => {
  const tools = withTerminalTools(baseTools, {
    policy,
    registry: { getTurnAuthority: () => Effect.succeed(Option.some(authority)) },
    proposals: { getProposal: () => Effect.succeed(Option.none()) },
    submitMutation: () => Effect.die("agent terminals never ask for consent"),
    projections: {
      getThreadShellById: () => Effect.sync(() => Option.some(threadShell("approval-required"))),
      getThreadCheckpointContext: () =>
        Effect.succeed(
          Option.some({
            threadId: THREAD,
            projectId: ProjectId.make("project-1"),
            workspaceRoot: path.join(root, "work"),
            worktreePath: null,
            checkpoints: [],
          }),
        ),
    },
    terminals,
  });
  return async (args: Record<string, unknown>) => {
    const result = await Effect.runPromise(
      tools.callTool(session, AGENT_CONTROL_TERMINAL_MCP_TOOL, args),
    );
    return { body: textOf(result), isError: result.isError === true };
  };
};

// Real shells in real PTYs: POSIX only.
const posix = process.platform !== "win32";

describe.runIf(posix)("ryco_terminal on a real shell", () => {
  let root: string;
  let scope: Scope.Closeable;
  let manager: TerminalManagerShape;
  const state = {
    runtimeMode: "approval-required" as RuntimeMode,
    nextStatus: "pending-user-approval" as AgentControlProposalStatus,
  };
  const proposals = new Map<string, AgentControlProposal>();
  const byRequest = new Map<string, string>();
  const seen: Array<string> = [];

  const makeManager = (integration: boolean, home = "home") =>
    Effect.gen(function* () {
      const ptyAdapter = yield* PtyAdapter;
      return yield* makeTerminalManagerWithOptions({
        logsDir: path.join(root, integration ? `logs-${home}` : "logs-plain"),
        ptyAdapter,
        shellResolver: () => "/bin/bash",
        env: {
          ...process.env,
          HOME: path.join(root, home),
          PS1: "$ ",
          BASH_SILENCE_DEPRECATION_WARNING: "1",
        },
        processKillGraceMs: 0,
        historyPersistDebounceMs: 40,
        ...(integration ? { shellIntegrationDir: path.join(root, "shell-integration") } : {}),
      });
    }).pipe(
      Effect.provide(NodePTY.layer.pipe(Layer.provideMerge(NodeServices.layer))),
      Scope.provide(scope),
    );

  const toolsFor = (terminals: TerminalManagerShape, userActions?: UserActionWaitDeps) => {
    const mutationDeps: Pick<AgentControlMcpToolDeps, "validator" | "proposals"> = {
      validator: {
        validateOwnerAutomation: () => Effect.die("unused"),
        validateExternalSubmission: () => Effect.die("unused"),
        revalidateExecution: () => Effect.void,
        validateSubmission: (input) =>
          Effect.succeed({
            kind: "provider-session",
            threadId: input.session.threadId,
            providerInstanceId: input.session.providerInstanceId,
            runtimeSessionId: input.session.runtimeSessionId,
            turnId: input.authority.turnId,
          }),
      },
      proposals: {
        getProposal: (proposalId) =>
          Effect.sync(() => Option.fromNullishOr(proposals.get(proposalId))),
        submit: (input) =>
          Effect.sync(() => {
            const existing = byRequest.get(input.requestId);
            if (existing !== undefined)
              return { proposal: proposals.get(existing)!, replayed: true };
            const proposal: AgentControlProposal = {
              proposalId: AgentControlProposalId.make(`proposal-${proposals.size + 1}`),
              requestId: input.requestId,
              principal: input.principal,
              planVersion: 1,
              plan: input.plan,
              planDigest: "a".repeat(64),
              riskTags: input.riskTags,
              promptSummary: input.promptSummary,
              status: state.nextStatus,
              createdAt: T0,
              updatedAt: T0,
              expiresAt: input.expiresAt,
              decidedAt: null,
              result: null,
            };
            proposals.set(proposal.proposalId, proposal);
            byRequest.set(input.requestId, proposal.proposalId);
            return { proposal, replayed: false };
          }),
      },
    };
    const tools = withTerminalTools(baseTools, {
      policy,
      registry: { getTurnAuthority: () => Effect.succeed(Option.some(authority)) },
      proposals: mutationDeps.proposals,
      submitMutation: (input) => submitAgentControlMutation(mutationDeps, input),
      projections: {
        getThreadShellById: () => Effect.sync(() => Option.some(threadShell(state.runtimeMode))),
        getThreadCheckpointContext: () =>
          Effect.succeed(
            Option.some({
              threadId: THREAD,
              projectId: ProjectId.make("project-1"),
              workspaceRoot: path.join(root, "work"),
              worktreePath: null,
              checkpoints: [],
            }),
          ),
      },
      terminals,
      ...(userActions === undefined ? {} : { userActions }),
    });
    return async (args: Record<string, unknown>) => {
      const result = await Effect.runPromise(
        tools.callTool(session, AGENT_CONTROL_TERMINAL_MCP_TOOL, args),
      );
      const body = textOf(result);
      seen.push(body);
      return { body, isError: result.isError === true };
    };
  };

  let call: ReturnType<typeof toolsFor>;

  beforeAll(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), "ryco-terminal-tools-"));
    for (const dir of ["home", "work"]) {
      rmSync(path.join(root, dir), { recursive: true, force: true });
      await import("node:fs").then((fs) => fs.mkdirSync(path.join(root, dir), { recursive: true }));
    }
    const work = path.join(root, "work");
    writeFileSync(
      path.join(work, "secret.sh"),
      'read -r -s -p "Password: " pw\necho\necho "length=${#pw}"\n',
    );
    writeFileSync(
      path.join(work, "yesno.sh"),
      'read -r -p "Continue? [y/N] " answer\necho "answer=$answer"\n',
    );
    writeFileSync(
      path.join(work, "device.sh"),
      'echo "! First copy your one-time code: ABCD-1234"\necho "Open https://github.com/login/device to authorize this device"\nread -r -p "Press Enter to open github.com in your browser... " _\necho done\n',
    );
    writeFileSync(
      path.join(work, "long.sh"),
      'for i in $(seq 1 12); do echo "tick $i"; sleep 0.25; done\nexit 3\n',
    );
    scope = await Effect.runPromise(Scope.make());
    manager = await Effect.runPromise(makeManager(true));
    call = toolsFor(manager);
  });

  afterAll(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    rmSync(root, { recursive: true, force: true });
  });

  it("runs a command in a terminal of its own and reports output and exit code", async () => {
    const first = await call({
      action: "run",
      command: "echo hello-terminal",
      timeout_seconds: 15,
    });
    expect(first.isError).toBe(false);
    expect(first.body).toContain("Opened terminal agent-1");
    expect(first.body).toContain("exited with code 0");
    expect(first.body).toContain("hello-terminal");

    const failing = await call({ action: "run", command: "false", timeout_seconds: 15 });
    expect(failing.body).toContain("exited with code 1");
  }, 30_000);

  it("hands a hidden password prompt to the user and never sees the secret", async () => {
    const run = await call({ action: "run", command: "bash secret.sh", timeout_seconds: 15 });
    expect(run.body).toContain("still running");
    expect(run.body).toContain("waiting-for-input, secret");
    expect(run.body).toContain("echo is off");

    const typed = await call({ action: "send", text: "guess", keys: ["Enter"] });
    expect(typed.isError).toBe(true);
    expect(typed.body).toContain("waits for hidden input");

    // The user types it in the drawer.
    await Effect.runPromise(
      manager.write({ threadId: THREAD, terminalId: "agent-1", data: `${SECRET}\r` }),
    );
    const done = await call({ action: "wait", timeout_seconds: 15 });
    expect(done.body).toContain(`length=${SECRET.length}`);
    expect(done.body).toContain("exited with code 0");
    for (const body of seen) expect(body).not.toContain(SECRET);
  }, 40_000);

  it("stops at a y/n prompt and answers it with send", async () => {
    const run = await call({ action: "run", command: "bash yesno.sh", timeout_seconds: 15 });
    expect(run.body).toContain("waiting-for-input");
    expect(run.body).not.toContain("secret");
    expect(run.body).toContain("Continue? [y/N]");

    const answered = await call({ action: "send", text: "y", keys: ["Enter"] });
    expect(answered.body).toContain("answer=y");
  }, 30_000);

  it("recognizes a device-code sign-in and reports its link and code", async () => {
    const run = await call({ action: "run", command: "bash device.sh", timeout_seconds: 15 });
    expect(run.body).toContain("waiting-for-input, sign-in");
    expect(run.body).toContain("code ABCD-1234");
    expect(run.body).toContain("https://github.com/login/device");

    const stopped = await call({ action: "interrupt" });
    expect(stopped.body).toMatch(/Interrupted/);
  }, 30_000);

  it("keeps a long command running past the timeout and reports its end later", async () => {
    const run = await call({ action: "run", command: "bash long.sh", timeout_seconds: 1 });
    expect(run.body).toContain("is still running");
    expect(run.body).toContain(`"action":"wait"`);
    const busy = await call({ action: "run", command: "echo other", terminal: "agent-1" });
    expect(busy.isError).toBe(true);
    expect(busy.body).toContain("busy");

    const done = await call({ action: "wait", timeout_seconds: 15 });
    expect(done.body).toContain("exited with code 3");
    expect(done.body).toContain("tick 12");
  }, 30_000);

  it("cuts long output to max_chars and names the call that reads the rest", async () => {
    const run = await call({
      action: "run",
      command: "seq 1 400",
      timeout_seconds: 15,
      max_chars: 500,
    });
    expect(run.body).toMatch(
      /earlier lines cut\. Read them with ryco_terminal \{"action":"read","terminal":"agent-1","what":"command","from_line":1\}/,
    );
    expect(run.body).toContain("400");
    const page = await call({ action: "read", what: "command", from_line: 1, max_chars: 500 });
    expect(page.body).toMatch(/\n1\n2\n/);
    expect(page.body).toMatch(/more lines\. Continue with/);
  }, 30_000);

  it("asks the user once per task before typing into a terminal they opened", async () => {
    await Effect.runPromise(
      manager.open({ threadId: THREAD, terminalId: "default", cwd: path.join(root, "work") }),
    );
    const read = await call({ action: "read", terminal: "default", what: "screen" });
    expect(read.isError).toBe(false);

    const asked = await call({ action: "run", terminal: "default", command: "echo from-agent" });
    expect(asked.isError).toBe(true);
    expect(asked.body).toContain('"consent":"pending"');
    const proposalId = /"proposalId":"([^"]+)"/.exec(asked.body)![1]!;
    expect(proposals.get(proposalId)?.plan).toMatchObject({
      kind: "terminalControlConsent",
      terminalId: "default",
    });

    proposals.set(proposalId, { ...proposals.get(proposalId)!, status: "completed" });
    const ran = await call({
      action: "run",
      terminal: "default",
      command: "echo from-agent",
      timeout_seconds: 15,
    });
    expect(ran.isError).toBe(false);
    expect(ran.body).toContain("from-agent");

    const closing = await call({ action: "close", terminal: "default" });
    expect(closing.isError).toBe(true);
    expect(closing.body).toContain("only the user closes it");
  }, 30_000);

  describe("handoff", () => {
    const engineRuntime = ManagedRuntime.make(
      OrchestrationEngineLive.pipe(
        Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(ThreadBackgroundLiveness.layer),
        Layer.provideMerge(OrchestrationProjectionPipelineLive),
        Layer.provide(
          Layer.succeed(ProjectAvatarStore, {
            write: () => Effect.die("unused"),
            read: () => Effect.succeed(null),
            remove: () => Effect.void,
          }),
        ),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provide(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolverLive),
        Layer.provideMerge(SqlitePersistenceMemory),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "ryco-terminal-handoff-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    let userActions: UserActionWaitDeps;
    let handoffCall: ReturnType<typeof toolsFor>;
    const runEngine = <A, E>(effect: Effect.Effect<A, E, OrchestrationEngineService>) =>
      engineRuntime.runPromise(effect);

    beforeAll(async () => {
      const engine = await runEngine(Effect.service(OrchestrationEngineService));
      const createdAt = new Date().toISOString();
      await runEngine(
        engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-project-handoff"),
          projectId: ProjectId.make("project-1"),
          title: "Hand-offs",
          workspaceRoot: path.join(root, "work"),
          defaultModelSelection: null,
          createdAt,
        }),
      );
      await runEngine(
        engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-handoff"),
          threadId: THREAD,
          projectId: ProjectId.make("project-1"),
          title: "Hand-offs",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      );
      userActions = { engine, findThreadInArray, waitUntil, threadWakeSource };
      handoffCall = toolsFor(manager, userActions);
    });
    afterAll(() => engineRuntime.dispose());

    const answer = (callerRequestId: string, value: "done" | "declined") =>
      runEngine(
        answerUserActionRequest(userActions, {
          threadId: THREAD,
          requestId: userActionRequestIdFor(THREAD, callerRequestId),
          answer: value,
        }),
      );

    it("refuses a blank message before starting anything", async () => {
      const refused = await handoffCall({
        action: "handoff",
        requestId: "blank",
        message: "   ",
        command: "echo should-not-run",
      });
      expect(refused.isError).toBe(true);
      expect(refused.body).toContain("Nothing was started");
      const requests = await runEngine(readThreadUserActionRequests(userActions, THREAD));
      expect(requests?.some((r) => r.requestId === userActionRequestIdFor(THREAD, "blank"))).toBe(
        false,
      );
      for (const body of seen) expect(body).not.toContain("should-not-run\n");
    });

    it("hands a password prompt to the user, refuses input meanwhile and ends with the command", async () => {
      const opened = await handoffCall({
        action: "handoff",
        requestId: "pw",
        message: "Enter the test password.",
        command: "bash secret.sh",
        timeout_seconds: 2,
      });
      expect(opened.isError).toBe(false);
      expect(opened.body).toContain("The user has agent-");
      const terminalId = /The user has (agent-\d+)/.exec(opened.body)![1]!;

      const typed = await handoffCall({ action: "send", terminal: terminalId, text: "x" });
      expect(typed.isError).toBe(true);
      expect(typed.body).toContain("is with the user");
      const ran = await handoffCall({ action: "run", terminal: terminalId, command: "echo hi" });
      expect(ran.isError).toBe(true);
      // Nor may it close the shell the user is typing a password into.
      const closed = await handoffCall({ action: "close", terminal: terminalId });
      expect(closed.isError).toBe(true);
      expect(closed.body).toContain("is with the user");
      // And when the hand-off record cannot be read, nothing is typed (fails closed).
      const blind = toolsFor(manager, {
        ...userActions,
        engine: {
          ...userActions.engine,
          getReadModel: () => Effect.die("read model unavailable"),
        },
      });
      const unreadable = await blind({ action: "send", terminal: terminalId, keys: ["Escape"] });
      expect(unreadable.isError).toBe(true);

      await Effect.runPromise(manager.write({ threadId: THREAD, terminalId, data: `${SECRET}\r` }));
      const ended = await handoffCall({ action: "handoff", requestId: "pw", timeout_seconds: 15 });
      expect(ended.body).toContain("exited with code 0");
      expect(ended.body).toContain("with the user at the terminal");
      expect(ended.body).toContain(`length=${SECRET.length}`);
      for (const body of seen) expect(body).not.toContain(SECRET);
    }, 40_000);

    it("shows a device code on the card and steers the agent after Won't do", async () => {
      const opened = await handoffCall({
        action: "handoff",
        requestId: "login",
        message: "Sign in to GitHub in your browser.",
        need: "sign-in",
        command: "bash device.sh",
        timeout_seconds: 3,
      });
      expect(opened.body).toContain("has not finished");
      const projections = await engineRuntime.runPromise(Effect.service(ProjectionSnapshotQuery));
      const thread = Option.getOrThrow(
        await engineRuntime.runPromise(projections.getThreadDetailById(THREAD)),
      );
      const hint = userActionRequestHints(thread.activities).get(
        userActionRequestIdFor(THREAD, "login"),
      );
      expect(hint?.codes).toContain("ABCD-1234");
      expect(hint?.links).toContainEqual({
        url: "https://github.com/login/device",
        host: "github.com",
        international: false,
      });
      const requests = await runEngine(readThreadUserActionRequests(userActions, THREAD));
      expect(
        requests?.find((r) => r.requestId === userActionRequestIdFor(THREAD, "login"))?.need,
      ).toBe("sign-in");

      await answer("login", "declined");
      const ended = await handoffCall({
        action: "handoff",
        requestId: "login",
        timeout_seconds: 5,
      });
      expect(ended.body).toContain("Do not ask again");
      expect(ended.body).toContain("is still running");
      const stopped = await handoffCall({ action: "interrupt" });
      expect(stopped.isError).toBe(false);

      // The next hand-off in that terminal starts clean: the earlier code on screen is not its own.
      const next = await handoffCall({
        action: "handoff",
        requestId: "pw-after-login",
        message: "Enter the test password.",
        command: "bash secret.sh",
        timeout_seconds: 3,
      });
      expect(next.body).toContain("has not finished");
      const later = Option.getOrThrow(
        await engineRuntime.runPromise(projections.getThreadDetailById(THREAD)),
      );
      expect(
        userActionRequestHints(later.activities).get(
          userActionRequestIdFor(THREAD, "pw-after-login"),
        ),
      ).toBeUndefined();
      await handoffCall({ action: "handoff", requestId: "pw-after-login", cancel: true });
      // The cancelled hand-off's script still waits for its password: stop it for later tests.
      const stoppedScript = await handoffCall({ action: "interrupt" });
      expect(stoppedScript.isError).toBe(false);
    }, 40_000);
  });

  it("guesses command ends in a shell without marks, without an exit code", async () => {
    const plain = await Effect.runPromise(makeManager(false));
    const plainCall = toolsFor(plain);
    const result = await plainCall({
      action: "run",
      command: "echo plain-shell",
      timeout_seconds: 15,
    });
    expect(result.body).toContain("plain-shell");
    expect(result.body).toContain("exit code unknown");

    // A sudo-style prompt the user started: no marks, the process poll has not seen it yet, the
    // screen rule waits for quiet. The tty's echo flag still refuses the agent's typing.
    const prompted = outputShows(plain, "agent-1", "Password:");
    await Effect.runPromise(
      plain.write({ threadId: THREAD, terminalId: "agent-1", data: "bash secret.sh\r" }),
    );
    await prompted;
    const typed = await plainCall({ action: "send", text: "guess", keys: ["Enter"] });
    expect(typed.isError).toBe(true);
    expect(typed.body).toContain("waits for hidden input");
    await Effect.runPromise(
      plain.write({ threadId: THREAD, terminalId: "agent-1", data: "\u0003" }),
    );
  }, 30_000);

  it("does not take a mark printed by the command for the command's end", async () => {
    // A sign-in link and code an earlier command left on screen are not this command's: its
    // quiet second must not read as "waits for a sign-in".
    await call({
      action: "run",
      command: "echo 'Open https://github.com/login/device and enter the one-time code WXYZ-1234'",
      timeout_seconds: 15,
    });
    // What a cat'ed file, a test or a remote host could print: Ryco's own marks look the same
    // apart from this session's nonce.
    const result = await call({
      action: "run",
      command: "printf '\\033]133;D;0\\007\\033]133;C\\007'; sleep 1.5; echo real-end; false",
      timeout_seconds: 15,
    });
    expect(result.body).toContain("real-end");
    expect(result.body).toContain("exited with code 1");
  }, 30_000);

  it("never stores the marks' nonce in the terminal's history files", async () => {
    const dir = path.join(root, "logs-home");
    const { readdirSync, readFileSync } = await import("node:fs");
    const logs = readdirSync(dir).map((file) => readFileSync(path.join(dir, file), "utf8"));
    expect(logs.length).toBeGreaterThan(0);
    for (const log of logs) expect(log).not.toContain("ryco=");
    const history = Option.getOrThrow(
      await Effect.runPromise(manager.inspect!({ threadId: THREAD, terminalId: "agent-1" })),
    ).snapshot.history;
    expect(history).toContain("real-end");
    expect(history).not.toContain("ryco=");
  }, 30_000);

  it("does not add the agent's command to a line the user is typing", async () => {
    const created = await call({ action: "create" });
    const terminalId = /Opened (agent-\d+)/.exec(created.body)![1]!;
    await Effect.runPromise(
      manager.write({ threadId: THREAD, terminalId, data: "echo half-typed | tr a-z A-Z" }),
    );
    const refused = await call({ action: "run", terminal: terminalId, command: "echo agent" });
    expect(refused.isError).toBe(true);
    expect(refused.body).toContain("someone typed at");
    // The user runs their line; then the prompt is free again. (What only the command prints:
    // bash 5 writes escapes between the echoed line and the output.)
    const ranTheirs = outputShows(manager, terminalId, "HALF-TYPED");
    await Effect.runPromise(manager.write({ threadId: THREAD, terminalId, data: "\r" }));
    await ranTheirs;
    const ran = await call({
      action: "run",
      terminal: terminalId,
      command: "echo agent-after",
      timeout_seconds: 15,
    });
    expect(ran.isError).toBe(false);
    expect(ran.body).toContain("agent-after");
  }, 30_000);

  it("never types into a hidden-input builtin, also after its mirror was rebuilt", async () => {
    const created = await call({ action: "create" });
    const terminalId = /Opened (agent-\d+)/.exec(created.body)![1]!;
    const prompted = outputShows(manager, terminalId, "secretvar");
    await Effect.runPromise(
      manager.write({ threadId: THREAD, terminalId, data: "read -r -s secretvar\r" }),
    );
    await prompted;
    // A fresh tool runtime builds its mirror from the history: no subprocess, no open region.
    const rebuilt = toolsFor(manager);
    const sent = await rebuilt({
      action: "send",
      terminal: terminalId,
      text: "guess",
      keys: ["Enter"],
    });
    expect(sent.isError).toBe(true);
    expect(sent.body).toMatch(/hidden input|someone typed/);
    const ran = await rebuilt({ action: "run", terminal: terminalId, command: "echo nope" });
    expect(ran.isError).toBe(true);
    await Effect.runPromise(manager.write({ threadId: THREAD, terminalId, data: "x\r" }));
  }, 30_000);
});

describe.runIf(posix)("ryco_terminal while a shell's startup files wait for input", () => {
  it("does not type into a passphrase prompt from the user's startup files", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ryco-terminal-startup-"));
    const scope = await Effect.runPromise(Scope.make());
    try {
      const { mkdirSync } = await import("node:fs");
      mkdirSync(path.join(root, "home"));
      mkdirSync(path.join(root, "work"));
      writeFileSync(
        path.join(root, "home", ".bashrc"),
        'read -r -s -p "Enter passphrase for key: " startup_pass\necho\n',
      );
      const startupManager = await Effect.runPromise(
        Effect.gen(function* () {
          const ptyAdapter = yield* PtyAdapter;
          return yield* makeTerminalManagerWithOptions({
            logsDir: path.join(root, "logs"),
            ptyAdapter,
            shellResolver: () => "/bin/bash",
            env: {
              ...process.env,
              HOME: path.join(root, "home"),
              PS1: "$ ",
              BASH_SILENCE_DEPRECATION_WARNING: "1",
            },
            processKillGraceMs: 0,
            historyPersistDebounceMs: 40,
            shellIntegrationDir: path.join(root, "shell-integration"),
          });
        }).pipe(
          Effect.provide(NodePTY.layer.pipe(Layer.provideMerge(NodeServices.layer))),
          Scope.provide(scope),
        ),
      );
      const startupCall = toolsForRoot(startupManager, root);
      const refused = await startupCall({ action: "run", command: "echo should-not-run" });
      expect(refused.isError).toBe(true);
      expect(refused.body).toMatch(/has not drawn its prompt|hidden input/);
      await Effect.runPromise(
        startupManager.write({ threadId: THREAD, terminalId: "agent-1", data: "pass\r" }),
      );
      const ran = await startupCall({
        action: "run",
        command: "echo now-it-runs",
        timeout_seconds: 15,
      });
      expect(ran.body).toContain("now-it-runs");
      expect(ran.body).not.toContain("should-not-run");
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
