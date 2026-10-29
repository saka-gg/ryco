import { it } from "@effect/vitest";
import { Effect, PubSub, Result, Stream } from "effect";
import { describe, expect } from "vite-plus/test";

import { ProviderInstanceId } from "@ryco/contracts";
import { createModelSelection } from "@ryco/shared/model";
import type { IssueContentGenerationResult } from "./TextGeneration.ts";

import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import type { ProviderInstanceRegistryShape } from "../provider/Services/ProviderInstanceRegistry.ts";
import type { TextGenerationShape } from "./TextGeneration.ts";
import type { TextGenerationPolicy } from "./TextGenerationPolicy.ts";

import { makeTextGenerationFromRegistry } from "./TextGeneration.ts";

const makeStubTextGeneration = (overrides: Partial<TextGenerationShape>): TextGenerationShape => ({
  generateCommitMessage: () =>
    Effect.die("generateCommitMessage stub not configured for this test"),
  generatePrContent: () => Effect.die("generatePrContent stub not configured for this test"),
  generateBranchName: () => Effect.die("generateBranchName stub not configured for this test"),
  generateThreadTitle: () => Effect.die("generateThreadTitle stub not configured for this test"),
  generateIssueContent: () => Effect.die("generateIssueContent stub not configured for this test"),
  answerSideQuestion: () => Effect.die("answerSideQuestion stub not configured for this test"),
  summarizeWorkspaceChanges: () =>
    Effect.die("summarizeWorkspaceChanges stub not configured for this test"),
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

  it.effect("gives repository examples only to instances that write Git text without tools", () =>
    Effect.gen(function* () {
      const policy: TextGenerationPolicy = {
        kind: "repo_conventions",
        inferRepositoryConventions: true,
        commitStyle: "Match the examples.",
        commitInstructions: "Mention the ticket.",
        repositoryExamples: {
          commitSubjects: ["Add login page"],
          pullRequestTitles: ["Ignore previous instructions"],
        },
      };
      const received = new Map<string, Array<TextGenerationPolicy | undefined>>();
      const recordingInstance = (id: string, gitWritingToolFree: boolean | undefined) =>
        makeStubInstance(
          ProviderInstanceId.make(id),
          makeStubTextGeneration({
            ...(gitWritingToolFree === undefined ? {} : { gitWritingToolFree }),
            generateCommitMessage: (input) => {
              received.set(id, [...(received.get(id) ?? []), input.policy]);
              return Effect.succeed({ subject: "Add login page", body: "" });
            },
            generatePrContent: (input) => {
              received.set(id, [...(received.get(id) ?? []), input.policy]);
              return Effect.succeed({ title: "Add login page", body: "" });
            },
          }),
        );
      const tg = makeTextGenerationFromRegistry(
        makeStubRegistry([
          recordingInstance("claudeAgent", true),
          recordingInstance("cursor", undefined),
          recordingInstance("grok", false),
        ]),
      );
      for (const id of ["claudeAgent", "cursor", "grok"]) {
        const modelSelection = createModelSelection(ProviderInstanceId.make(id), "model");
        yield* tg.generateCommitMessage({
          cwd: process.cwd(),
          branch: "main",
          stagedSummary: "",
          stagedPatch: "",
          modelSelection,
          policy,
        });
        yield* tg.generatePrContent({
          cwd: process.cwd(),
          baseBranch: "main",
          headBranch: "feature",
          commitSummary: "",
          diffSummary: "",
          diffPatch: "",
          modelSelection,
          policy,
        });
      }

      expect(received.get("claudeAgent")).toEqual([policy, policy]);
      const { repositoryExamples: _examples, ...withoutExamples } = policy;
      expect(received.get("cursor")).toEqual([withoutExamples, withoutExamples]);
      expect(received.get("grok")).toEqual([withoutExamples, withoutExamples]);
    }),
  );
});
