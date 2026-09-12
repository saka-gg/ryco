# Agent Control project and settings governance

Agent Control project mutations use the same immutable proposal, approval,
executor, orchestration-command, and audit lifecycle as thread mutations. MCP
handlers only prepare and submit plans. They never dispatch a project command,
write a projection, or touch workspace contents.

## Project operations

- `createProject` links one existing authorized directory. Its plan fixes the
  project id, display name, canonical workspace root, metadata directory, and
  repository identity. Execution dispatches `project.create` with directory
  creation disabled.
- `updateProject` changes the display name, canonical workspace root, default model selection, custom system prompt,
  scripts, and/or preferred remote.
  The plan records exact before/after values, repository identities, and the
  expected `updatedAt` revision.
- `removeProject` unlinks the Ryco project record. The plan records the exact
  project state and exact thread ids. `force` must be explicit when Ryco thread
  records would also be removed. The executor dispatches `project.delete`; it
  never calls a filesystem removal API and never deletes the repository or
  working directory.

Preparation and execution both apply the existing workspace access policy,
workspace normalization, repository identity, projection snapshot, and caller
project-scope checks. Execution revalidates the exact project revision, paths,
repository identity, thread set, and target availability.

## Routine preferences and approval

Private-session project title, default model and preferred remote updates execute automatically.
Workspace changes, script edits and custom system prompt edits still require approval. The immutable
plan includes before/after preferences, and the project revision guard rejects stale updates.
Previously persisted plans without preference fields remain readable and do not reset preferences.

The global settings allowlist contains only `legacyTokenStreaming` (`enableLegacyTokenStreaming`)
and `providerUpdateChecks` (`enableProviderUpdateChecks`). These non-secret boolean preferences
can execute for a private session through the same durable executor. Execution verifies the captured
before value and refuses stale requests. The settings service persists only the selected key.

Secrets, credentials, provider commands and environment, MCP connection/auth configuration,
remote/relay/hosted authentication, filesystem roots, network exposure and Agent Control policy
remain outside the schema. There is no generic settings JSON patch tool. Standalone external
integrations cannot change global settings or manage projects.

## Audit and approval presentation

The immutable proposal row retains the exact approved plan and terminal result.
Append-only audit rows reference that proposal and digest while retaining
requester/provider identity, timestamps, decision transitions, operation id,
outcome, and bounded non-secret action metadata. Web and mobile use the shared
client-runtime presentation model to show exact project/settings values;
project unlink proposals are explicitly destructive and state that workspace
contents are retained.
