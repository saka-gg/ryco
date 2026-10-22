import type { OrchestrationLatestTurnState } from "@ryco/contracts";
import type { ReactNode } from "react";

import type { GitActionNotice } from "../../../gitActionNotices";
import type { GitShipStep } from "../../GitActionsControl.logic";
import type { Project } from "../../../types";
import type { WorktreeNotes } from "../notes/useWorktreeNotes";
import type { OverviewDataReadiness, OverviewLayoutProps } from "../overviewTypes";
import type { CrownSection } from "./crownSections";

/** The thread's worktree notes as the crown renders them (`useWorktreeNotes`). */
export type CrownNotesBinding = WorktreeNotes;

/**
 * A "No project" chat the crown offers to turn into a project, in place of
 * its source-control sections (`usePromoteChatBinding`).
 */
export interface CrownChatBinding {
  /** Opens the "Turn into project…" dialog, growing out of `origin`. */
  readonly turnIntoProject: (origin: HTMLElement) => void;
  /** Starts loading the dialog ahead of a likely open. */
  readonly preload: () => void;
}

/** Where the Ship button is: waiting out its grace period, or running its steps. */
export type CrownShipPhase = "idle" | "arming" | "running";

/**
 * The rail's one-click Ship button, bound to the thread's checkout
 * (`useCrownShipBinding`): commit, push, pull request and a pull in front when
 * behind, as one chain. Clicking arms it; the chain starts after a short grace
 * that a second click or Escape cancels.
 */
export interface CrownShipBinding {
  /** What a click runs now; empty when nothing can ship. */
  readonly steps: ReadonlyArray<GitShipStep>;
  /** The steps as one phrase ("Commit, push & create PR"). */
  readonly label: string;
  /** Why nothing can ship (up to date, diverged, another action running). */
  readonly disabledReason: string | null;
  /** The provider's short name for a pull request ("PR", "MR"). */
  readonly changeRequestLabel: string;
  readonly phase: CrownShipPhase;
  /** The steps of the run in progress, frozen at the click. */
  readonly runSteps: ReadonlyArray<GitShipStep>;
  /** The step running now; null while arming. */
  readonly activeStep: GitShipStep | null;
  /** A short note per step ("3 files", "2 incoming"), frozen while a run is in flight. */
  readonly stepDetails: Readonly<Record<GitShipStep, string>>;
  /** Arms the chain; called again during the grace, it cancels instead. */
  readonly ship: () => void;
  /** The next run's commit message; empty lets the server write one. */
  readonly commitMessage: string;
  readonly setCommitMessage: (message: string) => void;
  /** Commits on its own, while there is something to commit. */
  readonly commitOnly: (() => void) | null;
  /** Pulls on its own, while the branch is behind. */
  readonly pull: (() => void) | null;
  /** Opens the branch's open pull request. */
  readonly openPullRequest: (() => void) | null;
}

/**
 * The project whose logo the crown face shows (`ProjectFavicon` inputs); its
 * `kind` tells a chat's folder project apart (`@ryco/shared/projectKind`).
 */
export type CrownProject = Pick<
  Project,
  "id" | "environmentId" | "name" | "cwd" | "customAvatarContentHash" | "kind"
>;

/** The slice of the thread's latest turn the crown watches for "turn finished" alerts. */
export interface CrownTurnInput {
  readonly turnId: string;
  readonly state: OrchestrationLatestTurnState;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

/** Everything the Crown presenter renders: the classic overview data plus crown-only inputs. */
export interface CrownOverviewProps extends OverviewLayoutProps {
  /** Computer-beta / background-browser previews (local environment only). */
  readonly preview?: ReactNode;
  readonly threadTitle: string;
  /** Which live data has answered; alerts only compare values that have. */
  readonly readiness: OverviewDataReadiness;
  /** Hides branch/changes/checks/PR/push outside a git repository. */
  readonly isGitRepo: boolean;
  readonly latestTurn: CrownTurnInput | null;
  /** `isLatestTurnSettled(...)` for the latest turn. */
  readonly turnSettled: boolean;
  /** Session phase is "running". */
  readonly agentRunning: boolean;
  /** Stable key for the thread + checkout; a change re-baselines alerts silently. */
  readonly scopeKey: string;
  /** A user-started git action (commit/push/PR) is in flight; it reports itself. */
  readonly userGitActionActive: boolean;
  /** The checkout's latest git action notice while this crown presents them (in place of toasts). */
  readonly gitNotice?: GitActionNotice | null | undefined;
  /** Worktree notes; the Notes icon shows only while `notes.available`. */
  readonly notes?: CrownNotesBinding | undefined;
  /** Set for a chat this client can promote: the rail shows "Turn into project". */
  readonly chat?: CrownChatBinding | undefined;
  /** The checkout's one-click Ship button; without it the rail's Ship icon opens the branch card. */
  readonly ship?: CrownShipBinding | undefined;
  /** The thread's project; the face shows its logo (a folder without one). */
  readonly project?: CrownProject | null | undefined;
  /**
   * The thread is a "No project" chat, sent or not yet (an unsent chat has no
   * project): the face shows the chat glyph instead of a project logo.
   */
  readonly isChat?: boolean | undefined;
}

/** Props of the shared section detail used by both the hover flyout and the card. */
export interface CrownSectionDetailProps {
  /** Notes and a chat's "Turn into project" render from their own bindings. */
  readonly section: Exclude<CrownSection, "notes" | "project">;
  /**
   * Flyouts are read-only previews with a heading row; the card titles the
   * section itself and hosts the interactive controls.
   */
  readonly variant: "flyout" | "card";
  readonly layout: OverviewLayoutProps;
  readonly isGitRepo: boolean;
}
