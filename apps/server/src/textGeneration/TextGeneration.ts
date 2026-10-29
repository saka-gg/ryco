import { Context, Effect, Layer } from "effect";
import type { ChatAttachment, ModelSelection, ProviderInstanceId } from "@ryco/contracts";
import { TextGenerationError } from "@ryco/contracts";

import {
  ProviderInstanceRegistry,
  type ProviderInstanceRegistryShape,
} from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import type { TextGenerationPolicy } from "./TextGenerationPolicy.ts";

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
  /** The user's writing instructions for this kind of text. */
  policy?: TextGenerationPolicy | undefined;
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
  /** The user's writing instructions for this kind of text. */
  policy?: TextGenerationPolicy | undefined;
}

export interface PrContentGenerationResult {
  title: string;
  body: string;
}

export interface BranchNameGenerationInput {
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** Start the branch with the kind of change, as in `fix/login-redirect`. */
  branchChangeTypes?: boolean;
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
  /** When true, the same request also names a git branch for the work (one call, not two). */
  includeBranch?: boolean;
  /** Start that branch with the kind of change, as in `fix/login-redirect`. */
  branchChangeTypes?: boolean;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface ThreadTitleGenerationResult {
  title: string;
  /** Present when `includeBranch` was set and the provider supports it. */
  branch?: string | undefined;
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

/** Read-only Git context of work that exists only in one checkout. */
export interface WorkspaceChangesSummaryGenerationInput {
  cwd: string;
  branch: string | null;
  /** Porcelain status plus the diff stat of uncommitted changes. */
  statusSummary: string;
  /** Patch of tracked changes against HEAD. */
  diffPatch: string;
  /** Untracked file paths, one per line. */
  untrackedFiles: string;
  /** Commits the project's main checkout does not contain, with their diff stat. */
  unmergedLog: string;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface WorkspaceChangesSummaryGenerationResult {
  summary: string;
}

export interface TextGenerationService {
  generateCommitMessage(
    input: CommitMessageGenerationInput,
  ): Promise<CommitMessageGenerationResult>;
  generatePrContent(input: PrContentGenerationInput): Promise<PrContentGenerationResult>;
  generateBranchName(input: BranchNameGenerationInput): Promise<BranchNameGenerationResult>;
  generateThreadTitle(input: ThreadTitleGenerationInput): Promise<ThreadTitleGenerationResult>;
  generateIssueContent(input: IssueContentGenerationInput): Promise<IssueContentGenerationResult>;
  answerSideQuestion(input: SideQuestionInput): Promise<SideQuestionResult>;
}

/**
 * TextGenerationShape - Service API for commit/PR text generation.
 */
export interface TextGenerationShape {
  /**
   * Commit messages and pull request text run without tools here, so their policy may carry
   * text from the repository and its forge (`TextGenerationPolicy.repositoryExamples`). Absent
   * means they may have tools: the router then drops that text before calling.
   */
  readonly gitWritingToolFree?: boolean | undefined;

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

  /**
   * Describe, in at most two sentences, the work a checkout holds that deleting
   * it would lose. Tool-free; the change data is quoted, never followed.
   */
  readonly summarizeWorkspaceChanges: (
    input: WorkspaceChangesSummaryGenerationInput,
  ) => Effect.Effect<WorkspaceChangesSummaryGenerationResult, TextGenerationError>;
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
  | "answerSideQuestion"
  | "summarizeWorkspaceChanges";

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

/**
 * Repository and forge text in a Git writing policy reaches only instances that write commit
 * messages and pull request text without tools; any other instance gets the style without it.
 */
export const gitWritingPolicyForInstance = (
  textGeneration: Pick<TextGenerationShape, "gitWritingToolFree">,
  policy: TextGenerationPolicy | undefined,
): TextGenerationPolicy | undefined => {
  if (policy?.repositoryExamples === undefined || textGeneration.gitWritingToolFree === true)
    return policy;
  const { repositoryExamples: _untrusted, ...withoutRepositoryText } = policy;
  return withoutRepositoryText;
};

export const makeTextGenerationFromRegistry = (
  registry: ProviderInstanceRegistryShape,
): TextGenerationShape => ({
  answerSideQuestion: (input) =>
    resolveInstance(registry, "answerSideQuestion", input.modelSelection.instanceId).pipe(
      Effect.flatMap((textGeneration) => textGeneration.answerSideQuestion(input)),
    ),
  generateCommitMessage: (input) =>
    resolveInstance(registry, "generateCommitMessage", input.modelSelection.instanceId).pipe(
      Effect.flatMap((textGeneration) =>
        textGeneration.generateCommitMessage({
          ...input,
          policy: gitWritingPolicyForInstance(textGeneration, input.policy),
        }),
      ),
    ),
  generatePrContent: (input) =>
    resolveInstance(registry, "generatePrContent", input.modelSelection.instanceId).pipe(
      Effect.flatMap((textGeneration) =>
        textGeneration.generatePrContent({
          ...input,
          policy: gitWritingPolicyForInstance(textGeneration, input.policy),
        }),
      ),
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
  summarizeWorkspaceChanges: (input) =>
    resolveInstance(registry, "summarizeWorkspaceChanges", input.modelSelection.instanceId).pipe(
      Effect.flatMap((textGeneration) => textGeneration.summarizeWorkspaceChanges(input)),
    ),
});

export const layer = Layer.effect(
  TextGeneration,
  Effect.gen(function* () {
    const registry = yield* ProviderInstanceRegistry;
    return makeTextGenerationFromRegistry(registry);
  }),
);
