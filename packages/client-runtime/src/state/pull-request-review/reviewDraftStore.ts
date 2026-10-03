/**
 * A review being written, held until it is sent.
 *
 * Nothing here reaches the host: a review is one request carrying every line
 * comment and the verdict together, so a half-written review is invisible to
 * everyone else. Drafts are user-authored text, so persisting them through an
 * injected storage is allowed; change request content (bodies, diffs, threads)
 * never enters this store. Each comment remembers the head it was written
 * against: once the change request moves, the comment is outdated and is
 * never silently re-anchored onto the new head.
 */
import type {
  ChangeRequestDiffSide,
  ChangeRequestDraftReviewComment,
  ChangeRequestReviewEvent,
  ChangeRequestSubmitReviewInput,
} from "@ryco/contracts";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { createJSONStorage, persist, type PersistStorage } from "zustand/middleware";

export interface ReviewDraftComment {
  readonly id: string;
  readonly path: string;
  /** `file` comments attach to the whole file and carry no line or side. */
  readonly subjectType: "line" | "file";
  readonly line?: number;
  readonly side?: ChangeRequestDiffSide;
  readonly startLine?: number;
  readonly startSide?: ChangeRequestDiffSide;
  readonly body: string;
  /** Head commit the line numbers refer to. */
  readonly headSha: string;
  /** Epoch milliseconds. */
  readonly createdAt: number;
}

export interface ReviewDraft {
  readonly comments: ReadonlyArray<ReviewDraftComment>;
  /** The review's summary body. */
  readonly summary: string;
  /** The verdict the reviewer picked, if any. */
  readonly event: ChangeRequestReviewEvent | null;
  /** Latest head reported through `markHead`; comments written on another head are outdated. */
  readonly headSha: string | null;
  readonly updatedAt: number;
}

export type NewReviewDraftComment = Omit<ReviewDraftComment, "id" | "createdAt" | "subjectType"> & {
  readonly subjectType?: "line" | "file";
};

/** Body edits, or an explicit user re-anchor (which must name the head it now refers to). */
export type ReviewDraftCommentPatch =
  | { readonly body: string }
  | {
      readonly body?: string;
      readonly subjectType?: "line" | "file";
      readonly line?: number;
      readonly side?: ChangeRequestDiffSide;
      readonly startLine?: number | null;
      readonly startSide?: ChangeRequestDiffSide | null;
      readonly headSha: string;
    };

export interface ReviewDraftStoreState {
  readonly draftsByKey: Readonly<Record<string, ReviewDraft>>;
  addComment(key: string, comment: NewReviewDraftComment): ReviewDraftComment;
  updateComment(key: string, commentId: string, patch: ReviewDraftCommentPatch): void;
  removeComment(key: string, commentId: string): void;
  removeComments(key: string, commentIds: ReadonlyArray<string>): void;
  setSummary(key: string, summary: string): void;
  setEvent(key: string, event: ChangeRequestReviewEvent | null): void;
  /** Record the change request's current head. Never rewrites comment anchors. */
  markHead(key: string, headSha: string): void;
  clear(key: string): void;
  /**
   * Remove exactly what the host accepted: the submitted comments, and the
   * summary/verdict only if they still equal what was sent (the form stays
   * editable while the request is in flight).
   */
  clearSubmitted(
    key: string,
    submitted: {
      readonly commentIds: ReadonlyArray<string>;
      readonly summary: string;
      readonly event: ChangeRequestReviewEvent;
    },
  ): void;
}

/** Plain key-value storage injected by the platform (web binds localStorage). */
export interface ReviewDraftStorage {
  readonly getItem: (name: string) => string | null | Promise<string | null>;
  readonly setItem: (name: string, value: string) => unknown;
  readonly removeItem: (name: string) => unknown;
}

export interface CreateReviewDraftStoreOptions {
  /** Omit for a memory-only store. */
  readonly storage?: ReviewDraftStorage;
  readonly storageKey?: string;
  readonly now?: () => number;
  readonly createId?: () => string;
  /** Persisted drafts beyond this many (least recently updated first) are dropped. */
  readonly maxPersistedDrafts?: number;
}

export const REVIEW_DRAFT_STORAGE_KEY = "ryco:pull-request-review-drafts:v1";
const REVIEW_DRAFT_STORAGE_VERSION = 1;
const DEFAULT_MAX_PERSISTED_DRAFTS = 50;

export const EMPTY_REVIEW_DRAFT: ReviewDraft = Object.freeze({
  comments: Object.freeze([]) as ReadonlyArray<ReviewDraftComment>,
  summary: "",
  event: null,
  headSha: null,
  updatedAt: 0,
});

/** One draft per change request per checkout: the same number can exist in two clones. */
export function reviewDraftKey(input: {
  readonly environmentId: string;
  readonly cwd: string;
  readonly number: number;
}): string {
  return JSON.stringify([input.environmentId, input.cwd, input.number]);
}

export function selectReviewDraft(
  state: Pick<ReviewDraftStoreState, "draftsByKey">,
  key: string,
): ReviewDraft {
  return state.draftsByKey[key] ?? EMPTY_REVIEW_DRAFT;
}

/** Outdated relative to `headSha` (defaults to the draft's last marked head). */
export function isReviewDraftCommentOutdated(
  comment: Pick<ReviewDraftComment, "headSha">,
  headSha: string | null | undefined,
): boolean {
  return headSha !== null && headSha !== undefined && comment.headSha !== headSha;
}

export function selectOutdatedReviewDraftComments(
  draft: ReviewDraft,
  headSha: string | null = draft.headSha,
): ReadonlyArray<ReviewDraftComment> {
  return draft.comments.filter((comment) => isReviewDraftCommentOutdated(comment, headSha));
}

function isEmptyDraft(draft: ReviewDraft): boolean {
  return draft.comments.length === 0 && draft.summary.length === 0 && draft.event === null;
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null),
  ) as T;
}

function normalizeComment(comment: ReviewDraftComment): ReviewDraftComment {
  if (comment.subjectType === "file") {
    return {
      id: comment.id,
      path: comment.path,
      subjectType: "file",
      body: comment.body,
      headSha: comment.headSha,
      createdAt: comment.createdAt,
    };
  }
  return withoutUndefined({ ...comment }) as ReviewDraftComment;
}

// ── Submit ──────────────────────────────────────────────────────────────

export type BuildSubmitReviewResult =
  | {
      readonly ok: true;
      readonly input: ChangeRequestSubmitReviewInput;
      /** Ids to pass to `clearSubmitted` once the host accepts the review. */
      readonly commentIds: ReadonlyArray<string>;
      readonly summary: string;
      readonly event: ChangeRequestReviewEvent;
      /** Left out because they were written against another head. */
      readonly outdated: ReadonlyArray<ReviewDraftComment>;
    }
  | {
      readonly ok: false;
      readonly reason: "no-head" | "empty" | "body-required";
      readonly message: string;
      readonly outdated: ReadonlyArray<ReviewDraftComment>;
    };

function toDraftReviewComment(comment: ReviewDraftComment): ChangeRequestDraftReviewComment {
  if (comment.subjectType === "file") {
    return { path: comment.path, body: comment.body, subjectType: "file" };
  }
  return {
    path: comment.path,
    body: comment.body,
    subjectType: "line",
    ...(comment.line !== undefined ? { line: comment.line } : {}),
    ...(comment.side !== undefined ? { side: comment.side } : {}),
    ...(comment.startLine !== undefined && comment.startLine !== comment.line
      ? {
          startLine: comment.startLine,
          ...(comment.startSide !== undefined ? { startSide: comment.startSide } : {}),
        }
      : {}),
  };
}

/**
 * Builds the single submit request for a draft. Only comments written against
 * `headSha` (the current head) are sent; outdated ones are reported, never
 * re-anchored. Blank comments are skipped. A `comment` or `request_changes`
 * review without inline comments needs a summary body, except that a
 * `comment` review may submit a pending review the viewer started on the host
 * (`hostPendingComments`), which already carries its comments.
 */
export function buildSubmitReviewInput(
  draft: ReviewDraft,
  target: {
    readonly cwd: string;
    readonly reference: string;
    /** Current head; defaults to the draft's last marked head. */
    readonly headSha?: string | null;
    /** Defaults to the draft's chosen verdict, then `comment`. */
    readonly event?: ChangeRequestReviewEvent;
    /** Comments in the viewer's pending review on the host; they are submitted too. */
    readonly hostPendingComments?: number;
  },
): BuildSubmitReviewResult {
  const headSha = target.headSha ?? draft.headSha;
  const outdated = selectOutdatedReviewDraftComments(draft, headSha ?? null);
  if (!headSha) {
    return {
      ok: false,
      reason: "no-head",
      message: "The pull request head is not known yet. Refresh and try again.",
      outdated,
    };
  }
  const event = target.event ?? draft.event ?? "comment";
  const comments = draft.comments.filter(
    (comment) => comment.headSha === headSha && comment.body.trim().length > 0,
  );
  const summary = draft.summary;
  const hasSummary = summary.trim().length > 0;
  const hasHostComments = event === "comment" && (target.hostPendingComments ?? 0) > 0;
  if (event !== "approve" && comments.length === 0 && !hasSummary && !hasHostComments) {
    return {
      ok: false,
      reason: event === "request_changes" ? "body-required" : "empty",
      message:
        event === "request_changes"
          ? "Explain what needs to change before requesting changes."
          : "Add a comment or a summary before submitting.",
      outdated,
    };
  }
  if (event === "request_changes" && !hasSummary) {
    return {
      ok: false,
      reason: "body-required",
      message: "Explain what needs to change before requesting changes.",
      outdated,
    };
  }
  return {
    ok: true,
    input: {
      cwd: target.cwd,
      reference: target.reference,
      event,
      ...(hasSummary ? { body: summary } : {}),
      comments: comments.map(toDraftReviewComment),
      expectedHeadSha: headSha,
    },
    commentIds: comments.map((comment) => comment.id),
    summary,
    event,
    outdated,
  };
}

// ── Persistence ─────────────────────────────────────────────────────────

interface PersistedReviewDraftState {
  readonly draftsByKey: Record<string, ReviewDraft>;
}

const DIFF_SIDES = new Set(["left", "right"]);
const REVIEW_EVENTS = new Set(["comment", "approve", "request_changes"]);

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function decodeComment(raw: unknown): ReviewDraftComment | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.id !== "string" ||
    typeof value.path !== "string" ||
    value.path.length === 0 ||
    typeof value.body !== "string" ||
    typeof value.headSha !== "string" ||
    value.headSha.length === 0 ||
    typeof value.createdAt !== "number"
  ) {
    return null;
  }
  const subjectType = value.subjectType === "file" ? "file" : "line";
  if (subjectType === "line" && !isPositiveInt(value.line)) return null;
  return normalizeComment({
    id: value.id,
    path: value.path,
    subjectType,
    ...(isPositiveInt(value.line) ? { line: value.line } : {}),
    ...(DIFF_SIDES.has(value.side as string) ? { side: value.side as ChangeRequestDiffSide } : {}),
    ...(isPositiveInt(value.startLine) ? { startLine: value.startLine } : {}),
    ...(DIFF_SIDES.has(value.startSide as string)
      ? { startSide: value.startSide as ChangeRequestDiffSide }
      : {}),
    body: value.body,
    headSha: value.headSha,
    createdAt: value.createdAt,
  });
}

function decodeDraft(raw: unknown): ReviewDraft | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const comments = Array.isArray(value.comments)
    ? value.comments.flatMap((comment) => decodeComment(comment) ?? [])
    : [];
  const draft: ReviewDraft = {
    comments,
    summary: typeof value.summary === "string" ? value.summary : "",
    event: REVIEW_EVENTS.has(value.event as string)
      ? (value.event as ChangeRequestReviewEvent)
      : null,
    headSha: typeof value.headSha === "string" && value.headSha.length > 0 ? value.headSha : null,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
  };
  return isEmptyDraft(draft) ? null : draft;
}

/** Keeps only well-formed, non-empty drafts, newest first up to `limit`. */
export function decodePersistedReviewDrafts(
  raw: unknown,
  limit = DEFAULT_MAX_PERSISTED_DRAFTS,
): Record<string, ReviewDraft> {
  if (typeof raw !== "object" || raw === null) return {};
  const drafts = (raw as { draftsByKey?: unknown }).draftsByKey;
  if (typeof drafts !== "object" || drafts === null) return {};
  return Object.fromEntries(
    Object.entries(drafts as Record<string, unknown>)
      .flatMap(([key, value]) => {
        const draft = decodeDraft(value);
        return draft ? [[key, draft] as const] : [];
      })
      .toSorted(([, left], [, right]) => right.updatedAt - left.updatedAt)
      .slice(0, Math.max(0, limit)),
  );
}

// ── Store ───────────────────────────────────────────────────────────────

let fallbackIdSequence = 0;

export type ReviewDraftStore = UseBoundStore<StoreApi<ReviewDraftStoreState>>;

export function createReviewDraftStore(
  options: CreateReviewDraftStoreOptions = {},
): ReviewDraftStore {
  const now = options.now ?? Date.now;
  const createId =
    options.createId ??
    (() => {
      fallbackIdSequence += 1;
      return `review-draft-${now().toString(36)}-${fallbackIdSequence.toString(36)}`;
    });
  const maxPersistedDrafts = options.maxPersistedDrafts ?? DEFAULT_MAX_PERSISTED_DRAFTS;

  const initializer = (
    set: (
      updater: (
        state: ReviewDraftStoreState,
      ) => Partial<ReviewDraftStoreState> | ReviewDraftStoreState,
    ) => void,
  ): ReviewDraftStoreState => {
    const updateDraft = (key: string, update: (draft: ReviewDraft) => ReviewDraft) =>
      set((state) => {
        const current = state.draftsByKey[key] ?? EMPTY_REVIEW_DRAFT;
        const next = update(current);
        if (next === current) return state;
        const { [key]: _removed, ...rest } = state.draftsByKey;
        return {
          draftsByKey: isEmptyDraft(next)
            ? rest
            : { ...rest, [key]: { ...next, updatedAt: now() } },
        };
      });

    return {
      draftsByKey: {},
      addComment: (key, input) => {
        const comment = normalizeComment({
          ...input,
          subjectType: input.subjectType ?? "line",
          id: createId(),
          createdAt: now(),
        });
        updateDraft(key, (draft) => ({
          ...draft,
          headSha: draft.headSha ?? comment.headSha,
          comments: [...draft.comments, comment],
        }));
        return comment;
      },
      updateComment: (key, commentId, patch) =>
        updateDraft(key, (draft) => {
          const index = draft.comments.findIndex((comment) => comment.id === commentId);
          const current = draft.comments[index];
          if (!current) return draft;
          const next = normalizeComment(
            "headSha" in patch
              ? ({
                  ...current,
                  ...withoutUndefined({
                    body: patch.body,
                    subjectType: patch.subjectType,
                    line: patch.line,
                    side: patch.side,
                    headSha: patch.headSha,
                  }),
                  // A re-anchor replaces the range: absent means single line.
                  startLine: patch.startLine ?? undefined,
                  startSide: patch.startSide ?? undefined,
                } as ReviewDraftComment)
              : { ...current, body: patch.body },
          );
          const comments = [...draft.comments];
          comments[index] = next;
          return { ...draft, comments };
        }),
      removeComment: (key, commentId) =>
        updateDraft(key, (draft) =>
          draft.comments.some((comment) => comment.id === commentId)
            ? { ...draft, comments: draft.comments.filter((comment) => comment.id !== commentId) }
            : draft,
        ),
      removeComments: (key, commentIds) => {
        const ids = new Set(commentIds);
        updateDraft(key, (draft) =>
          draft.comments.some((comment) => ids.has(comment.id))
            ? { ...draft, comments: draft.comments.filter((comment) => !ids.has(comment.id)) }
            : draft,
        );
      },
      setSummary: (key, summary) =>
        updateDraft(key, (draft) => (draft.summary === summary ? draft : { ...draft, summary })),
      setEvent: (key, event) =>
        updateDraft(key, (draft) => (draft.event === event ? draft : { ...draft, event })),
      markHead: (key, headSha) =>
        updateDraft(key, (draft) =>
          draft === EMPTY_REVIEW_DRAFT || draft.headSha === headSha ? draft : { ...draft, headSha },
        ),
      clear: (key) =>
        set((state) => {
          if (!(key in state.draftsByKey)) return state;
          const { [key]: _removed, ...rest } = state.draftsByKey;
          return { draftsByKey: rest };
        }),
      clearSubmitted: (key, submitted) => {
        const ids = new Set(submitted.commentIds);
        updateDraft(key, (draft) => {
          const comments = draft.comments.filter((comment) => !ids.has(comment.id));
          const clearSummary = draft.summary === submitted.summary;
          const clearEvent = draft.event === submitted.event;
          if (comments.length === draft.comments.length && !clearSummary && !clearEvent) {
            return draft;
          }
          return {
            ...draft,
            comments,
            summary: clearSummary ? "" : draft.summary,
            event: clearEvent ? null : draft.event,
          };
        });
      },
    };
  };

  if (!options.storage) {
    return create<ReviewDraftStoreState>()((set) => initializer(set));
  }

  const storage = options.storage;
  return create<ReviewDraftStoreState>()(
    persist<ReviewDraftStoreState, [], [], PersistedReviewDraftState>((set) => initializer(set), {
      name: options.storageKey ?? REVIEW_DRAFT_STORAGE_KEY,
      version: REVIEW_DRAFT_STORAGE_VERSION,
      storage: createJSONStorage(() => storage) as PersistStorage<PersistedReviewDraftState>,
      partialize: (state) => ({
        draftsByKey: decodePersistedReviewDrafts(state, maxPersistedDrafts),
      }),
      migrate: (persisted) => ({
        draftsByKey: decodePersistedReviewDrafts(persisted, maxPersistedDrafts),
      }),
      merge: (persisted, current) => ({
        ...current,
        draftsByKey: {
          ...decodePersistedReviewDrafts(persisted, maxPersistedDrafts),
          // Anything written before hydration finished wins over storage.
          ...current.draftsByKey,
        },
      }),
    }),
  );
}
