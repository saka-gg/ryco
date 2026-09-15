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
Reads have a 15-second per-command timeout and a 2 MB patch limit; oversized reads
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
