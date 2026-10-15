// Full payloads of activities the thread window sent as previews, read when a
// work row expands. The query and its bounds (16 retained payloads, collected
// two minutes after the row closes) are shared with web; only the environment
// API lookup is mobile's, and it resolves per request, never at module load.
import { createActivityPayloadQuery } from "@ryco/client-runtime/state/session";

import { ensureEnvironmentApi } from "../connection/environmentApi";

const activityPayload = createActivityPayloadQuery({
  resolveGetActivityPayload: (environmentId) =>
    ensureEnvironmentApi(environmentId).orchestration.getActivityPayload,
});

export const activityPayloadQuery = activityPayload.query;
export const resetActivityPayloadAtomsForTests = activityPayload.resetForTests;
