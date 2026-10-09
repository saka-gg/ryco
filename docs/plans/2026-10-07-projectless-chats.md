# Chats Without a Project ("No project") and Promotion to a Project

Status: implemented (phases 1–2)
Date: 2026-10-07
Owner: unassigned
Related: `docs/chats.md` (user guide), `docs/worktree-roots.md`, `docs/context-handoffs.md`,
`docs/superpowers/specs/2026-10-07-managed-worktree-naming-design.md`

See [Implementation notes](#implementation-notes) for where the implementation differs from this
design.

## Goal

1. Let a user start a thread without picking a project. Each such chat works in its own
   Ryco-managed plain folder, so files the agent writes persist and are easy to find.
2. Later, turn that chat into a real project: move the folder to a chosen directory,
   optionally initialize git, and keep the same Ryco thread(s) attached.

## Non-goals (v1)

- Threads with no `projectId`. Every thread keeps a project. A chat is a project of kind `chat`.
- Moving chat files into an _existing_ project and re-parenting threads across projects
  (see Phase 3). Threads cannot change project today (`decider.ts:691`), and that is a separate change.
- Agent Control and native mobile entry points. The contracts must allow them later. The frozen
  web `phone:` tier is not extended (AGENTS.md).

## Prior art (summary)

| App            | Location                                                                                      | Takeaway                                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| t3code         | One shared "Scratch" project at `~/.t3/scratch/<date>-<slug>-<id>` per thread                 | Turned off when the data dir is inside a git repo. Folders are kept on delete. No way to promote after the first send. |
| Codex app      | `~/Documents/Codex/<date>/<chat>`                                                             | iCloud-synced `~/Documents`, the location can't be changed, and symlinks are rejected. These are the top complaints.   |
| Claude Desktop | `<appdata>/scratch-workspaces/…` (throwaway)                                                  | Users lose files and ask for a persistent default.                                                                     |
| Synara         | `~/Documents/Synara/<date>/<slug>/{work,outputs}`, one project record of kind `chat` per chat | Closest to this plan.                                                                                                  |

Decisions taken from these:

- Store chats under the Ryco home, not `~/Documents` and not a temp dir.
- Make the location configurable and resolve symlinked roots (don't reject them).
- Keep one project record per chat.
- Keep folders when a chat is deleted.

## What Ryco already has

- **Non-git projects work.** `project.create` only checks access and existence
  (`Normalizer.ts:66-93`). `createWorkspaceRootIfMissing` creates the folder
  (`WorkspacePaths.ts:31-63`).
- **Checkpoints are skipped quietly** for non-git cwds (`CheckpointReactor.ts:331-361`). Revert
  reports `not-git` (`:1110-1115`).
- **Git UI is gated** on runtime `gitStatus.isRepo` (`ChatView.tsx:2053-2180`, `DiffPanel.tsx:414`,
  `GitActionsControl.tsx:1180`, "No Git" badge in `ChatHeaderBar.tsx:56`).
- **Promotion to git** already exists: `projects.initializeGit` (`worktreeOperations.ts:1024-1060`)
  runs `git init`, creates the main worktree record, and attaches every project thread.
- **A cwd change restarts the provider session** on the next turn (`ProviderCommandReactor.ts:826`,
  `:856-893`) with the _old_ resume cursor (`ProviderService.ts:1298-1309`).
- **Fresh-session plumbing exists:** `startFreshSession` (`ProviderService.ts:1443-1456`) plus the
  context-handoff document builder (`docs/context-handoffs.md`).
- **The root-setting pattern exists:** `worktreeRoot` / `projectWorktreeRoots`
  (`apps/server/src/project/worktreeRoot.ts:64-117`).
- **The crash-safe relocation pattern exists:** `managed_worktree_relocations` and
  `managedWorktreeMigration.ts`, including the "refuse while a session is running" check (`:128-132`).

## Design

### Data model

Add `kind: "project" | "chat"` to projects.

- `packages/contracts/src/orchestration.ts`
  - `OrchestrationProject` (`:727`): `kind: Schema.optional(ProjectKind)` with decoding default
    `"project"`, so existing snapshots and clients stay valid.
  - `ProjectCreateCommand` (`:1349`) and the `ProjectCreated` payload (`:2239+`): optional `kind`.
  - `ProjectMetaUpdateCommand` (`:1365`) and its payload: optional `kind`.
- `apps/server/src/orchestration/decider.ts:468-509`: allow only `chat → project` (one way). Reject
  `project → chat`.
- `apps/server/src/orchestration/projector.ts:272-364` and `ProjectionPipeline.ts:611-704`: carry `kind`.
- Migration `080_ProjectKindAndRelocations.ts` (written as 079; renumbered when main's
  `079_WorktreeNotes` landed first):
  - `projection_projects.kind TEXT NOT NULL DEFAULT 'project'`.
  - A new `project_relocations` journal table (see Promotion). Use the idempotent
    `PRAGMA table_info` style and register it in `Migrations.ts`.

Why not a single shared scratch project like t3code? With one record per chat, promotion is just
"update `workspaceRoot` + `kind`" on one aggregate. Threads never change project, and per-project
settings (prompt, scripts, avatar) start working as soon as the chat is promoted.

### Location and naming

- `apps/server/src/config.ts`
  - Add `chatsDir: join(baseDir, "chats")` to `deriveServerPaths` (`:308`).
  - Add `resolveManagedChatsRoot`, mirroring `resolveManagedWorktreesRoot` (`:300`). Under
    `--restrict-to-cwd` it becomes `<workspaceAccessRoot>/.ryco/chats`.
  - Create the directory lazily, not in `ensureServerDirectories`.
- New setting `chatsRoot` (sourced, default `""` meaning the managed default), modelled on
  `worktreeRoot` (`packages/contracts/src/settings.ts:581, :632`) and validated the same way
  (`worktreeRoot.ts:64-98`). No per-project overrides.
- New module `apps/server/src/project/chatFolders.ts`:
  - `allocateChatFolder({ createdAt, titleSeed })` returns `<chatsRoot>/<YYYY-MM-DD>-<slug>-<8hex>`.
  - Reuse the slug helper from `worktreeCheckoutPaths.ts:12-30`; move it to a shared helper rather
    than copying it.
  - Strip path separators and `..` from the slug. Create the folder with `mkdir` (no `-p` on the
    leaf), so a collision fails loudly and the allocator retries.
  - The name is fixed at creation. Renaming the chat never renames the folder.
- **Availability guard.** Chats are unavailable when the resolved `chatsRoot` is inside a git
  working tree. Check with `git rev-parse --is-inside-work-tree`, not the `.git`-exists check in
  `git/Utils.ts:4`. Otherwise status would report the _parent_ repo and show its branch and diff UI
  in every chat (t3code has the same rule).
  - Expose this as `serverConfig.chats: { available: boolean, root?: string, reason?: string }`.
- `WorkspaceAccessPolicy.assertPath` must accept the root. This happens automatically under
  `--restrict-to-cwd`, because the root lives inside the access root.

### Creating a chat (first send)

Folder creation and the `thread.create` happen in one server round trip by extending the existing
first-send bootstrap.

- `packages/contracts/src/orchestration.ts:1547-1572` (`thread.turn.start` bootstrap): add
  `createChatProject?: { projectId, titleSeed }`. It is mutually exclusive with `prepareWorktree`.
- `apps/server/src/ws/context.ts:387+`: when this field is set:
  1. Check `chats.available`.
  2. `allocateChatFolder`.
  3. Dispatch `project.create { kind: "chat", title: <derived from titleSeed>, workspaceRoot }`.
  4. Continue the existing `createThread` path.

  If anything fails after the folder exists, remove the empty folder (t3code does the same).

- Client draft (`packages/client-runtime/src/state/composer/draftStore.ts:147-148, :284`):
  - A "No project" draft gets a client-generated `projectId` and `logicalProjectKey = "chat:<id>"`,
    plus `pendingChat: true`.
  - `moveDraftThreadToProject` clears `pendingChat` when the user picks a real project, and the
    reverse works too.
  - The logic lives in client-runtime so mobile can use it later.

### Web UX

- **Entry points:**
  - "or start without a project" in `NewThreadHero.tsx:38-75`. Copy for the no-project case
    already exists in `NewThreadHero.logic.ts:34-45`.
  - A "No project" item in `ProjectSwitcher.tsx` and `DraftDeviceProjectDialog.tsx`.
  - A new keybinding command `chat.newWithoutProject` (`packages/contracts/src/keybindings.ts:70`,
    no default key; see the implementation notes), handled in `routes/_chat.tsx:105-130`.
  - `chatThreadActions.ts:80-103` should fall back to a chat draft instead of returning `false`
    when there is no project.
  - All of these are hidden when `chats.available` is false.
- **Sidebar** (`Sidebar.tsx:681-720`, `SidebarProjectList.tsx`):
  - Leave `kind: "chat"` projects out of the project tree.
  - Render them in a "Chats" section, newest first, one row per chat thread. Project picker lists
    also exclude them.
  - In `inboxSidebarModel.ts:557-574`, label chat threads "No project" instead of the project title.
- **Thread chrome:**
  - In chat projects, the "No Git" badge and the "Initialize Git" button (`GitActionsControl.tsx:1838`)
    are replaced by a **Turn into project…** action.
  - Add "Reveal folder" / "Open in editor" by reusing the existing open-in-editor actions.
- **Settings:** add a **Chats folder** row next to **Worktree root** under
  General → Projects and threads.

### Deleting

- Archiving or deleting the last thread of a chat project also deletes the chat project record
  (`project.delete`, `decider.ts:534-607`).
- **The folder is kept.** An explicit **Also delete files** option runs a guarded delete. Before
  removing anything it checks that the realpath is strictly inside `chatsRoot` and does not equal
  it. Prefer moving to the OS trash where available.

## Promotion: "Turn into project…"

New RPC `projects.promoteChat` (`packages/contracts/src/rpc.ts`, handler next to
`projects.initializeGit` in `apps/server/src/ws/gitRpc.ts:297`, logic in a new
`apps/server/src/project/chatPromotion.ts`).

**Input:**

```ts
{
  projectId, expectedUpdatedAt,
  title,                // prefilled from the chat title
  destination,          // absolute path of the new folder; default <addProjectBaseDirectory>/<slug>
  initializeGit: boolean, // default true
  initialCommit: boolean, // default true (only if initializeGit)
  writeGitignore: boolean // default true; only when no .gitignore exists
}
```

**Output:** `{ workspaceRoot, gitInitialized, commitError?: string }`.

**Steps:**

1. **Preconditions** (all must hold, checked under the project's `expectedUpdatedAt`):
   - `kind === "chat"`.
   - No thread in the project has a running or starting turn, pending approval or question, queued
     dispatch, or active handoff. Reuse the busy check from the context-handoff send path.
   - `destination` does not exist, its parent exists and is writable, and it passes
     `WorkspaceAccessPolicy.assertPath`.
   - `destination` is not inside `chatsRoot` and not inside the source folder.
2. **Journal** a `project_relocations` row:
   `{ id, projectId, source, destination, state: "pending", createdAt }`.
3. **Stop** the project's provider sessions.
4. **Move.** `rename(source, destination)`. On `EXDEV` (different disk), recursive copy, then
   verify (entry count and sizes), then remove the source. On failure, roll back and mark the
   journal row `failed`.
5. **Commit the record.** Dispatch
   `project.meta.update { workspaceRoot: destination, title, kind: "project", expectedUpdatedAt }`.
   Mark the journal row `done`.
6. **Git** (optional). Refactor `initializeGitForProject` (`worktreeOperations.ts:1024`) to take
   options and reuse it:
   - `git init`, main worktree record, attach threads.
   - Write a minimal `.gitignore`: `.DS_Store`, `node_modules/`, `.env*`, and
     `<projectMetadataDir>/worktrees/`.
   - Make the first commit. If it fails (no git identity, signing prompt), keep the project and
     return `commitError`; the UI shows how to fix it. Same behaviour as t3code.
7. **Session continuity.** See the next section.

**Crash recovery.** At startup, next to `managedWorktreeMigration` (`serverRuntimeStartup.ts:850`),
resolve `pending` journal rows:

- Only the destination exists → finish step 5.
- Only the source exists → mark `failed`.
- Both exist (the copy fell back mid-way) → keep the source, delete a destination that the journal
  shows Ryco created, and mark `failed`.

This mirrors the existing worktree relocation journal.

### Provider session continuity after a move

The next turn sees a changed cwd and restarts the session with the old resume cursor:

- **Codex** resumes by thread id and is passed the new cwd (`CodexSessionRuntime.ts:608-642`).
  Resume works.
- **Claude** keeps transcripts under `~/.claude/projects/<cwd-key>/` (or `CLAUDE_CONFIG_DIR`), so a
  resume after a move can fail with "No conversation found".

Plan:

- Add a provider capability `resumeSurvivesCwdChange` (Codex `true`; Claude, Copilot, OpenCode and
  Cursor `false` until each is verified).
- When `ProviderCommandReactor` (`:826`) sees `cwdChanged` and the capability is false, call
  `startFreshSession` and pass the deterministic context document from the context-handoff builder,
  targeting the _same_ provider instance. Do this instead of resuming.
- This is generic, not promotion-specific. It also fixes the same latent bug for
  `project.meta.update { workspaceRoot }` and worktree relocation.
- Not chosen: copying Claude transcript files to the new cwd key. It depends on undocumented SDK
  storage layout and on `CLAUDE_CONFIG_DIR` per provider instance.

### Promotion UI

A dialog opened from "Turn into project…" (thread header, chat row context menu, command palette):

- Name, and location (folder picker: desktop `pickFolder`, otherwise the `filesystem.browse` combobox).
- Checkboxes: Initialize git, Initial commit, Add .gitignore.
- The action is disabled with a reason while any thread is busy. The preview reports only busy
  thread IDs, so the dialog classifies each from the client's stores (`describeChatBusy`): a
  working agent offers "Stop the agent" (which interrupts only those threads), a terminal running
  a command names the terminal, and anything else offers "Check again". The re-check signature
  (`chatActivitySignature`) covers each thread's activity and its running terminal count.
- On success the project moves from "Chats" into the project tree and the git UI appears.
- A `commitError` is shown as a toast with a "Set git identity" hint.

Default parent folder: the existing **Add project base directory** setting
(`addProjectBaseDirectory`), with the same fallback the Add project dialog uses when it is empty.
The same setting will drive Phase 3's "new project from a name".

## Phases

1. **Chats.** Contracts (`kind`, bootstrap field, `chats` server config, keybinding), migration
   080, `chatFolders.ts`, the bootstrap path, client-runtime draft support, web entry points,
   sidebar section, settings row, delete semantics.
2. **Promotion.** `projects.promoteChat`, relocation journal and startup recovery, the
   `initializeGitForProject` refactor, the `resumeSurvivesCwdChange` capability plus a fresh
   session with a context handoff, and the promotion dialog.
3. **Later.**
   - "New project from a name": `<addProjectBaseDirectory>/<slug>` + git init + README + first
     commit, sharing the allocator and git bootstrap from Phases 1–2.
   - "Move files into an existing project" (needs thread re-parenting).
   - Agent Control `ryco_create_threads` with `chat: true`.
   - Native mobile entry point.

## Testing

Proportional, focused (AGENTS.md):

- **Unit (Vitest):**
  - Folder-name allocator: slugging, traversal stripping, collisions.
  - Chats availability guard: root inside a repo, symlinked root.
  - Decider `kind` rules.
  - Migration 080 run twice (idempotent), and every ledger it can meet (see below).
  - `chatPromotion`: rename, `EXDEV` copy fallback (injected fs), busy rejection, a stale
    `expectedUpdatedAt`, an existing destination, rollback, and each crash-recovery state.
  - The reactor's fresh-session-on-cwd-change branch.
- **Browser** (`apps/web` `test:browser`, affected files only):
  - "No project" draft → first send → appears under Chats.
  - Promote dialog → appears in the project tree with git controls.
  - Hidden entry points when `chats.available` is false.
- **Live E2E** on an isolated dev instance:
  - A Claude chat that writes a file, then is promoted. The next turn still knows the earlier
    context through the handoff document.
  - The same flow on Codex, which should resume natively.

## Open questions

1. One thread per chat folder (t3code), or allow "New thread in this chat" so several threads
   share one folder? The plan supports both because a chat is a project; the UI default is one.
2. Should chat folders get Synara's `work/` and `outputs/` subfolders? I propose no: keep the
   folder flat so promotion yields a clean project.
3. Default `initializeGit` on or off in the promotion dialog? I propose on.

All three were decided as proposed: one thread per chat folder, a flat folder, and
**Initialize Git** on by default.

## Implementation notes

Phases 1 and 2 are implemented. The user guide is [`docs/chats.md`](../chats.md). These are the
notable differences from the design above.

**Data model and contracts**

- The client `Normalizer` refuses three kinds of client command: `project.create` with
  `kind: "chat"`, any `kind` on `project.meta.update`, and a new `workspaceRoot` for a chat
  project. Only server-internal dispatch can create a chat or change its kind or folder: the
  first-send bootstrap and promotion. The decider additionally enforces chat → project only.
- `project.meta-updated` carries `kind` only when the kind actually changes.
- The `thread.turn.start` bootstrap schema rejects `createChatProject` together with
  `prepareWorktree` or `requireWorktree: true`. It also requires `createThread` for the same
  project ID. The server also refuses a chat whose `createThread` has a `worktreePath`.
- Migration 080 also runs again after the migration ledger, as `repairProjectKindAndRelocations()`.
  The migrator keys progress by id alone. This branch first shipped the migration as 079, and
  main's `079_WorktreeNotes` merged first, so the branch's migration became 080. A development
  database that recorded the old `79_ProjectKindAndRelocations` skips main's 079; main's
  `ensureWorktreeNotesTable` repair creates `worktree_notes` there, and 080 then runs as a no-op.
  `080_ProjectKindAndRelocations.test.ts` covers a fresh database, a main-only database at 79 and
  a database with the old 79 ledger entry.
- The journal has states `pending`, `moved`, `done` and `failed`, plus `strategy` (`rename` or
  `copy`) and `destinationCreated`. The new `moved` state marks a verified destination, so that
  recovery finishes the promotion instead of undoing it.
- The slug helper moved to `@ryco/shared/directorySlug`. `worktreeDirectorySlug` delegates to it.
- `ServerConfig.chats` is `{ available, root?, unavailableReason? }`. The reason is
  `inside-git-repository`, `root-unavailable` or `restricted`. Nodes without support omit the
  field, and clients then hide every entry point. A capability change is pushed as a full config
  snapshot on the config stream. The Git probe times out after 10 seconds, and a failed probe is
  retried every 30 seconds. A missing `git` binary counts as "not inside a repository".
- `chatsRoot` is a plain node setting, not a sourced one. It is validated by
  `validateWorktreeRoot(value, policy, "Chats folder")`, which was generalized with a label and
  now reports `restricted` separately from `unusable`.
- `defaultProjectsParent` was removed. The default parent for promotion is the existing
  `addProjectBaseDirectory` setting ("Add project starts in"). Its fallback differs from the Add
  project dialog, which uses `~/`:
  1. the workspace access root under `--restrict-to-cwd`,
  2. otherwise `addProjectBaseDirectory`,
  3. otherwise `~/Code` when it exists,
  4. otherwise the home folder.

**Folders**

- The 8-hex suffix is the start of the SHA-256 of the project ID, so it is stable across retries.
  A collision derives a new suffix, up to 8 attempts. The date is the node's local date.
- A failed first send removes the empty folder but keeps the chat project. Resending the same draft
  reuses the project and recreates the folder with `ensureChatFolder`. Only a folder that the
  failed attempt created is removed, and never while a concurrent send of the same chat already
  has a live thread there. A thread that was never used and was deleted by a rolled-back creation
  does not retire its chat.
- Startup garbage-collects orphaned chat projects (`project/orphanChatProjects.ts`):
  - An orphan is a chat project that is not deleted, whose `createdAt` is more than an hour old
    (`ORPHAN_CHAT_PROJECT_MIN_AGE`), and that has no thread row at all: live, archived, in Trash,
    or deleted but retained. The age keeps a chat whose first send may still be retried.
  - It runs as startup phase `chat-projects.remove-orphans`, after `project-relocations.recover`.
    It is forked in the background, so startup does not wait for it. A failure is logged and the
    sweep runs again on the next start.
  - Each orphan is deleted with a server-internal `project.delete` guarded by the record's
    `updatedAt` and `expectedThreadIds: []`. A chat that changed or gained a thread meanwhile is
    kept and counted as skipped.
  - After a delete, `ChatFolders.removeEmptyChatFolder` removes the folder only when its realpath
    is strictly inside the current chats root, and only with `rmdir`, so a folder that is not
    empty stays. Files are never deleted.
- A stale draft that later sends with a deleted chat's project ID gets
  `OrchestrationDispatchCommandError` with `reason: "chat-project-retired"`, before anything is
  created. The same reason is reported when the chat is deleted while its first send runs
  (`classifyChatBootstrapFailure`, after the send's cleanup settles). The decider never re-creates
  a project ID, so a retry with the old ID can never succeed. The client gives the draft a new
  project ID and sends once more: `commitSendTurnDispatch` (client-runtime) recognises the reason
  with `isChatProjectRetiredError` (tag and reason, never the message), calls the caller's
  `renewChatProjectId`, and repeats `thread.turn.start` with `retargetChatProjectBootstrap` (both
  bootstrap project IDs) and a new command ID. The thread ID, message and attachments are reused.
  On the web, `renewChatProjectId` moves the draft to `buildChatDraftTarget(env, newProjectId())`,
  so the new ID persists. A second failure is shown as usual.
- The **Chats folder** row is under **General → Project defaults**, next to **Worktree root**.

**Web**

- One thread per chat: `chat.new` and `chat.newLocal` inside a chat start a new chat, and
  "New thread in <chat>" is never offered. Each environment reuses its unsent chat draft. Entry
  points include the hosted draft's device and project picker (`selectNoProject`). The rule is the
  clients'; the node still accepts `thread.create` in a chat project (Agent Control, older clients).
- Every chat entry point reads `useChatsAvailability`, which reports chats unavailable on the
  frozen `phone:` tier, so the hero, switcher, palette and shortcuts offer no chat there.
  `PhoneHome` filters chat projects out with `excludeChatProjects`, like every other project list.
- Every send of an unsent chat draft carries `createChatProject`, also once its chat project has
  reached the client (an earlier first send failed after creating it): only that bootstrap makes
  the node reuse the chat and recreate its folder.
- `chat.newWithoutProject` ships without a default key. Every default rule is sent in
  `ServerConfig.keybindings`, whose command is a closed literal set, so a client that predates the
  command could not decode the config at all; a default can follow once clients tolerate unknown
  commands. A user binding such as `mod+alt+n` works: the web matcher falls back to `event.code`
  (`KeyN`) when Alt rewrites the typed character, such as the macOS Option dead keys. This also
  fixes the existing `mod+alt+p`.
- The **Chats** section lists unsent chat drafts first, then threads in the user's thread order
  with pinned threads first, rather than strictly newest first. It is hidden when empty. The inbox
  labels a chat's project "No project" and its workspace "Chat folder", and its text filter
  (`buildThreadInbox`, shared with mobile) matches "No project" for chat threads.
- Web and mobile share the chat labelling: `excludeChatProjects` lives in
  `@ryco/shared/projectKind`; `CHAT_PROJECT_LABEL`, `CHAT_WORKSPACE_LABEL`, `projectPlaceLabel`
  and `projectDisplayLabel` live in client-runtime `state/composer/chatDrafts.ts`. The relocation
  divider's wording (`cwdRelocationHandoffAccessibleLabel`, `cwdRelocationHandoffRetryHint`,
  `contextHandoffStatusSuffix`) lives in client-runtime `state/session/contextHandoff.ts`; the
  mobile divider renders relocations with it instead of a model transition.
- Chat row menus have these folder actions: show in the file manager and open in the editor (both
  only on the primary environment), and copy the path. "Turn into project…" plugs into the
  extension point in `chatRowMenu.ts`. On the desktop overview (the Crown rail), a chat has a
  **Turn into project** section (rail icon, hover preview and card) in place of the Git sections.
  ChatView passes `sourceControlCwd` (null for a chat) to the overview and its Git controls, so no
  Git status, pull request or CI query, and no VCS status scope, runs for a chat folder. Worktree
  Notes are hidden for chats (`notesTarget` is null): a chat folder has no worktree record, and the
  project keeps its id on promotion, so notes start then.

**Deleting**

- `TrashedThreadSummary.projectKind` carries the owning project's kind, so Trash can list a chat
  as "No project" without the client's project store. It is absent when the project record is gone.
  The web Trash reads it first and falls back to the project store for older nodes
  (`describeTrashedThreadPlace` in `archivedSettings.ts`). "Also delete files" still needs the
  store's project for the folder path, so it is not offered for a chat the store no longer lists.
- Archiving does not remove the chat project. `ThreadDeletionReactor` retires it with
  `project.delete` only after a permanent delete, and only when no live or trashed thread
  remains.
- "Also delete files" is a new RPC, `projects.deleteChatFolder`. It is offered only in
  **Settings → Archive → Trash → Delete permanently**, is off by default, and runs after the
  conversation is deleted. It deletes recursively and does not use the OS trash. It is refused in
  these cases:
  - the project is not a chat,
  - threads remain, live or trashed (`has-threads`),
  - the realpath is not strictly inside the current chats root (`outside-chats-root`),
  - a provider session is still open for the chat's threads or inside its folder, after waiting up
    to 10 seconds for deletion cleanup (`busy`).

**Promotion**

- The RPC handlers live in `ws/chatProjectRpc.ts`, not in `gitRpc.ts`. A read-only
  `projects.promoteChatPreview` was added. It reports the destination status (including
  `inside-source`), the file count and bytes (counting stops at 20,000 entries), busy threads, Git
  availability and identity, and whether the move crosses devices. All chat RPCs need operator
  access, and the preview has read delivery. `expectedUpdatedAt` is optional.
- Admission fence: the journal row is written first, under the storage lifecycle lock. While a row
  is `pending` or `moved`, storage admission (`storagePathBlocker` returns `project-relocation`)
  refuses work at or below the source or the destination:
  - In `OrchestrationEngine`, the storage-admitted commands, such as turn starts and steers, fail
    with a retryable `OrchestrationCommandAdmissionError` (`PROJECT_RELOCATION_PENDING_MESSAGE`,
    "This chat is being moved into a project…") and record no rejected receipt.
  - Provider session starts (`ProviderService.startSession` and the reactor's thread-path lease)
    and editor workspace use are refused by `acquireStoragePathUseLease`.
  - A terminal reports `TerminalCwdError` with reason `relocationPending`.
  - Workspace file writes fail with `WorkspaceFileSystemError` and the same message.

  The busy check runs once before the journal is written and again after it. Provider sessions of
  the chat's threads, and any session whose cwd is inside the folder, are then stopped and
  confirmed closed, and the chat's idle terminals are closed with their history kept. Only this
  vacate step can be cancelled, and a cancelled one marks the journal `failed`. The move and the
  record commit run uninterruptibly. The Git steps after them do not (see Not done).

- The destination must also pass storage admission (`storagePathBlocker`). A path at or below
  a removed checkout, the old path of a completed checkout move, or a checkout that is being
  removed or moved is judged `retired-checkout` (error `destination-retired-checkout`). Work there
  would be refused, permanently for a removed checkout. A path another promotion is moving into
  is judged `exists`. The check runs again under the storage lifecycle lock, in the same step that
  writes the journal.
- Promotion is also refused in these cases:
  - background work, a pending checkpoint revert, or a terminal that is running a command (or
    another conversation's terminal in the folder),
  - an unresolved journal row,
  - no live thread,
  - a source folder that contains the chats root.

  Process-wide locks guard the project and the canonical destination.

- Copy ordering on `EXDEV`:
  1. Create the destination (`destinationCreated`).
  2. Copy, with symlinks copied verbatim.
  3. Verify the copy against the source, and check that the source did not change during the copy.
  4. Journal `moved` and commit the record.
  5. Only then remove the source, and only if it is unchanged since the copy.

  The design copied, verified and removed the source before committing the record. If the commit
  fails, the move is undone: a rename is reversed, and for a copy the journal returns to `pending`
  and the copy is removed.

- `initializeGitForProject(projectId, { writeGitignore, initialCommit })`:
  - The `.gitignore` adds `.env.*` and anchors `/<projectMetadataDir>/worktrees/`. It is written
    only when no `.gitignore` exists.
  - The first commit runs only without a `HEAD` and only when something is staged.
  - It uses `git add --all`, a 60-second timeout and `LC_ALL=C`. Failures are mapped to an
    actionable `commitError`.
  - A failed `git init` is also reported as `commitError` and does not fail the promotion.
  - The result adds `initialCommitCreated`.
- Recovery runs as startup phase `project-relocations.recover` with a 30-second budget, and
  anything left is retried on the next start. It does not run Git. The journal records the
  requested title (`project_relocations.title`), so a promotion recovery finishes keeps the name
  the user chose.
- Recovery commits "destination only" for a `rename` only: a `pending` copy was never verified and
  its source may sit on an unmounted volume, so it is settled `failed` with both paths kept. It
  removes a copied source only when it still matches the copy. A copy that cannot be removed
  (in-process or at recovery) settles the journal `failed` and names the leftover, because the
  record still points at the source; removal first makes read-only folders writable.

**Provider continuity**

- `resumeSurvivesCwdChange` is `true` for Codex. It is `false` for Claude, Copilot, OpenCode,
  Cursor and the generic ACP adapter.
- Instead of calling `startFreshSession` directly, the reactor runs a server-initiated
  `full-context-fresh-session` handoff through the existing coordinator on the same instance. It
  uses deterministic IDs (`context-handoff:cwd-relocation:<turn-start event id>`), and handoff
  activities gained `reason: "model-change" | "cwd-relocation"`. An absent reason means a model
  change.
- A turn's resume after a move that fails with a missing-conversation error also falls back to
  this handoff. The check uses the shared `provider/resumeFailure.ts`, which the Codex resume
  check now uses too. On a provider that cannot follow the move, a restart without a message is
  deferred to the next turn. `ProviderService.readResumeTarget` was added for persisted bindings.

**Fixes after the end-to-end test**

- Claude resume review after a stop or a move. `ClaudeCacheObservation.cwd` records the
  directory of the runtime that made the request, and `OrchestrationThreadWindowSnapshot`
  carries `workspaceCwd`, the directory the next turn runs in. `assessClaudeCacheResume` shows no
  review when both are known and differ, because that turn continues by handoff. A stopped session
  (no runtime) is reviewed with its own reason, and `compactUnavailableReason`
  (`claudeCompactUnavailableReason`) makes surfaces offer only continuing: compaction needs a
  ready, idle session with a runtime on the selected model. `ClaudeResumeGuard.runtimeSessionId`
  is nullable; the decider accepts a null guard only while no runtime is bound.
- Runtime-session fence. `thread.session.set` gained an optional server-internal
  `expectedRuntime`. Runtime ingestion sets it to the provider instance and runtime of the event
  it derives the update from, and the decider rejects the update when the thread's session is no
  longer bound to them (`runtimeSessionFence.ts`). Ingestion counts that rejection as a stale
  event (`runtime-session-superseded`) and applies nothing more of the event. A late lifecycle
  event of a replaced or stopped runtime can therefore no longer overwrite its successor.
- History-recovery attachment fence. Provider transcripts keep the raw `ryco-attachments`
  manifest that live completion strips. `historyMessagesToRestore` normalizes recovered assistant
  text the same way (`parseAssistantDelivery` and `formatAssistantDeliveryText`, shared with
  ingestion) and re-delivers no files. A message that already shows the delivered reply, with its
  per-file notices, is left alone; one that still shows a raw manifest is repaired.
- Quiet paths for an unknown hosting provider. A promoted chat's new repository has no remote, so
  it resolves to the `unknown` source control provider. The remote Git status looks up no pull
  request for it, and the list and search RPCs (issues, change requests, labels, assignees,
  workflow runs) answer empty instead of failing. Single-item reads and mutations still fail,
  with a message that the repository has no recognized host. Recognized hosts keep their errors.
- Binding cwd after promotion. A move leaves the provider binding's recorded directory behind
  until the next start. `ProviderService.readThreadHistory` takes the thread's current directory:
  a provider whose resume survives a directory change (Codex) is read there, any other in the
  recorded directory. The binding is not rewritten, because `readResumeTarget` compares the
  recorded directory with the new one to detect the move.
- The plan's paths in the promotion dialog shorten their parent folders first and cut a name that
  is still too long in its middle (`TruncatedPath`), so a chat folder's suffix stays visible.

**Not done**

- Phase 3.
- Orphan collection runs only at startup. A chat project whose first send failed and whose draft
  was then discarded stays, invisible, until the first start after it is an hour old (see
  Folders).
- The Git steps of a promotion run after the uninterruptible move. A client that disconnects
  during them can cut them short; the project then needs **Initialize Git**.
