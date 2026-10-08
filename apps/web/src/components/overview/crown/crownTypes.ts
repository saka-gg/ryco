import type { OrchestrationLatestTurnState } from "@ryco/contracts";
import type { ReactNode } from "react";

import type { Project } from "../../../types";
import type { WorktreeNotes } from "../notes/useWorktreeNotes";
import type { OverviewDataReadiness, OverviewLayoutProps } from "../overviewTypes";
import type { CrownSection } from "./crownSections";

/** The thread's worktree notes as the crown renders them (`useWorktreeNotes`). */
export type CrownNotesBinding = WorktreeNotes;

/** The project whose logo the crown face shows (`ProjectFavicon` inputs). */
export type CrownProject = Pick<
  Project,
  "id" | "environmentId" | "name" | "cwd" | "customAvatarContentHash"
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
  /** A user-started git action (commit/push/PR) is in flight; it already toasts. */
  readonly userGitActionActive: boolean;
  /** Worktree notes; the Notes icon shows only while `notes.available`. */
  readonly notes?: CrownNotesBinding | undefined;
  /** The thread's project; the face shows its logo (a folder without one). */
  readonly project?: CrownProject | null | undefined;
}

/** Props of the shared section detail used by both the hover flyout and the card. */
export interface CrownSectionDetailProps {
  readonly section: Exclude<CrownSection, "notes">;
  /**
   * Flyouts are read-only previews with a heading row; the card titles the
   * section itself and hosts the interactive controls.
   */
  readonly variant: "flyout" | "card";
  readonly layout: OverviewLayoutProps;
  readonly isGitRepo: boolean;
}
