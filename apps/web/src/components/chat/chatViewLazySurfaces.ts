import type { ComponentProps } from "react";

import { preloadableLazy, type PreloadableLazyComponent } from "../../lib/preloadableLazy";
import type { PullRequestThreadDialog } from "../PullRequestThreadDialog";
import type { ExpandedImageDialog } from "./ExpandedImageDialog";

/*
 * Conditional ChatView surfaces kept out of the chat route's first-frame
 * graph. Each loads the first time ChatView wants it (`useLazyComponentReady`
 * gates the mount, so no Suspense fallback ever commits) and renders
 * synchronously from then on. The overview panel module also carries the
 * crown, the plan sidebar and the git action controls; drafts and empty
 * threads never load it. The worktree dialogs ChatView also opens this way are
 * shared with the sidebar: see `worktrees/lazyWorktreeDialogs`.
 */

export const LazyChatOverviewPanel = preloadableLazy(() =>
  import("./ChatOverviewPanel").then((module) => module.ChatOverviewPanelWithControls),
);

export const LazySideChatPanel = preloadableLazy(() =>
  import("../SideChatPanel").then((module) => module.SideChatPanel),
);

export const LazyContextHandoffInspectionPanel = preloadableLazy(() =>
  import("./ContextHandoffInspectionPanel").then((module) => module.ContextHandoffInspectionPanel),
);

export const LazyComputerBetaPreview = preloadableLazy(() =>
  import("./ComputerBetaPreview").then((module) => module.ComputerBetaPreview),
);

// Annotated through the component type: its props interface is module-private.
export const LazyExpandedImageDialog: PreloadableLazyComponent<
  ComponentProps<typeof ExpandedImageDialog>
> = preloadableLazy(() =>
  import("./ExpandedImageDialog").then((module) => module.ExpandedImageDialog),
);

/**
 * Wanted on every non-phone thread, but only ever shows cards once an Agent
 * Control request is pending: it loads right after the first frame instead of
 * with it.
 */
export const LazyAgentControlApprovals = preloadableLazy(() =>
  import("../agent-control/AgentControlApprovals").then((module) => module.AgentControlApprovals),
);

/** The frozen phone tier's overview sheet; mounted on its first open and kept. */
export const LazyPhoneOverviewSheet = preloadableLazy(() =>
  import("../shell/phone/PhoneWorkSurface").then((module) => module.PhoneOverviewSheet),
);

// Annotated through the component type: its props interface is module-private.
export const LazyPullRequestThreadDialog: PreloadableLazyComponent<
  ComponentProps<typeof PullRequestThreadDialog>
> = preloadableLazy(() =>
  import("../PullRequestThreadDialog").then((module) => module.PullRequestThreadDialog),
);
