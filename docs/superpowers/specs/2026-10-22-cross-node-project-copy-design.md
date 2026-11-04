# Cross-node projects: copy a project to another node, better node + folder picking, per-node selector, Agent Control

Date: 2026-10-22. Status: approved direction (user, 2026-10-22), implementation in progress.
Interactive mockup: `output/mockups/project-nodes.html` (untracked; three scenes: selector, add
project, copy to another node). The shipped UI follows it.

## Goals

1. **Copy a project to another node.** Pick a destination node and folder; clone from the
   project's origin; optionally bring unpushed commits and uncommitted changes; copy the project's
   settings (title, scripts, system prompt, preferred remote, avatar); optionally run the setup
   script and/or start an agent thread on the destination that finishes setup (install tools,
   run special commands). Progress is visible and survives closing the dialog.
2. **Better node picking and folder search when adding a project.** Node first (cards with
   presence, OS, project count, code roots), then source (open folder / clone repository / copy
   from another node), then a folder picker with real search across the node's code roots.
3. **The project selector shows every node a project is on and its path there**, with node chips,
   `@node` search and path search, plus "Add project…" and "Copy <project> to another node…".
4. **Agent Control.** An agent can be told "set up project X on my Mac mini in the normal code
   directory". It proposes the action; the user approves; the project is copied and set up there.
5. **SSH works.** Nodes added through Desktop SSH can be copy destinations.

Non-goals (v1): moving threads or worktrees between nodes; direct node-to-node transfer on a LAN
(the transfer layer below is built so a direct path can be added later); copying node-local
`ServerSettings` maps keyed by projectId (`projectPreferences`, `projectWorktreeRoots`), Atlassian
links; mobile UI for any of this (mobile must keep compiling and must not lose its approval queue).

## Architecture decisions

- **Nodes never talk to each other.** There is no server-to-server path and the Hub relay only
  connects clients to nodes (and must stay blind). Every cross-node flow is therefore driven by a
  client that holds connections to both nodes.
- **The destination node owns execution.** A durable _import job_ on the destination does clone →
  bring commits → checkout → apply changes → register project → copy settings → avatar → setup, and
  streams progress. The client only reads from the source (an _export_), uploads artifacts to the
  destination in chunks (a _transfer_), starts the import and follows it. This makes the copy
  idempotent (client-minted ids, receipted start), atomic enough (owned-directory compensation), free
  of the 120 s clone limit, and independent of the client staying open once the import started.
- **All payloads go through chunked RPC** under the relay's limits: 160 KiB raw per chunk (≈213 KiB
  base64), which fits one 256 KiB relay data chunk even for peers without chunk support. Since
  2026-11-03, chunks are 1 MiB when both nodes are direct and announce it (`maxChunkBytes` in the
  `exportStart` and `transferBegin` answers, which a node sets from the caller's connection).
- **Repository identity** stays `normalizeGitRemoteUrl` of the primary remote. The import recreates
  the source's remotes (stripped of userinfo) so the copy groups with the source automatically.
- **Agent Control acts on its own node only.** Two new plan kinds:
  - `importProject` — _server-executed_ on the agent's node (clone a repository into a folder on
    this node, register it, optional settings, setup script, follow-up setup thread).
  - `copyProjectToNode` — _client-executed_: the proposal lives on the agent's node, and the owner
    client that approves it runs the copy against the target node with the same client coordinator
    as the UI, then reports the outcome back. Nodes learn which other nodes exist from a non-secret
    node directory that owner clients publish (`agentControl.publishNodeDirectory`).
- **Version skew.** Older clients decode the proposal stream with a closed plan union and clear the
  whole approval queue on a decode error. The proposal _view_ schema used on the wire gets a tolerant
  fallback member (`{ kind: string }` with unknown keys allowed) so future kinds degrade to an
  "update Ryco to review this request" card; this change ships now so the next new kind is safe.
  New RPCs are announced by one capability flag, `ExecutionEnvironmentCapabilities.projectCopy`.
- **Roles.** Every new method is `operator` (same as `filesystem.browse`, `sourceControl.cloneRepository`,
  `orchestration.dispatchCommand`). On direct transport that means owner. `agentControl.publishNodeDirectory`
  and `agentControl.reportClientExecution` are owner.
- **SSH pairing mints owner credentials.** `ryco auth pairing create --role owner` is added (anyone
  running it already has shell access as the node's user, who can mint owner sessions with
  `ryco auth session issue --role owner`); the Desktop SSH pairing script uses it, so SSH-added
  nodes can browse, clone, add projects and be copy destinations. Default stays `client`.

## Contracts (`packages/contracts/src/projectCopy.ts`, new; exported from the root index)

All ids are client-minted UUID strings, branded: `ProjectExportId`, `ProjectTransferId`,
`ProjectImportId`. Constants:

```ts
export const PROJECT_COPY_CHUNK_BYTES = 160 * 1024;
export const PROJECT_COPY_MAX_ARTIFACT_BYTES = 256 * 1024 * 1024; // per bundle/patch transfer
export const PROJECT_COPY_MAX_AVATAR_BYTES = 1024 * 1024;
export const PROJECT_COPY_DEFAULT_PATCH_LIMIT_BYTES = 64 * 1024 * 1024;
```

### Node path hints — `projects.pathHints` (operator, read)

```ts
NodePathHintsInput = {}
NodeCodeRootSource = "access-root" | "setting" | "existing-projects" | "well-known" | "home"
NodePathHints = {
  homeDirectory: string;                    // absolute
  pathSeparator: "/" | "\\";
  defaultProjectDirectory: string;          // absolute; the node's "normal code directory"
  defaultProjectDirectorySource: NodeCodeRootSource;
  codeRoots: ReadonlyArray<{ path: string; source: NodeCodeRootSource; projectCount: number }>;  // existing dirs only, ≤ 8, best first
  workspaceAccessRoot: string | null;
}
```

Resolution order for `defaultProjectDirectory`: workspace access root (when restricted) → the
`addProjectBaseDirectory` setting → the most common parent directory of the node's existing
(non-chat) project roots, when it holds ≥ 2 projects → the first existing of `~/Code`, `~/Developer`,
`~/dev`, `~/src`, `~/projects`, `~/repos`, `~/code`, `~/workspace`, `~/git` → home. The server's chat
promotion default (`resolvePromotionParent`) must use the same resolver (one shared module).

### Folder search — `filesystem.searchDirectories` (operator, read)

```ts
FilesystemSearchDirectoriesInput = {
  query: string;                 // 0..256 chars; empty = shallow listing of the roots (git repos first)
  roots?: ReadonlyArray<string>; // ≤ 8; default = pathHints.codeRoots paths
  limit?: number;                // 1..100, default 40
  maxDepth?: number;             // 1..6, default 4
}
FilesystemDirectoryMatch = {
  path: string; name: string; parentPath: string; depth: number;
  isGitRepository: boolean;
  gitBranch: string | null;                 // cheap read of .git/HEAD; null when unknown/detached
  projectId: ProjectId | null;              // existing non-chat Ryco project rooted here on this node
  repositoryCanonicalKey: string | null;    // from that project's identity when known
  score: number;
}
FilesystemSearchDirectoriesResult = {
  matches: ReadonlyArray<FilesystemDirectoryMatch>;
  roots: ReadonlyArray<string>;
  truncated: boolean;            // hit the entry/time budget
  scannedDirectories: number;
}
```

Server rules: bounded breadth-first walk (≤ 20 000 directories, ≤ 1.5 s, results ≤ limit), never
follows symlinks or Finder aliases, does not descend into git repositories' subtrees beyond depth 1
(a repo is a leaf for search purposes), skips `node_modules`, `.git`, `.hg`, `dist`, `build`,
`target`, `.venv`, `vendor`, `Library`, `.Trash`, `.cache`, cloud-storage placeholder roots
(`Library/CloudStorage`, `Library/Mobile Documents`), and hidden directories unless the query
starts with `.`. Fuzzy ranking reuses the workspace-entry ranker. Every root passes
`WorkspaceAccessPolicy.assertExistingPath`. Windows nodes: drive-letter paths, `\\` separators.

### Destination preview — `projects.previewDestination` (operator, read)

```ts
ProjectDestinationPreviewInput = { path: string }   // absolute or ~-relative
ProjectDestinationPreview = {
  resolvedPath: string;
  state: "available" | "exists-empty" | "exists-not-empty" | "is-git-repository" | "access-denied" | "invalid";
  existingProjectId: ProjectId | null;
  existingRepositoryCanonicalKey: string | null;   // when it is a git repo with a primary remote
  suggestedPath: string | null;                    // first free "<path>-2", "-3", … when not available
  detail: string | null;                           // human-readable reason for access-denied/invalid
}
```

### Source export — on the source node

`projects.exportStart` (operator, receipted by `exportId`):

```ts
ProjectExportStartInput = {
  exportId: ProjectExportId;
  projectId: ProjectId;
  checkoutPath?: string;          // a worktree of this project; default = project root
  include: {
    commits: boolean;             // bundle of commits not on any remote (unpushed / local-only branch)
    workingTreeChanges: boolean;  // binary patch: staged + unstaged + untracked (respecting .gitignore)
    ignoredPaths: ReadonlyArray<string>;  // explicit opt-in extra ignored files, e.g. ".env" (≤ 32, relative)
    wholeRepository: boolean;     // full bundle (repos without a usable remote)
    avatar: boolean;
  };
  patchLimitBytes?: number;       // default PROJECT_COPY_DEFAULT_PATCH_LIMIT_BYTES
}
ProjectExportArtifactKind = "commits-bundle" | "repository-bundle" | "changes-patch" | "avatar"
ProjectExportArtifact = { artifactId: string; kind: ProjectExportArtifactKind; byteLength: number; sha256: string }
ProjectExportResult = {
  exportId: ProjectExportId;
  repository: {
    rootPath: string;
    isGitRepository: boolean;
    branch: string | null; headOid: string | null; isDetached: boolean;
    remotes: ReadonlyArray<{ name: string; url: string }>;   // userinfo stripped
    primaryRemoteName: string | null;
    canonicalKey: string | null;
    isShallow: boolean; hasSubmodules: boolean; usesLfs: boolean;
  };
  pushedState: {
    headOnRemote: boolean;              // HEAD reachable from some refs/remotes/* (after a quiet fetch attempt)
    upstreamBranch: string | null;      // "origin/feature" when the branch exists on the primary remote
    unpushedCommitCount: number;        // commits in HEAD not on any remote ref
  };
  workingTree: { trackedChangeCount: number; untrackedCount: number; hasConflicts: boolean;
                 ignoredCandidates: ReadonlyArray<{ path: string; byteLength: number }> };  // .env*, *.local ≤ 1 MiB, for the opt-in
  artifacts: ReadonlyArray<ProjectExportArtifact>;
  skipped: ReadonlyArray<{ kind: ProjectExportArtifactKind; reason: string }>;  // e.g. "patch over limit", "conflicts"
  settings: {
    title: string; scripts: ReadonlyArray<ProjectScript>; customSystemPrompt: string | null;
    preferredRemoteName: string | null; projectMetadataDir: string; hasCustomAvatar: boolean;
    relativeRootInRepository: string;   // "" or the monorepo subfolder of the project root
  };
  expiresAt: IsoDateTime;               // artifacts are deleted after 30 min or on dispose
}
```

`projects.exportReadChunk({ exportId, artifactId, offset, length ≤ PROJECT_COPY_CHUNK_BYTES })` →
`{ dataBase64, offset, length, eof }` (read, operator). `projects.exportDispose({ exportId })` → `{}`.

Commits bundle: `git bundle create <f> HEAD <branch> --not --remotes` (skipped when empty).
Repository bundle: `git bundle create <f> --all`. Patch: a temporary index seeded from HEAD, `git add -A`
(plus the explicit ignored paths with `--force`), then `git diff --binary --cached HEAD`. Refuses with a
`skipped` entry (not an error) on conflicts or when over the limit. A non-git project exports only
settings + avatar and `repository.isGitRepository = false` (the UI then offers a repository bundle only
for git repos; non-git folders are refused in v1 with a clear reason).

### Transfer — on the destination node

```ts
projects.transferBegin({ transferId, purpose: "commits-bundle" | "repository-bundle" | "changes-patch" | "avatar", byteLength, sha256 }) → { transferId, receivedBytes }
projects.transferAppend({ transferId, offset, dataBase64 }) → { transferId, receivedBytes }   // receipted-safe: re-sending an already-written range is a no-op if bytes match
projects.transferCommit({ transferId }) → { transferId, byteLength, sha256 }                 // verifies length + sha256
projects.transferAbort({ transferId }) → {}
```

Stored under `<stateDir>/project-transfers/<transferId>.part` with a 1 h TTL, ≤ 512 MiB total,
≤ `PROJECT_COPY_MAX_ARTIFACT_BYTES` each (avatar ≤ 1 MiB). Begin is idempotent for the same
(id, purpose, length, sha); `receivedBytes` lets a client resume after a reconnect.

### Import — on the destination node

```ts
ProjectImportSource =
  | { kind: "clone"; remoteUrl: string; remoteName: string /* "origin" */; branch: string | null; recurseSubmodules: boolean }
  | { kind: "repository-bundle"; transferId: ProjectTransferId; branch: string | null }
ProjectImportStartInput = {
  importId: ProjectImportId;
  projectId: ProjectId;                 // client-minted new id for the destination project
  title: string;
  destinationPath: string;              // full target directory (must be missing or empty)
  source: ProjectImportSource;
  remotes: ReadonlyArray<{ name: string; url: string }>;   // recreated after clone (e.g. upstream); userinfo stripped
  commits: { transferId: ProjectTransferId; branch: string; headOid: string } | null;
  checkout: { branch: string | null; headOid: string | null } | null;   // branch to end on
  changes: { transferId: ProjectTransferId; baseOid: string } | null;
  relativeRootInRepository: string;    // project root = destinationPath/<relative> for monorepo subfolders
  settings: {
    scripts: ReadonlyArray<ProjectScript>; customSystemPrompt: string | null;
    preferredRemoteName: string | null; projectMetadataDir: string;
  } | null;
  avatarTransferId: ProjectTransferId | null;
  runSetupScript: boolean;
  origin: { kind: "user" | "agent-control"; sourceLabel: string | null; proposalId: string | null };
}
ProjectImportStepId = "preflight" | "clone" | "commits" | "checkout" | "changes" | "register" | "settings" | "avatar" | "setup"
ProjectImportStepStatus = "pending" | "running" | "done" | "skipped" | "failed"
ProjectImportStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted"
ProjectImportSnapshot = {
  importId; projectId; title; destinationPath; status: ProjectImportStatus;
  steps: ReadonlyArray<{ id: ProjectImportStepId; status: ProjectImportStepStatus; progressPercent: number | null; detail: string | null }>;
  outputTail: string;                   // ≤ 16 KiB, clone progress and setup output
  error: { step: ProjectImportStepId; code: ProjectImportErrorCode; message: string } | null;
  warnings: ReadonlyArray<string>;
  preflight: { remoteReachable: boolean | null; alternateRemoteUrl: string | null } | null;
  leftoverPath: string | null;          // an owned directory left after interrupted/failed runs
  createdAt; updatedAt;
}
ProjectImportErrorCode = "destination-unavailable" | "access-denied" | "remote-unreachable" | "clone-failed"
  | "commits-failed" | "checkout-failed" | "changes-conflict" | "register-failed" | "transfer-missing"
  | "cancelled" | "interrupted" | "internal"
```

RPCs: `projects.importStart` (receipted: the same importId with the same input digest returns the
existing snapshot; a different digest fails), `projects.subscribeImport({ importId })` (stream of
snapshots; first item is current), `projects.cancelImport({ importId })`, `projects.listImports({})`
(recent ≤ 20, newest first, for resuming progress UI), `projects.discardImport({ importId })` (deletes
`leftoverPath` when the job owns it and no project was registered).

Import rules:

- **Preflight**: destination must be missing or an empty dir and pass the access policy; no existing
  project may have that workspace root; for `clone`, `git ls-remote --heads <url>` under a
  non-interactive env (`GIT_TERMINAL_PROMPT=0`; `GIT_SSH_COMMAND` = `ssh -o BatchMode=yes -o
  StrictHostKeyChecking=accept-new` unless the server env already sets `GIT_SSH_COMMAND`). On failure,
  try the alternate URL form (https ↔ scp-ssh, derived from host/owner/repo); if that works use it
  and record `preflight.alternateRemoteUrl`; otherwise fail `remote-unreachable` with git's stderr.
- **Clone**: `git clone --progress [--branch b] [--recurse-submodules] -- <url> <dest>`, progress
  parsed from `Receiving objects/Resolving deltas N%`, 30 min timeout, cancellable (kills the process
  group). The job records whether it created `destinationPath` (owned directory).
- **repository-bundle**: `git clone <bundlePath> <dest>`, then remove the bundle `origin` remote.
- **remotes**: add/replace each listed remote (so `canonicalKey` matches the source).
- **commits**: `git fetch <bundle> <branch>:refs/heads/<branch>` (force when not checked out).
- **checkout**: check out the branch (track `<remote>/<branch>` when it exists), verify `headOid`
  when given (warning, not failure, when it differs).
- **changes**: `git apply --binary --check` then `git apply --binary` (falls back to `--3way`); on
  conflict fail `changes-conflict` but keep the clone and still register the project (status
  `completed` with a warning is preferred: the user keeps a working checkout; the patch stays as
  `<projectMetadataDir>/imports/<importId>.patch` inside the project for manual apply).
- **register**: `project.create` with `createWorkspaceRootIfMissing: false`, title, root,
  `projectMetadataDir`, prompt; then `project.meta.update` (scripts, preferredRemoteName) with
  deterministic command ids derived from importId.
- **avatar**: write through the avatar store (same pipeline as the HTTP upload) then
  `project.avatar.set`.
- **setup**: when `runSetupScript` and the project has a `runOnWorktreeCreate` script, run it as a
  tracked non-interactive job in the project root (`sh -lc` / `pwsh -NoProfile -Command` on Windows),
  stdin closed, 30 min timeout, exit code captured, output tail streamed. A failing setup finishes the
  import as `completed` with a warning and the step `failed`.
- **Failure/cancel** before `register`: remove the owned directory. After `register`: keep everything.
- **Persistence**: table `project_imports` (snapshot JSON + input digest + owned-directory flag). On
  startup, `running` jobs become `interrupted` with `leftoverPath` set when they own a directory.

### Agent Control additions

Plan kinds (in `AgentControlActionPlan` and `AgentControlActionKind`):

```ts
AgentControlImportProjectPlan = {
  kind: "importProject";
  projectId: ProjectId; title: string;
  destinationPath: string;              // absolute, resolved + previewed at proposal time
  remoteUrl: string; branch: string | null;
  runSetupScript: boolean;
  followUpThread: { title: string; prompt: string } | null;   // started in the new project with the caller's model + runtime mode
}
AgentControlCopyProjectToNodePlan = {
  kind: "copyProjectToNode";
  source: { kind: "project"; projectId: ProjectId; title: string } | { kind: "repository"; remoteUrl: string; title: string };
  target: { environmentId: EnvironmentId; label: string };
  destination: { kind: "default" } | { kind: "child-of-default"; name: string } | { kind: "path"; path: string };
  bringCommits: boolean; bringChanges: boolean; copySettings: boolean;
  runSetupScript: boolean;
  followUpThread: { title: string; prompt: string } | null;
}
```

Both are approval-required (never routine); risk tags `creates-project`, `cross-node` (copy),
`runs-commands` (when setup or a follow-up thread is requested), `copies-workspace-content` (changes or
commits). External MCP integrations reject both kinds.

`copyProjectToNode` is client-executed: when an owner client accepts it with
`agentControl.acceptProposal({ …, executeOnClient: true })` the proposal becomes `executing` with a
client executor recorded; the client runs the coordinator and calls
`agentControl.reportClientExecution({ proposalId, outcome: "completed" | "failed", result: { targetEnvironmentId, projectId, workspaceRoot, warnings } | null, error: string | null })`.
Without a report within 2 h the proposal fails ("The app that approved this request closed before
finishing"). Accepting a client-executed plan without `executeOnClient` is rejected.

Tools (private sessions only, not the external endpoint):

- `ryco_list_nodes` (read, capability `nodes.read`): the published node directory —
  `{ environmentId, label, platformOs, online, isThisNode, lastPublishedAt }`.
- `ryco_suggest_project_destination` (read, `projects.read`): for this node, `{ name }` →
  `{ defaultProjectDirectory, suggestedPath, state }` (paths of this node only; documented exception
  to the "no workspace paths in MCP results" rule because the agent already runs on this node).
- `ryco_propose_project_import` (write, `projects.import`): builds `importProject`.
- `ryco_propose_project_copy` (write, `projects.copy`): builds `copyProjectToNode`; target by
  environmentId or by label match against the node directory; fails clearly when the directory is
  empty ("Open Ryco on a device connected to that node so it can publish its node list").
- `agentControl.publishNodeDirectory({ nodes })` (owner RPC): owner clients publish the nodes they know
  (≤ 64 entries, non-secret fields only) to every connected node, on connect and when the catalog
  changes. Stored in memory plus `<stateDir>/agent-control-node-directory.json`.

Tolerant proposal view: `AgentControlProposal.plan` on the wire decodes through
`AgentControlProposalPlanView = Union([...known plans, AgentControlUnknownPlan])` and `actionKind`
through a string fallback, so an unknown kind yields an "unsupported" card instead of a stream
failure. Server-side validation keeps the strict union.

### Capability flag

`ExecutionEnvironmentCapabilities.projectCopy: optionalKey(Boolean)` — the node implements
`projects.pathHints`, `filesystem.searchDirectories`, `projects.previewDestination`, `projects.export*`,
`projects.transfer*`, `projects.*Import*`. Clients fall back to today's behaviour without it (browse
only, legacy clone + `project.create`, no copy).

## Client (packages/client-runtime + apps/web)

- **Node catalog** (`packages/client-runtime/src/state/nodes/catalog.ts`, pure merge logic; web hook
  `apps/web/src/environments/nodeCatalog.ts` → `useNodeCatalog()`): one list across primary + saved
  registry + Desktop Hub machines + hosted nodes, de-duplicated (local Hub alias), with
  `{ environmentId, label, isPrimary, isThisDevice, presence: "online" | "connecting" | "offline",
  platformOs, iconKind, canMutate, mutateBlockedReason, supportsProjectCopy, lastSeenAt }`. The
  add-project dialog, copy dialog, selector chips, Projects page devices section and Agent Control
  node-directory publishing use it.
- **acquireNode(environmentId)** (web): wakes/retains the node (saved reconnect, desktop interactive
  scope, hosted interactive scope), awaits bootstrap and, in hosted mode, the mutation lease; returns
  `{ api, release }`. Both nodes stay retained for the whole copy.
- **Copy coordinator** (`packages/client-runtime/src/projectCopy/{plan,run,io}.ts`): `plan` builds the
  steps from the export result and the user's options; `run` executes export → transfer(s) → import →
  follow → optional follow-up thread → dispose, with injected IO (`readSourceApi`, `readTargetApi`),
  resumable transfers (`receivedBytes`), retries for receipted calls, cancellation; emits a progress
  model the dialog/toast render. Used by the copy dialog, the add-project dialog's "copy from another
  node" source, and the Agent Control client executor.
- **Folder picker** (`apps/web/src/components/projectNodes/FolderPicker.tsx`): search box
  (`filesystem.searchDirectories`, debounced), Places (code roots), Git repos, breadcrumb listing
  (`filesystem.browse`), marks git repos and existing projects, selection + destination preview.
  Falls back to browse-only when the node lacks `projectCopy`.
- **Dialogs**: `AddProjectDialog` (replaces the palette's add-project views; every `openAddProject()`
  entry point opens it) and `CopyProjectDialog`; each has a tiny zustand store and a `preloadableLazy`
  mount in RootAppShell, preloaded on menu intent. Copy progress continues in a toast with "Run in
  background"; finished copies toast "X is ready on Y · View".
- **Entry points**: sidebar project context menu + kebab (opt-in so the frozen phone tier does not gain
  it), Projects page overflow menu and "Not on X → Copy here", project selector footer.
- **Project selector**: groups checkouts by logical project (`useLogicalProjectSnapshots` member
  projects), one row per project with node badges, "N nodes · path", expandable per-node rows (path,
  branch, offline rows disabled), node chips with counts, `@node` token and path matching, footer
  actions. Hosted mode lists other nodes' checkouts and switches through the hosted draft-target path.
- **Agent Control client executor**: the approval card for `copyProjectToNode` shows source, target,
  the destination resolved from the target's path hints, and the options; approving runs the
  coordinator (progress toast) and reports the outcome.

## Testing

- Unit/integration tests per module (real git repos and bare remotes in temp dirs; fake ssh shim).
- Browser tests for the dialogs, the selector and the folder picker (seeded stores + API overrides).
- `scripts/e2e/cross-node/`: node A from source on macOS + node B in a `node:24-bookworm` container,
  sharing a bare origin through a fake-ssh shim; an env-gated RPC-level test drives export → transfer →
  import → setup and asserts on B via `docker exec`; a manual UI run pairs B in node A's web client.

---

# Binding amendments (adversarial design review, 2026-10-22)

Four reviewers (security, robustness, compatibility/conventions, UX/completeness) checked the spec
above against the code and a synthesizer merged their findings. **Every amendment below is binding.
Where an amendment conflicts with the text above, the amendment wins.** Line references point at the
spec text above as it was when it was reviewed.

## Resolved decisions (defaults chosen 2026-10-22)

- Relayed copies are capped at about 24 MiB of artifacts per relayed node (amendment 7). Over the cap
  the user pushes the branch or connects directly. Changing the Hub budget is out of scope.
- Unknown SSH host key on the destination: the copy fails with `host-key-unknown <host>` and offers
  "Send files" instead. A "Trust <host>" fingerprint flow is a follow-up.
- Agent copy source: a project on the agent's own node, or a repository URL.
- Plain `http://` remotes: clone over http is refused and "Send files" is offered; the URL is still
  recreated as a remote on the destination.
- Non-git folders: refused in v1 with a clear reason.

## Amendments

### A1. [blocker] Agent Control: client-executed copyProjectToNode lifecycle (spec lines 324-329)

Replace the paragraph with these rules. (1) New input `AgentControlAcceptProposalInput = { proposalId; executeOnClient?: { executorId: UUIDv4 } }`; AgentControlDecideProposalInput stays as is for reject. For copyProjectToNode, accept requires executeOnClient. In one request the service (a) records the user decision `approved`, then (b) calls `AgentControlExecution.beginClientExecution`. Acting as `executor`, it re-checks `computeAgentControlPlanDigest(plan) === planDigest` and `validator.revalidateExecution`, then in one transaction moves the proposal approved→executing and inserts the operation row with `state.clientExecution = { executorIdHash: sha256(executorId), deadlineAt: now+2h, importId: null, targetEnvironmentId }`. The transition table is unchanged. Neither executorId nor its hash ever appears on the proposal stream or in audit rows. (2) Re-accepting with the same executorId returns the current receipt, and runs step (b) if a crash left the proposal `approved`. A different executorId fails `conflict`. (3) The `executeApproved` listener and `scanApproved` skip client-executed kinds. `recoverIncomplete` skips operations that have `clientExecution` until `deadlineAt` has passed. A startup and periodic executor sweep fails expired ones with 'The app that approved this request did not report back; check <target label>'. (4) `agentControl.reportClientExecution({ proposalId, executorId, outcome: 'started' | 'completed' | 'failed', importId?, result?, error? })` is accepted only when the hash matches and the proposal is `executing`. `started` records importId and extends deadlineAt to now+6h. `completed`/`failed` are applied by the executor actor and settle the operation and the proposal. `result.targetEnvironmentId` must equal `plan.target.environmentId`. error and warnings are bounded to AGENT_CONTROL_ERROR_MESSAGE_MAX_CHARS and credential-redacted. Repeating the same outcome returns the receipt. (5) The client starts the coordinator only after it sees `executing`. It keeps `{ proposalId, executorId, exportId, transferIds, importId, targetEnvironmentId }` (ids only) in a local job record, and after a reload it resumes following B's import and reports.
WHY: transitions.ts:25-46 lets only `executor` leave approved/executing; no client actor and no timeout transition exist. The executor runs every approved proposal (AgentControlExecution.ts:1790-1812). recoverIncomplete fails every executing proposal that has no operation row (AgentControlExecution.ts:1746-1764), so any node restart, update-everything included, fails a copy that is still running. AgentControlDecideProposalInput is only {proposalId} (agentControl.ts:1197-1199) and decide is idempotent (AgentControlProposalService.ts:85-114), so two clients could both execute. A relay principal's scopeId changes on every reconnect (RpcPrincipal.ts:58-68), so the binding has to be a client-minted secret. This resolves a conflict between the reviews: it keeps compat's executor-owned transitions and security's executorId binding, and drops the new `client-executor` actor and the 'any client may report' idea.

### A2. [blocker] Version skew: proposal stream for clients older than this change (spec lines 50-53, 345-348)

Replace the tolerant-view paragraph. (1) Server-side gate: the payloads of `agentControl.subscribeProposals`, `listProposals` and `getProposal` gain `planView: Schema.optional(Schema.Literal('tolerant'))`. When it is absent, the server leaves out every proposal whose plan.kind is not in `AGENT_CONTROL_LEGACY_PLAN_KINDS` (the 29 kinds released clients decode, frozen: `deviceControlConsent`, `pullRequestWatch` and `worktreeHandoff` included, `importProject` and `copyProjectToNode` and every later kind left out): from snapshot.active, from snapshot.recent and from events (filter around service.subscribeQueue in agentControlRpc.ts). getProposal then returns `{ proposal: null }`. New clients always send 'tolerant'; older servers ignore the key. Add a test that a legacy subscriber never receives the new kinds. (2) Keep AgentControlProposal, AgentControlActionPlan and AgentControlActionKind strict. Add wire-only view schemas: `AgentControlUnsupportedPlan = Struct({ kind: Literal('unsupported'), originalKind: String })`; `AgentControlPlanView = Union([...known plans, StructWithRest(Struct({kind:String}),[Record(String,Unknown)]).pipe(decodeTo(AgentControlUnsupportedPlan, ...))])`; `AgentControlProposalView = AgentControlProposal.mapFields({ plan: AgentControlPlanView })`; and a receipt view with `actionKind: Union([AgentControlActionKind, String])`. Use them only in RPC success schemas (queue, getProposal, stream events, accept/reject results). Client state and presentation switch to the view types and add `case 'unsupported'`. (3) The unsupported card, on web and mobile, renders only Reject and 'Update Ryco', never Accept. (4) The card model gains `requiresClientExecutor: boolean`. Clients without the coordinator (mobile, the phone tier), or not connected to the target, show 'Approve in Ryco on a computer connected to <target>' plus Reject.
WHY: Today's desktop, hosted PWA and App Store builds decode with the closed union (agentControl.ts:1216-1228). A SchemaError is terminal for them (wsTransport.ts:381-395), and sync then clears the environment's whole queue (state/agentControl/sync.ts:50-60). `recent` keeps the proposal in every snapshot afterwards (agentControl.ts:1172-1176). The spec's fallback protects only clients built from this change, so the two new kinds would wipe existing approval queues, against the non-goal at line 26. A `{kind:string}` union member also breaks narrowing (presentation.ts:174, logic.ts:292, automationSchedules.ts:329), and the server decodes the strict type for persistence (AgentControlProposals.ts:32-45). Mobile accepts with `{ proposalId }` only (apps/mobile/src/features/threads/agentControlActions.ts:24).

### A3. [blocker] RPC delivery-effect classification (spec lines 37, 145, 206, 258)

Add this table and forbid 'receipted' for every new method. read: projects.pathHints, projects.exportInspect, filesystem.searchDirectories, projects.previewDestination, projects.checkRemoteAccess, projects.exportReadChunk, projects.subscribeImport, projects.listImports. Also read, with the comment 'idempotent by client-minted id/offset; scratch state expires on its own TTL' (precedents: providerPrewarmSession, vcsPrefetchWorktreeBase): projects.exportStart, projects.exportDispose, projects.transferBegin, projects.transferAppend, projects.transferCommit, projects.transferAbort, agentControl.publishNodeDirectory. mutation: projects.importStart, projects.cancelImport, projects.discardImport, agentControl.reportClientExecution. After a dropped importStart, the coordinator reads subscribeImport({importId}) and resends importStart with the same id and input only if the node does not know the import. In the spec text, replace 'receipted' with 'idempotent by id'.
WHY: Verified in code. The hosted transport stops tracking a receipted request whenever a receipted owner exists (relay/transport.ts:714-724). bindHostedDispatchReplay claims every receipted tag but replays only orchestration.dispatchCommand (relay/dispatchReplay.ts:393-425), so a receipted importStart that the relay drops is neither tracked nor replayed. Left at the default 'mutation', any relay drop during the roughly 1,600 transferAppend calls marks the session delivery-unknown (transport.ts:700-709), and hostedSessionAdmits then blocks every non-read method (capabilities.ts:54-61). publishNodeDirectory runs on every connect, so it would cause the same without any user action.

### A4. [blocker] Import git pipeline: clone, commits, checkout (spec lines 228-229, 271-278)

Replace with the following. clone: `git clone --progress --no-checkout --origin <remoteName> -- <url> <staging>`, without --branch or --recurse-submodules, with GIT_LFS_SKIP_SMUDGE=1. commits: `git bundle verify <file>`, then `git fetch --no-tags <file> +HEAD:refs/ryco-import/<importId>/head`. Missing prerequisites fail `commits-failed` with 'The remote no longer has commits this copy builds on; retry with Send files'. checkout: when `checkout.headOid` is set it is authoritative: run `git checkout -f -B <branch> <headOid> --`, or `git checkout -f --detach <headOid>` when branch is null. If `refs/remotes/<remoteName>/<branch>` exists, run `git branch --set-upstream-to=<remoteName>/<branch> <branch>`. A headOid that is not present fails `checkout-failed`; it is not a warning. When `checkout` is null, check out the remote's default branch. Finally run `git update-ref -d refs/ryco-import/<importId>/head`. Contract: `commits: { transferId } | null`; branch and oid live only in `checkout`. Export: the commits bundle always includes HEAD (`git bundle create <file> HEAD --not <oids>`).
WHY: The reviewer reproduced three failures. `clone --branch <b>` fails for a branch that exists only in the bundle. Fetching into the checked-out branch after the clone is refused. DWIM tracking lands on the remote tip, so a source that is behind its remote silently ends on newer code and the patch then applies to the wrong base. Also, `commits.branch: string` cannot express a detached HEAD. I ran the replacement sequence end to end and it worked: clone --no-checkout from a file:// remote, fetch +HEAD from a bundle made with `--not <ls-remote oids>`, then checkout -f -B.

### A5. [blocker] Byte safety of patches and bundles

Add: "Patch and bundle bytes never exist as JS strings. Export writes `git diff ... --output=<artifactFile>` and `git bundle create <file>`, and takes the size from stat. Chunks are base64 of the raw file bytes. Import runs `git apply --binary <path>` and `git fetch <path>`, never through stdin. Every long git step passes an explicit timeout (export steps 10 min), because VcsProcess defaults to a 30 s timeout and 1 MB of output."
WHY: VcsProcess decodes stdout with TextDecoder (collectUint8StreamText.ts:79-108) and encodes stdin as text (VcsProcess.ts:19, 150-153), with defaults of 30 s and 1 MB (VcsProcess.ts:66-67). GitIndexReview, the obvious template, passes the patch as stdin (GitIndexReview.ts:385-394). The reviewer reproduced a Latin-1 file silently becoming U+FFFD while `git apply --check` still exited 0.

### A6. [blocker] Input hygiene: ids, paths, refs, plan fields

Add an 'Input hygiene' section with these rules. (1) Ids: ProjectExportId, ProjectTransferId and ProjectImportId use a UUIDv4 pattern. ProjectImportStartInput.projectId must match /^[A-Za-z0-9_-]{1,128}$/, and that check moves into ProjectAvatarStore.write/read/remove so no caller can bypass it. artifactId is only looked up in the export's own map and is never joined into a path. (2) relativeRootInRepository and ignoredPaths are relative and slash-separated: no `..`, `.git` or empty segment; no leading `/`, `~`, `:` or drive letter; no NUL or backslash; at most 1024 chars. Resolve them with WorkspacePaths.resolveRelativePathWithinRoot. After checkout, realpath(project root) must lie inside realpath(repository root), and lstat must show a directory, not a symlink. (3) ignoredPaths must be a subset of the ignoredCandidates the server recomputes; each must be a regular file per lstat and at most 1 MiB, and is added with GIT_LITERAL_PATHSPECS=1 and `--`. (4) checkoutPath is the project root or one of the project's registered worktrees. (5) `child-of-default.name` and the `{name}` of ryco_suggest_project_destination match /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/. (6) Destination paths: only `~` or `~/` is expanded, and the result must be absolute. Anything else (`~user`, `C:foo`, relative) gets state `invalid` and is never resolved against the server cwd. (7) Branch names pass `git check-ref-format --branch` and do not start with `-`. Remote names match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/. OIDs match /^[0-9a-f]{40}([0-9a-f]{24})?$/. (8) Every git call puts `--` or `--end-of-options` before positional arguments. (9) settings.projectMetadataDir uses the ProjectMetadataDir schema. Plan fields use AgentControlTitle, AgentControlPrompt and AgentControlWorkspaceRoot, URLs at most 2048 chars, `.pipe(rejectExcessProperties)`.
WHY: ProjectId accepts any trimmed string (baseSchemas.ts:97-104). The avatar store builds `path.join(avatarsDir, `${projectId}.png`)` (ProjectAvatarStore.ts:21), and only the HTTP route checks PROJECT_ID_PATTERN (http.ts:785,796). An import with projectId '../../x' therefore writes outside the data dir. The existing normaliser resolves non-absolute input against the server cwd (SourceControlRepositoryService.ts:154-162). Agent-supplied branch, remote and URL strings would reach git argv; the existing clone already uses `clone --` (SourceControlRepositoryService.ts:465).

### A7. [blocker] Relay per-channel transfer budget (Architecture decisions, line 39-40)

Add: "Relayed connections carry a Hub per-channel transfer budget (50 MiB of payload per channel lifetime, both directions) and an 8 MiB per-connection queue. acquireNode returns `transport: 'direct' | 'relay'`. When the source or the target is relayed, the raw artifact total of one copy is capped at 24 MiB per relayed node, which leaves room for base64 overhead and the user's session. The dialog runs projects.exportInspect (sizes known) before it enables Copy. Over the cap, Send files, Bring unpushed commits and Bring uncommitted changes are disabled with 'Too large to send through the Hub (N MB). Push the branch, or connect both devices directly.' The coordinator never reconnects to reset the budget, and keeps at most 4 chunk RPCs in flight per node." PROJECT_COPY_MAX_ARTIFACT_BYTES applies only on direct transport.
WHY: docs/relay-capacity-assessment-3b.md:52 sets a 'Per-channel transfer budget 50 MiB ... for the channel lifetime', and :51 an 8 MiB per-connection queue. The same channel carries the user's live session. A raw artifact of about 37 MiB uses up the budget after base64, and the mockup's own Send files example is 38 MB (project-nodes.html:469). The spec checks only the size of each chunk.

### A8. [major] Changes step and where a leftover patch goes (spec lines 279-282)

Replace with the following. Changes run only when `git rev-parse HEAD` equals changes.baseOid; otherwise the step is skipped with a warning and the patch is kept. Run `git apply --binary --check <file>`, then `git apply --binary <file>`; both are atomic and never touch the index. There is no automatic `--3way`. On failure the step is `failed` with a warning, the job continues to register, and the final status is `completed`. A changes failure never triggers removal of the directory. A patch that was not applied is kept at `$(git rev-parse --path-format=absolute --git-path ryco-imports)/<importId>.patch` (inside .git, never tracked or checkpointed). The warning names that path and the command `git apply --binary <path>`, run from the repository root. For every opted-in ignored file that is written, if `git check-ignore -q -- <path>` fails on the destination, append the path to the destination's `.git/info/exclude`. The coordinator includes commits whenever changes are included and pushedState.headOnRemote is false; otherwise it disables 'bring changes' with 'needs unpushed commits'.
WHY: The spec says both 'fail changes-conflict' and 'completed with a warning is preferred', while line 292 deletes the owned directory on any failure before register. `--3way` implies `--index`, so it stages the force-added .env, and its conflict markers make the kept patch unusable. Ryco never ignores `.ryco` in user repos (only `/<metadataDir>/worktrees/`, worktreeOperations.ts:117-125). A patch kept there, possibly holding a .env, would be committed by commit-all's `git add -A` (GitVcsDriverCore.ts:1985) and by checkpoints (CheckpointStore.ts:256), then pushed. This supersedes security's 3way-plus-reset variant.

### A9. [major] Export: commits bundle exclusion and pushed state (spec lines 174-178, 195)

Compute the exclusion against the clone source only. Run `git ls-remote --heads --tags -- <primaryRemoteUrl>` with the network env and a 30 s timeout, keep the oids that exist locally (`git cat-file -e`), and run `git bundle create <file> HEAD --not <oids>`. If ls-remote fails, fall back to `--not --remotes=<primaryRemoteName>`. headOnRemote and unpushedCommitCount use the same set. Check first with `git rev-list --count HEAD --not <set>`; when it is 0, report 'skipped: nothing unpushed'. Tests use file:// remotes, because local-path clones hide missing prerequisites.
WHY: The reviewer reproduced it: `--not --remotes` treats commits as pushed when they exist only on a remote that is not cloned (for example a fork) or behind a stale tracking ref. `git fetch` on B then fails with 'Repository lacks these prerequisite commits'. An empty bundle exits 128. I ran the ls-remote-oid version end to end and it worked.

### A10. [major] Whole-repository bundle (spec lines 196, 220, 274)

Export: `git bundle create <file> --branches --tags --remotes HEAD`. Never include refs/ryco/* or refs/stash. Refuse it with a skipped reason when isShallow or when HEAD is unborn. Import of a repository-bundle: `git init <staging>`, then `git fetch --no-tags <file> '+refs/heads/*:refs/heads/*' '+refs/tags/*:refs/tags/*' '+refs/remotes/*:refs/remotes/*'`, then recreate the remotes with `git remote add --`, then the checkout step (set the upstream when the ref exists). No origin remote is ever created or removed.
WHY: `--all` also bundles Ryco's checkpoint refs under refs/ryco (checkpointing/Utils.ts:5), which snapshot untracked content, plus stashes, all counting against the 256 MiB cap. Cloning a `--all` bundle from a shallow source fails. `git clone <bundle>` followed by removing origin deletes every branch but one and leaves no upstream refs. I tested the replacement: refs/ryco was excluded, and branches, tags and refs/remotes arrived in a fresh init with the upstream set. This resolves the conflict between the robustness and UX reviews.

### A11. [major] Export: patch generation (spec lines 196-198)

Patch rule: "Seed the temporary index with CheckpointStore's seedIndexFromCheckout (CheckpointStore.ts:138), extracted to a shared module, with `read-tree HEAD` as the fallback. Run with GIT_INDEX_FILE=<tmp>/index, GIT_OBJECT_DIRECTORY=<tmp>/objects, GIT_ALTERNATE_OBJECT_DIRECTORIES=<repo objects dir>, GIT_LITERAL_PATHSPECS=1 and `-c core.hooksPath=/dev/null -c core.splitIndex=false`. Before `add`, sum the lstat sizes of `ls-files --others --exclude-standard -z` plus ignoredPaths, and skip with 'over limit' when the sum exceeds 4 × patchLimitBytes. Diff with GitIndexReview's diffArgs (--no-ext-diff, --no-textconv, --no-color, explicit prefixes) plus `--cached --ignore-submodules=all --output=<file> HEAD`. List dropped nested repos and submodules in `skipped`. When usesLfs, exclude `:(attr:filter=lfs)` paths and list them in skipped. With an unborn HEAD, skip commits and patch with 'Repository has no commits yet'. exportStart is single-flight per exportId: a retry joins the running computation."
WHY: User git config (diff.noprefix, diff.external, color.diff, textconv) produces patches that `git apply` rejects; GitIndexReview already guards against this (GitIndexReview.ts:153-167, 231-234). `add -A` hashes every untracked file into the source's .git/objects before any size check, and nested repos become gitlinks.

### A12. [major] Network git: env, ssh, credentials, early remote check (spec lines 266-270)

Replace with the following. All import and export git processes use one shared env constant: `LC_ALL=C LANG=C GIT_TERMINAL_PROMPT=0 SSH_ASKPASS_REQUIRE=never GCM_INTERACTIVE=never`, extracted from STATUS_UPSTREAM_REFRESH_ENV. Only when GIT_SSH, GIT_SSH_COMMAND and `git config core.sshCommand` are all unset, add `-c core.sshCommand="ssh -o BatchMode=yes -o ConnectTimeout=15"`. Never pass StrictHostKeyChecking. 'Host key verification failed' maps to `remote-unreachable` with detail `host-key-unknown <host>`. ls-remote has a 30 s timeout; clone has a 30 min overall timeout plus a 5 min no-output stall timeout. Clone, ls-remote and checkRemoteAccess reuse SourceControlRepositoryService's validateCloneRemoteUrl and the provider's cloneAuthentication/askpass, extracted into a shared `runGitNetworkCommand`. Add `projects.checkRemoteAccess({ remoteUrl }) -> { reachable; alternateRemoteUrl; detail }` (operator, read, gated by projectCopy). The dialog calls it as soon as a destination is chosen, marks 'Clone from origin' as reachable or not, and selects Send files when it is unreachable. Sources whose primary remote is not a network URL default to Send. On remote-unreachable, the progress view offers 'Send from <source> instead', which starts a new importId with a repository-bundle.
WHY: `accept-new` set through GIT_SSH_COMMAND overrides both the user's ssh config and core.sshCommand (1Password, `-i key`), and downgrades `StrictHostKeyChecking yes`; the repo's own precedent pins host keys (SshDeviceBackend.ts:39). Existing code uses GIT_TERMINAL_PROMPT=0 and SSH_ASKPASS_REQUIRE=never (GitVcsDriverCore.ts:74-77) and LC_ALL=C (GitVcsDriverCore.ts:1013); this machine's git prints German, which breaks progress parsing. Private HTTPS clones that work today through cloneAuthentication (SourceControlRepositoryService.ts:457-494) would fail. Checking reachability only after the upload wastes the transfer.

### A13. [major] Remote URL sanitization and the remotes step (spec lines 41-42, 169, 227, 275)

Rule: "URLs with a password component are rejected at schema decode. Sanitizing always removes the password, and removes the username only for http(s); ssh:// and scp-style usernames are kept. Clone URLs must pass validateCloneRemoteUrl (https, ssh, scp). Recreated remotes[] entries are written only when they are https, http, ssh or scp-style; file://, local paths and other transports are skipped with a warning. The remotes step never replaces the clone remote, which keeps the URL that was actually used, alternate or not. `scheme://user:pass@` is redacted from outputTail, warnings, error.message and client-execution errors."
WHY: removeUrlCredentials also clears usernames (SourceControlRepositoryService.ts:213-222), so ssh://git@github.com becomes ssh://github.com and authentication fails. An agent-supplied token URL would be stored in an immutable proposal row and broadcast to every owner client. Replacing the clone remote undoes the alternate-URL fallback. normalizeGitRemoteUrl maps the https, ssh and scp forms to the same key (packages/shared/src/git.ts:200-228), so grouping still works.

### A14. [major] Submodules and LFS (spec lines 172, 219, 271)

Clone never recurses into submodules and runs with GIT_LFS_SKIP_SMUDGE=1. After the changes step, add two warn-only steps. `submodules` runs `git submodule update --init --recursive` (network env, 10 min) when hasSubmodules and recurseSubmodules are set. `lfs` runs `git lfs pull` when usesLfs is set and `git lfs version` succeeds; otherwise it adds the warning 'Git LFS is not installed on <node>; large files are pointers'. Add `remotes`, `submodules`, `lfs` and `follow-up` to ProjectImportStepId.
WHY: `--recurse-submodules` checks out the default branch's gitlinks, which are wrong after the source checkout, and one private submodule fails the whole clone, which then gets deleted. A failing LFS smudge also fails the clone. The spec reports usesLfs but has no rule for it.

### A15. [major] Destination ownership, concurrency and discard (spec lines 225, 262, 273, 292)

Rule: "Clone into a staging sibling `<parent>/.<name>.ryco-import-<importId>`, created with a non-recursive mkdir that must succeed; that mkdir is the proof of ownership. Record the staging dir's dev and ino. After checkout and changes, publish it with rename(staging, destinationPath); rmdir a pre-existing empty destination first, and retry EPERM/EBUSY on Windows. A per-node reservation (in memory and in project_imports) is keyed on the realpath of the nearest existing ancestor joined with the remaining segments, case-folded on case-insensitive volumes. It rejects a second running import or legacy clone to the same destination with destination-unavailable. Cleanup and discardImport delete only the staging path, and only when all of these hold: the job is terminal and never registered (read from the projection for input.projectId, never from step status); lstat shows a directory, not a symlink, with matching dev and ino; no project is rooted at or under it. Otherwise discard returns `{ deleted: false, reason }`. Removal retries ENOTEMPTY/EBUSY/EPERM 5 times with backoff and records leftoverPath on final failure."
WHY: The existing destination logic is check-then-mkdir (SourceControlRepositoryService.ts:376-398). Two importStarts with different ids for one path both pass preflight, and the loser can rm -rf the winner's clone. assertPath does not canonicalize when access is unrestricted (WorkspaceAccessPolicy.ts:59-63). A discard hours later could delete a folder the user has since re-created.

### A16. [major] Import job crash recovery and cancellation (spec lines 293-294)

Add: "project_imports stores the full input, the staging path with its dev and ino, and the pid, pgid and start time of the running child. Children are spawned with forceKillAfter: 5 s, and cancel waits for the child to exit before cleanup. On startup, signal surviving process groups whose start time matches, then mark the job `interrupted`. Post-register steps are replayed on startup: settings and avatar are idempotent through deterministic command ids, while setup and follow-up are marked skipped with a warning. Interrupted jobs that never registered delete their own staging dir at startup. The server-executed importProject uses importId = uuidv5(operationId, 'project-import'). Its recoverIncomplete branch reads the project_imports row and settles from its status; it never compensates or deletes."
WHY: Effect's spawner starts children detached in their own process group and kills them only when the scope closes (NodeChildProcessSpawner.ts:571-586), without SIGKILL escalation unless forceKillAfter is set (:18-24, 497-509). After a crash, clone, index-pack and setup therefore keep writing while discard deletes. A crash between project.create and the snapshot save would let discard delete a registered project's folder. recoverIncomplete compensates operations that are still running (AgentControlExecution.ts:1721-1730).

### A17. [major] Transfer lifecycle (spec lines 202-213)

Rules: "(a) Each transfer has a sidecar `<transferId>.json` {purpose, byteLength, sha256, createdAt, lastAppendAt}. The TTL is 1 h since the last append; the export TTL slides 30 min from the last readChunk. (b) Appends are serialized per transferId. offset == receivedBytes appends. A range entirely below receivedBytes is a no-op when the bytes match and a `conflict` when they differ. offset > receivedBytes fails with { receivedBytes }; since 2026-11-03 an append at most 8 direct chunks ahead first waits, outside the transfer's lock, up to 15 s for the bytes before it (at most 8 waiting per transfer, 16 MiB waiting per node), because a pipelining client's appends may reach the lock out of order. (c) transferCommit renames .part to .ready, and later appends fail. (d) importStart atomically claims every referenced transfer. Each must be committed and have the matching purpose: commits→commits-bundle, changes→changes-patch, avatarTransferId→avatar, repository-bundle source→repository-bundle. The claim moves the file into `<stateDir>/project-imports/<importId>/`, re-verifies its sha256, and the file is deleted together with the job (precedent: attachmentUpload claimForTask)."
WHY: With a TTL counted from begin, a slow relayed upload followed by a 30 min clone can expire the bundle before the `commits` step reads it (transfer-missing). Without metadata, begin cannot be idempotent after a restart. Two retried appends at the same offset have undefined behaviour. Purpose is checked only at begin, so a committed 256 MiB bundle could be passed as the avatar and reach sharp.

### A18. [major] Setup command (spec lines 237, 288-291, 306, 315)

Replace `runSetupScript: boolean` everywhere with `setup: { command: string /* at most 4000 chars */; saveAsScript: boolean } | null`, the exact command that will run. Both plans pin it. For copyProjectToNode with a project source, it is captured from the source's runOnWorktreeCreate script when the proposal is built, or the agent writes it. The card shows it verbatim, and the client executor fails if the command it would send differs. It runs through the terminal manager's shell resolver ($SHELL -lc; the default shell on Windows), with cwd = project root, stdin closed, a 30 min timeout and forceKillAfter. Env: extract createTerminalSpawnEnv and shouldExcludeTerminalEnvKey from terminal/Layers/Manager.ts into a shared module, then add `projectScriptRuntimeEnv({ project: { cwd: root }, worktreePath: root })`. No RYCO_*, VITE_*, PORT or ELECTRON_RUN_AS_NODE value from the server env reaches the script; add a unit test for this. outputTail uses TerminalOutputTail (worktreeSetupOutputTail.ts). The copy dialog has an editable command field prefilled from the setup script. When the source and destination OS differ, it says 'This setup was written on <os>; it may need changes on <os>'.
WHY: The user asked for 'special setup commands or installing tools'. A boolean can only run an already saved script, and importProject has no scripts at all. A script read at export time is not covered by the approved digest; routineActions.ts:17-23 deliberately keeps executable scripts out. The server env can hold RYCO_AGENT_CONTROL_TOKEN and forge tokens, which terminals strip (Manager.ts:1083-1101). Existing setup runs under $SHELL with RYCO_PROJECT_ROOT set (ProjectSetupScriptRunner.ts:47-63), so `sh -lc` breaks zsh and nvm scripts.

### A19. [major] Follow-up setup thread (spec lines 12-13, 37-38, 307, 316, 371)

Plans: `followUpThread: { title: AgentControlTitle; prompt: AgentControlPrompt; runtimeMode: RuntimeMode; envMode: ThreadEnvMode; modelSelection: ModelSelection | null } | null`, covered by the digest. The validator applies the createThreads rules: runtimeMode rank at most the origin's, and envMode `worktree` when the origin is worktree-isolated. Risk tags: creates-threads and starts-provider-turn, plus elevated-runtime-mode when the mode is above approval-required. For importProject, modelSelection is required and validated on this node. For copyProjectToNode, null means the target's default; the approving client resolves it from the target's server config and shows it before Approve. Add the same `followUpThread` (with the resolved modelSelection) to ProjectImportStartInput, plus a step `follow-up`. The destination job starts the thread after setup, with deterministic thread and command ids derived from importId, and appends the setup exit code and output tail when setup failed. If no provider is ready, the step is skipped with a warning. The card states that the repository's provider hooks and settings will run. The copy dialog offers 'Ask an agent to finish setup', with an editable prompt and a model picker listing the destination's providers.
WHY: Resolving model and runtime mode at execution time means the user approves privileges the digest does not cover; createThreads pins them in the plan (agentControl.ts:350-382) and limits them in the validator (AgentControlActionValidator.ts:339-363). ProviderInstanceIds are per node. As specified, the client starts the thread, so closing the app after importStart loses the setup agent, which contradicts line 37-38.

### A20. [major] Agent Control wiring checklist

Add a checklist. (a) AGENT_CONTROL_CAPABILITIES: importProject='projects.import', copyProjectToNode='projects.copy', readNodes='nodes.read'. Add them to ProviderInjection.ts grantedCapabilities and to writeCapabilityForTool, never to external integrations. ryco_suggest_project_destination uses the existing `read` capability; `projects.read` does not exist. (b) Add cross-node, runs-commands and copies-workspace-content to AGENT_CONTROL_RISK_TAGS. (c) Add explicit branches for both kinds in AgentControlActionValidator, in both validate and revalidateExecution. principal.kind !== 'provider-session' fails privilege-escalation. source.projectId may be any non-chat project on this node; its expectedUpdatedAt is captured and re-checked. A target equal to this node is refused. Add the same explicit branches in AgentControlExecution runAction, recoverIncomplete and isProjectAction; in the AgentControlProposalStore audit metadata (importProject → {projectId}; copyProjectToNode → {sourceProjectId?, targetEnvironmentId, bringCommits, bringChanges, copySettings, setup: bool, followUpThread: bool}; client reports → {outcome}; never URLs, paths, titles, prompts, labels or error text); in proposalPresentation.ts risk tags and summary; in client presentation.ts; and in AGENT_CONTROL_ACTION_CAPABILITIES. routineActions stays false. (d) The MCP-visible result is `{ outcome, createdProjectIds (this node only), detail: 'Copied to <label>' }`. A copy's result goes in a new optional `AgentControlCompletedResult.remoteProject?: { environmentId, projectId }`, never in createdProjectIds. (e) The tools live in apps/server/src/agentControl/Mcp/projectCopyTools.ts, wired with `withProjectCopyTools` in the same way as localTaskTools (AgentControlMcpServer.ts).
WHY: Without the grants, every propose call fails capability-denied (ProviderInjection.ts:146-170). The kind dispatch uses if/else chains with defaults, so tsc will not catch a missing case: the validator ends in 'not a thread control plan' (AgentControlActionValidator.ts:675-690), execution ends in 'Unsupported Agent Control action.' (AgentControlExecution.ts:1289-1292), and audit metadata silently becomes {} (AgentControlProposalStore.ts:59-160). Unknown kinds would otherwise fall into externalCreateTask (validator 986-993).

### A21. [major] SSH pairing (spec lines 58-61)

Pairing script: run `"$RUNNER_FILE" auth pairing create --role owner --label "Desktop SSH" --base-dir "$PAIRING_BASE_DIR" --json`, and retry without --role only on an unknown-option failure. The JSON output gains `role`. A client-role result sets the node's mutateBlockedReason to 'Update Ryco on <node> to copy projects here'. On connect, a desktopSsh record whose session role is client re-pairs once with owner over the existing tunnel, persists the new bearer, and revokes the old client session. `--role owner` caps --ttl at 15 min. `pairing list` (CLI and web) shows client and owner links with a role column; the startup owner-bootstrap link stays excluded. `pairing revoke` accepts owner links. Add a tunnel.ts test that runs the script against a CLI that rejects --role.
WHY: The runner prefers an installed `ryco` (tunnel.ts:339-341). An older remote CLI rejects --role, so adding the node fails outright. Nodes added before this change keep client bearers, because the runtime re-issues only on a missing or rejected token (apps/web/src/environments/runtime/service.ts:1419-1446), so goal 5 is not met for them. `pairing list` filters on role client (cli.ts:1590).

### A22. [major] Client: connection scope, leases, browser storage (spec lines 366-368, 381)

acquireNode retains a new non-preemptible scope `{ type: 'project-copy'; copyId }`, added to WorkspaceConnectionScope, scopeKey and the desktop scope projection, and renewed every UNIFIED_WORKSPACE_SCOPE_LEASE_TTL_MS/2. It is held on the source until exportDispose and on the target until importStart is accepted; after that the target drops to the import subscription's view scope. acquireNode fails after 30 s with 'All connections are in use; close a view on another device', and the dialog refuses to start a copy that needs more than UNIFIED_WORKSPACE_MAX_CONNECTIONS. `io.withLease(environmentId, call)` checks nodeMutationLeaseIsCurrent before every mutating call. On a failed check the copy pauses ('Reconnecting to <node>'), re-acquires, and resumes with the same ids; it never calls through an api handle from an earlier generation. Artifacts stream with at most 4 MiB of chunks in memory (since 2026-11-03: reads run ahead and up to 4 appends per node are in flight, in offset order; before, 2 chunks with one append at a time) and are never written to browser storage; the local job record holds ids only. Progress copy before importStart: 'Keep Ryco open until the upload finishes (x of y MB)'. After importStart: 'Runs on <D>; you can close Ryco'. The hosted acquireNode path is exported from hostedConnectionCoordinator.ts, with an inert stub in the .standard.ts sibling.
WHY: The hosted interactive scope is preemptible background demand (hostedConnectionScopes.ts:110-125; preemptible flag at hostedConnectionCoordinator.ts:217), with at most 3 connections and 45 s leases (connectionDemand.ts:7-8). Mutation leases are revoked on every relay renewal (hostedConnectionCoordinator.ts:389-426) and must be revalidated at each mutation (nodeMutationLease.ts:54-69; precedent useHandleNewThread.ts:172-203). The mockup says the copy 'keeps running if you close it' even during the upload (project-nodes.html:480).

### A23. [major] Node catalog and capability states (spec lines 350-365)

Build useNodeCatalog by extending WorkspaceMachineCatalogEntry (reconcileWorkspaceMachine in machineCatalog.ts) with `projectCopySupport: 'yes' | 'no' | 'unknown'` (unknown = not connected yet) and `transport`. Derive mutateBlockedReason from accessReasons. The only new logic is the merge and dedup of non-hosted sources, placed next to machineCatalog.ts. Unknown nodes stay selectable; selecting one acquires it and shows 'Checking <node>…'. Matrix: a target with 'no' is disabled with 'Update Ryco on <node> to copy here', plus the node-update action when the node has nodeSelfUpdate. A source with 'no' and a target with 'yes' allow only 'Clone from origin', using the client-side repositoryIdentity remotes and Project settings; commits, changes and avatar are disabled with 'Update Ryco on <source>'. Extend the projectCopy capability doc to cover agentControl.publishNodeDirectory, reportClientExecution, acceptProposal.executeOnClient, planView and both kinds. Clients call publishNodeDirectory only when capabilities.projectCopy === true and the hosted session admits the call.
WHY: With a boolean, nodes that are not connected read as unsupported, because capabilities only come from a connected node's descriptor (environment.ts:104-110) and the hosted catalog does not carry them (state/workspace/types.ts:48-54). Such nodes could then never become destinations. A second canMutate policy would duplicate machineCatalog.ts:48-125. The spec does not cover an old source with a new target.

### A24. [major] Node directory (spec lines 332-343)

Entry schema: `{ environmentId (≤128), label (≤120), platformOs, online, projectCopySupport }` with rejectExcessProperties, at most 64 entries. Entries are stored per publisher (client session), merged by environmentId with the newest winning, local Hub aliases are de-duplicated with isLocalHubAlias, and entries expire 30 days after lastPublishedAt. Clients publish only nodes where they hold owner. isThisNode and lastPublishedAt are computed by the server. ryco_propose_project_copy fails when a label matches 0 or 2+ entries (and lists the candidates) or when the target's support is 'no'. The approval card and the executor resolve target.environmentId in the approving client's own catalog; an id the client does not know fails without running. Node B treats importStart.origin as display-only and never relaxes a check because of it.
WHY: Any owner client can publish arbitrary entries. A label like 'Mac mini' can match two nodes. There is no merge rule between Desktop and hosted publishers, and one machine can appear under two ids (deviceName.logic.ts:23-33).

### A25. [major] Destination judging reuse (spec lines 129-141, 265)

projects.previewDestination and import preflight call a shared `judgeProjectDestination`, extracted from judgePromotionDestination in chatPromotion.ts, with the same storage-admission `fenced` callback. Add state 'retired-checkout'. suggestedPath reuses suggestPromotionDestination. resolvePromotionParent becomes a call to the shared code-roots resolver. The duplicate-root and access checks apply to the final project root (destinationPath/<relative>) and run again just before register.
WHY: Storage admission permanently refuses turns and sessions under a retired checkout or a moved project's old path (chatPromotion.ts:363-376). The spec's preview states miss that case, so a project imported there would register but could never run a turn. project.create only checks that the id is absent (decider.ts:575-580). AGENTS.md asks for shared logic to be extracted.

### A26. [major] Phone tier and AddProjectDialog parity (spec lines 379-384)

When getPresentationTier() === 'phone', the palette's 'Add project' action and openAddProject() keep today's palette views unchanged; on other tiers they open AddProjectDialog. Before building the dialog, extract the palette helpers into apps/web/src/components/projectNodes/addProjectSources.ts and list each behaviour as an acceptance criterion: source readiness and 'Setup Required', repository search, cloneUrlForRemoteProjectSource (Bitbucket forced to https), Windows path validation, opening an existing project's latest thread, creating a missing folder through createWorkspaceRootIfMissing, a new thread after add, the native Finder picker for the local Desktop node, and skipping the node step when only one node can mutate. Signature: `openAddProject(options?: { environmentId?; mode?: 'folder' | 'clone' | 'copy' | 'link'; projectRef? })`. commandPaletteStore.openAddProject stays as a shim, and the palette's own item closes the palette, then opens the dialog. Menus: add an optional `crossNodeActions?: { onCopy; onLink }` parameter to useSidebarProjectContextMenu and ProjectSettingsMenu, left unset in PhoneHome. 'On N nodes' rows appear only in the DOM kebab.
WHY: The palette is the phone tier's only way to add a project (PhoneHome.tsx:130,304; CommandPaletteDialog.tsx:1405,1600-1621). Replacing it would either extend or delete the frozen tier, and AGENTS.md forbids both. The behaviours listed above (CommandPaletteDialog.tsx:1199-1291, 1866-1934, 2108, 2362-2490) would otherwise be lost. Entry points such as onboarding (OnboardingDialog.tsx:251) need a preselected node. This drops the UX review's single-column phone sheet.

### A27. [major] Link an existing checkout (in the mockup, missing from the spec)

Add a source kind `{ kind: 'existing-checkout'; expectedCanonicalKey: string | null }` to ProjectImportSource. Preflight requires a git repo whose canonicalKey equals expectedCanonicalKey. The job never owns or deletes that directory, and skips clone, commits, changes and remotes. The sidebar menu, the kebab and the Projects page get 'Link a copy that's already on a node…', which opens AddProjectDialog in link mode: folder search prefilled with the repo name, with matches badged by repositoryCanonicalKey. In the copy dialog, when the suggested destination is already a repo with the same key, the primary button becomes 'Link existing checkout'. State in the spec that repos without a remote do not group in v1; the copy and link dialogs say '<project> has no remote, so the copy shows as a separate project.'
WHY: The spec says the shipped UI follows the mockup, and the mockup has 'Link a copy that's already on a node…' (project-nodes.html:321) and shows the remote-less 'homelab' grouped across two nodes (:256). The spec has no link flow, and its import requires an empty destination. Grouping keys on repositoryIdentity.canonicalKey (logicalProjects.ts:81-107).

### A28. [major] Monorepo subfolder projects (spec line 231)

Add: "Every git command in the import runs with cwd = the repository root (staging or destinationPath), never the project root. After checkout, `<root>/<relative>` must exist as a directory; otherwise the import fails `checkout-failed`."
WHY: `git apply` run from a subdirectory silently ignores paths outside the cwd. The reviewer reproduced it: exit 0, and the root-level change was dropped.

### A29. [major] Migration and implementation order for ~15 parallel agents

Migration: `apps/server/src/persistence/Migrations/0NN_ProjectImports.ts` exports an idempotent `ensureProjectImportsTable` that checks sqlite_master inside a transaction; the default export pipes it to void. It takes the next free id at merge time (renumber on rebase). `repairProjectImportsTable` is called in runMigrations after the 093 repair, guarded by toMigrationInclusive, and a test runs the migration twice. Only the server-import work package adds a migration. Add an 'Implementation order' section. Wave 0, done by one agent: every contract schema in a `./project-copy` contracts subpath (not the root index); new method names in WS_METHODS and AGENT_CONTROL_WS_METHODS (no new constant); the Rpc.make and WsRpcGroup entries; both policy rows; WsRpcClient members and optional createEnvironmentApi members; apps/server/src/ws/projectCopyRpc.ts with stub handlers spread into makeWsRpcHandlers; services under apps/server/src/projectCopy/{Services,Layers}/, provided beneath RuntimeServicesLive with Layer.provideMerge so AgentControlExecutionLive gets them; the migration; client-runtime `./projectCopy` and `./state/nodes` exports; and the capability set to false. Every other agent branches from wave 0. `projectCopy: true` (ServerEnvironment.ts:102-104) is switched on in the last wave.
WHY: The latest migration is 093 (Migrations.ts:246), and parallel branches already use the ensure-plus-repair pattern (Migrations.ts:560-605; 092_LocalTaskDelegations.ts:17-66). Otherwise all 15 agents edit rpc.ts, rpcAccessPolicy.ts (`satisfies Record<RpcMethod>`), wsRpcClient.ts, environmentApi.ts, ws/context.ts and server.ts. Lint forbids value imports from the contracts root in client-runtime, shared and mobile (vite.config.ts:47-57, 157-212), so 'exported from the root index' (line 63) does not work.

### A30. [minor] Export inspection before artifacts

Add `projects.exportInspect({ projectId, checkoutPath? })` (operator, read). It returns repository, pushedState, workingTree (including ignoredCandidates), settings and per-artifact size estimates, without creating any artifact. The dialog uses it for the option list, the relay cap and the remote check, and calls exportStart only when the user clicks Copy. exportStart recomputes ignoredCandidates and rejects ignoredPaths outside them.
WHY: The opt-in list, the relay cap and the 'Send files … N MB' label all need the inspection data before the user decides. Without this read, the export would have to build artifacts twice.

### A31. [minor] Web typing and test harness

New EnvironmentApi members are optional (`filesystem.searchDirectories?`, `projects.pathHints?`, …, `agentControl.publishNodeDirectory?`, `agentControl.reportClientExecution?`), and callers check both the member and capabilities.projectCopy. Add WS_METHODS.projectsSubscribeImport to STREAM_METHODS in apps/web/test/wsRpcHarness.ts. Add `projectCopy` to the expected field list in apps/server/src/agentControl/Mcp/hostedBoundaries.test.ts.
WHY: ChatView.browser.helpers.tsx:362-364 builds `filesystem: { browse }` without a cast, so a required member fails `bun typecheck`; the precedent is optional members (ipc.ts:1318-1326). The harness answers a stream it does not list as unary (wsRpcHarness.ts:36-49). The boundary test pins every capability field (hostedBoundaries.test.ts:47-69).

### A32. [minor] Bundle budget

Only the two zustand dialog stores may be static imports in RootAppShell. The node-directory publisher, the client executor, the coordinator (client-runtime projectCopy/run) and the progress toast load through dynamic import()/preloadableLazy. Add a standardBootGraph.test.ts forbiddenChains rule from components/RootAppShell.tsx to projectCopy/run, AddProjectDialog and CopyProjectDialog.
WHY: The RootAppShell closure is capped at 115 files and 420 KiB gzip (scripts/perf/model.ts:353-363), and all of these mount at app level.

### A33. [minor] Secrets over legacy relay channels

When the export's caller is a relay principal on a `legacy` (non-E2EE) channel, the server refuses include.ignoredPaths with the skipped reason `insecure-channel`, and the dialog explains that repository content travels through the Hub unencrypted.
WHY: Relay channels can lock into legacy plaintext mode unless requireE2EE is set (NodeE2eeChannelSession.ts:1092-1113), and requireE2EE defaults to false (NodeE2eePolicyStore.ts). The claim that the 'relay must stay blind' then does not hold for an opted-in .env.

### A34. [minor] Folder search on macOS (spec lines 121-127)

From a `home` root, do not descend into Desktop, Documents, Downloads, Pictures, Movies or Music, unless that folder is itself a code root (setting, access root or existing-projects parent) or the query path explicitly starts with it.
WHY: These folders are protected by macOS privacy permissions (TCC), so an unattended Mac mini node would show repeated permission prompts or log EPERM noise. The spec skips only Library.

### A35. [minor] Suggested destination rule (mockup suggestParent, project-nodes.html:431-434)

In client-runtime projectCopy/plan.ts, add `suggestCopyDestination(sourceRoot, sourceHints, destHints, preview)`. rel = sourceRoot relative to sourceHints.homeDirectory. The candidate parent is destHints.homeDirectory joined with rel's parent, using destHints.pathSeparator; use it when previewDestination(parent) is exists-empty or exists-not-empty, otherwise use destHints.defaultProjectDirectory. The leaf is basename(sourceRoot). When the destination is taken, use suggestedPath and tag it 'renamed, folder exists'. When it is a repo with the same canonicalKey, offer Link. The agent's `{kind:'default'}` resolves to `<defaultProjectDirectory>/<basename>` through the same function.
WHY: The spec does not give the mockup's rule ('Same place as on X' / '<path> doesn't exist on D'), so parallel agents would each invent their own. Mirroring a path also needs the source's home directory and the destination's separator.

### A36. [minor] Selector data, progress model, management UI

(1) The selector shows branch, dirty and behind state only from VCS status that is already loaded, and never retains vcs-status or interactive scopes. The hero opens the selector whenever the footer has an action, even with one project, and the work-location row gets an 'also on <nodes>' suffix. (2) Define `ProjectCopyProgress = { copyId; phase: 'acquire' | 'export' | 'upload' | 'import' | 'done' | 'failed' | 'cancelled'; uploadedBytes; totalBytes; importSnapshot: ProjectImportSnapshot | null; canCloseClient: boolean; error: { code; message; retry: 'send-files' | 'resume' | null } | null }` in projectCopy/run.ts. (3) Add a 'Copies' block to the Projects page devices section, built from the local job records plus listImports on nodes that are already connected (never wake a node for it), with View log, Retry, Resume and Discard leftover. (4) 'View' and 'Start a thread on D' open a new-thread draft in the new project on D, through the hosted draft-target controller in hosted mode.
WHY: Retaining vcs-status scopes is connection demand in hosted mode (hostedConnectionScopes.ts:25-27). The coordinator, dialog, toast, sidebar badge and executor are built in parallel without a shared type. discardImport and leftoverPath have no UI in the spec.

### A37. [major] Clone remote (integration, 2026-10-22; spec lines 41-42, 174-178, A9)

A copy clones from, and the export measures `pushedState` and the A9 exclusion against, the _clone
remote_: the project's `preferredRemoteName` when the checkout has it, else `origin`, else the
identity remote (`pickCloneRemoteName` in `@ryco/shared/gitRemoteUrl`; the identity rule is
`pickIdentityRemoteName` there). The export names it in `ProjectExportRepository.cloneRemoteName`;
`primaryRemoteName` and `canonicalKey` stay the identity's. A plan for an old source applies the same
function to the client-side `repositoryIdentity.remotes` and `Project.preferredRemoteName`. The import
recreates every other remote (`upstream` included), so the copy keeps the source's identity.
WHY: The identity prefers `upstream`, so a fork's copy cloned the repository it was forked from: the
fork's own branches were missing on the destination, and unpushed commits were counted against a
remote the user does not push to.

---

# Work packages (implementation plan)

Each package is done by one agent in its own detached worktree branched from the wave base. Owned
files are listed so packages do not collide; touching another package's files is allowed only for
small wiring edits that the package's description names.

## Wave 0 (sequential, one agent each, the base for everything else)

- **W0a contracts.** `packages/contracts/src/projectCopy.ts` exported as the `@ryco/contracts/project-copy`
  subpath (package.json `exports`), with every schema, id brand and constant from the spec and
  amendments (pathHints, searchDirectories, previewDestination, checkRemoteAccess, exportInspect,
  export*, transfer*, import*, ProjectImportSnapshot incl. steps `remotes`/`submodules`/`lfs`/`follow-up`,
  setup `{ command, saveAsScript }`, followUpThread, ProjectCopyProgress lives in client-runtime, not here).
  Agent Control contracts in `packages/contracts/src/agentControl.ts`: both plan kinds, the legacy kind
  list constant, view schemas (A2), accept input with `executeOnClient`, report input, node directory
  entry + publish input, new capabilities and risk tags, `AgentControlCompletedResult.remoteProject`.
  `WS_METHODS` / `AGENT_CONTROL_WS_METHODS` names, `Rpc.make` definitions and `WsRpcGroup` entries in
  `packages/contracts/src/rpc.ts`; `planView` payload field on the three proposal read RPCs; both rows per
  method in `packages/shared/src/rpcAccessPolicy.ts` (delivery classes from amendment 3);
  `ExecutionEnvironmentCapabilities.projectCopy` (doc per amendment 23); optional `EnvironmentApi`
  members in `packages/contracts/src/ipc.ts`. Contract tests (decode/encode, hygiene patterns).
- **W0b skeleton.** Client: `WsRpcClient` members and optional `createEnvironmentApi` members in
  packages/client-runtime; `STREAM_METHODS` in `apps/web/test/wsRpcHarness.ts`; hostedBoundaries test field
  list. Server: `apps/server/src/projectCopy/Services/*.ts` service tags with the interfaces below and
  `apps/server/src/projectCopy/Layers/*Placeholder*.ts` layers that fail "not available yet";
  `apps/server/src/ws/projectCopyRpc.ts` handlers delegating to the services, spread into the WS handler map;
  layers provided beneath RuntimeServicesLive (Layer.provideMerge) so Agent Control execution can use
  them; migration `094_ProjectImports.ts` (ensure + repair pattern); server handlers for the Agent Control
  RPC additions as stubs; `projectCopy` capability reported as `false`. Typecheck clean.

Service interfaces (W0b defines tags; wave 1 implements the Live layers):
`NodePaths` (pathHints, searchDirectories, previewDestination, judgeProjectDestination, resolveCodeRoots),
`GitNetwork` (env, runGitNetworkCommand, lsRemote, checkRemoteAccess, alternateRemoteUrl),
`ProjectExport` (inspect, start, readChunk, dispose, sweep), `ProjectTransfers` (begin, append, commit,
abort, claimForImport, sweep), `ProjectImportGit` (cloneNoCheckout, initFromBundle, fetchCommitsBundle,
checkout, setRemotes, applyChanges, updateSubmodules, lfsPull), `ProjectSetupCommand` (run with tail,
timeout, cancel), `ProjectImports` (start, subscribe, cancel, list, discard, recoverOnStartup),
`AgentControlNodeDirectory` (publish, list).

## Wave 1 (parallel)

1. **S1 node paths**: `NodePaths` Live — code roots resolver (shared with chat promotion:
   `resolvePromotionParent` delegates to it), pathHints, previewDestination via extracted
   `judgeProjectDestination` (from chatPromotion.ts), searchDirectories (A34 macOS rules). Tests.
2. **S2 export**: `ProjectExport` Live — inspect, start (commits bundle A4/A9, repository bundle A10,
   patch A11, ignored candidates A6/A33, avatar artifact), readChunk, dispose, TTL sweep (A17a). Uses
   `GitNetwork` through its tag. Real-git tests with file:// remotes.
3. **S3 transfers**: `ProjectTransfers` Live per A17 (sidecars, serialized appends, commit, claim, sweep). Tests.
4. **S4 git network + import git**: `GitNetwork` Live (A12, extract askpass/cloneAuthentication from
   SourceControlRepositoryService into a shared module and keep the legacy clone working), the
   `projects.checkRemoteAccess` handler body, and `ProjectImportGit` Live (A4, A8, A10, A13, A14, A28,
   A5 byte safety). Real-git tests.
5. **S5 import job**: `ProjectImports` Live — state machine, persistence (094 table), reservation and
   staging publish (A15), crash recovery and cancellation (A16), register/meta/avatar (incl. ProjectAvatarStore
   id validation, A6), follow-up thread (A19), warnings, subscribe/list/discard. Uses the other services by tag. Tests.
6. **S6 setup command**: `ProjectSetupCommand` Live per A18 (extract terminal env helpers from
   terminal/Layers/Manager.ts into a shared module), Windows shell handling. Tests.
7. **H1 SSH/CLI owner pairing** per A21 (cli.ts pairing create/list/revoke, packages/ssh tunnel script with
   fallback, desktop re-pair of client-role SSH records). Tests.
8. **AC1 tolerant proposals** per A2: server planView filtering, client-runtime view types in sync and
   presentation, unsupported card on web and mobile, `requiresClientExecutor` in the card model. Tests.
9. **AC2 plan kinds** per A1, A19, A20, A24: validator, execution (importProject server-executed through
   `ProjectImports`; copyProjectToNode client-executed lifecycle, beginClientExecution, reportClientExecution,
   deadline sweep, recovery skip), audit metadata, presentation on the server, tools in
   `apps/server/src/agentControl/Mcp/projectCopyTools.ts` (`ryco_propose_project_import`,
   `ryco_propose_project_copy`, `ryco_suggest_project_destination`, `ryco_list_nodes`), grants in
   ProviderInjection, external rejection. Tests.
10. **AC3 node directory**: `AgentControlNodeDirectory` Live (per-publisher store, merge, expiry, JSON file)
    and the `agentControl.publishNodeDirectory` handler. Tests.
11. **C1 coordinator**: `packages/client-runtime/src/projectCopy/{plan,run,io,jobRecord}.ts` —
    `suggestCopyDestination` (A35), option planning incl. relay cap (A7) and capability matrix (A23),
    `ProjectCopyProgress` (A36), run with resumable transfers, ≤ 4 chunk RPCs in flight, pause/resume on
    lease loss (A22), importStart retry rule (A3), follow subscribeImport, dispose. Pure tests with fakes.
12. **U1 node catalog + acquire**: client-runtime machine catalog extension (A23) and `state/nodes`,
    web `useNodeCatalog`, `acquireNode` with the `project-copy` connection scope (A22, hosted path in
    hostedConnectionCoordinator.ts + .standard.ts stub), lazy node-directory publisher. Tests.
13. **U2 pickers**: `apps/web/src/components/projectNodes/{NodePicker,FolderPicker}.tsx` and
    `addProjectSources.ts` extracted from the palette (A26) without changing palette behaviour. Browser tests.
14. **T1 cross-node E2E harness**: `scripts/e2e/cross-node/` (Dockerfile + dockerignore, compose, fake-ssh
    shim, fixture builder, env-gated RPC-level test driving export → transfer → import → setup between a
    native node A and node B in Docker). Written against the contracts; run after integration.

## Wave 2 (parallel, after wave 1 is integrated)

15. **U3 add-project dialog** (A26, A27 link mode), palette shim, entry points incl. onboarding/inbox.
16. **U4 copy dialog** + store + entry points (sidebar/kebab opt-in, Projects page, selector footer, Not on X),
    progress toast, Copies block (A36), runs the coordinator.
17. **U5 project selector** per mockup and A36.
18. **U6 approval card + client executor** for copyProjectToNode (A1 client side, A19 model resolution).

## Wave 3

Switch `projectCopy` to `true`, docs (`docs/agent-control.md`, a feature doc), full validation, an
adversarial code review workflow, fixes, the Docker E2E run and a manual UI run with two nodes.
