import {
  BotIcon,
  CircleCheckIcon,
  CloudUploadIcon,
  FileDiffIcon,
  FolderGit2Icon,
  GitBranchIcon,
  GitPullRequestIcon,
  NotebookPenIcon,
  SparklesIcon,
  type LucideIcon,
} from "lucide-react";

/**
 * The Crown rail's single section registry. The rail, the card's spine, the
 * hover flyout and the card title all read from this list, so adding a
 * section is one entry here plus its detail view.
 */

/** A detail view the card / flyout can show. */
export type CrownSection =
  | "branch"
  | "changes"
  | "checks"
  | "plan"
  | "agents"
  | "pr"
  | "notes"
  | "project";

/** A rail button. `ship` (push) opens the branch section. */
export type CrownRailKey = CrownSection | "ship";

/** Alert and ping colours; each maps to a CSS variable in {@link CROWN_TONE_VAR}. */
export type CrownTone =
  | "success"
  | "danger"
  | "warning"
  | "info"
  | "plan"
  | "agent"
  | "note"
  | "neutral";

/** How a rail button draws its glyph. */
export type CrownGlyphKind = "icon" | "checkRing" | "planArc";

export interface CrownRailItem {
  readonly key: CrownRailKey;
  readonly section: CrownSection;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly glyph: CrownGlyphKind;
  /** Rail group; a separator renders where the group changes. */
  readonly group: "status" | "tools";
  /** Source-control sections are meaningless outside a git repository. */
  readonly requiresGit: boolean;
  /** Notes ride on the server's `worktreeNotes` capability (Stage 2). */
  readonly requiresNotes: boolean;
  /** Only a "No project" chat this client can turn into a project offers it. */
  readonly requiresChat?: boolean;
}

export const CROWN_RAIL_ITEMS: ReadonlyArray<CrownRailItem> = [
  {
    key: "branch",
    section: "branch",
    label: "Branch",
    icon: GitBranchIcon,
    glyph: "icon",
    group: "status",
    requiresGit: true,
    requiresNotes: false,
  },
  {
    key: "changes",
    section: "changes",
    label: "Changes",
    icon: FileDiffIcon,
    glyph: "icon",
    group: "status",
    requiresGit: true,
    requiresNotes: false,
  },
  {
    key: "checks",
    section: "checks",
    label: "Checks",
    icon: CircleCheckIcon,
    glyph: "checkRing",
    group: "status",
    requiresGit: true,
    requiresNotes: false,
  },
  {
    key: "plan",
    section: "plan",
    label: "Plan",
    icon: SparklesIcon,
    glyph: "planArc",
    group: "status",
    requiresGit: false,
    requiresNotes: false,
  },
  {
    key: "agents",
    section: "agents",
    label: "Subagents",
    icon: BotIcon,
    glyph: "icon",
    group: "status",
    requiresGit: false,
    requiresNotes: false,
  },
  {
    key: "pr",
    section: "pr",
    label: "Pull request",
    icon: GitPullRequestIcon,
    glyph: "icon",
    group: "status",
    requiresGit: true,
    requiresNotes: false,
  },
  {
    key: "notes",
    section: "notes",
    label: "Notes",
    icon: NotebookPenIcon,
    glyph: "icon",
    group: "tools",
    requiresGit: false,
    requiresNotes: true,
  },
  {
    key: "project",
    section: "project",
    label: "Turn into project",
    icon: FolderGit2Icon,
    glyph: "icon",
    group: "tools",
    requiresGit: false,
    requiresNotes: false,
    requiresChat: true,
  },
  {
    key: "ship",
    section: "branch",
    label: "Push",
    icon: CloudUploadIcon,
    glyph: "icon",
    group: "tools",
    requiresGit: true,
    requiresNotes: false,
  },
];

/** Each section's title: the label of the rail item that owns it. */
export const CROWN_SECTION_LABEL = Object.fromEntries(
  CROWN_RAIL_ITEMS.filter((item) => item.key === item.section).map((item) => [
    item.section,
    item.label,
  ]),
) as Readonly<Record<CrownSection, string>>;

/** CSS colour for each tone. `--crown-*` tokens are declared on the island root. */
export const CROWN_TONE_VAR: Readonly<Record<CrownTone, string>> = {
  success: "var(--success)",
  danger: "var(--destructive)",
  warning: "var(--warning)",
  info: "var(--info)",
  plan: "var(--crown-plan)",
  agent: "var(--crown-agent)",
  note: "var(--crown-note)",
  neutral: "var(--muted-foreground)",
};

export function crownSectionForRailKey(key: CrownRailKey): CrownSection {
  return key === "ship" ? "branch" : key;
}

/** Rail items that apply to this thread, in rail order. */
export function visibleCrownRailItems(input: {
  readonly isGitRepo: boolean;
  readonly notesAvailable: boolean;
  /** The thread is a "No project" chat this client can turn into a project. */
  readonly chatAvailable?: boolean;
}): ReadonlyArray<CrownRailItem> {
  return CROWN_RAIL_ITEMS.filter(
    (item) =>
      (!item.requiresGit || input.isGitRepo) &&
      (!item.requiresNotes || input.notesAvailable) &&
      (!item.requiresChat || input.chatAvailable === true),
  );
}
