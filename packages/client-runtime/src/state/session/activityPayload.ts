import type {
  EnvironmentApi,
  EnvironmentId,
  OrchestrationGetActivityPayloadResult,
  ThreadId,
} from "@ryco/contracts";
import { EventId } from "@ryco/contracts/base-schemas";

import {
  createKeyedQueryRegistry,
  defineKeyedQueryByKey,
  KEY_SEP,
  type KeyedQueryByKey,
} from "../../rpc/keyedQuery.ts";
import { deriveActivityPayloadOutput, mergeLoadedChangedFiles } from "./session-logic.ts";

/** Stored activity payloads never change, so a fetched one stays fresh until collected. */
export const ACTIVITY_PAYLOAD_STALE_TIME_MS = Number.POSITIVE_INFINITY;
/** Long enough to collapse and reopen a row without a refetch, short enough to drop MBs of output. */
export const ACTIVITY_PAYLOAD_GC_TIME_MS = 2 * 60_000;
export const ACTIVITY_PAYLOAD_MAX_ENTRIES = 16;

export interface ActivityPayloadQueryState {
  readonly data: OrchestrationGetActivityPayloadResult | null;
  readonly isLoading: boolean;
  readonly error: Error | null;
}

export interface ActivityPayloadInput {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly activityId: string | null;
}

export type ActivityPayloadQuery = KeyedQueryByKey<
  ActivityPayloadInput,
  OrchestrationGetActivityPayloadResult,
  ActivityPayloadQueryState
>;

const INITIAL_QUERY_STATE: ActivityPayloadQueryState = Object.freeze({
  data: null,
  isLoading: false,
  error: null,
});

/**
 * The stored payload of an activity a thread window sent as a preview, read
 * when its row expands (`orchestration.getActivityPayload`). Each app builds
 * one over its own environment API lookup; the lookup runs per request, never
 * at module load.
 */
export function createActivityPayloadQuery(options: {
  readonly resolveGetActivityPayload: (
    environmentId: EnvironmentId,
  ) => EnvironmentApi["orchestration"]["getActivityPayload"];
}): { readonly query: ActivityPayloadQuery; readonly resetForTests: () => void } {
  const registry = createKeyedQueryRegistry<ActivityPayloadQueryState>({
    labelPrefix: "activity-payload",
    initialState: INITIAL_QUERY_STATE,
    gcTime: ACTIVITY_PAYLOAD_GC_TIME_MS,
    maxEntries: ACTIVITY_PAYLOAD_MAX_ENTRIES,
    buildFetchingState: (current) => ({
      data: current.data,
      isLoading: current.data === null,
      error: null,
    }),
    buildSuccessState: (data) => ({
      data: data as OrchestrationGetActivityPayloadResult,
      isLoading: false,
      error: null,
    }),
    buildErrorState: (current, error) => ({ data: current.data, isLoading: false, error }),
    isErrorState: (state) => state.error !== null,
  });
  const query: ActivityPayloadQuery = defineKeyedQueryByKey(
    registry,
    {
      label: "activityPayload",
      staleTime: ACTIVITY_PAYLOAD_STALE_TIME_MS,
      isEnabled: (input: ActivityPayloadInput) =>
        input.environmentId !== null && input.threadId !== null && input.activityId !== null,
      buildKey: (input: ActivityPayloadInput) =>
        `${input.environmentId}${KEY_SEP}${input.threadId}${KEY_SEP}${input.activityId}`,
      resolveEnvironmentId: (input: ActivityPayloadInput) => input.environmentId as EnvironmentId,
      run: (input: ActivityPayloadInput) => {
        const read = options.resolveGetActivityPayload(input.environmentId as EnvironmentId);
        if (!read) {
          return Promise.reject(new Error("This environment cannot load full tool output."));
        }
        return read({
          threadId: input.threadId as ThreadId,
          activityId: EventId.make(input.activityId as string),
        });
      },
      createControllerFields: () => ({}),
    },
    (controller) => !controller.hasData,
  );
  return { query, resetForTests: () => registry.resetForTests() };
}

export interface ActivityPayloadOutputView {
  readonly status: "idle" | "loading" | "loaded" | "error";
  /** The full output, once loaded; null while only the preview is available. */
  readonly output: string | null;
  readonly exitCode: number | null;
  /** The full payload's changed files, once loaded; empty until then. */
  readonly changedFiles: ReadonlyArray<string>;
  /** The stored payload was still larger than one response, so `output` is cut short too. */
  readonly truncated: boolean;
}

const NO_CHANGED_FILES: ReadonlyArray<string> = Object.freeze([]);

const IDLE_ACTIVITY_PAYLOAD_OUTPUT: ActivityPayloadOutputView = Object.freeze({
  status: "idle",
  output: null,
  exitCode: null,
  changedFiles: NO_CHANGED_FILES,
  truncated: false,
});

/**
 * What an expanded work entry shows for a payload fetched in full: idle when no
 * request applies (`cacheKey` null: the entry's output is already complete),
 * loading or error until the payload arrives, then its output and exit code.
 */
export function resolveActivityPayloadOutputView(
  cacheKey: string | null,
  state: ActivityPayloadQueryState,
): ActivityPayloadOutputView {
  if (cacheKey === null) return IDLE_ACTIVITY_PAYLOAD_OUTPUT;
  if (state.data) {
    const derived = deriveActivityPayloadOutput(state.data.payload);
    return {
      status: "loaded",
      output: derived.output,
      exitCode: derived.exitCode,
      changedFiles: derived.changedFiles,
      truncated: state.data.truncated,
    };
  }
  return {
    status: state.error ? "error" : "loading",
    output: null,
    exitCode: null,
    changedFiles: NO_CHANGED_FILES,
    truncated: false,
  };
}

/**
 * The changed files an expanded work entry lists: its own until the full
 * payload loads, then completed from the payload, since a preview of a large
 * edit keeps only its first few changes.
 */
export function resolveActivityChangedFiles(
  entryChangedFiles: ReadonlyArray<string>,
  view: ActivityPayloadOutputView,
): ReadonlyArray<string> {
  if (view.status !== "loaded") return entryChangedFiles;
  return mergeLoadedChangedFiles(entryChangedFiles, view.changedFiles);
}
