# Repository comparisons

The desktop/web diff panel offers **Turn review**, **Branch changes → HEAD**, and
**Commit to HEAD**. Enter a local branch, remote-tracking branch, tag, or commit ID,
then select **Compare**. References resolve in the connected server's repository;
comparison never fetches a remote, checks out a branch, or modifies the index.

- **Branch changes → HEAD** compares the unique merge-base of the entered reference
  and HEAD with HEAD. Changes exclusive to the base branch are excluded.
- **Commit to HEAD** compares the entered commit directly with HEAD. Changes on
  either side of a diverged history appear in the resulting patch.
- Both compare committed trees. Staged, unstaged, and untracked changes are
  explicitly excluded. Editing local files therefore does not change this patch.
- **Turn review** returns to the existing conversation/checkpoint view. Explicit
  links to a particular turn still open that turn even when a comparison is saved.

The selected mode/reference is saved locally per environment and project repository
path. Linked worktrees use that repository preference but read their own HEAD.
Different environments never share comparison preferences or cache entries.
The frozen web phone presentation is unchanged.

## Refresh and failure behavior

**Refresh comparison** re-resolves the reference and HEAD. Git operation invalidation,
foreground/resume, and connection replacement/reconnection also revalidate observed
comparisons. There is no background polling or automatic remote fetch. A reference
changed by an external process while the app stays foregrounded requires Refresh.
The label displays the resolved endpoint IDs. When refresh observes a moved
reference it says so. Missing/deleted/ambiguous references leave the selection in
place with an error; they do not silently fall back to another reference.

During refresh the previous immutable patch stays visible with a refreshing label,
preserving unchanged file renderers. Failed reads and connection invalidation clear
it. Late responses cannot replace a newer selection, worktree, or connection generation.
Comparisons with an unborn HEAD, unavailable commits, or no unique merge-base fail
explicitly. A direct comparison remains available for unrelated committed histories.
Repository discovery has a 10-second timeout; comparison commands have a 15-second
per-command timeout and a 2 MB patch limit; oversized reads
fail rather than publishing a partial patch. Binary changes and submodule commit
changes use Git's normal textual summaries. Renames appear as deletion/addition
pairs, avoiding repository-config-dependent rename detection costs.

## Shared revision boundary

`EnvironmentApi.vcs.readComparison` / `vcs.readComparison` takes:

```ts
{ cwd, selection: { ref, mode: "mergeBase" | "direct" }, ignoreWhitespace }
```

It returns `{ selection, patch, source }`. `source` contains:

- `repositoryPath`: absolute Git common metadata directory (shared by linked worktrees).
- `worktreePath`: Git worktree root.
- `refOid`: resolved entered reference.
- `headOid`: captured HEAD.
- `baseOid`: effective left endpoint (merge-base or entered commit).
- `revision`: opaque content/options/endpoint identity for this comparison.

The server verifies the entered reference and HEAD again after producing the patch.
A move during the read fails and asks for refresh. No server patch cache or temporary
index is required. Existing Pierre rendering, ActiveDiffParser reuse, and file
navigation remain the diff implementation. Totals, when rendered, must describe
this patch rather than independent working-tree status totals.

Subsequent file/blame readers must consume `baseOid` or `headOid` from the displayed
source and use the appropriate old/new path. They must not resolve the entered
symbolic reference a second time. The shared client-runtime
`comparisonFileKey(environmentId, source, side, filePath)` includes environment,
repository, worktree, revision, side, immutable OID, and path. Readers must add any
further output-shaping arguments to their keys.

`source` and `revision` are content identities, not authorization tokens. A future
reader must independently authorize its repository/path access, validate object IDs
and paths, and bound output. It must not accept a client-supplied path as authority.
The RPC uses the existing operator access guard. It adds no mutation capability,
authentication/reconnect owner, or service-worker caching. Only preferences are
persisted; patches stay in memory.

## Line blame

In committed comparisons, click a code line or use the file header's **Line blame**
button. The dialog supports keyboard lookup by side and displayed line number.
Base context/deleted lines use the captured base commit and old path; head context
lines use the captured head commit and new path. Line-number clicks still open the
editor. Added lines, checkpoint review, binary files, symlinks, submodules and lines
outside the displayed hunks are not attributed. A committed addition can therefore
be visible in the comparison while intentionally having no blame action result.

`vcs.readLineBlame` independently enforces operator and workspace access, accepts
only a full immutable object ID and a safe repository-relative path, verifies the
resolved worktree root against workspace policy, and checks
that the object is a commit and the path a regular text file. It never resolves a
symbolic reference or falls back to a working file. File reads are limited to 2 MB,
blame output to 64 KB, with 10-second command timeouts. Missing objects, unsupported
files, and failed reads leave an explicit unavailable state. Synthetic Ryco
checkpoint attribution is suppressed.

Line results are kept only in a bounded per-dialog memory cache using
`comparisonFileKey` plus line number. Closing/replacing the comparison invalidates
pending results; retrying an error performs a fresh read. Comparison lifecycle
remains the authority for connection invalidation. There is no blame polling,
persistent content cache, or service-worker caching.

The shared diff-rendering boundary decodes Git C-quoted paths from raw headers
once. All file consumers, including search, next/previous navigation, editor opens,
and blame, preserve real top-level `a/` and `b/` directories. Unsupported or
ambiguous headers use the raw-patch fallback instead of guessed filesystem paths.

### Shared repository-read authorization

Comparison and blame share `authorizeGitReadWorkspace`, which applies the existing
`WorkspaceAccessPolicy` to the requested cwd before Git discovery, then to Git's
resolved absolute worktree root before any ref or object read. An allowed child
directory cannot authorize reading its ancestor repository. Subsequent commands
run at the authorized canonical root. Returned comparison metadata remains an
identity, never an authorization token. Both RPCs retain operator access guards.
