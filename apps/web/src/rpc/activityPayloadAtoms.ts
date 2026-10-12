import {
  EventId,
  type EnvironmentId,
  type OrchestrationGetActivityPayloadResult,
  type ThreadId,
} from "@ryco/contracts";
import {
  createKeyedQueryRegistry,
  defineKeyedQueryByKey,
  KEY_SEP,
  type KeyedQueryByKey,
} from "@ryco/client-runtime/rpc";

import { ensureEnvironmentApi } from "~/environmentApi";

/** Stored activity payloads never change, so a fetched one stays fresh until collected. */
const ACTIVITY_PAYLOAD_STALE_TIME_MS = Number.POSITIVE_INFINITY;
/** Long enough to collapse and reopen a row without a refetch, short enough to drop MBs of output. */
const ACTIVITY_PAYLOAD_GC_TIME_MS = 2 * 60_000;
const ACTIVITY_PAYLOAD_MAX_ENTRIES = 16;

export interface ActivityPayloadQueryState {
  readonly data: OrchestrationGetActivityPayloadResult | null;
  readonly isLoading: boolean;
  readonly error: Error | null;
}

const INITIAL_QUERY_STATE: ActivityPayloadQueryState = Object.freeze({
  data: null,
  isLoading: false,
  error: null,
});

const activityPayloadRegistry = createKeyedQueryRegistry<ActivityPayloadQueryState>({
  labelPrefix: "activity-payload",
  initialState: INITIAL_QUERY_STATE,
  gcTime: ACTIVITY_PAYLOAD_GC_TIME_MS,
  maxEntries: ACTIVITY_PAYLOAD_MAX_ENTRIES,
  buildFetchingState: (current) => ({ data: current.data, isLoading: current.data === null, error: null }),
  buildSuccessState: (data) => ({
    data: data as OrchestrationGetActivityPayloadResult,
    isLoading: false,
    error: null,
  }),
  buildErrorState: (current, error) => ({ data: current.data, isLoading: false, error }),
  isErrorState: (state) => state.error !== null,
});

export interface ActivityPayloadInput {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly activityId: string | null;
}

/**
 * The stored payload of an activity a thread window sent as a preview, read
 * when its row expands (`orchestration.getActivityPayload`).
 */
export const activityPayloadQuery: KeyedQueryByKey<
  ActivityPayloadInput,
  OrchestrationGetActivityPayloadResult,
  ActivityPayloadQueryState
> = defineKeyedQueryByKey(
  activityPayloadRegistry,
  {
    label: "activityPayload",
    staleTime: ACTIVITY_PAYLOAD_STALE_TIME_MS,
    isEnabled: (input) =>
      input.environmentId !== null && input.threadId !== null && input.activityId !== null,
    buildKey: (input) =>
      `${input.environmentId}${KEY_SEP}${input.threadId}${KEY_SEP}${input.activityId}`,
    resolveEnvironmentId: (input) => input.environmentId as EnvironmentId,
    run: (input) => {
      const read = ensureEnvironmentApi(input.environmentId as EnvironmentId).orchestration
        .getActivityPayload;
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

export function resetActivityPayloadAtomsForTests(): void {
  activityPayloadRegistry.resetForTests();
}
