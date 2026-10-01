import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  type EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ProviderInteractionMode,
  ProviderDriverKind,
  ProviderOptionSelection,
  RuntimeMode,
  AgentTokenMode,
  type ScopedProjectRef,
  type ScopedThreadRef,
  ThreadId,
} from "@ryco/contracts";
import {
  parseScopedProjectKey,
  parseScopedThreadKey,
  scopedProjectKey,
  scopeProjectRef,
  scopedThreadKey,
  scopeThreadRef,
} from "../../scoped.ts";
import * as Schema from "effect/Schema";
import type { DeepMutable } from "effect/Types";
import { createModelSelection, normalizeModelSlug } from "@ryco/shared/model";
import {
  DEFAULT_AGENT_TOKEN_MODE,
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
} from "../threads/types.ts";
import { ensureInlineTerminalContextPlaceholders } from "./terminalContext.ts";
import type {
  ComposerDraftImage,
  ComposerDraftStoreState,
  ComposerThreadDraftState,
  DraftId,
  DraftThreadState,
} from "./draftStore.ts";

export const COMPOSER_DRAFT_STORAGE_KEY = "ryco:composer-drafts:v1";
export const COMPOSER_DRAFT_STORAGE_VERSION = 7;
const DraftThreadEnvModeSchema = Schema.Literals(["local", "worktree"]);
export const isRuntimeMode = Schema.is(RuntimeMode);
export const isAgentTokenMode = Schema.is(AgentTokenMode);
export const isProviderInteractionMode = Schema.is(ProviderInteractionMode);
export type DraftThreadEnvMode = typeof DraftThreadEnvModeSchema.Type;

export const PersistedComposerImageAttachment = Schema.Struct({
  type: Schema.optionalKey(Schema.Literals(["image", "file"])),
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  /** Absent for uploaded streamed files; those carry uploadToken instead. */
  dataUrl: Schema.optionalKey(Schema.String),
  /** Uploaded file attachments carry a single-use token instead of bytes. */
  uploadToken: Schema.optionalKey(Schema.String),
  expiresAt: Schema.optionalKey(Schema.String),
  /** Non-uploaded streamed files restore as "attach again" rows. */
  uploadState: Schema.optionalKey(Schema.Literals(["needsReattach"])),
});
export type PersistedComposerImageAttachment = typeof PersistedComposerImageAttachment.Type;

const PersistedTerminalContextDraft = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  createdAt: Schema.String,
  terminalId: Schema.String,
  terminalLabel: Schema.String,
  lineStart: Schema.Number,
  lineEnd: Schema.Number,
});
type PersistedTerminalContextDraft = typeof PersistedTerminalContextDraft.Type;

const PersistedComposerThreadDraftState = Schema.Struct({
  prompt: Schema.String,
  attachments: Schema.Array(PersistedComposerImageAttachment),
  terminalContexts: Schema.optionalKey(Schema.Array(PersistedTerminalContextDraft)),
  // Keyed by `ProviderInstanceId` (open branded slug) so custom provider
  // instances (e.g. `codex_personal`) round-trip alongside the built-in
  // `codex` / `claudeAgent` / ... entries. Every prior `ProviderDriverKind`
  // literal satisfies the `ProviderInstanceId` slug pattern, so existing
  // persisted drafts decode unchanged.
  //
  // The record's value schema is NOT wrapped in `Schema.optionalKey`:
  // that helper is only meaningful on property signatures with a known
  // key set, and `Schema.Record(<branded string>, …)` produces an index
  // signature at runtime (Schema rejects the combination). Absence of
  // an entry already encodes "no selection for this instance".
  modelSelectionByProvider: Schema.optionalKey(Schema.Record(ProviderInstanceId, ModelSelection)),
  activeProvider: Schema.optionalKey(Schema.NullOr(ProviderInstanceId)),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  interactionMode: Schema.optionalKey(ProviderInteractionMode),
  tokenMode: Schema.optionalKey(AgentTokenMode),
});
type PersistedComposerThreadDraftState = typeof PersistedComposerThreadDraftState.Type;

/**
 * Per-provider record of generic option selections. Used as a transient
 * representation when migrating legacy v2 storage payloads and when
 * deriving per-provider option bundles for downstream consumers.
 */
export type ProviderOptionSelectionsByProvider = Partial<
  Record<string, ReadonlyArray<ProviderOptionSelection>>
>;

type LegacyCodexFields = {
  effort?: unknown;
  codexFastMode?: unknown;
  serviceTier?: unknown;
};

type LegacyThreadModelFields = {
  provider?: unknown;
  model?: unknown;
  modelOptions?: unknown;
};

type LegacyV2ThreadDraftFields = {
  modelSelection?: ModelSelection | null;
  modelOptions?: unknown;
};

type LegacyPersistedComposerThreadDraftState = PersistedComposerThreadDraftState &
  LegacyCodexFields &
  LegacyThreadModelFields &
  LegacyV2ThreadDraftFields;

type LegacyStickyModelFields = {
  stickyProvider?: unknown;
  stickyModel?: unknown;
  stickyModelOptions?: unknown;
};

type LegacyV2StoreFields = {
  stickyModelSelection?: ModelSelection | null;
  stickyModelOptions?: unknown;
  projectDraftThreadIdByProjectId?: Record<string, string> | null;
  draftsByThreadId?: Record<string, PersistedComposerThreadDraftState> | null;
  draftThreadsByThreadId?: Record<string, PersistedDraftThreadState> | null;
  projectDraftThreadIdByProjectKey?: Record<string, string> | null;
  draftsByThreadKey?: Record<string, PersistedComposerThreadDraftState> | null;
  draftThreadsByThreadKey?: Record<string, PersistedDraftThreadState> | null;
  projectDraftThreadKeyByProjectKey?: Record<string, string> | null;
  logicalProjectDraftThreadKeyByLogicalProjectKey?: Record<string, string> | null;
};

type LegacyPersistedComposerDraftStoreState = PersistedComposerDraftStoreState &
  LegacyStickyModelFields &
  LegacyV2StoreFields;

export const PersistedDraftThreadState = Schema.Struct({
  threadId: ThreadId,
  environmentId: Schema.String,
  projectId: ProjectId,
  logicalProjectKey: Schema.optionalKey(Schema.String),
  createdAt: Schema.String,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  tokenMode: Schema.optionalKey(AgentTokenMode),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  fetchOrigin: Schema.optionalKey(Schema.Boolean),
  worktreeBranchName: Schema.optionalKey(Schema.NullOr(Schema.String)),
  // Optional so drafts persisted before sources existed still decode.
  worktreeSource: Schema.optionalKey(
    Schema.NullOr(
      Schema.Union([
        Schema.Struct({
          kind: Schema.Literal("pr"),
          number: Schema.Number,
          label: Schema.String,
        }),
        Schema.Struct({
          kind: Schema.Literal("issue"),
          number: Schema.Number,
          title: Schema.String,
          label: Schema.String,
        }),
        Schema.Struct({
          kind: Schema.Literal("workItem"),
          provider: Schema.Literal("jira"),
          key: Schema.String,
          title: Schema.String,
          state: Schema.optional(Schema.String),
          stateName: Schema.optional(Schema.String),
          url: Schema.optional(Schema.String),
          label: Schema.String,
        }),
      ]),
    ),
  ),
  envMode: DraftThreadEnvModeSchema,
  promotedTo: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        environmentId: Schema.String,
        threadId: Schema.String,
      }),
    ),
  ),
});
type PersistedDraftThreadState = typeof PersistedDraftThreadState.Type;

const PersistedComposerDraftStoreState = Schema.Struct({
  draftsByThreadKey: Schema.Record(Schema.String, PersistedComposerThreadDraftState),
  draftThreadsByThreadKey: Schema.Record(Schema.String, PersistedDraftThreadState),
  logicalProjectDraftThreadKeyByLogicalProjectKey: Schema.Record(Schema.String, Schema.String),
  stickyModelSelectionByProvider: Schema.optionalKey(
    Schema.Record(ProviderInstanceId, ModelSelection),
  ),
  stickyActiveProvider: Schema.optionalKey(Schema.NullOr(ProviderInstanceId)),
});
export type PersistedComposerDraftStoreState = typeof PersistedComposerDraftStoreState.Type;

export const PersistedComposerDraftStoreStorage = Schema.Struct({
  version: Schema.Number,
  state: PersistedComposerDraftStoreState,
});

function cloneModelSelection(selection: ModelSelection): DeepMutable<ModelSelection> {
  return {
    ...selection,
    ...(selection.options ? { options: selection.options.map((option) => ({ ...option })) } : {}),
  } as DeepMutable<ModelSelection>;
}

export function compactModelSelectionByProvider(
  selections: Partial<Record<ProviderInstanceId, ModelSelection>>,
): DeepMutable<Record<ProviderInstanceId, ModelSelection>> {
  return Object.fromEntries(
    Object.entries(selections)
      .filter((entry): entry is [string, ModelSelection] => entry[1] !== undefined)
      .map(([provider, selection]) => [provider, cloneModelSelection(selection)]),
  ) as DeepMutable<Record<ProviderInstanceId, ModelSelection>>;
}

const EMPTY_PERSISTED_DRAFT_STORE_STATE = Object.freeze<PersistedComposerDraftStoreState>({
  draftsByThreadKey: {},
  draftThreadsByThreadKey: {},
  logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  stickyModelSelectionByProvider: {},
  stickyActiveProvider: null,
});

export function normalizeProviderDriverKind(value: unknown): ProviderDriverKind | null {
  return Schema.is(ProviderDriverKind)(value) ? value : null;
}

/**
 * Match the `ProviderInstanceId` slug pattern (letter followed by
 * letters/digits/`-`/`_`, 1..64 chars). Permissive validator — the schema
 * layer owns authoritative validation; this is used inline to gate typed
 * writes to the draft's instance-keyed maps without pulling the full
 * Effect Schema runtime into the hot path.
 */
const PROVIDER_INSTANCE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

/**
 * Coerce an arbitrary persisted value into a valid `ProviderInstanceId`. Used
 * wherever we need to accept both legacy driver-kind keys and custom instance
 * slugs (e.g. `codex_personal`) as routing keys.
 */
export function normalizeProviderInstanceId(value: unknown): ProviderInstanceId | null {
  if (typeof value !== "string") return null;
  if (!PROVIDER_INSTANCE_ID_PATTERN.test(value)) return null;
  return value as ProviderInstanceId;
}

/**
 * Coerce an unknown value into a `ReadonlyArray<ProviderOptionSelection>`.
 * Accepts either:
 *   - the v3 representation: an array of `{ id, value }` entries
 *   - the legacy v2 representation: a record of `{ id: string | boolean }`
 *
 * Validation is intentionally permissive: descriptors are the source of truth
 * for which option ids are meaningful for a given provider/model. Anything
 * outside the descriptor list is harmless trailing data and will simply be
 * ignored downstream.
 */
function coerceProviderOptionSelections(
  value: unknown,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  if (Array.isArray(value)) {
    const out: ProviderOptionSelection[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const id = record.id;
      const optionValue = record.value;
      if (typeof id !== "string" || id.length === 0) continue;
      if (typeof optionValue === "string" || typeof optionValue === "boolean") {
        out.push({ id, value: optionValue });
      }
    }
    return out.length > 0 ? out : undefined;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: ProviderOptionSelection[] = [];
    for (const [id, raw] of Object.entries(record)) {
      if (typeof raw === "string" || typeof raw === "boolean") {
        out.push({ id, value: raw });
      }
    }
    return out.length > 0 ? out : undefined;
  }
  return undefined;
}

/**
 * Normalize a per-provider options bag from either the v3 or legacy v2 shape.
 *
 * `provider` and `legacy` parameters are migration-only inputs used to
 * recover legacy codex fields (effort/codexFastMode/serviceTier) that lived
 * directly on the draft instead of inside `modelOptions.codex`.
 */
function normalizeProviderModelOptions(
  value: unknown,
  provider?: ProviderDriverKind | null,
  legacy?: LegacyCodexFields,
): ProviderOptionSelectionsByProvider | null {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const result: ProviderOptionSelectionsByProvider = {};
  for (const providerKey of ["codex", "claudeAgent", "cursor", "grok", "opencode"] as const) {
    const selections = coerceProviderOptionSelections(candidate?.[providerKey]);
    if (selections) {
      result[providerKey] = selections;
    }
  }

  // Recover legacy codex fields that lived outside modelOptions.
  if (provider === "codex" && legacy) {
    const codexExtras: ProviderOptionSelection[] = [];
    if (typeof legacy.effort === "string" && legacy.effort.length > 0) {
      codexExtras.push({ id: "reasoningEffort", value: legacy.effort });
    }
    const fastMode =
      legacy.codexFastMode === true ||
      (typeof legacy.serviceTier === "string" && legacy.serviceTier === "fast");
    if (fastMode) {
      codexExtras.push({ id: "fastMode", value: true });
    }
    if (codexExtras.length > 0) {
      const existing = result.codex ?? [];
      const existingIds = new Set(existing.map((entry) => entry.id));
      const merged = [...existing];
      for (const extra of codexExtras) {
        if (!existingIds.has(extra.id)) merged.push(extra);
      }
      result.codex = merged;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

// Returns a model selection whose `instanceId` is a valid
// `ProviderInstanceId` slug. Legacy `provider` fields are promoted verbatim
// because default instance ids used the same slug as the driver kind.
//
// Selections whose instance id doesn't match the slug pattern collapse to
// `null` — caller is responsible for deciding whether that's a dropped
// write or a routed error.
export function normalizeModelSelection(
  value: unknown,
  legacy?: {
    provider?: unknown;
    model?: unknown;
    modelOptions?: unknown;
    legacyCodex?: LegacyCodexFields;
  },
): NormalizedModelSelection | null {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  // Post-migration ModelSelection carries `instanceId`; pre-migration (v2
  // storage, legacy wire shapes) carries `provider`. Accept either so both
  // normalized stores and legacy drafts round-trip through this helper.
  const instanceId = normalizeProviderInstanceId(
    candidate?.instanceId ?? candidate?.provider ?? legacy?.provider,
  );
  if (instanceId === null) {
    return null;
  }
  const rawModel = candidate?.model ?? legacy?.model;
  if (typeof rawModel !== "string") {
    return null;
  }
  // Slug normalization can use provider-kind-specific rules when a legacy
  // driver key is present. Instance-only selections are not reverse-inferred
  // into a driver kind here; they get generic default normalization.
  const driverKindHint =
    normalizeProviderDriverKind(candidate?.provider ?? legacy?.provider) ??
    ProviderDriverKind.make("codex");
  const model = normalizeModelSlug(rawModel, driverKindHint);
  if (!model) {
    return null;
  }
  if (Array.isArray(candidate?.options)) {
    const selections = coerceProviderOptionSelections(candidate.options);
    return createModelSelection(instanceId, model, selections) as NormalizedModelSelection;
  }
  // Per-kind options were a pre-migration concern; only recover them for a
  // built-in-kind instance. Custom instances don't have a legacy options
  // store to thread through here.
  const kindForLegacyOptions = normalizeProviderDriverKind(instanceId);
  const modelOptions = kindForLegacyOptions
    ? normalizeProviderModelOptions(
        candidate?.options ? { [kindForLegacyOptions]: candidate.options } : legacy?.modelOptions,
        kindForLegacyOptions,
        kindForLegacyOptions === "codex" ? legacy?.legacyCodex : undefined,
      )
    : null;
  const options = kindForLegacyOptions ? modelOptions?.[kindForLegacyOptions] : undefined;
  return createModelSelection(instanceId, model, options) as NormalizedModelSelection;
}

type NormalizedModelSelection = Omit<ModelSelection, "instanceId"> & {
  readonly instanceId: ProviderInstanceId;
};

// ── Legacy sync helpers (used only during migration from v2 storage) ──
//
// These operate against the legacy kind-keyed `modelOptions` map. The
// normalized selection now carries an open `ProviderInstanceId`; legacy
// migration only recovers options for keys that existed before custom
// provider instances.

function legacySyncModelSelectionOptions(
  modelSelection: NormalizedModelSelection | null,
  modelOptions: ProviderOptionSelectionsByProvider | null | undefined,
): NormalizedModelSelection | null {
  if (modelSelection === null) {
    return null;
  }
  const kind = normalizeProviderDriverKind(modelSelection.instanceId);
  const options = kind ? modelOptions?.[kind] : undefined;
  return createModelSelection(
    modelSelection.instanceId,
    modelSelection.model,
    options,
  ) as NormalizedModelSelection;
}

function legacyMergeModelSelectionIntoProviderModelOptions(
  modelSelection: NormalizedModelSelection | null,
  currentModelOptions: ProviderOptionSelectionsByProvider | null | undefined,
): ProviderOptionSelectionsByProvider | null {
  if (!modelSelection?.options || modelSelection.options.length === 0) {
    return normalizeProviderModelOptions(currentModelOptions);
  }
  const kind = normalizeProviderDriverKind(modelSelection.instanceId);
  if (!kind) {
    return normalizeProviderModelOptions(currentModelOptions);
  }
  return legacyReplaceProviderModelOptions(
    normalizeProviderModelOptions(currentModelOptions),
    kind,
    modelSelection.options,
  );
}

function legacyReplaceProviderModelOptions(
  currentModelOptions: ProviderOptionSelectionsByProvider | null | undefined,
  provider: ProviderDriverKind,
  nextProviderOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): ProviderOptionSelectionsByProvider | null {
  const { [provider]: _discardedProviderModelOptions, ...otherProviderModelOptions } =
    currentModelOptions ?? {};
  const merged: ProviderOptionSelectionsByProvider = { ...otherProviderModelOptions };
  if (nextProviderOptions && nextProviderOptions.length > 0) {
    merged[provider] = nextProviderOptions;
  }
  return Object.keys(merged).length > 0 ? merged : null;
}

// ── New helpers for the consolidated representation ────────────────────

function legacyToModelSelectionByProvider(
  modelSelection: NormalizedModelSelection | null,
  modelOptions: ProviderOptionSelectionsByProvider | null | undefined,
): Partial<Record<ProviderInstanceId, ModelSelection>> {
  const result: Partial<Record<ProviderInstanceId, ModelSelection>> = {};
  if (modelOptions) {
    for (const provider of ["codex", "claudeAgent", "cursor", "grok", "opencode"] as const) {
      const options = modelOptions[provider];
      if (options && options.length > 0) {
        const driverKind = ProviderDriverKind.make(provider);
        const instanceKey = defaultInstanceIdForDriver(driverKind);
        result[instanceKey] = createModelSelection(
          instanceKey,
          modelSelection?.instanceId === instanceKey
            ? modelSelection.model
            : (DEFAULT_MODEL_BY_PROVIDER[driverKind] ?? DEFAULT_MODEL),
          options,
        );
      }
    }
  }
  if (modelSelection) {
    result[modelSelection.instanceId] = modelSelection as ModelSelection;
  }
  return result;
}

function normalizePersistedAttachment(value: unknown): PersistedComposerImageAttachment | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const id = candidate.id;
  const type = candidate.type;
  const name = candidate.name;
  const mimeType = candidate.mimeType;
  const sizeBytes = candidate.sizeBytes;
  const dataUrl = candidate.dataUrl;
  const uploadToken = candidate.uploadToken;
  const expiresAt = candidate.expiresAt;
  const uploadState = candidate.uploadState;
  const hasDataUrl = typeof dataUrl === "string" && dataUrl.length > 0;
  const hasUploadToken = typeof uploadToken === "string" && uploadToken.length > 0;
  const isNeedsReattach = uploadState === "needsReattach";
  if (
    typeof id !== "string" ||
    (type !== undefined && type !== "image" && type !== "file") ||
    typeof name !== "string" ||
    typeof mimeType !== "string" ||
    typeof sizeBytes !== "number" ||
    !Number.isFinite(sizeBytes) ||
    id.length === 0 ||
    (!hasDataUrl && !hasUploadToken && !isNeedsReattach)
  ) {
    return null;
  }
  return {
    ...(type ? { type } : {}),
    id,
    name,
    mimeType,
    sizeBytes,
    ...(hasDataUrl ? { dataUrl } : {}),
    ...(hasUploadToken ? { uploadToken } : {}),
    ...(typeof expiresAt === "string" && expiresAt.length > 0 ? { expiresAt } : {}),
    ...(uploadState === "needsReattach" ? { uploadState } : {}),
  };
}

function normalizePersistedTerminalContextDraft(
  value: unknown,
): PersistedTerminalContextDraft | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const id = candidate.id;
  const threadId = candidate.threadId;
  const createdAt = candidate.createdAt;
  const lineStart = candidate.lineStart;
  const lineEnd = candidate.lineEnd;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof threadId !== "string" ||
    threadId.length === 0 ||
    typeof createdAt !== "string" ||
    createdAt.length === 0 ||
    typeof lineStart !== "number" ||
    !Number.isFinite(lineStart) ||
    typeof lineEnd !== "number" ||
    !Number.isFinite(lineEnd)
  ) {
    return null;
  }
  const terminalId = typeof candidate.terminalId === "string" ? candidate.terminalId.trim() : "";
  const terminalLabel =
    typeof candidate.terminalLabel === "string" ? candidate.terminalLabel.trim() : "";
  if (terminalId.length === 0 || terminalLabel.length === 0) {
    return null;
  }
  const normalizedLineStart = Math.max(1, Math.floor(lineStart));
  const normalizedLineEnd = Math.max(normalizedLineStart, Math.floor(lineEnd));
  return {
    id,
    threadId: threadId as ThreadId,
    createdAt,
    terminalId,
    terminalLabel,
    lineStart: normalizedLineStart,
    lineEnd: normalizedLineEnd,
  };
}

function normalizeDraftThreadEnvMode(
  value: unknown,
  fallbackWorktreePath: string | null,
): DraftThreadEnvMode {
  if (value === "local" || value === "worktree") {
    return value;
  }
  return fallbackWorktreePath ? "worktree" : "local";
}

export function projectDraftKey(projectRef: ScopedProjectRef): string {
  return scopedProjectKey(projectRef);
}

export function logicalProjectDraftKey(logicalProjectKey: string): string {
  return logicalProjectKey.trim();
}

/**
 * Runtime composer storage key for app-facing identities only.
 *
 * Draft sessions are keyed by `DraftId`. Real threads are keyed by
 * `ScopedThreadRef` so environment identity is always preserved.
 */
export function composerTargetKey(target: ScopedThreadRef | DraftId): string {
  if (typeof target === "string") {
    return target.trim();
  }
  return scopedThreadKey(target);
}

/**
 * Legacy persisted data may still be keyed by a raw `ThreadId`. This helper is
 * intentionally migration-only so live code cannot accidentally accept that
 * incomplete identity.
 */
function normalizeLegacyComposerStorageKey(
  threadKeyOrId: string,
  options?: {
    environmentId?: EnvironmentId;
  },
): string {
  const parsedThreadRef = parseScopedThreadKey(threadKeyOrId);
  if (parsedThreadRef) {
    return composerTargetKey(parsedThreadRef);
  }
  if (options?.environmentId) {
    return composerTargetKey(scopeThreadRef(options.environmentId, threadKeyOrId as ThreadId));
  }
  return threadKeyOrId;
}

function composerThreadRefFromKey(threadKey: string): ScopedThreadRef | null {
  return parseScopedThreadKey(threadKey);
}

function normalizePersistedDraftThreads(
  rawDraftThreadsByThreadId: unknown,
  rawProjectDraftThreadIdByProjectKey: unknown,
): Pick<
  PersistedComposerDraftStoreState,
  "draftThreadsByThreadKey" | "logicalProjectDraftThreadKeyByLogicalProjectKey"
> {
  const draftThreadsByThreadKey: Record<string, PersistedDraftThreadState> = {};
  const environmentIdByThreadId = new Map<ThreadId, EnvironmentId>();
  if (
    rawProjectDraftThreadIdByProjectKey &&
    typeof rawProjectDraftThreadIdByProjectKey === "object"
  ) {
    for (const [projectKey, threadId] of Object.entries(
      rawProjectDraftThreadIdByProjectKey as Record<string, unknown>,
    )) {
      if (typeof threadId !== "string" || threadId.length === 0) {
        continue;
      }
      const projectRef = parseScopedProjectKey(projectKey);
      if (!projectRef) {
        continue;
      }
      const parsedThreadRef = parseScopedThreadKey(threadId);
      if (parsedThreadRef) {
        environmentIdByThreadId.set(parsedThreadRef.threadId, parsedThreadRef.environmentId);
        continue;
      }
      environmentIdByThreadId.set(threadId as ThreadId, projectRef.environmentId);
    }
  }
  if (rawDraftThreadsByThreadId && typeof rawDraftThreadsByThreadId === "object") {
    for (const [threadKeyOrId, rawDraftThread] of Object.entries(
      rawDraftThreadsByThreadId as Record<string, unknown>,
    )) {
      if (typeof threadKeyOrId !== "string" || threadKeyOrId.length === 0) {
        continue;
      }
      if (!rawDraftThread || typeof rawDraftThread !== "object") {
        continue;
      }
      const candidateDraftThread = rawDraftThread as Record<string, unknown>;
      const parsedThreadRef = parseScopedThreadKey(threadKeyOrId);
      const threadKey = normalizeLegacyComposerStorageKey(threadKeyOrId);
      const threadId =
        parsedThreadRef?.threadId ??
        (typeof candidateDraftThread.threadId === "string" &&
        candidateDraftThread.threadId.length > 0
          ? (candidateDraftThread.threadId as ThreadId)
          : (threadKeyOrId as ThreadId));
      const environmentId =
        parsedThreadRef?.environmentId ??
        (typeof candidateDraftThread.environmentId === "string" &&
        candidateDraftThread.environmentId.length > 0
          ? (candidateDraftThread.environmentId as EnvironmentId)
          : environmentIdByThreadId.get(threadKeyOrId as ThreadId));
      const projectId = candidateDraftThread.projectId;
      const createdAt = candidateDraftThread.createdAt;
      const branch = candidateDraftThread.branch;
      const worktreePath = candidateDraftThread.worktreePath;
      const normalizedWorktreePath = typeof worktreePath === "string" ? worktreePath : null;
      const promotedToCandidate = candidateDraftThread.promotedTo;
      const promotedToRecord =
        promotedToCandidate && typeof promotedToCandidate === "object"
          ? (promotedToCandidate as Record<string, unknown>)
          : null;
      const promotedTo =
        promotedToRecord &&
        typeof promotedToRecord.environmentId === "string" &&
        promotedToRecord.environmentId.length > 0 &&
        typeof promotedToRecord.threadId === "string" &&
        promotedToRecord.threadId.length > 0
          ? scopeThreadRef(
              promotedToRecord.environmentId as EnvironmentId,
              promotedToRecord.threadId as ThreadId,
            )
          : null;
      if (typeof projectId !== "string" || projectId.length === 0 || environmentId === undefined) {
        continue;
      }
      const normalizedEnvironmentId = environmentId as EnvironmentId;
      draftThreadsByThreadKey[threadKey] = {
        threadId,
        environmentId: normalizedEnvironmentId,
        projectId: projectId as ProjectId,
        logicalProjectKey:
          typeof candidateDraftThread.logicalProjectKey === "string" &&
          candidateDraftThread.logicalProjectKey.length > 0
            ? candidateDraftThread.logicalProjectKey
            : parsedThreadRef
              ? projectDraftKey(scopeProjectRef(normalizedEnvironmentId, projectId as ProjectId))
              : threadKeyOrId,
        createdAt:
          typeof createdAt === "string" && createdAt.length > 0
            ? createdAt
            : new Date().toISOString(),
        runtimeMode: isRuntimeMode(candidateDraftThread.runtimeMode)
          ? candidateDraftThread.runtimeMode
          : DEFAULT_RUNTIME_MODE,
        interactionMode: isProviderInteractionMode(candidateDraftThread.interactionMode)
          ? candidateDraftThread.interactionMode
          : DEFAULT_INTERACTION_MODE,
        tokenMode: isAgentTokenMode(candidateDraftThread.tokenMode)
          ? candidateDraftThread.tokenMode
          : DEFAULT_AGENT_TOKEN_MODE,
        fetchOrigin:
          typeof candidateDraftThread.fetchOrigin === "boolean"
            ? candidateDraftThread.fetchOrigin
            : true,
        worktreeBranchName:
          typeof candidateDraftThread.worktreeBranchName === "string"
            ? candidateDraftThread.worktreeBranchName
            : null,
        branch: typeof branch === "string" ? branch : null,
        worktreePath: normalizedWorktreePath,
        envMode: normalizeDraftThreadEnvMode(candidateDraftThread.envMode, normalizedWorktreePath),
        promotedTo,
      };
    }
  }

  const logicalProjectDraftThreadKeyByLogicalProjectKey: Record<string, string> = {};
  if (
    rawProjectDraftThreadIdByProjectKey &&
    typeof rawProjectDraftThreadIdByProjectKey === "object"
  ) {
    for (const [logicalProjectKey, threadKeyOrId] of Object.entries(
      rawProjectDraftThreadIdByProjectKey as Record<string, unknown>,
    )) {
      if (typeof threadKeyOrId !== "string" || threadKeyOrId.length === 0) {
        continue;
      }
      const projectRef = parseScopedProjectKey(logicalProjectKey);
      const parsedThreadRef = parseScopedThreadKey(threadKeyOrId);
      const threadKey = normalizeLegacyComposerStorageKey(threadKeyOrId);
      logicalProjectDraftThreadKeyByLogicalProjectKey[logicalProjectKey] = threadKey;
      if (parsedThreadRef) {
        environmentIdByThreadId.set(parsedThreadRef.threadId, parsedThreadRef.environmentId);
      }
      if (!projectRef) {
        const existingDraftThread = draftThreadsByThreadKey[threadKey];
        if (existingDraftThread && !existingDraftThread.logicalProjectKey) {
          draftThreadsByThreadKey[threadKey] = {
            ...existingDraftThread,
            logicalProjectKey,
          };
        }
        continue;
      }
      if (!draftThreadsByThreadKey[threadKey]) {
        draftThreadsByThreadKey[threadKey] = {
          threadId: parsedThreadRef?.threadId ?? (threadKey as ThreadId),
          environmentId: projectRef.environmentId,
          projectId: projectRef.projectId,
          logicalProjectKey,
          createdAt: new Date().toISOString(),
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_INTERACTION_MODE,
          tokenMode: DEFAULT_AGENT_TOKEN_MODE,
          branch: null,
          worktreePath: null,
          envMode: "local",
          promotedTo: null,
        };
      } else if (
        draftThreadsByThreadKey[threadKey]?.projectId !== projectRef.projectId ||
        draftThreadsByThreadKey[threadKey]?.environmentId !== projectRef.environmentId
      ) {
        draftThreadsByThreadKey[threadKey] = {
          ...draftThreadsByThreadKey[threadKey]!,
          threadId: draftThreadsByThreadKey[threadKey]!.threadId,
          environmentId: projectRef.environmentId,
          projectId: projectRef.projectId,
          logicalProjectKey,
        };
      }
    }
  }

  return { draftThreadsByThreadKey, logicalProjectDraftThreadKeyByLogicalProjectKey };
}

function normalizePersistedDraftsByThreadId(
  rawDraftMap: unknown,
  draftThreadsByThreadKey: PersistedComposerDraftStoreState["draftThreadsByThreadKey"],
): PersistedComposerDraftStoreState["draftsByThreadKey"] {
  if (!rawDraftMap || typeof rawDraftMap !== "object") {
    return {};
  }

  const environmentIdByThreadId = new Map<ThreadId, EnvironmentId>();
  for (const [threadKey, draftThread] of Object.entries(draftThreadsByThreadKey)) {
    const parsedThreadRef = composerThreadRefFromKey(threadKey);
    if (!parsedThreadRef) {
      continue;
    }
    environmentIdByThreadId.set(
      parsedThreadRef.threadId,
      draftThread.environmentId as EnvironmentId,
    );
  }

  const nextDraftsByThreadKey: DeepMutable<PersistedComposerDraftStoreState["draftsByThreadKey"]> =
    {};
  for (const [threadKeyOrId, draftValue] of Object.entries(
    rawDraftMap as Record<string, unknown>,
  )) {
    if (typeof threadKeyOrId !== "string" || threadKeyOrId.length === 0) {
      continue;
    }
    if (!draftValue || typeof draftValue !== "object") {
      continue;
    }
    const draftCandidate = draftValue as PersistedComposerThreadDraftState;
    const promptCandidate = typeof draftCandidate.prompt === "string" ? draftCandidate.prompt : "";
    const attachments = Array.isArray(draftCandidate.attachments)
      ? draftCandidate.attachments.flatMap((entry) => {
          const normalized = normalizePersistedAttachment(entry);
          return normalized ? [normalized] : [];
        })
      : [];
    const terminalContexts = Array.isArray(draftCandidate.terminalContexts)
      ? draftCandidate.terminalContexts.flatMap((entry) => {
          const normalized = normalizePersistedTerminalContextDraft(entry);
          return normalized ? [normalized] : [];
        })
      : [];
    const runtimeMode = isRuntimeMode(draftCandidate.runtimeMode)
      ? draftCandidate.runtimeMode
      : null;
    const interactionMode = isProviderInteractionMode(draftCandidate.interactionMode)
      ? draftCandidate.interactionMode
      : null;
    const tokenMode = isAgentTokenMode(draftCandidate.tokenMode) ? draftCandidate.tokenMode : null;
    const prompt = ensureInlineTerminalContextPlaceholders(
      promptCandidate,
      terminalContexts.length,
    );
    // If the draft already has the v3 shape, use it directly
    const legacyDraftCandidate = draftValue as LegacyPersistedComposerThreadDraftState;
    let modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>> = {};
    let activeProvider: ProviderInstanceId | null = null;

    if (
      draftCandidate.modelSelectionByProvider &&
      typeof draftCandidate.modelSelectionByProvider === "object"
    ) {
      // v3 format
      modelSelectionByProvider = draftCandidate.modelSelectionByProvider as Partial<
        Record<ProviderInstanceId, ModelSelection>
      >;
      activeProvider = normalizeProviderInstanceId(draftCandidate.activeProvider);
    } else {
      // v2 or legacy format: migrate
      const normalizedModelOptions =
        normalizeProviderModelOptions(
          legacyDraftCandidate.modelOptions,
          undefined,
          legacyDraftCandidate,
        ) ?? null;
      const normalizedModelSelection = normalizeModelSelection(
        legacyDraftCandidate.modelSelection,
        {
          provider: legacyDraftCandidate.provider,
          model: legacyDraftCandidate.model,
          modelOptions: normalizedModelOptions ?? (legacyDraftCandidate.modelOptions as unknown),
          legacyCodex: legacyDraftCandidate,
        },
      );
      const mergedModelOptions = legacyMergeModelSelectionIntoProviderModelOptions(
        normalizedModelSelection,
        normalizedModelOptions,
      );
      const modelSelection = legacySyncModelSelectionOptions(
        normalizedModelSelection,
        mergedModelOptions,
      );
      modelSelectionByProvider = legacyToModelSelectionByProvider(
        modelSelection,
        mergedModelOptions,
      );
      activeProvider = modelSelection?.instanceId ?? null;
    }

    const hasModelData =
      Object.keys(modelSelectionByProvider).length > 0 || activeProvider !== null;
    if (
      promptCandidate.length === 0 &&
      attachments.length === 0 &&
      terminalContexts.length === 0 &&
      !hasModelData &&
      !runtimeMode &&
      !interactionMode &&
      !tokenMode
    ) {
      continue;
    }
    const parsedThreadRef = parseScopedThreadKey(threadKeyOrId);
    const normalizedThreadKey =
      parsedThreadRef !== null
        ? normalizeLegacyComposerStorageKey(threadKeyOrId)
        : draftThreadsByThreadKey[threadKeyOrId] !== undefined
          ? threadKeyOrId
          : (() => {
              const environmentId = environmentIdByThreadId.get(threadKeyOrId as ThreadId);
              return environmentId
                ? normalizeLegacyComposerStorageKey(threadKeyOrId, { environmentId })
                : threadKeyOrId;
            })();
    nextDraftsByThreadKey[normalizedThreadKey] = {
      prompt,
      attachments,
      ...(terminalContexts.length > 0 ? { terminalContexts } : {}),
      ...(hasModelData
        ? {
            modelSelectionByProvider: compactModelSelectionByProvider(modelSelectionByProvider),
            activeProvider,
          }
        : {}),
      ...(runtimeMode ? { runtimeMode } : {}),
      ...(interactionMode ? { interactionMode } : {}),
      ...(tokenMode ? { tokenMode } : {}),
    };
  }

  return nextDraftsByThreadKey;
}

export function migratePersistedComposerDraftStoreState(
  persistedState: unknown,
): PersistedComposerDraftStoreState {
  if (!persistedState || typeof persistedState !== "object") {
    return EMPTY_PERSISTED_DRAFT_STORE_STATE;
  }
  const candidate = persistedState as LegacyPersistedComposerDraftStoreState;
  const rawDraftMap = candidate.draftsByThreadKey ?? candidate.draftsByThreadId;
  const rawDraftThreadsByThreadId =
    candidate.draftThreadsByThreadKey ?? candidate.draftThreadsByThreadId;
  const rawProjectDraftThreadIdByProjectKey =
    candidate.logicalProjectDraftThreadKeyByLogicalProjectKey ??
    candidate.projectDraftThreadKeyByProjectKey ??
    candidate.projectDraftThreadIdByProjectKey ??
    candidate.projectDraftThreadIdByProjectId;

  // Migrate sticky state from v2 (dual) to v3 (consolidated)
  const stickyModelOptions = normalizeProviderModelOptions(candidate.stickyModelOptions) ?? {};
  const normalizedStickyModelSelection = normalizeModelSelection(candidate.stickyModelSelection, {
    provider: candidate.stickyProvider ?? "codex",
    model: candidate.stickyModel,
    modelOptions: stickyModelOptions,
  });
  const nextStickyModelOptions = legacyMergeModelSelectionIntoProviderModelOptions(
    normalizedStickyModelSelection,
    stickyModelOptions,
  );
  const stickyModelSelection = legacySyncModelSelectionOptions(
    normalizedStickyModelSelection,
    nextStickyModelOptions,
  );
  const stickyModelSelectionByProvider = legacyToModelSelectionByProvider(
    stickyModelSelection,
    nextStickyModelOptions,
  );
  const stickyActiveProvider = normalizeProviderInstanceId(candidate.stickyProvider) ?? null;

  const { draftThreadsByThreadKey, logicalProjectDraftThreadKeyByLogicalProjectKey } =
    normalizePersistedDraftThreads(rawDraftThreadsByThreadId, rawProjectDraftThreadIdByProjectKey);
  const draftsByThreadKey = normalizePersistedDraftsByThreadId(
    rawDraftMap,
    draftThreadsByThreadKey,
  );
  return {
    draftsByThreadKey,
    draftThreadsByThreadKey,
    logicalProjectDraftThreadKeyByLogicalProjectKey,
    stickyModelSelectionByProvider: compactModelSelectionByProvider(stickyModelSelectionByProvider),
    stickyActiveProvider,
  };
}

export function partializeComposerDraftStoreState<TImage extends ComposerDraftImage>(
  state: ComposerDraftStoreState<TImage>,
): PersistedComposerDraftStoreState {
  const persistedDraftsByThreadKey: DeepMutable<
    PersistedComposerDraftStoreState["draftsByThreadKey"]
  > = {};
  for (const [threadKey, draft] of Object.entries(state.draftsByThreadKey)) {
    if (typeof threadKey !== "string" || threadKey.length === 0) {
      continue;
    }
    const hasModelData =
      Object.keys(draft.modelSelectionByProvider).length > 0 || draft.activeProvider !== null;
    if (
      draft.prompt.length === 0 &&
      draft.persistedAttachments.length === 0 &&
      draft.terminalContexts.length === 0 &&
      !hasModelData &&
      draft.runtimeMode === null &&
      draft.interactionMode === null &&
      draft.tokenMode == null
    ) {
      continue;
    }
    const persistedDraft: DeepMutable<PersistedComposerThreadDraftState> = {
      prompt: draft.prompt,
      attachments: draft.persistedAttachments,
      ...(draft.terminalContexts.length > 0
        ? {
            terminalContexts: draft.terminalContexts.map((context) => ({
              id: context.id,
              threadId: context.threadId,
              createdAt: context.createdAt,
              terminalId: context.terminalId,
              terminalLabel: context.terminalLabel,
              lineStart: context.lineStart,
              lineEnd: context.lineEnd,
            })),
          }
        : {}),
      ...(hasModelData
        ? {
            modelSelectionByProvider: compactModelSelectionByProvider(
              draft.modelSelectionByProvider,
            ),
            activeProvider: draft.activeProvider,
          }
        : {}),
      ...(draft.runtimeMode ? { runtimeMode: draft.runtimeMode } : {}),
      ...(draft.interactionMode ? { interactionMode: draft.interactionMode } : {}),
      ...(draft.tokenMode ? { tokenMode: draft.tokenMode } : {}),
    };
    persistedDraftsByThreadKey[threadKey] = persistedDraft;
  }
  return {
    draftsByThreadKey: persistedDraftsByThreadKey,
    draftThreadsByThreadKey: state.draftThreadsByThreadKey,
    logicalProjectDraftThreadKeyByLogicalProjectKey:
      state.logicalProjectDraftThreadKeyByLogicalProjectKey,
    stickyModelSelectionByProvider: compactModelSelectionByProvider(
      state.stickyModelSelectionByProvider,
    ),
    stickyActiveProvider: state.stickyActiveProvider,
  };
}

export function normalizeCurrentPersistedComposerDraftStoreState(
  persistedState: unknown,
): PersistedComposerDraftStoreState {
  if (!persistedState || typeof persistedState !== "object") {
    return EMPTY_PERSISTED_DRAFT_STORE_STATE;
  }
  const normalizedPersistedState = persistedState as LegacyPersistedComposerDraftStoreState;
  const { draftThreadsByThreadKey, logicalProjectDraftThreadKeyByLogicalProjectKey } =
    normalizePersistedDraftThreads(
      normalizedPersistedState.draftThreadsByThreadKey ??
        normalizedPersistedState.draftThreadsByThreadId,
      normalizedPersistedState.logicalProjectDraftThreadKeyByLogicalProjectKey ??
        normalizedPersistedState.projectDraftThreadKeyByProjectKey ??
        normalizedPersistedState.projectDraftThreadIdByProjectKey ??
        normalizedPersistedState.projectDraftThreadIdByProjectId,
    );

  // Handle both v3 (modelSelectionByProvider) and v2/legacy formats
  let stickyModelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>> = {};
  let stickyActiveProvider: ProviderInstanceId | null = null;
  if (
    normalizedPersistedState.stickyModelSelectionByProvider &&
    typeof normalizedPersistedState.stickyModelSelectionByProvider === "object"
  ) {
    stickyModelSelectionByProvider =
      normalizedPersistedState.stickyModelSelectionByProvider as Partial<
        Record<ProviderInstanceId, ModelSelection>
      >;
    stickyActiveProvider = normalizeProviderInstanceId(
      normalizedPersistedState.stickyActiveProvider,
    );
  } else {
    // Legacy migration path
    const stickyModelOptions =
      normalizeProviderModelOptions(normalizedPersistedState.stickyModelOptions) ?? {};
    const normalizedStickyModelSelection = normalizeModelSelection(
      normalizedPersistedState.stickyModelSelection,
      {
        provider: normalizedPersistedState.stickyProvider,
        model: normalizedPersistedState.stickyModel,
        modelOptions: stickyModelOptions,
      },
    );
    const nextStickyModelOptions = legacyMergeModelSelectionIntoProviderModelOptions(
      normalizedStickyModelSelection,
      stickyModelOptions,
    );
    const stickyModelSelection = legacySyncModelSelectionOptions(
      normalizedStickyModelSelection,
      nextStickyModelOptions,
    );
    stickyModelSelectionByProvider = legacyToModelSelectionByProvider(
      stickyModelSelection,
      nextStickyModelOptions,
    );
    stickyActiveProvider = normalizeProviderInstanceId(normalizedPersistedState.stickyProvider);
  }

  return {
    draftsByThreadKey: normalizePersistedDraftsByThreadId(
      normalizedPersistedState.draftsByThreadKey ?? normalizedPersistedState.draftsByThreadId,
      draftThreadsByThreadKey,
    ),
    draftThreadsByThreadKey,
    logicalProjectDraftThreadKeyByLogicalProjectKey,
    stickyModelSelectionByProvider: compactModelSelectionByProvider(stickyModelSelectionByProvider),
    stickyActiveProvider,
  };
}

/**
 * Rehydrates the neutral persisted attachments (dataURL-encoded) into the
 * app's in-memory image representation. The web adapter decodes the dataURL to
 * a DOM `File` at this boundary; the package never touches `File`/`Blob`.
 */
export type HydrateComposerImages<TImage extends ComposerDraftImage> = (
  attachments: ReadonlyArray<PersistedComposerImageAttachment>,
) => TImage[];

export function toHydratedThreadDraft<TImage extends ComposerDraftImage>(
  persistedDraft: PersistedComposerThreadDraftState,
  hydrateImages: HydrateComposerImages<TImage>,
): ComposerThreadDraftState<TImage> {
  // The persisted draft is already in v3 shape (migration handles older formats)
  const modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>> =
    persistedDraft.modelSelectionByProvider ?? {};
  const activeProvider = normalizeProviderInstanceId(persistedDraft.activeProvider) ?? null;

  return {
    prompt: persistedDraft.prompt,
    images: hydrateImages(persistedDraft.attachments),
    nonPersistedImageIds: [],
    persistedAttachments: [...persistedDraft.attachments],
    terminalContexts:
      persistedDraft.terminalContexts?.map((context) => ({
        ...context,
        text: "",
      })) ?? [],
    sourceControlContexts: [],
    modelSelectionByProvider,
    activeProvider,
    runtimeMode: persistedDraft.runtimeMode ?? null,
    interactionMode: persistedDraft.interactionMode ?? null,
    tokenMode: persistedDraft.tokenMode ?? null,
  };
}

export function toHydratedDraftThreadState(
  persistedDraftThread: PersistedDraftThreadState,
): DraftThreadState {
  return {
    threadId: persistedDraftThread.threadId,
    environmentId: persistedDraftThread.environmentId as EnvironmentId,
    projectId: persistedDraftThread.projectId,
    logicalProjectKey:
      persistedDraftThread.logicalProjectKey ??
      projectDraftKey(
        scopeProjectRef(
          persistedDraftThread.environmentId as EnvironmentId,
          persistedDraftThread.projectId,
        ),
      ),
    createdAt: persistedDraftThread.createdAt,
    runtimeMode: persistedDraftThread.runtimeMode,
    interactionMode: persistedDraftThread.interactionMode,
    tokenMode: persistedDraftThread.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
    fetchOrigin: persistedDraftThread.fetchOrigin ?? true,
    worktreeBranchName: persistedDraftThread.worktreeBranchName ?? null,
    branch: persistedDraftThread.branch,
    worktreePath: persistedDraftThread.worktreePath,
    envMode: persistedDraftThread.envMode,
    promotedTo: persistedDraftThread.promotedTo
      ? scopeThreadRef(
          persistedDraftThread.promotedTo.environmentId as EnvironmentId,
          persistedDraftThread.promotedTo.threadId as ThreadId,
        )
      : null,
  };
}
