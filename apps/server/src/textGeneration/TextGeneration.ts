import { Context, Effect, Layer } from "effect";
import type { ChatAttachment, ModelSelection, ProviderInstanceId } from "@ryco/contracts";
import { TextGenerationError } from "@ryco/contracts";

import {
  ProviderInstanceRegistry,
  type ProviderInstanceRegistryShape,
} from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import {
  ThreadPriorityPolicyError,
  validateThreadPriorityRankings,
  type ThreadPriorityPromptChunk,
  type ValidatedThreadPriorityRanking,
} from "../threadPriority/threadPriorityPolicy.ts";

export type TextGenerationProvider = "codex" | "claudeAgent" | "cursor" | "grok" | "opencode";

export interface SideQuestionInput {
  cwd: string;
  context: string;
  question: string;
  history: ReadonlyArray<{ question: string; answer: string }>;
  modelSelection: ModelSelection;
}

export interface SideQuestionResult {
  answer: string;
}

export interface CommitMessageGenerationInput {
  cwd: string;
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  /** When true, the model also returns a semantic branch name for the change. */
  includeBranch?: boolean;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface CommitMessageGenerationResult {
  subject: string;
  body: string;
  /** Only present when `includeBranch` was set on the input. */
  branch?: string | undefined;
}

export interface PrContentGenerationInput {
  cwd: string;
  baseBranch: string;
  headBranch: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface PrContentGenerationResult {
  title: string;
  body: string;
}

export interface BranchNameGenerationInput {
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface BranchNameGenerationResult {
  branch: string;
}

export interface ThreadTitleGenerationInput {
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface ThreadTitleGenerationResult {
  title: string;
}

interface IssueContentGenerationInputBase {
  cwd: string;
  modelSelection: ModelSelection;
}

export type IssueContentGenerationInput =
  | (IssueContentGenerationInputBase & {
      mode: "polish";
      rough: string;
      currentTitle?: string;
      customInstructions?: string;
    })
  | (IssueContentGenerationInputBase & {
      mode: "title";
      body: string;
    });

export interface IssueContentGenerationResult {
  title: string;
  body?: string;
}

export interface RankInboxThreadsInput {
  cwd: string;
  chunk: ThreadPriorityPromptChunk;
  modelSelection: ModelSelection;
}

export interface RankInboxThreadsResult {
  rankings: ReadonlyArray<ValidatedThreadPriorityRanking>;
}

export function validateRankInboxThreadsResult(
  input: RankInboxThreadsInput,
  rankings: unknown,
): Effect.Effect<RankInboxThreadsResult, TextGenerationError> {
  return Effect.try({
    try: () => ({ rankings: validateThreadPriorityRankings(rankings, input.chunk) }),
    catch: (cause) =>
      new TextGenerationError({
        operation: "rankInboxThreads",
        detail:
          cause instanceof ThreadPriorityPolicyError
            ? `Invalid inbox ranking output (${cause.kind}).`
            : "Invalid inbox ranking output.",
        cause,
      }),
  });
}

export interface TextGenerationService {
  generateCommitMessage(
    input: CommitMessageGenerationInput,
  ): Promise<CommitMessageGenerationResult>;
  generatePrContent(input: PrContentGenerationInput): Promise<PrContentGenerationResult>;
  generateBranchName(input: BranchNameGenerationInput): Promise<BranchNameGenerationResult>;
  generateThreadTitle(input: ThreadTitleGenerationInput): Promise<ThreadTitleGenerationResult>;
  generateIssueContent(input: IssueContentGenerationInput): Promise<IssueContentGenerationResult>;
  rankInboxThreads(input: RankInboxThreadsInput): Promise<RankInboxThreadsResult>;
  answerSideQuestion(input: SideQuestionInput): Promise<SideQuestionResult>;
}

/**
 * TextGenerationShape - Service API for commit/PR text generation.
 */
export interface TextGenerationShape {
  /** Answer from a frozen completed-context snapshot in an isolated, tool-free request. */
  readonly answerSideQuestion: (
    input: SideQuestionInput,
  ) => Effect.Effect<SideQuestionResult, TextGenerationError>;

  /**
   * Generate a commit message from staged change context.
   */
  readonly generateCommitMessage: (
    input: CommitMessageGenerationInput,
  ) => Effect.Effect<CommitMessageGenerationResult, TextGenerationError>;

  /**
   * Generate pull request title/body from branch and diff context.
   */
  readonly generatePrContent: (
    input: PrContentGenerationInput,
  ) => Effect.Effect<PrContentGenerationResult, TextGenerationError>;

  /**
   * Generate a concise branch name from a user message.
   */
  readonly generateBranchName: (
    input: BranchNameGenerationInput,
  ) => Effect.Effect<BranchNameGenerationResult, TextGenerationError>;

  /**
   * Generate a concise thread title from a user's first message.
   */
  readonly generateThreadTitle: (
    input: ThreadTitleGenerationInput,
  ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;

  /**
   * Generate or polish issue title/body content.
   */
  readonly generateIssueContent: (
    input: IssueContentGenerationInput,
  ) => Effect.Effect<IssueContentGenerationResult, TextGenerationError>;

  /** Rank one bounded, environment-local chunk without tools or mutations. */
  readonly rankInboxThreads: (
    input: RankInboxThreadsInput,
  ) => Effect.Effect<RankInboxThreadsResult, TextGenerationError>;
}

/**
 * TextGeneration - Service tag for commit and PR text generation.
 */
export class TextGeneration extends Context.Service<TextGeneration, TextGenerationShape>()(
  "ryco/text-generation/TextGeneration",
) {}

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle"
  | "generateIssueContent"
  | "rankInboxThreads"
  | "answerSideQuestion";

const resolveInstance = (
  registry: ProviderInstanceRegistryShape,
  operation: TextGenerationOp,
  instanceId: ProviderInstanceId,
): Effect.Effect<ProviderInstance["textGeneration"], TextGenerationError> =>
  registry.getInstance(instanceId).pipe(
    Effect.flatMap((instance) =>
      instance
        ? Effect.succeed(instance.textGeneration)
        : Effect.fail(
            new TextGenerationError({
              operation,
              detail: `No provider instance registered for id '${instanceId}'.`,
            }),
          ),
    ),
  );

export const makeTextGenerationFromRegistry = (
  registry: ProviderInstanceRegistryShape,
): TextGenerationShape => ({
  answerSideQuestion: (input) =>
    resolveInstance(registry, "answerSideQuestion", input.modelSelection.instanceId).pipe(
      Effect.flatMap((textGeneration) => textGeneration.answerSideQuestion(input)),
    ),
  generateCommitMessage: (input) =>
    resolveInstance(registry, "generateCommitMessage", input.modelSelection.instanceId).pipe(
      Effect.flatMap((textGeneration) => textGeneration.generateCommitMessage(input)),
    ),
  generatePrContent: (input) =>
    resolveInstance(registry, "generatePrContent", input.modelSelection.instanceId).pipe(
      Effect.flatMap((textGeneration) => textGeneration.generatePrContent(input)),
    ),
  generateBranchName: (input) =>
    resolveInstance(registry, "generateBranchName", input.modelSelection.instanceId).pipe(
      Effect.flatMap((textGeneration) => textGeneration.generateBranchName(input)),
    ),
  generateThreadTitle: (input) =>
    resolveInstance(registry, "generateThreadTitle", input.modelSelection.instanceId).pipe(
      Effect.flatMap((textGeneration) => textGeneration.generateThreadTitle(input)),
    ),
  generateIssueContent: (input) =>
    resolveInstance(registry, "generateIssueContent", input.modelSelection.instanceId).pipe(
      Effect.flatMap((textGeneration) => textGeneration.generateIssueContent(input)),
    ),
  rankInboxThreads: (input) =>
    resolveInstance(registry, "rankInboxThreads", input.modelSelection.instanceId).pipe(
      Effect.flatMap((textGeneration) => textGeneration.rankInboxThreads(input)),
    ),
});

export const layer = Layer.effect(
  TextGeneration,
  Effect.gen(function* () {
    const registry = yield* ProviderInstanceRegistry;
    return makeTextGenerationFromRegistry(registry);
  }),
);
