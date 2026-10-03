# Project defaults and inheritance

On web and desktop, open a node's **General → Projects and threads** settings.
Choose **Node defaults** or a project in **Project default scope**. Initial model
and effort, new-thread location, generated worktree branch prefix, and whether
to run the project's existing setup script can be overridden independently.
Each row shows its effective value and source. **Use node default** resets only
that project field; resetting node defaults leaves project overrides intact.
An empty project branch prefix explicitly disables the prefix. It does not mean
inheritance. Worktree roots keep their existing dedicated scope control.

These preferences belong to the selected server. An unavailable or read-only
node cannot be edited, and operations never switch to a different node. Native
New Task reads the same effective-value RPC through `packages/client-runtime`.
The legacy web phone presentation remains unchanged.

Defaults initialize new drafts, including model traits such as reasoning effort
and fast mode. Explicit caller choices and existing draft edits stay intact.
Generated worktree branches and setup behavior resolve the current project's
preferences at creation time. Existing threads, branches, and checkout paths
are not rewritten. Disabling setup skips the existing project script; these
settings cannot provide script text, commands, environment variables, provider
credentials, filesystem grants, authentication, or runtime security policy.
Appearance and notifications remain client-owned.

## Storage and compatibility

`initialModelSelection` (nullable) and `runSetupScript` are node defaults.
`projectPreferences` is a map keyed by project ID with a bounded allowlist:
`initialModelSelection`, `defaultThreadEnvMode`, `worktreeBranchPrefix`, and
`runSetupScript`. Node `defaultThreadEnvMode` and `worktreeBranchPrefix` retain
their existing keys. `worktreeRoot` / `projectWorktreeRoots` retain their existing
path validation and persistence. No repository configuration is read for these
general preferences.

The server resolver first uses a project model override, then the node's
initial model, then the existing project `defaultModelSelection`, then Ryco's
built-in model. A legacy project preset therefore only stands in for the
built-in model: most were the built-in model of the day, copied in when the
project was created, so a node default replaces them everywhere. A persisted
`initialModelSelection: null` in a project's map explicitly selects inheritance
and masks a legacy project preset. The legacy
preset remains stored and readable by older nodes. Other null project patch
fields remove that field. A null map entry removes that project's new overrides.
Model replacements replace options as a whole, avoiding stale effort or fast-mode
values when changing models. New model presets allow only bounded model traits.
Fresh draft initialization also replaces omitted traits with an explicit empty
selection, so sticky effort/fast mode from another project cannot leak into a
preset. Native resets its model and readiness when changing targets; older nodes
use that target's legacy creation defaults rather than a previous node's preset.

Field-level compare-and-set guards reject stale changes to the same field while
allowing independent edits to other fields and projects. Model guards distinguish
an absent override from a null inheritance mask. Settings persistence serializes
patches and writes atomically. Project RPCs reject deleted project targets before
mutation; orphaned stored entries cannot affect other project IDs.

The `projectPreferences` environment capability gates `server.getProjectPreferences`.
A capable node's read failure is visible and never substitutes cached defaults.
Older nodes use the existing settings controls and creation behavior. Additive
settings decode without a database migration; old event logs and project model
presets remain readable on upgrade or rollback. Older node versions do not apply
new override fields and may omit them when rewriting their settings file.

Thread-location, branch-prefix, and setup sources are **node** whenever no project
override exists, including default-valued node preferences. This describes the
inheritance layer without claiming whether a default-valued node preference was
explicitly persisted. Model/root **builtin** sources describe their built-in
fallbacks, and **legacy-project** identifies an existing project model preset in
effect because the node has no initial model.

## Integration boundary

`apps/server/src/project/projectPreferences.ts` owns general resolution and returns
`EffectiveProjectPreferences`, including values/sources and the stored overrides.
`ServerSettings` and RPC schemas remain schema-only in `packages/contracts`.
`@ryco/client-runtime/state/settings` exposes `readEffectiveProjectPreferences`;
it has no DOM or React Native imports and does not establish connection readiness.

Feature-specific policies (cleanup, submodules) own their bounded schemas and
narrow resolvers. Creation flows should pass one authoritative node settings
snapshot and project to general resolution and each relevant policy resolver.
Repository policy readers must run only against the authorized checkout and keep
their own fixed path, size, schema, and source validation. General preferences do
not broaden those policies or their authority.

`resolveThreadCreationPreferences` applies explicit caller choices over effective
defaults. Current batch plans require model and environment choices, so those
remain explicit; branch prefix and setup inherit the project's effective values.
Setup runs only for newly created batch checkouts after ownership, preparation,
thread creation and attachment, before the first turn. Submodule preparation must
remain before this setup point when integrating the narrow submodule resolver.

`ws/context/bootstrapPreferences.ts` obtains and authorizes one project/settings
snapshot before bootstrap mutation. An omitted setup flag inherits for newly
prepared checkouts; explicit true/false wins. Existing checkouts retain opt-in
setup semantics. Model selection is currently required and stays explicit.
An omitted bootstrap branch retains its existing meaning: attach the base ref,
rather than generate a new branch. Clients requesting a new branch resolve its
prefix from authoritative effective preferences. Git branch-name text generation
continues to use the separate text-generation model setting.

PR preparation uses the same resolver for the fork branch prefix and whether to
launch setup on a newly created checkout. Existing checkouts and local PR
checkout keep their attachment behavior and do not rerun setup. A thread ID
remains necessary to own a setup terminal. An explicit project ID must resolve
to a live project whose canonical workspace matches the requested repository.

`GitPreparePullRequestThreadOptions.preferencesSnapshot` is a server-only argument
forwarded by `GitWorkflowService`. The PR RPC and project worktree path supply
their already resolved project/settings snapshot, so root selection, prefix,
setup, and narrow policy integration do not reread different settings versions.
Standalone server callers resolve the project by ID or canonical repository root;
unregistered repositories retain node defaults. This internal snapshot is never
accepted through the public RPC schema and does not grant filesystem authority.
