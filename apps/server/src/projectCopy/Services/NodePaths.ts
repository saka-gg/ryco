/**
 * NodePaths - where projects live on this node: its code roots and "normal code directory",
 * folder search across them, and the verdict for a destination folder.
 *
 * One resolver serves every default location: the add-project and copy dialogs
 * (`projects.pathHints`), chat promotion's default parent and Agent Control's destination
 * suggestion all read `resolveCodeRoots`. Destination verdicts (`projects.previewDestination`,
 * the import's preflight and its re-check just before register) share `judgeProjectDestination`
 * with chat promotion, storage admission's fence included, so a project is never registered
 * where turns would be refused.
 *
 * @module NodePaths
 */
import type {
  FilesystemSearchDirectoriesInput,
  FilesystemSearchDirectoriesResult,
  NodeCodeRoot,
  NodeCodeRootSource,
  NodePathHints,
  NodePathHintsInput,
  ProjectCopyError,
  ProjectCopyRelativeRoot,
  ProjectDestinationPreview,
  ProjectDestinationPreviewInput,
} from "@ryco/contracts/project-copy";
import { Context } from "effect";
import type { Effect } from "effect";

/** The node's "normal code directory" and the roots folder search starts from. */
export interface NodeCodeRoots {
  /**
   * The workspace access root when restricted, else the `addProjectBaseDirectory` setting, else
   * the common parent of at least two existing non-chat projects, else the first existing
   * well-known folder (`~/Code`, `~/Developer`, …), else home.
   */
  readonly defaultProjectDirectory: string;
  readonly defaultProjectDirectorySource: NodeCodeRootSource;
  /** Existing directories only, best first, at most `PROJECT_COPY_MAX_CODE_ROOTS`. */
  readonly codeRoots: ReadonlyArray<NodeCodeRoot>;
}

/**
 * What the caller means to do at the destination: `create` a repository there (the folder must
 * be missing or empty) or `link` the checkout already there (a git repository no project is
 * rooted at).
 */
export type ProjectDestinationIntent = "create" | "link";

export interface JudgeProjectDestinationInput {
  /** As the caller gave it: absolute, `~` or `~/…`. Anything else is `invalid`, never resolved. */
  readonly path: string;
  readonly intent: ProjectDestinationIntent;
  /**
   * The monorepo subfolder the project is rooted at. The duplicate-root and access checks apply
   * to `path/<relativeRootInRepository>`, the root the project will be registered with.
   */
  readonly relativeRootInRepository?: ProjectCopyRelativeRoot | undefined;
  /**
   * Suggested by a client, not chosen by the user: on macOS a place in a privacy-guarded home
   * folder that holds none of the code roots is `access-denied`, judged without opening it.
   */
  readonly suggested?: boolean | undefined;
}

export interface ProjectDestinationJudgement {
  /** The verdict as `projects.previewDestination` reports it. */
  readonly preview: ProjectDestinationPreview;
  /** Whether `intent` may proceed: `create` on `available` / `exists-empty`, `link` on an unregistered git repository. */
  readonly usable: boolean;
  /** The destination with symlinks in its nearest existing ancestor resolved; null unless judged. */
  readonly canonicalPath: string | null;
  /** `canonicalPath/<relativeRootInRepository>`: the root the project would be registered with. */
  readonly projectRoot: string | null;
  /**
   * The per-node reservation key: the realpath of the nearest existing ancestor joined with the
   * remaining segments, case-folded on case-insensitive volumes. A running import and a legacy
   * clone with the same key exclude each other. Null when the path is not usable.
   */
  readonly reservationKey: string | null;
}

export interface NodePathsShape {
  /** Home, separator, code roots and default directory, for the node and folder pickers. */
  readonly pathHints: (input: NodePathHintsInput) => Effect.Effect<NodePathHints, ProjectCopyError>;
  /**
   * Bounded breadth-first folder search across the code roots (or the given roots, each checked
   * by the workspace access policy). Never follows symlinks; a git repository is a leaf.
   */
  readonly searchDirectories: (
    input: FilesystemSearchDirectoriesInput,
  ) => Effect.Effect<FilesystemSearchDirectoriesResult, ProjectCopyError>;
  /** `judgeProjectDestination` with intent `create`, as the dialogs preview a folder. */
  readonly previewDestination: (
    input: ProjectDestinationPreviewInput,
  ) => Effect.Effect<ProjectDestinationPreview, ProjectCopyError>;
  readonly judgeProjectDestination: (
    input: JudgeProjectDestinationInput,
  ) => Effect.Effect<ProjectDestinationJudgement, ProjectCopyError>;
  /** The resolver behind `pathHints`, shared with chat promotion and Agent Control. */
  readonly resolveCodeRoots: () => Effect.Effect<NodeCodeRoots, ProjectCopyError>;
}

export class NodePaths extends Context.Service<NodePaths, NodePathsShape>()(
  "ryco/projectCopy/Services/NodePaths",
) {}
