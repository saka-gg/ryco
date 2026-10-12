/**
 * Claude forks end to end: the real cutoff pinning, Claude SDK fork and read-back against a
 * fixture transcript, while the source keeps running.
 */
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  ThreadId,
} from "@ryco/contracts";
import { Effect, Option } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { readClaudeMainChain } from "../../imports/claudeNativeFork.ts";
import { pinClaudeForkCutoff, resolveNativeForkStore } from "../nativeFork.ts";
import {
  createForkHarness,
  FORK_TEST_PROVIDER_INSTANCES,
  type ForkHarness,
  type ForkHarnessOptions,
  seedCompletedTurn,
  seedNativeBinding,
  seedProject,
  seedThread,
} from "../threadFork.fixtures.ts";

const roots: string[] = [];
const harnesses: ForkHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const projectId = ProjectId.make("fork-claude-project");
const sourceId = ThreadId.make("fork-claude-source");
const sessionId = "11111111-1111-4111-8111-111111111111";
const prompt = (turn: number) => `2222222${turn}-2222-4222-8222-222222222222`;
const answer = (turn: number) => `3333333${turn}-3333-4333-8333-333333333333`;

/** A Claude instance whose config root is a temporary directory, and its source transcript. */
async function claudeSetup() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "ryco-fork-claude-")));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const configDir = path.join(root, "claude-config");
  await mkdir(configDir);
  const instance: ProviderInstanceConfig = {
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    config: { homePath: path.join(root, "home") },
    environment: [{ name: "CLAUDE_CONFIG_DIR", value: configDir, sensitive: false }],
  };
  const { root: claudeRoot } = await Effect.runPromise(
    resolveNativeForkStore("claudeAgent", instance).pipe(Effect.provide(NodeServices.layer)),
  );
  expect(claudeRoot).toBe(configDir);
  const projectDir = path.join(claudeRoot, "projects", workspace.replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(projectDir, { recursive: true });
  const sourceFile = path.join(projectDir, `${sessionId}.jsonl`);
  let parent: string | null = null;
  const turnLines = (turn: number, complete = true) => {
    const rows = [
      {
        type: "user",
        uuid: prompt(turn),
        parentUuid: parent,
        sessionId,
        cwd: workspace,
        timestamp: `2026-01-01T00:0${turn * 2}:00Z`,
        message: { role: "user", content: `Question ${turn}` },
      },
      ...(complete
        ? [
            {
              type: "assistant",
              uuid: answer(turn),
              parentUuid: prompt(turn),
              sessionId,
              cwd: workspace,
              timestamp: `2026-01-01T00:0${turn * 2 + 1}:00Z`,
              message: {
                role: "assistant",
                content: [{ type: "text", text: `Answer ${turn}` }],
                stop_reason: "end_turn",
              },
            },
          ]
        : []),
    ];
    parent = complete ? answer(turn) : prompt(turn);
    return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  };
  await writeFile(sourceFile, turnLines(1) + turnLines(2));
  return {
    root,
    workspace,
    claudeRoot,
    sourceFile,
    instance,
    /** The source runs another turn: Claude appends it to the same transcript. */
    appendTurn: (turn: number, complete = true) =>
      appendFile(sourceFile, turnLines(turn, complete)),
  };
}

async function harness(
  setup: Awaited<ReturnType<typeof claudeSetup>>,
  options: ForkHarnessOptions = {},
) {
  const created = await createForkHarness({
    ...options,
    settings: {
      providerInstances: { ...FORK_TEST_PROVIDER_INSTANCES, claude: setup.instance },
      ...options.settings,
    } as NonNullable<ForkHarnessOptions["settings"]>,
  });
  harnesses.push(created);
  return created;
}

async function seedClaudeSource(h: ForkHarness, workspace: string) {
  await seedProject(h, { projectId, workspaceRoot: workspace });
  await seedThread(h, { threadId: sourceId, projectId, instance: "claude" });
  for (const turn of [1, 2]) {
    await seedCompletedTurn(h, {
      threadId: sourceId,
      index: turn,
      instance: "claude",
      turnId: prompt(turn),
    });
  }
  await seedNativeBinding(h, {
    threadId: sourceId,
    instance: "claude",
    cwd: workspace,
    nativeId: sessionId,
  });
}

describe("ThreadFork with Claude", () => {
  for (const complete of [true, false]) {
    it(
      `copies the newest turn's session only through the entry pinned at acceptance while the source runs on (${complete ? "a whole later turn" : "a later prompt"})`,
      { timeout: 90_000 },
      async () => {
        const setup = await claudeSetup();
        let runOn: () => Promise<void> = async () => {};
        const h = await harness(setup, {
          service: {
            onRunPoint: (point) =>
              point === "accepted" ? Effect.promise(() => runOn()) : Effect.void,
          },
        });
        await seedClaudeSource(h, setup.workspace);
        // Once the fork is accepted, the user keeps chatting in the original.
        runOn = async () => {
          await setup.appendTurn(3, complete);
          if (complete) {
            await seedCompletedTurn(h, {
              threadId: sourceId,
              index: 3,
              instance: "claude",
              turnId: prompt(3),
            });
          }
        };

        const result = await h.run(
          h.forks.fork({
            forkKey: "fork-key-claude-newest-01",
            sourceThreadId: sourceId,
            sourceMessageId: MessageId.make(`${sourceId}-reply-2`),
            destination: { kind: "current-checkout" },
          }),
        );

        expect(result.providerContext).toBe("native");
        const binding = Option.getOrThrow(await h.run(h.directory.getBinding(result.threadId)));
        const cursor = binding.resumeCursor as { resume: string; turnCount: number };
        expect(cursor.resume).not.toBe(sessionId);
        expect(cursor.turnCount).toBe(2);
        const copy = await readClaudeMainChain({
          root: setup.claudeRoot,
          sessionId: cursor.resume,
          cwd: setup.workspace,
        });
        if (!copy.found) throw new Error("expected the fork's Claude copy");
        // The copy ends with turn 2, exactly where the fork's visible history ends.
        expect(copy.chain.map((entry) => entry.type)).toEqual([
          "user",
          "assistant",
          "user",
          "assistant",
        ]);
        const copied = await readFile(copy.file, "utf8");
        expect(copied).toContain("Answer 2");
        expect(copied).not.toContain("Question 3");
        expect(copied).not.toContain("Answer 3");
        const ledger = Option.getOrThrow(
          await h.run(h.ledger.getByKey({ forkKey: "fork-key-claude-newest-01" })),
        );
        expect(ledger.plan.provider).toMatchObject({
          kind: "native",
          driver: "claudeAgent",
          cutoff: { entryUuid: answer(2), entryIndex: 3 },
        });
      },
    );
  }

  it(
    "hands off a newest-turn fork while a later prompt is queued, without forking",
    { timeout: 90_000 },
    async () => {
      const setup = await claudeSetup();
      const forks: unknown[] = [];
      const h = await harness(setup, {
        service: {
          native: {
            fork: (request) =>
              Effect.sync(() => {
                forks.push(request);
                return { kind: "refused", detail: "unexpected" } as const;
              }),
          },
        },
      });
      await seedClaudeSource(h, setup.workspace);
      // A follow-up was sent: its turn has no id yet, so its prompt may already be in the
      // transcript without Ryco being able to tell it apart from turn 2's entries.
      await h.run(
        h.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("claude-source-queued"),
          threadId: sourceId,
          message: {
            messageId: MessageId.make("claude-source-queued-prompt"),
            role: "user",
            text: "Follow-up",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: new Date().toISOString(),
        }),
      );
      await setup.appendTurn(3, false);

      const result = await h.run(
        h.forks.fork({
          forkKey: "fork-key-claude-queued-01",
          sourceThreadId: sourceId,
          sourceMessageId: MessageId.make(`${sourceId}-reply-2`),
          destination: { kind: "current-checkout" },
        }),
      );
      expect(result.providerContext).toBe("handoff");
      expect(forks).toEqual([]);
      const ledger = Option.getOrThrow(
        await h.run(h.ledger.getByKey({ forkKey: "fork-key-claude-queued-01" })),
      );
      expect(ledger.plan.provider).toEqual({
        kind: "handoff",
        reason: "turn-not-in-native-session",
      });
    },
  );

  it(
    "hands off when a turn starts while the transcript is read at acceptance",
    { timeout: 90_000 },
    async () => {
      const setup = await claudeSetup();
      let startTurn: () => Promise<void> = async () => {};
      const h = await harness(setup, {
        service: {
          native: {
            // The real read, then the source's next turn lands before acceptance re-checks.
            pinClaudeCutoff: (request) =>
              Effect.gen(function* () {
                const pin = yield* pinClaudeForkCutoff({
                  root: setup.claudeRoot,
                  environment: process.env,
                  sourceSessionId: request.plan.sourceNativeId,
                  recordedCwd: request.plan.recordedCwd,
                  turnId: request.plan.turnId,
                  laterTurnIds: request.laterTurnIds,
                });
                yield* Effect.promise(() => startTurn());
                return pin;
              }),
          },
        },
      });
      await seedClaudeSource(h, setup.workspace);
      startTurn = () =>
        h
          .run(
            h.engine.dispatch({
              type: "thread.turn.start",
              commandId: CommandId.make("claude-source-racing"),
              threadId: sourceId,
              message: {
                messageId: MessageId.make("claude-source-racing-prompt"),
                role: "user",
                text: "Racing follow-up",
                attachments: [],
              },
              runtimeMode: "full-access",
              interactionMode: "default",
              createdAt: new Date().toISOString(),
            }),
          )
          .then(() => undefined);

      const result = await h.run(
        h.forks.fork({
          forkKey: "fork-key-claude-racing-01",
          sourceThreadId: sourceId,
          sourceMessageId: MessageId.make(`${sourceId}-reply-2`),
          destination: { kind: "current-checkout" },
        }),
      );
      expect(result.providerContext).toBe("handoff");
      const ledger = Option.getOrThrow(
        await h.run(h.ledger.getByKey({ forkKey: "fork-key-claude-racing-01" })),
      );
      expect(ledger.plan.provider).toEqual({
        kind: "handoff",
        reason: "turn-not-in-native-session",
      });
    },
  );
});
