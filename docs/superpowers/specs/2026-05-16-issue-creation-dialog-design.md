# Issue Creation Dialog (Phase 1)

## Goal

Add an in-app "New issue" dialog so the user never has to leave Ryco to file
an issue against the current project's source-control provider. The dialog
must let the user write a rough description, polish it into a clean issue
body with the configured text-generation model, set labels and assignees,
and optionally create a git worktree on submit with a model-suggested
branch name.

Phase 1 is GitHub-only and is invoked from the existing Issues tab. Phases 2
(post-creation actions on existing issues) and 3 (other providers) are
intentionally out of scope and tracked separately.

## Scope

### In scope (Phase 1)

- Issue creation dialog opened from a new `+` button at the top of the
  Issues tab (`apps/web/src/components/projectExplorer/IssuesTab.tsx`).
- "Polish-in-place" AI flow: a single description textarea, a
  `✨ Polish with AI` button that rewrites the text, and a
  `✨ Suggest from body` button on the title field.
- Labels and assignees pickers populated from the provider.
- Worktree opt-in checkbox (default ON) with a model-suggested branch name
  that the user can regenerate or edit before submitting.
- Wiring through `SourceControlProvider` so any provider can be added later
  without re-shaping the contract.
- GitHub implementation via the `gh` CLI.
- Stubs in the other four providers (GitLab, Forgejo, Bitbucket, Azure
  DevOps) that return a `SourceControlProviderError` with
  `detail: "Not implemented"`.
- Hide the `+` button when the active provider is not GitHub.

### Out of scope (deferred)

- Command-palette entry point, sidebar entry point, and "convert chat
  selection to issue" entry point.
- Post-creation actions on existing issues (create worktree button on
  `IssueDetail`, create branch, link existing PR/branch, add comment) —
  Phase 2.
- Multi-provider implementations beyond GitHub — Phase 3.
- Editing or closing existing issues from inside Ryco.

## Architecture

```text
+-------------------+    +-------------------+    +---------------------------+
| IssuesTab (+ btn) | -> | NewIssueDialog    | -> | issueCreationRpc          |
| (existing,        |    | (new)             |    | (new)                     |
| extended)         |    |                   |    |                           |
+-------------------+    +-------------------+    +---------------------------+
                                                              |
                                                              v
                                                  +--------------------------+
                                                  | wsServer RPC (new four)  |
                                                  | createIssue              |
                                                  | listIssueLabels          |
                                                  | listIssueAssignees       |
                                                  | generateIssueContent     |
                                                  +--------------------------+
                                                       |              |
                              +------------------------+              +-----------------+
                              v                                                         v
                  +-------------------------+                          +------------------------+
                  | SourceControlProvider   |                          | TextGeneration         |
                  | (extended: +createIssue |                          | (extended:             |
                  |  +listLabels            |                          |  +generateIssueContent)|
                  |  +listAssignees)        |                          +------------------------+
                  +-------------------------+
                              |
                              v
                  +-------------------------+
                  | GitHubSourceControl     |
                  | Provider (extended)     |
                  | + gitHubIssueCreate.ts  |
                  +-------------------------+
```

After a successful `createIssue`, the server optionally calls
`git.createWorktreeForProject` when `worktree.enabled` is set on the
request. Branch name generation is client-side using the existing
`textGeneration.generateBranchName` RPC; the selected branch name is
forwarded to the server in the create request and passed through to the
worktree creation intent.

This requires a small extension to `git.createWorktreeForProject`'s
`GitCreateWorktreeIntent` type so that `{kind: "issue", number}` can
optionally carry a `branchName` override. The new shape is
`{kind: "issue", number, branchName?: string}`; when `branchName` is
omitted, the existing server-side default behavior applies and the
caller behavior is unchanged. Existing callers (`NewWorktreeDialog`)
continue to work without modification.

## Server contracts

### `packages/contracts/src/sourceControl.ts`

```ts
SourceControlAssigneeCandidate = Schema.Struct({
  login: TrimmedNonEmptyString,
  displayName: Schema.optional(TrimmedNonEmptyString),
  avatarUrl: Schema.optional(Schema.String),
});

SourceControlCreateIssueInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  body: Schema.String, // markdown, may be ""
  labels: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  assignees: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  worktree: Schema.optional(
    Schema.Struct({
      enabled: Schema.Boolean,
      branchName: TrimmedNonEmptyString,
    }),
  ),
});

SourceControlCreateIssueResult = Schema.Struct({
  issue: SourceControlIssueSummary,
  worktree: Schema.optional(GitCreateWorktreeForProjectOutput),
  worktreeError: Schema.optional(Schema.String),
});
```

### `SourceControlProviderShape` additions

```ts
createIssue(input: {
  cwd: string
  context?: SourceControlProviderContext
  title: string
  body: string
  labels?: ReadonlyArray<string>
  assignees?: ReadonlyArray<string>
}): Effect.Effect<SourceControlIssueSummary, SourceControlProviderError>

listLabels(input: {
  cwd: string
  context?: SourceControlProviderContext
}): Effect.Effect<ReadonlyArray<SourceControlLabel>, SourceControlProviderError>

listAssignees(input: {
  cwd: string
  context?: SourceControlProviderContext
}): Effect.Effect<ReadonlyArray<SourceControlAssigneeCandidate>, SourceControlProviderError>
```

Non-GitHub providers implement these three methods by returning
`Effect.fail(new SourceControlProviderError({ operation, provider, detail: "Not implemented in Phase 1" }))`.

### `TextGenerationShape` addition

```ts
IssueContentGenerationInput = {
  cwd: string
  mode: "polish" | "title"
  rough?: string         // required for "polish"
  body?: string          // required for "title"
  currentTitle?: string  // optional context for "polish"
  modelSelection: ModelSelection
}

IssueContentGenerationResult = {
  title?: string         // present for "polish" and "title"
  body?: string          // present for "polish" only
}

generateIssueContent(input: IssueContentGenerationInput):
  Effect.Effect<IssueContentGenerationResult, TextGenerationError>
```

`modelSelection` is resolved server-side from
`serverSettingsService.getSettings.textGenerationModelSelection`; the client
does not send it.

### Prompts (`TextGenerationPrompts.ts`)

- `buildIssueContentPolishPrompt(input)` — instructs the model to return JSON
  `{title, body}`. Rules: title ≤ 72 chars, no trailing period; body is
  markdown with sections inferred from the rough text (Steps to reproduce /
  Expected / Actual for bug-shaped input; single summary + bullets
  otherwise). Honors a new `issueInstructions` field added to
  `TextGenerationPolicy` (defaulting to undefined; no behavior change for
  existing users).
- `buildIssueContentTitlePrompt(input)` — instructs the model to return JSON
  `{title}` derived from the existing body. Same title rules.

Both prompts wrap user content in delimited sections so user text is treated
as data, not instructions, matching the existing commit/PR prompt pattern.

### RPC methods (`packages/contracts/src/rpc.ts`, `apps/server/src/ws.ts`)

- `sourceControl.createIssue(SourceControlCreateIssueInput) -> SourceControlCreateIssueResult`
- `sourceControl.listIssueLabels({ cwd }) -> ReadonlyArray<SourceControlLabel>`
- `sourceControl.listIssueAssignees({ cwd }) -> ReadonlyArray<SourceControlAssigneeCandidate>`
- `textGeneration.generateIssueContent(IssueContentGenerationInput) -> IssueContentGenerationResult`

### GitHub implementation

`apps/server/src/sourceControl/GitHubSourceControlProvider.ts` (extended) and
`apps/server/src/sourceControl/gitHubIssueCreate.ts` (new):

- `createIssue`:
  `gh issue create --title <title> --body-file <path> [--label NAME...] [--assignee LOGIN...]`
  with the body written to a temporary file, matching the pull-request
  creation flow. Parses the returned issue URL, then fetches the summary via
  the existing `getIssue` flow to produce `SourceControlIssueSummary`.
- `listLabels`: `gh label list --json name,color,description --limit 1000`.
- `listAssignees`: `gh api repos/{owner}/{repo}/assignees --paginate`.

Argv construction and parsing live in `gitHubIssueCreate.ts` mirroring the
existing `gitHubPullRequests.ts` / `gitHubIssues.ts` split.

## Web component design

### File layout (`apps/web/src/components/issues/`)

- `NewIssueDialog.tsx` — root dialog, owns form state via `useReducer`.
- `NewIssueDialogAiActions.tsx` — the three ✨ buttons and their loading and
  error states.
- `IssueLabelPicker.tsx` — chip strip + searchable popover.
- `IssueAssigneePicker.tsx` — same pattern, fetched separately.

### RPC client hooks (`apps/web/src/lib/issueCreationRpc.ts`)

- `useCreateIssueMutation()` — invokes `sourceControl.createIssue`. Returns
  `{ issue, worktree?, worktreeError? }`.
- `useIssueLabelsQuery({ environmentId, cwd })` — 5-minute stale time.
- `useIssueAssigneesQuery({ environmentId, cwd })` — 5-minute stale time.
- `useGenerateIssueContentMutation()` — invokes
  `textGeneration.generateIssueContent`.
- `useGenerateBranchNameMutation()` — wraps the existing
  `textGeneration.generateBranchName` RPC; no new server-side work.

### Reducer state

```ts
type State = {
  title: string;
  body: string;
  labels: string[]; // names
  assignees: string[]; // logins
  worktreeEnabled: boolean; // initial: true
  worktreeBranchName: string | null; // null = not yet generated
  ai: {
    polishStatus: "idle" | "running" | "error";
    titleStatus: "idle" | "running" | "error";
    branchStatus: "idle" | "running" | "error";
    lastError: string | null;
  };
  submitStatus: "idle" | "submitting" | "error";
  submitError: string | null;
};
```

### Interaction rules

1. **Open**: title/body empty; labels and assignees prefetched in the
   background; worktree checkbox ON; branch name empty.
2. **First polish completion OR body reaches ≥ 10 chars with worktree ON**
   triggers `generateBranchName` once. Subsequent body edits do not
   re-trigger; the user must click `↻ Regenerate`.
3. **`✨ Polish with AI`** — disabled when body is empty. On click: set
   `polishStatus = "running"`, call the RPC, on success replace `body` and
   replace `title` only if it is currently empty. On error show inline text
   under the button.
4. **`✨ Suggest from body`** — disabled when body is empty. Replaces
   `title` only.
5. **`↻ Regenerate` (branch name)** — calls `generateBranchName` again,
   debounced 300 ms; user can also edit the branch field manually.
6. **Submit** — disabled while any AI op is running, while the title is
   empty, or while `worktreeEnabled && worktreeBranchName === null`
   (branch name is still being generated). Sends
   `{ title, body, labels, assignees, worktree: { enabled, branchName } }`;
   the `worktree` object is omitted when `worktreeEnabled` is false. On
   success: close dialog, invalidate `issueListQueryOptions`, call
   `onCreated(result)`. `IssuesTab` then selects the new issue; if a
   worktree is present, the project explorer auto-opens it, matching the
   pattern in `NewWorktreeDialog.onCreated`.
7. **Cancel / Esc** — confirms via small inline "Discard?" prompt only when
   any field has content. No second dialog.

### IssuesTab change (`apps/web/src/components/projectExplorer/IssuesTab.tsx`)

- Add a `PlusIcon` button beside the existing Refresh button.
- Hidden when the resolved provider kind is not `"github"` in Phase 1,
  using the existing `sourceControlDiscoveryState` source of truth.
- The dialog is mounted lazily on open.

### Defense in depth

The dialog also reads provider kind on mount and shows a "Not supported on
this provider yet" empty state if it is ever invoked on a non-GitHub
project. This should not happen via the UI in Phase 1 but is cheap
insurance against future regressions.

## Error handling

### Issue created but worktree creation fails

- Server returns
  `{ issue, worktree: null, worktreeError: <detail> }`.
  Issue creation is the source of truth and is never rolled back.
- Client treats this as success-with-warning: dialog closes, issue is
  selected, a toast says "Issue #N created. Worktree failed: <detail>.
  Retry from the Worktree menu." The user can use the existing
  `NewWorktreeDialog` to retry.

### AI generation fails

- Polish, title, and branch each fail independently. The error renders
  inline under the relevant button as red text with a Retry link. The form
  remains usable; the user can type and submit without AI.

### Provider auth gone mid-flow

- `gh` CLI returns an auth error → `SourceControlProviderError` with
  `detail` set to provider stderr. Surfaced as the submit-level banner in
  the dialog. User content is preserved.

### Concurrent submits

- Submit button is disabled while `submitStatus === "submitting"`. The
  dialog is unmounted on close, so no resubmit race.

### Empty / whitespace handling

- Title is required and validated server-side via `TrimmedNonEmptyString`.
- Body may be empty — GitHub accepts empty issue bodies. Client passes "".
- Empty `labels` / `assignees` arrays are omitted from the `gh` invocation.

### Branch name collisions

- `git.createWorktreeForProject` already handles "branch exists" by
  returning the existing worktree. This dialog inherits that behavior; no
  new code path.

## Security

- `gh issue create --body-file <path>` keeps markdown bodies out of argv and
  mirrors the existing pull-request creation flow.
- Label and assignee names are validated by `gh` against the repo; client
  trims whitespace only.
- AI prompt content is treated as data — the system prompt is fixed and
  user-supplied text is placed in a delimited section, matching the
  existing commit/PR prompt convention.
- Server validates RPC input via Effect Schema, rejecting malformed
  payloads at the boundary.

## Testing

### Server (Vitest + Effect-test)

- `GitHubSourceControlProvider.test.ts` (extended):
  - `createIssue` happy path — correct argv, parses URL, returns
    `SourceControlIssueSummary`.
  - `createIssue` with empty `labels` / `assignees` — no `--label` /
    `--assignee` flags emitted.
  - `createIssue` on `gh` non-zero exit — `SourceControlProviderError`
    with stderr in `detail`.
  - `listLabels` / `listAssignees` — happy path, empty result, auth
    failure.
- `gitHubIssueCreate.test.ts` (new) — argv builder unit tests, including
  the temp-file body path.
- `TextGenerationPrompts.test.ts` (extended) — `polish` and `title` cases:
  JSON output schema, title length rule, policy instruction injection.
- `TextGeneration.test.ts` (extended) — `generateIssueContent` delegates
  to the resolved provider instance; missing instance →
  `TextGenerationError`. Mirrors the existing `generateBranchName`
  pattern.
- Per-driver tests (`CodexTextGeneration.test.ts`, `ClaudeTextGeneration.
  test.ts`, etc.) — one happy-path case per driver confirming wire-up and
  JSON parsing.
- `wsServer` test — RPC routing for the four new methods, input
  validation, error pass-through.
- Provider stub tests — GitLab, Forgejo, Bitbucket, Azure DevOps each
  return the "Not implemented" `SourceControlProviderError` for
  `createIssue`, `listLabels`, `listAssignees`.

### Web (Vitest + Testing Library)

- `NewIssueDialog.logic.test.tsx` — reducer transitions: text edits,
  label and assignee toggles, worktree checkbox, AI status transitions,
  submit-disabled logic. Pure-function tests; no mounting.
- `NewIssueDialog.browser.tsx` — snapshots: empty state, post-polish,
  submitting, submit-error-with-content-preserved. Follows the
  `ContextPickerPopup.browser.tsx` convention.
- `issueCreationRpc.test.ts` — hooks call the right RPC paths with
  correct payloads, using the mocked `wsRpcClient`.
- `IssuesTab` test — `+` button visibility gated by provider kind;
  clicking opens the dialog; `onCreated` invalidates the issues list
  query.

### Not tested

- End-to-end against the real `gh` CLI — too fragile / network-dependent.
  Manual smoke testing covers this surface, matching the existing repo
  convention.
- AI generation quality — model-dependent and out of scope. We test only
  that prompts are constructed correctly and the JSON contract is
  honored.

## Open questions

None at this time. All branching design questions were resolved during
brainstorming:

- Entry point: Issues tab `+` button only (no command palette, no chat-
  selection conversion).
- AI flow: polish-in-place with separate ✨ buttons for title, body, and
  branch.
- Model selection: global `textGenerationModelSelection` from server
  settings, never per-dialog.
- Worktree default: ON.
- Phase 1 provider scope: GitHub only; others stubbed.

## Acceptance criteria

- Clicking the `+` button on the Issues tab opens `NewIssueDialog` when
  the active provider is GitHub.
- The user can fill title and body manually, click `✨ Polish with AI` to
  rewrite the body and optionally the title, click `✨ Suggest from body`
  to rewrite the title, and submit to create a real GitHub issue.
- Labels and assignees pickers populate from the repo and apply on
  submit.
- With the worktree checkbox enabled, submit creates a git worktree using
  the displayed branch name; `↻ Regenerate` produces a new name.
- If worktree creation fails, the issue still exists and a toast surfaces
  the worktree error.
- The `+` button is hidden on non-GitHub projects.
- All server and web unit tests listed in the Testing section pass.
- `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` are green.
