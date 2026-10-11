# Atlassian Bitbucket + Jira Integration - Design Spec

**Date:** 2026-05-12
**Status:** Draft for implementation planning
**Related code paths:** `apps/server/src/sourceControl/*`, `apps/web/src/components/projectExplorer/*`, `apps/web/src/components/settings/SourceControlSettings.tsx`, `apps/web/src/components/chat/*`

## Goal

Make Atlassian workflows feel first-class in Ryco:

1. Bitbucket Cloud should be as easy to connect and use as GitHub/GitLab, without requiring users to manually set environment variables and restart the server.
2. Bitbucket pull requests should render rich review context: details, comments, commits, reviewers, changed files, diffstat, linked Jira keys, and checkout actions.
3. Jira Cloud should be available as a real work-item provider, not hidden behind Bitbucket's repository issue tracker.
4. Users should be able to start coding from a Jira issue, create a branch/worktree, attach the issue as chat context, open a Bitbucket PR, and optionally move the Jira issue through workflow states.

The target experience is:

```
Settings -> Connections -> Connect Atlassian
Project -> Link Jira project(s)
Composer -> #PROJ-123 or #42 to attach Jira/Bitbucket context
Project Explorer -> Jira + Bitbucket PRs in one useful workspace
Git action -> Create PR with Jira key, linked issue, and optional Jira transition
```

## Non-goals

- Bitbucket Server/Data Center support. v1 is Bitbucket Cloud only.
- Jira Data Center support. v1 is Jira Cloud only.
- Creating or editing Jira issues in v1. v1 can read, comment, and transition existing issues.
- Full Atlassian Marketplace app packaging. This is an Ryco server-side integration, not a Marketplace distribution.
- Replacing Git. Local operations remain Git-backed through the existing VCS layer.
- Replacing existing GitHub/GitLab/Azure source-control providers.

## Current State

Bitbucket currently exists as a server-side REST implementation:

- `BitbucketApi.ts` reads `RYCO_BITBUCKET_ACCESS_TOKEN` or `RYCO_BITBUCKET_EMAIL` + `RYCO_BITBUCKET_API_TOKEN`.
- `BitbucketSourceControlProvider.ts` maps REST results into the shared `SourceControlProvider` interface.
- `SourceControlProviderRegistry.ts` registers Bitbucket lazily beside GitHub, GitLab, and Azure DevOps.
- `docs/source-control-providers.md` tells users to create a Bitbucket API token, set env vars, restart Ryco, then rescan.

Supported today:

- Repository lookup, clone URLs, create repository.
- PR list/get/create/checkout.
- Default branch lookup, including Bitbucket branching model.
- Bitbucket issue list/get/search.
- PR/issue body and recent comments.
- Composer source-control context can attach Bitbucket issues/PRs because it uses the provider-neutral contracts.

Important gaps:

- No in-app Bitbucket credential setup.
- Invalid Bitbucket credentials often degrade to "unknown/configured" instead of a clear unauthenticated state.
- No dedicated `sourceControl.listChangeRequests` RPC; the web lists PRs by calling search with an empty query and ignores state filters.
- `getChangeRequestDiff` returns an empty string for Bitbucket.
- PR detail lacks commits, files, diffstat, reviewers, participants, task counts, draft flag, and linked Jira issue keys.
- Some UI text is provider-specific in the wrong way, e.g. "View on GitHub" in the generic PR detail view.
- No Jira integration exists in the repository.

## Design Principles

1. **Atlassian account first, product capabilities second.** Users connect Atlassian once, then Ryco discovers available Jira sites and Bitbucket workspaces.
2. **Provider-neutral contracts stay useful.** Bitbucket PRs should populate existing `SourceControlChangeRequestDetail` fields before introducing provider-specific UI.
3. **Jira is not Bitbucket issues.** Jira becomes a separate work-item provider. Bitbucket's repository issue tracker remains supported but is not the main Atlassian issue workflow.
4. **No secrets in browser state.** Web UI receives redacted connection status only. Tokens live server-side in `ServerSecretStore`.
5. **Graceful degradation.** Existing env var Bitbucket setup continues working. Missing Jira scopes should disable Jira actions without breaking Bitbucket PRs.
6. **Predictable under failure.** Token refresh, rate limits, inaccessible sites, disabled Bitbucket issue trackers, and missing Jira projects get explicit error states.

## Architecture Overview

```
apps/web
  Settings -> Atlassian connection UI
  Project Explorer -> Bitbucket PR + Jira issue tabs
  Composer -> source-control + work-item context picker
  Git actions -> branch/PR/Jira workflow actions

packages/contracts
  atlassian.ts
  workItems.ts
  sourceControl.ts additions
  rpc.ts additions

apps/server
  atlassian/
    AtlassianConnectionService
    AtlassianOAuthService
    AtlassianClient
    AtlassianResourceDiscovery
  sourceControl/
    BitbucketApi upgraded to credential provider + richer PR APIs
  workItems/
    WorkItemProvider
    JiraWorkItemProvider
    WorkItemProviderRegistry
  project/
    ProjectAtlassianLinkService
  git/
    GitManager Jira-aware branch/PR helpers
```

## Authentication Model

### v1 credential strategy

Use two paths:

1. **Preferred:** Atlassian OAuth 2.0 3LO for Jira Cloud, with token refresh and accessible-resource discovery.
2. **Fallback:** Bitbucket Cloud app password/API token stored through Ryco Settings for users who cannot use OAuth.

Bitbucket Cloud and Jira Cloud have historically had different auth surfaces. The implementation should avoid assuming one token always covers both products. The abstraction is:

```ts
type AtlassianCredentialCapability =
  | "jira:read"
  | "jira:write"
  | "bitbucket:read"
  | "bitbucket:write";
```

Each saved Atlassian connection advertises capabilities based on actual token type and verified probes.

### Secret storage

Token material goes into `ServerSecretStore`, keyed by connection id:

```
atlassian.connection.<connectionId>.accessToken
atlassian.connection.<connectionId>.refreshToken
atlassian.connection.<connectionId>.bitbucketToken
```

Database rows store only metadata:

- connection id
- account id/display name/email
- auth kind
- scopes/capabilities
- created/updated/last verified timestamps
- token expiration timestamp, if known
- redacted status

### OAuth callback

Add HTTP endpoints:

- `GET /api/atlassian/oauth/start`
- `GET /api/atlassian/oauth/callback`
- `POST /api/atlassian/connections/:id/disconnect`
- `POST /api/atlassian/connections/:id/refresh`

The start endpoint creates state/PKCE verifier material server-side, stores it temporarily in `ServerSecretStore` or a short-lived persistence table, and returns the authorization URL to the web client. The browser opens that URL. The callback completes the exchange and redirects back to Settings.

Security requirements:

- Use `state`.
- Use PKCE if supported by the chosen app type.
- Never log access tokens, refresh tokens, authorization codes, app passwords, or full Authorization headers.
- Redact credentials in errors surfaced to the web.
- Token refresh must be serialized per connection to avoid refresh-token races.

## Persistence

Add migrations:

### `atlassian_connections`

| column              | type      | notes                                             |
| ------------------- | --------- | ------------------------------------------------- |
| `connection_id`     | TEXT PK   | opaque id                                         |
| `kind`              | TEXT      | `oauth_3lo` or `bitbucket_token`                  |
| `account_id`        | TEXT NULL | Atlassian account id when known                   |
| `account_email`     | TEXT NULL | redacted in UI                                    |
| `display_name`      | TEXT NULL | user-facing label                                 |
| `capabilities_json` | TEXT      | JSON string array                                 |
| `scopes_json`       | TEXT      | JSON string array                                 |
| `status`            | TEXT      | `connected`, `needs_reauth`, `invalid`, `revoked` |
| `last_verified_at`  | TEXT NULL | ISO timestamp                                     |
| `expires_at`        | TEXT NULL | access token expiry                               |
| `created_at`        | TEXT      | ISO timestamp                                     |
| `updated_at`        | TEXT      | ISO timestamp                                     |

### `atlassian_resources`

Represents Jira sites and Bitbucket workspaces discovered for a connection.

| column           | type      | notes                             |
| ---------------- | --------- | --------------------------------- |
| `resource_id`    | TEXT PK   | opaque id or provider resource id |
| `connection_id`  | TEXT FK   | parent connection                 |
| `product`        | TEXT      | `jira` or `bitbucket`             |
| `cloud_id`       | TEXT NULL | Jira Cloud id                     |
| `workspace_slug` | TEXT NULL | Bitbucket workspace               |
| `name`           | TEXT      | display name                      |
| `url`            | TEXT      | site/workspace URL                |
| `avatar_url`     | TEXT NULL | optional                          |
| `last_seen_at`   | TEXT      | ISO timestamp                     |

### `project_atlassian_links`

Maps Ryco projects to Jira project keys and Bitbucket repository identity.

| column                      | type      | notes                      |
| --------------------------- | --------- | -------------------------- |
| `project_id`                | TEXT      | Ryco project id            |
| `connection_id`             | TEXT      | Atlassian connection       |
| `jira_cloud_id`             | TEXT NULL | selected Jira site         |
| `jira_project_keys_json`    | TEXT      | e.g. `["RYCO", "WEB"]`     |
| `bitbucket_workspace`       | TEXT NULL | inferred/selected          |
| `bitbucket_repo_slug`       | TEXT NULL | inferred/selected          |
| `branch_template`           | TEXT      | default `{key}-{slug}`     |
| `pr_title_template`         | TEXT      | default `{key}: {summary}` |
| `auto_comment_on_pr`        | INTEGER   | 0/1                        |
| `auto_transition_on_branch` | INTEGER   | 0/1                        |
| `auto_transition_on_pr`     | INTEGER   | 0/1                        |
| `created_at`                | TEXT      | ISO timestamp              |
| `updated_at`                | TEXT      | ISO timestamp              |

Primary key: `(project_id, connection_id)`.

## Contracts

### `packages/contracts/src/atlassian.ts`

Add schemas for:

- `AtlassianConnectionId`
- `AtlassianConnectionStatus`
- `AtlassianCapability`
- `AtlassianConnectionSummary`
- `AtlassianResourceSummary`
- `ProjectAtlassianLink`
- connect/disconnect/refresh RPC payloads

### `packages/contracts/src/workItems.ts`

Add provider-neutral work-item types:

```ts
WorkItemProviderKind = "jira";

WorkItemSummary = {
  provider: "jira";
  key: string;              // PROJ-123
  title: string;
  url: string;
  state: "open" | "in_progress" | "done" | "closed" | "unknown";
  statusName: string;       // Jira workflow status
  statusCategory?: string;  // To Do / In Progress / Done
  type?: string;            // Bug / Story / Task
  priority?: string;
  assignee?: string;
  reporter?: string;
  labels?: string[];
  updatedAt: DateTimeUtc;
};

WorkItemDetail = WorkItemSummary & {
  body: string;
  comments: SourceControlIssueComment[];
  transitions?: WorkItemTransition[];
  linkedChangeRequests?: LinkedChangeRequest[];
  truncated: boolean;
};
```

Keep this provider-neutral so Linear or other trackers can be added later.

### `packages/contracts/src/sourceControl.ts`

Extend existing source-control contracts with fields Bitbucket can populate:

- `author`
- `reviewers`
- `participants`
- `isDraft`
- `commentsCount`
- `tasksCount`
- `commits`
- `files`
- `additions`
- `deletions`
- `changedFiles`
- `linkedWorkItemKeys`

Do not remove existing fields.

### `packages/contracts/src/rpc.ts`

Add:

- `atlassian.listConnections`
- `atlassian.startOAuth`
- `atlassian.completeOAuth`
- `atlassian.disconnect`
- `atlassian.refresh`
- `atlassian.listResources`
- `atlassian.saveProjectLink`
- `atlassian.getProjectLink`
- `sourceControl.listChangeRequests`
- `workItems.list`
- `workItems.search`
- `workItems.get`
- `workItems.addComment`
- `workItems.transition`
- `workItems.listTransitions`

## Server Services

### `AtlassianConnectionService`

Owns persistence and secret coordination.

Methods:

- `listConnections()`
- `getConnection(connectionId)`
- `upsertOAuthConnection(...)`
- `upsertBitbucketTokenConnection(...)`
- `disconnect(connectionId)`
- `markNeedsReauth(connectionId, reason)`
- `verify(connectionId)`
- `listResources(connectionId)`

### `AtlassianClient`

HTTP wrapper with:

- auth header injection
- token refresh
- JSON decode helper
- rate limit detection
- Atlassian error normalization
- per-connection request logging without secrets

### `BitbucketCredentialProvider`

Provides the best available Bitbucket credential:

1. Project-linked Atlassian connection with Bitbucket capability.
2. Any server default Atlassian connection with Bitbucket capability.
3. Existing env var credentials.

`BitbucketApi` should depend on this provider instead of directly reading env config for all requests. Env config remains only as fallback implementation.

### `JiraWorkItemProvider`

Uses Jira Cloud REST API through `AtlassianClient`.

Core behavior:

- `listWorkItems`: default JQL from project link, usually `project in (...) ORDER BY updated DESC`.
- `searchWorkItems`: if query looks like issue key, fetch directly; otherwise JQL text search.
- `getWorkItem`: fetch issue fields + comments + transitions in parallel where possible.
- `addComment`: post comment body.
- `transition`: call Jira transition endpoint.
- `listLinkedChangeRequests`: v1 can combine parsed local Bitbucket PR metadata and Jira development info when available.

## Bitbucket Improvements

### Dedicated PR listing

Add server method:

```ts
sourceControl.listChangeRequests({
  cwd,
  state,
  limit,
  query?,
})
```

Provider implementations can use their native list operations. The web project explorer and composer stop using empty-query search as list.

### Pagination helper

Implement a Bitbucket paginated GET helper:

```ts
executePagedJson({
  operation,
  initialRequest,
  itemSchema,
  limit,
});
```

Respect `pagelen`, `next`, and client-requested limits. Keep default limits small for UI latency.

### Rich PR detail

Populate:

- body
- comments
- reviewers/participants
- commits
- changed files
- additions/deletions
- linked Jira keys
- draft flag if present
- comments/tasks counts if present

Use parallel calls:

```
GET /repositories/{workspace}/{repo_slug}/pullrequests/{id}
GET /repositories/{workspace}/{repo_slug}/pullrequests/{id}/comments
GET /repositories/{workspace}/{repo_slug}/pullrequests/{id}/commits
GET /repositories/{workspace}/{repo_slug}/pullrequests/{id}/diffstat
GET /repositories/{workspace}/{repo_slug}/pullrequests/{id}/diff
```

### Linked Jira key extraction

Add shared helper:

```ts
extractJiraIssueKeys(text: string): string[]
```

Run against:

- branch names
- PR title
- PR description
- commit messages

Use a conservative default pattern:

```
\b[A-Z][A-Z0-9]+-\d+\b
```

Allow project links to restrict to configured Jira project keys.

## Jira + Bitbucket Workflow

### Start from Jira issue

Entry points:

- Project Explorer Jira tab row action: `Start work`
- Composer context chip action: `Create branch`
- Command palette action: `Start from Jira issue`

Flow:

1. User selects `PROJ-123`.
2. Server resolves project Atlassian link.
3. Server creates branch name from template.
4. Server creates/switches worktree or branch.
5. New chat draft opens with Jira issue context attached.
6. Optional: transition Jira issue to an "in progress" state.

### Create PR for Jira issue

When current branch contains a Jira key or a Jira work item is attached:

- PR title template defaults to `{key}: {generatedTitle}` or `{key}: {summary}`.
- PR body includes a `Jira: PROJ-123` line.
- After creation, Ryco optionally posts a Jira comment with the Bitbucket PR link.
- Optional transition to configured review state.

### Work item transitions

Transitions vary by Jira workflow. UI must not hard-code "In Progress" or "In Review" as transition ids.

Implementation:

- Fetch transitions for issue.
- Show a small menu of available transitions.
- Project link settings can remember preferred transition id per action:
  - branch created
  - PR created
  - PR merged

## UI Design

### Settings -> Connections

Replace the passive Source Control provider list with a richer connection manager while preserving existing provider status rows.

Sections:

1. **Version Control**
   - Git/JJ availability, unchanged.
2. **Connected Accounts**
   - Atlassian account card.
   - GitHub/GitLab/Azure rows remain as today.
3. **Atlassian**
   - Connect Atlassian button.
   - Manual Bitbucket token fallback.
   - Connected Jira sites.
   - Connected Bitbucket workspaces.
   - Missing scopes warnings.
   - Disconnect/refresh controls.

The Atlassian card states:

- Connected as `<account>`
- Jira: `N sites`
- Bitbucket: `N workspaces` or `manual token`
- Last verified
- Problems and fix action

### Project Settings / Project Link

Add a project-level Atlassian link panel:

- Select Atlassian connection.
- Select Jira site.
- Select Jira project keys.
- Show detected Bitbucket workspace/repo from Git remote.
- Branch template input.
- PR title template input.
- Toggles for Jira comments/transitions.
- Test link button.

### Project Explorer

Tabs:

- Branches
- Pull Requests
- Issues
- Jira

If the repo has Bitbucket but no Jira link:

- Show Bitbucket PRs normally.
- Jira tab shows a setup empty state with "Link Jira project".

PR detail:

- Provider-aware external link label.
- Conversation tab.
- Commits tab.
- Files changed tab with real Bitbucket diffstat.
- Sidebar: reviewers, assignees, labels, linked Jira issues, tasks.

Jira detail:

- Header: key, title, status, type, priority.
- Body/description.
- Comments.
- Linked PRs.
- Available transitions.
- Actions: attach to chat, create branch, open in Jira.

### Composer

The `#` picker becomes provider-aware:

- `#42` -> provider issue/PR numeric lookup.
- `#PROJ-123` -> Jira issue lookup.
- Text search -> tabs for Jira, Issues, PRs.

Attached chips:

- Jira chip: `PROJ-123` + title + status color.
- Bitbucket PR chip: `PR #42` + title.
- Bitbucket issue chip: `Issue #42` + title.

On send:

- Source-control contexts and work-item contexts are formatted separately.
- Stale contexts refetch best-effort before turn dispatch.
- If refetch fails, send the cached context with a stale marker.

### Sidebar / Worktree Rows

When a worktree or thread is linked to a Jira issue:

- Show a compact Jira key chip near the branch/PR chip.
- Clicking opens Jira detail in the project explorer/right panel.
- If a PR is linked too, show both `PROJ-123` and `PR #42`.

## Error Handling

### Auth errors

- Expired token: mark connection `needs_reauth`, show Fix connection.
- Revoked token: mark `invalid`, disable actions.
- Missing scope: keep connection, disable only affected product/action.
- Bitbucket env fallback invalid: show unauthenticated with env-var hint.

### API errors

- 401/403: auth or scope issue, not generic failure.
- 404 Bitbucket issues disabled: empty state "Bitbucket issue tracker is disabled."
- 404 Jira issue: "Issue not found or not visible to this account."
- 429: retry when safe; otherwise show rate-limited state with retry time if available.
- Schema decode failures: log sanitized payload shape; show "Provider returned an unsupported response."

### Offline/degraded

Use TanStack Query cache in web for short-lived UI caching. Server-side request caches can be added later only around resource discovery and project links.

## Testing Strategy

### Contracts

- Schema decode/encode for Atlassian connection summaries.
- Work item summary/detail schemas.
- RPC payload schemas.

### Server

- Secret storage metadata never includes token values.
- OAuth state handling rejects mismatches.
- Token refresh serializes concurrent refreshes.
- Bitbucket env fallback still works.
- Bitbucket invalid auth is unauthenticated.
- Bitbucket pagination follows `next` until limit.
- Bitbucket PR detail merges detail/comments/commits/diffstat.
- Jira JQL construction escapes user input.
- Jira issue-key direct lookup avoids broad search.
- Jira transition/comment calls use correct endpoints.
- Project link inference from Bitbucket remote works.

### Web

- Settings shows connected/needs-reauth/missing-scope states.
- Manual Bitbucket token dialog redacts token after save.
- Project Explorer shows provider-aware labels.
- Bitbucket PR detail files tab renders non-empty diffstat.
- Jira tab empty/setup/loading/error states.
- Composer `#PROJ-123` attach flow.
- Duplicate context chips are prevented.

### Browser verification

Use browser tests/screenshots for:

- Settings Atlassian connection card.
- Project Explorer Bitbucket PR detail.
- Jira issue detail view.
- Composer context picker with Jira and PR tabs.

## Rollout Plan

Milestone 1: Bitbucket usability and correctness.

- Settings-based Bitbucket token storage.
- Better auth status.
- Real PR list RPC.
- Provider-aware PR detail UI labels.

Milestone 2: Rich Bitbucket PRs.

- Commits/files/diffstat/reviewers.
- Real diff endpoint.
- Linked Jira key extraction.

Milestone 3: Jira read-only.

- Atlassian OAuth.
- Jira resource discovery.
- Project Jira link.
- Jira search/detail/context attach.

Milestone 4: Jira workflow actions.

- Start from Jira issue.
- Branch naming templates.
- PR title/body Jira key insertion.
- Optional Jira comments and transitions.

Milestone 5: Polish and reliability.

- Rate-limit handling.
- Better empty states.
- Browser QA.
- Documentation update.

## Open Decisions

1. Whether to support a single global Atlassian connection initially, or multiple named connections from day one. Recommendation: multiple internally, single default in UI for v1.
2. Whether Bitbucket OAuth should be implemented immediately or whether Settings-stored app passwords are enough for Milestone 1. Recommendation: token fallback first, Jira OAuth next.
3. Whether Jira transitions should be enabled by default. Recommendation: off by default; users opt in per project.
4. Whether Jira comments on PR creation should be automatic. Recommendation: off by default; visible toggle in project link settings.
5. Whether `workItems` should eventually replace source-control issues for all providers. Recommendation: no for now; keep source-control issues and work items separate.

## References

- Atlassian OAuth 2.0: https://developer.atlassian.com/cloud/oauth/
- Jira OAuth 2.0 3LO: https://developer.atlassian.com/cloud/jira/platform/three-legged-oauth/
- Bitbucket Cloud REST API: https://developer.atlassian.com/cloud/bitbucket/rest/intro/
- Bitbucket pull request REST API: https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/
- Jira issue search REST API: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/
- Jira issue comments REST API: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/
