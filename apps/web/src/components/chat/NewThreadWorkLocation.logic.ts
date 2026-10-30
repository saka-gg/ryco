/**
 * Pure logic behind the new-thread "Work in …" sentence.
 *
 * A draft can target three places, and the underlying state already expresses
 * all three — the pairing of `envMode` and `worktreePath` is just not obvious
 * from either field alone:
 *
 * | target           | envMode    | worktreePath | branch          |
 * |------------------|------------|--------------|-----------------|
 * | project root     | "local"    | null         | current checkout|
 * | existing worktree| "local"    | "/path"      | that worktree's |
 * | a new worktree   | "worktree" | null         | base to fork    |
 *
 * This module names that mapping in one place so the sentence, its popover,
 * and the send path can't drift apart.
 */

export type WorkLocationKind = "projectRoot" | "existingWorktree" | "newWorktree";

export interface WorktreeChoice {
  readonly worktreeId: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly title: string | null;
}

export interface WorkLocation {
  readonly kind: WorkLocationKind;
  /** Set only for `existingWorktree`. */
  readonly worktree: WorktreeChoice | null;
}

export interface WorkLocationDraft {
  readonly envMode: "local" | "worktree";
  readonly worktreePath: string | null;
}

/** Reads the draft's current target back out of the `envMode`/path pairing. */
export function resolveWorkLocation(input: {
  readonly draft: WorkLocationDraft;
  readonly worktrees: ReadonlyArray<WorktreeChoice>;
}): WorkLocation {
  const { draft, worktrees } = input;
  if (draft.worktreePath) {
    const match = worktrees.find((worktree) => worktree.worktreePath === draft.worktreePath);
    return {
      kind: "existingWorktree",
      // A path with no matching summary still means "an existing worktree" —
      // synthesize a choice so the sentence names the directory rather than
      // silently falling back to "project root" and lying about where the
      // turn will run.
      worktree: match ?? {
        worktreeId: draft.worktreePath,
        worktreePath: draft.worktreePath,
        branch: "",
        title: null,
      },
    };
  }
  if (draft.envMode === "worktree") {
    return { kind: "newWorktree", worktree: null };
  }
  return { kind: "projectRoot", worktree: null };
}

/**
 * The draft-context patch that moves a draft to the given target.
 *
 * Both non-worktree targets clear `worktreeSource`: a recorded PR / issue /
 * work item is an instruction to create a worktree on send, so leaving one
 * behind would materialize a worktree for a draft the user just pointed at an
 * existing checkout.
 */
export function workLocationDraftPatch(location: WorkLocation): {
  readonly envMode: "local" | "worktree";
  readonly worktreePath: string | null;
  readonly branch?: string | null;
  readonly worktreeSource?: null;
} {
  switch (location.kind) {
    case "existingWorktree":
      return {
        envMode: "local",
        worktreePath: location.worktree?.worktreePath ?? null,
        branch: location.worktree?.branch || null,
        worktreeSource: null,
      };
    case "newWorktree":
      // Branch and source are deliberately left alone: in worktree mode they
      // are the base to fork from, and whichever the user already picked stays
      // valid.
      return { envMode: "worktree", worktreePath: null };
    case "projectRoot":
      // Clearing the branch lets the toolbar re-read the checkout that is
      // actually live in the project directory.
      return { envMode: "local", worktreePath: null, branch: null, worktreeSource: null };
  }
}

/** Short label for a worktree, preferring its title over the raw branch. */
export function worktreeChoiceLabel(worktree: WorktreeChoice): string {
  const title = worktree.title?.trim();
  if (title) return title;
  const branch = worktree.branch.trim();
  if (branch) return branch;
  const segments = worktree.worktreePath.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? worktree.worktreePath;
}

/** The bold token rendered in the sentence for the current target. */
export function workLocationLabel(location: WorkLocation): string {
  switch (location.kind) {
    case "existingWorktree":
      return location.worktree ? worktreeChoiceLabel(location.worktree) : "a worktree";
    case "newWorktree":
      return "a new worktree";
    case "projectRoot":
      return "the project root";
  }
}

/**
 * Whether the sentence shows a `from <branch>` slot.
 *
 * An existing worktree is already checked out to its own branch, so offering a
 * source there would be a control that does nothing — the slot is dropped
 * rather than disabled.
 */
export function showsBranchSlot(location: WorkLocation): boolean {
  return location.kind !== "existingWorktree";
}

/**
 * The connective before the branch token. "from" reads as forking a new
 * worktree; "on" reads as working directly on a checkout.
 */
export function branchSlotPreposition(location: WorkLocation): "from" | "on" {
  return location.kind === "newWorktree" ? "from" : "on";
}
