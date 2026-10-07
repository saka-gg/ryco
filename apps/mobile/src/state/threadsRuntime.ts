import { useComposerDraftStore } from "./composerDraftStore";
import {
  configureThreadsRuntime,
  setThreadsRuntimeConfigurator,
} from "@ryco/client-runtime/state/threads";

import { mobileClock, mobileFrameScheduler, mobileObservability } from "../platform";
import { getMobileEndpoint } from "../connection/runtimeConfig";

// Mobile binding of the threads runtime, mirroring apps/web/src/store.ts. The
// configurator is registered lazily (invoked on first runtime use) so this
// module has no import-time side effects. Hosted mode is inert in B1.
setThreadsRuntimeConfigurator(() => {
  configureThreadsRuntime({
    onCheckoutRelocated: (input) => useComposerDraftStore.getState().retargetCheckoutPath(input),
    clock: { now: () => mobileClock.now() },
    frameScheduler: {
      scheduleFrame: (callback) => mobileFrameScheduler.scheduleFrame(callback),
    },
    observability: mobileObservability,
    isHostedHubMode: () => false,
    resolveAttachmentPreviewUrl: ({ attachmentId }) =>
      getMobileEndpoint().resolveHttpUrl(`/attachments/${encodeURIComponent(attachmentId)}`),
  });
});

// Re-export the threads state surface so app screens import from one place,
// matching the web store module's role.
export * from "@ryco/client-runtime/state/threads";
