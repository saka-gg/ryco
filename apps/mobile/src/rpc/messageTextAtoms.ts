// Whole texts of very long messages a thread window sent as previews, read
// when the reader asks for one or copies it. The query and its bounds are
// shared with web; only the environment API lookup is mobile's, and it
// resolves per request, never at module load.
import { createMessageTextQuery } from "@ryco/client-runtime/state/session";

import { ensureEnvironmentApi } from "../connection/environmentApi";

const messageText = createMessageTextQuery({
  resolveGetMessageText: (environmentId) =>
    ensureEnvironmentApi(environmentId).orchestration.getMessageText,
});

export const messageTextQuery = messageText.query;
export const resetMessageTextAtomsForTests = messageText.resetForTests;
