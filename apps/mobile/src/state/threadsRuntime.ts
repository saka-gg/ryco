import { useComposerDraftStore } from "./composerDraftStore";
import {
  configureThreadsRuntime,
  setThreadsRuntimeConfigurator,
} from "@ryco/client-runtime/state/threads";

import { mobileClock, mobileFrameScheduler, mobileObservability } from "../platform";

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
    // No URL reaches a message attachment from the phone: each paired or Hub
    // machine has its own authorized connection, and the app's credentials
    // never go into an image request. Attachments are read over that
    // connection instead (features/threads/attachmentFiles.ts).
    resolveAttachmentPreviewUrl: () => undefined,
  });
});

// Re-export the threads state surface so app screens import from one place,
// matching the web store module's role.
export * from "@ryco/client-runtime/state/threads";
