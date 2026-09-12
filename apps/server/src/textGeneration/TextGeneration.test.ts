import { it } from "@effect/vitest";
import { Effect, PubSub, Result, Stream } from "effect";
import { describe, expect } from "vite-plus/test";

import { ProviderInstanceId } from "@ryco/contracts";
import { createModelSelection } from "@ryco/shared/model";
import type { IssueContentGenerationResult, RankInboxThreadsInput } from "./TextGeneration.ts";

import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import type { ProviderInstanceRegistryShape } from "../provider/Services/ProviderInstanceRegistry.ts";
import type { TextGenerationShape } from "./TextGeneration.ts";

import { makeTextGenerationFromRegistry } from "./TextGeneration.ts";

const makeStubTextGeneration = (overrides: Partial<TextGenerationShape>): TextGenerationShape => ({
  generateCommitMessage: () =>
    Effect.die("generateCommitMessage stub not configured for this test"),
  generatePrContent: () => Effect.die("generatePrContent stub not configured for this test"),
  generateBranchName: () => Effect.die("generateBranchName stub not configured for this test"),
  generateThreadTitle: () => Effect.die("generateThreadTitle stub not configured for this test"),
  generateIssueContent: () => Effect.die("generateIssueContent stub not configured for this test"),
  rankInboxThreads: () => Effect.die("rankInboxThreads stub not configured for this test"),
  answerSideQuestion: () => Effect.die("answerSideQuestion stub not configured for this test"),
  ...overrides,
});

const makeStubInstance = (
  instanceId: ProviderInstanceId,
  textGeneration: TextGenerationShape,
): ProviderInstance =>
  ({
    instanceId,
    driverKind: instanceId as unknown as ProviderInstance["driverKind"],
    continuationIdentity: {
      driverKind: instanceId as unknown as ProviderInstance["driverKind"],
      continuationKey: `${instanceId}:test`,
    },
    displayName: undefined,
    enabled: true,
    snapshot: {} as ProviderInstance["snapshot"],
    adapter: {} as ProviderInstance["adapter"],
    textGeneration,
  }) satisfies ProviderInstance;

const makeStubRegistry = (
  instances: ReadonlyArray<ProviderInstance>,
): ProviderInstanceRegistryShape => {
  const byId = new Map(instances.map((instance) => [instance.instanceId, instance] as const));
  return {
    getInstance: (id) => Effect.succeed(byId.get(id)),
    listInstances: Effect.succeed(instances),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    // Tests never drive changes through this stub; acquire a throwaway
    // subscription on an unused PubSub so the shape is satisfied.
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
      PubSub.subscribe(pubsub),
    ),
  };
};

describe("makeTextGenerationFromRegistry", () => {
  it.effect("routes inbox ranking to the selected provider instance without fallback", () =>
    Effect.gen(function* () {
      const selectedId = ProviderInstanceId.make("claude_work");
      const calls: RankInboxThreadsInput["modelSelection"][] = [];
      const selected = makeStubInstance(
        selectedId,
        makeStubTextGeneration({
          rankInboxThreads: (input) => {
            calls.push(input.modelSelection);
            return Effect.succeed({ rankings: [] });
          },
        }),
      );
      const other = makeStubInstance(
        ProviderInstanceId.make("codex"),
        makeStubTextGeneration({
          rankInboxThreads: () => Effect.die("must not fall back"),
        }),
      );
      const tg = makeTextGenerationFromRegistry(makeStubRegistry([selected, other]));
      const result = yield* tg.rankInboxThreads({
        cwd: process.cwd(),
        chunk: {
          candidates: [],
          threadIdsByCandidateId: new Map(),
          serializedCandidates: '{"candidates":[]}',
          prompt: "rank",
        },
        modelSelection: createModelSelection(selectedId, "claude-sonnet", [
          { id: "effort", value: "high" },
        ]),
      });
      expect(result.rankings).toEqual([]);
      expect(calls).toEqual([
        createModelSelection(selectedId, "claude-sonnet", [{ id: "effort", value: "high" }]),
      ]);
    }),
  );

  it.effect("fails inbox ranking when the selected provider instance is unavailable", () =>
    Effect.gen(function* () {
      const tg = makeTextGenerationFromRegistry(makeStubRegistry([]));
      const result = yield* tg
        .rankInboxThreads({
          cwd: process.cwd(),
          chunk: {
            candidates: [],
            threadIdsByCandidateId: new Map(),
            serializedCandidates: '{"candidates":[]}',
            prompt: "rank",
          },
          modelSelection: createModelSelection(
            ProviderInstanceId.make("missing_instance"),
            "gpt-5",
          ),
        })
        .pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure.operation).toBe("rankInboxThreads");
        expect(result.failure.detail).toContain("missing_instance");
      }
    }),
  );

  it.effect("delegates to the matching instance's textGeneration closure", () =>
    Effect.gen(function* () {
      const personalId = ProviderInstanceId.make("codex_personal");
      const personalCalls: string[] = [];
      const personal = makeStubInstance(
        personalId,
        makeStubTextGeneration({
          generateBranchName: (input) => {
            personalCalls.push(input.message);
            return Effect.succeed({ branch: "personal-branch" });
          },
        }),
      );

      const workId = ProviderInstanceId.make("codex_work");
      const work = makeStubInstance(
        workId,
        makeStubTextGeneration({
          generateBranchName: () => Effect.succeed({ branch: "work-branch" }),
        }),
      );

      const tg = makeTextGenerationFromRegistry(makeStubRegistry([personal, work]));

      const result = yield* tg.generateBranchName({
        cwd: process.cwd(),
        message: "Refactor the routing layer",
        modelSelection: createModelSelection(ProviderInstanceId.make("codex_personal"), "gpt-5"),
      });

      expect(result.branch).toBe("personal-branch");
      expect(personalCalls).toEqual(["Refactor the routing layer"]);
    }),
  );

  it.effect("fails with TextGenerationError when the instance is unknown", () =>
    Effect.gen(function* () {
      const tg = makeTextGenerationFromRegistry(makeStubRegistry([]));

      const result = yield* tg
        .generateBranchName({
          cwd: process.cwd(),
          message: "anything",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("missing_instance"),
            "gpt-5",
          ),
        })
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("TextGenerationError");
        expect(result.failure.operation).toBe("generateBranchName");
        expect(result.failure.detail).toContain("missing_instance");
      }
    }),
  );

  it.effect(
    "generateIssueContent: delegates to the matching instance's textGeneration closure",
    () =>
      Effect.gen(function* () {
        const personalId = ProviderInstanceId.make("codex_personal");
        const personalCalls: string[] = [];
        const polishResult: IssueContentGenerationResult = {
          title: "Polish: Implement stacked git actions",
          body: "Polished body content",
        };
        const personal = makeStubInstance(
          personalId,
          makeStubTextGeneration({
            generateIssueContent: (input) => {
              personalCalls.push(input.mode);
              return Effect.succeed(polishResult);
            },
          }),
        );

        const workId = ProviderInstanceId.make("codex_work");
        const work = makeStubInstance(
          workId,
          makeStubTextGeneration({
            generateIssueContent: () => Effect.succeed({ title: "work title" }),
          }),
        );

        const tg = makeTextGenerationFromRegistry(makeStubRegistry([personal, work]));

        const result = yield* tg.generateIssueContent({
          cwd: process.cwd(),
          mode: "polish",
          rough: "Implement stacked git actions",
          modelSelection: createModelSelection(ProviderInstanceId.make("codex_personal"), "gpt-5"),
        });

        expect(result.title).toBe(polishResult.title);
        expect(result.body).toBe(polishResult.body);
        expect(personalCalls).toEqual(["polish"]);
      }),
  );

  it.effect("generateIssueContent: title mode returns only title from provider", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex_personal");
      const titleResult: IssueContentGenerationResult = { title: "Generated Title" };
      const instance = makeStubInstance(
        instanceId,
        makeStubTextGeneration({
          generateIssueContent: (input) => {
            if (input.mode === "title") {
              return Effect.succeed(titleResult);
            }
            return Effect.succeed({ title: "unexpected", body: "unexpected" });
          },
        }),
      );

      const tg = makeTextGenerationFromRegistry(makeStubRegistry([instance]));

      const result = yield* tg.generateIssueContent({
        cwd: process.cwd(),
        mode: "title",
        body: "old title",
        modelSelection: createModelSelection(instanceId, "gpt-5"),
      });

      expect(result.title).toBe("Generated Title");
      expect(result.body).toBeUndefined();
    }),
  );

  it.effect(
    "generateIssueContent: fails with TextGenerationError when the instance is unknown",
    () =>
      Effect.gen(function* () {
        const tg = makeTextGenerationFromRegistry(makeStubRegistry([]));

        const result = yield* tg
          .generateIssueContent({
            cwd: process.cwd(),
            mode: "polish",
            rough: "rough issue notes",
            modelSelection: createModelSelection(
              ProviderInstanceId.make("missing_instance"),
              "gpt-5",
            ),
          })
          .pipe(Effect.result);

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("TextGenerationError");
          expect(result.failure.operation).toBe("generateIssueContent");
          expect(result.failure.detail).toContain("missing_instance");
        }
      }),
  );
});
