# Managed worktree naming and automatic migration

## Decisions

Use the same disk naming convention for a project's managed worktree directory and
each checkout: an eight-character random ID, an underscore, and an initial name.
Folder names stay fixed when projects, conversations, workspace titles, or branches
are renamed. Branch generation continues to rename only the Git branch.

Automatically migrate existing Ryco-managed checkouts when idle. Defer busy
checkouts. Preserve the locations of project roots, manually imported checkouts,
and explicit external paths.

Example:

```text
<worktree-root>/
  7c2a91bf_ryco/
    a8d42f19_fix-login/
    b34ec851_pr-42-improve-search/
  936fb120_website/
    d772b0a9_update-navigation/
```

Renaming `ryco/a8d42f19` to `ryco/fix-login-timeout` leaves
`7c2a91bf_ryco/a8d42f19_fix-login` in place. Renaming the project to `Ryco Desktop`
also leaves its directory in place. Two projects called `website` have different
random IDs. Internal project, thread, and worktree IDs keep their existing format.

## Naming and placement

- Generate eight lowercase hexadecimal characters with a cryptographically secure
  random source. IDs are disk identities, not shortened database identities.
- Normalize names with NFKD, remove combining marks, lowercase, replace runs outside
  `a-z` and `0-9` with a hyphen, trim hyphens, and limit the slug to 48 characters
  with trailing hyphens removed. Use `project` or `new-worktree` when normalization
  produces no name. The ID prefix also avoids Windows device
  name collisions.
- Capture the project title when its managed directory is first reserved. Persist
  the generated segment in a node-owned project-directory registry, keyed by
  project ID. All creation paths use that same reservation.
- Choose the checkout slug from its explicit initial title, linked PR/issue/work
  item title, or first-send title seed; use a meaningful explicit branch when no
  title is available. Temporary generated branch tokens are not useful names.
- Pass the title seed to the server's path allocator. Do not wait for an extra
  model call before creating the checkout. Persist the chosen path before use;
  subsequent model-generated titles and branches do not change it.
- Check filesystem occupancy and reserve names under the creation lock. Regenerate
  the random ID on a collision, with a bounded attempt count. Never reuse an
  unrelated existing directory. Stop with a clear allocation error after eight
  collisions.
- Preserve environment and project worktree-root preferences. Those settings
  select storage placement; they do not grant access. The deprecated explicit
  project-metadata mode keeps its placement and uses the new checkout basename
  for new creations, without automatically relocating existing metadata checkouts.
- Explicit checkout paths and restore/recovery requests use their recorded paths.
  They do not allocate a fresh folder on every retry.

The path allocator belongs in the server project/workspace layer. Contracts remain
schema-only. Web, desktop, mobile, Agent Control, plain first sends, project worktree
creation, and PR preparation consume the same allocation logic.

## Creation failures

Complete Git checkout preparation before publishing a new draft's `thread.create`
event. Publishing that event promotes the draft on connected clients; deleting it
after a Git failure clears the local draft. A checkout failure must instead return
its error while leaving the draft ID, prompt, attachments, and source selection
available for retry. Setup scripts and turn starts still require a published
thread, and deletion recovery must drain before acquiring their thread resources.

Recognize Git's `mmap failed: Operation timed out` and `Operation canceled` errors
and preserve the original diagnostic while adding an available-offline suggestion
for cloud or network filesystems. File providers can time out while downloading
repository data; see [Apple TN3150](https://developer.apple.com/documentation/technotes/tn3150-getting-ready-for-data-less-files).
Other mapping failures, such as memory exhaustion, must not receive that advice.

Git can leave a branch or partial checkout behind on failure. Keep incomplete setup
journals and those files protected. Do not automatically reset, delete, or retry
over an uncertain checkout. Creating a new draft must not depend on renaming or
migrating older worktrees.

## Migration ownership and admission

Implement relocation as a server-owned operation under `WorkspaceLifecycle`, with
a durable migration journal and shared checkout admission. A background scheduler
discovers pending migrations; it invokes the lifecycle owner instead of moving
directories independently.

Eligibility requires a registered checkout belonging to the expected repository,
recognized legacy managed placement, and verified creation/ownership provenance.
An unfamiliar directory or missing/ambiguous ownership record is skipped with a
reason. Main checkouts, imported/manual worktrees, symlink escapes, unavailable
roots, and incomplete setup are excluded. Existing managed checkouts move within
their current authorized storage root; changing today's root preference does not
silently transfer older checkouts to another disk.

For migrated folders, the initial slug uses the title available when the migration
destination is reserved; historical titles may not be recoverable. That slug then
stays fixed. Migrate checkouts individually into the new project directory so an
idle checkout can move while its busy sibling remains under the legacy parent.

Idle means no live provider binding, pending turn or automatic continuation,
background provider work, live terminal shell/process, setup/creation operation,
editor use, or outstanding filesystem write. Even an idle terminal shell or ready
provider process can retain its working directory and defers migration. Migration
does not stop those resources automatically. Uncommitted and untracked data are
preserved by relocation; it does not require deleting or recreating the checkout.

The existing lifecycle does not track every editor presence. Add checkout-use
admission for connected clients through the shared client runtime, including editor
buffers and filesystem writes. Connected idle checks alone are insufficient:
reconnecting clients must accept the authoritative workspace path/revision before
resuming writes, and old paths must remain fenced after relocation. A missed
heartbeat must not permit a still-authorized stale writer to bypass that fence.

Run a bounded, serialized migration pass after startup recovery. Reconsider
deferred entries after resource-release events and a low-frequency background
check every five minutes; deduplicate triggers and do not scan every project on
every socket connection. A busy checkout does not prevent other idle checkouts
from migrating. Retry transient busy/unavailable states; mark unsupported or
ambiguous cases as requiring attention instead of repeatedly attempting them.

## Move and restart recovery

For each eligible checkout:

1. Reserve its destination and persist the journal's source, destination,
   repository identity, worktree ID, and expected metadata revision.
2. Fence both paths against creation, provider starts, terminals, editors, writes,
   cleanup, and competing lifecycle operations. Recheck ownership and idle state
   under that fence.
3. Use `git worktree move` without force. Verify that the destination is registered
   to the expected repository/branch and that the source is no longer registered.
   Git refusal, submodule restrictions, cross-device moves, or an unexpected
   destination leave a deferred/failed migration with a concrete reason. Never
   fall back to destructive removal or an unverified filesystem rename.
4. Publish one server-only relocation command/event that updates the worktree and
   its current conversation paths, including archived and trashed conversations.
   Persist ownership/cleanup paths and migration completion transactionally with
   authoritative state. Keep conversation IDs, branch, attachments, lineage,
   archive/trash state, and historical messages intact.
5. Shared clients retarget workspace views, caches, persisted editor/file tabs, and
   relevant drafts using worktree identity and relative paths. Preserve unsent
   buffers and messages. Invalidate source-control and workspace caches at both
   locations. Do not rewrite historical message text or tool output.
6. Release admission at the verified destination. Retain an old-path tombstone so
   stale clients cannot recreate or write to the previous directory. Remove an
   empty legacy parent only after no remaining records or entries reference it.

On restart, inspect incomplete journals before admitting work at either path.
If only the verified source exists, resume or defer the move. If only the verified
destination exists, finish publishing its state. If both exist, neither exists, or
repository identity differs, keep mutation fenced and report the conflict. Do not
guess which directory contains the user's data. Retrying a journal uses the same
reserved destination and idempotent command IDs.

## Validation

Cover slug normalization, length limits, random-ID collisions, stable names after
renames, identical project titles, configured roots, and every creation entry
point. Exercise migration against real temporary Git repositories, including
dirty/untracked files, archived/trashed conversations, busy resources, explicit
imports, submodules, refusal, and interruptions before and after each durable step.
Verify source/destination fences and stale writes during restart and reconnect.
Exercise draft error/retry preservation and shared client path retargeting.

The creation-error fix receives focused server bootstrap, Git, formatting, lint,
and TS7 checks. Implementing relocation crosses persistence, lifecycle admission,
and shared client state, so run the repository backstop, web build, and browser
suite required by `AGENTS.md`, plus focused native client tests for retargeting.
Do not change the frozen web phone tier.
