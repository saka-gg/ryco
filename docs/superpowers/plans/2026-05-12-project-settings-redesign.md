# Project Settings Dialog Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cluttered project settings dialog with a sidebar-nav layout matching the global SettingsDialog, add a real custom project image (upload + remove with server-side storage), and surface all git remotes with a per-project "preferred primary" override.

**Architecture:** Three coordinated layers. (1) Contracts: extend `OrchestrationProject`, `RepositoryIdentity`, and the `project.meta.update` command; add a new `project.avatar.set` command. (2) Server: extend `RepositoryIdentityResolver` to return all remotes, add a SQL migration + projector logic for the two new project fields, add two HTTP routes for avatar upload/serving with disk storage under `<server-data-dir>/project-avatars/`. (3) Web: redesign `ProjectSettingsDialog` with a `Settings2`/`FolderOpen`/`Sparkles` left nav, extend `ProjectFavicon` to render the custom avatar when set, update `resolveProjectRemoteLink` to honor `preferredRemoteName`.

**Tech Stack:** TypeScript, Effect (server runtime), Effect Schema (contracts), SQLite (persistence), React + Tailwind + Base UI (web). Tests use `@effect/vitest` on the server and `vitest` on the web.

**Spec:** `docs/superpowers/specs/2026-05-12-project-settings-redesign-design.md`

---

## File Structure

**Contracts** (`packages/contracts/src/`)

- Modify `environment.ts` — extend `RepositoryIdentity` with `remotes` array
- Modify `orchestration.ts` — extend `OrchestrationProject`, `ProjectMetaUpdateCommand`, `ProjectMetaUpdatedPayload`; add `ProjectAvatarSetCommand`, `ProjectAvatarSetPayload`, and a corresponding event entry

**Server** (`apps/server/src/`)

- Modify `project/Layers/RepositoryIdentityResolver.ts` — populate `remotes`
- Modify `project/Layers/RepositoryIdentityResolver.test.ts` — assertions for `remotes`
- Create `persistence/Migrations/034_ProjectAvatarAndPreferredRemote.ts` — add two TEXT columns
- Modify `persistence/Layers/ProjectionProjects.ts` — read/write the two new columns
- Modify `orchestration/Layers/ProjectionSnapshotQuery.ts` — surface the two new fields in `OrchestrationProjectShell` mapping
- Modify `orchestration/decider.ts` — handle `project.avatar.set` and accept `preferredRemoteName` on `project.meta.update`
- Modify `orchestration/projector.ts` — apply the new payload fields to the in-memory projection
- Create `project/Services/ProjectAvatarStore.ts` — service interface for disk storage
- Create `project/Layers/ProjectAvatarStore.ts` — concrete implementation
- Create `project/Layers/ProjectAvatarStore.test.ts` — upload + read + delete tests
- Modify `http.ts` — add `projectAvatarUploadRouteLayer` and `projectAvatarServeRouteLayer`
- Modify `server.ts` (or wherever the http router is composed) — wire the new layers

**Web** (`apps/web/src/`)

- Modify `types.ts` — extend the `Project` interface with the two new fields
- Modify `store.ts` — map the two new fields in `mapProject`
- Modify `components/ProjectFavicon.tsx` — render custom avatar when set
- Modify `components/Sidebar.tsx`:
  - Rewrite the `ProjectSettingsDialog` function (lines 1317–1526)
  - Update `resolveProjectRemoteLink` to honor `preferredRemoteName`
  - Update the parent state setters/handlers wiring the dialog
  - Drop the worktree props and the duplicated path display

---

## Phase 1 — Contracts

### Task 1: Extend `RepositoryIdentity` with all remotes

**Files:**

- Modify: `packages/contracts/src/environment.ts:44-60`

- [ ] **Step 1: Add the `RepositoryRemote` schema and `remotes` field**

Add a new schema next to the existing `RepositoryIdentityLocator`, then extend `RepositoryIdentity`:

```typescript
export const RepositoryRemote = Schema.Struct({
  name: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  provider: Schema.optionalKey(TrimmedNonEmptyString),
  ownerRepo: Schema.optionalKey(TrimmedNonEmptyString),
});
export type RepositoryRemote = typeof RepositoryRemote.Type;

export const RepositoryIdentity = Schema.Struct({
  canonicalKey: TrimmedNonEmptyString,
  locator: RepositoryIdentityLocator,
  rootPath: Schema.optionalKey(TrimmedNonEmptyString),
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
  provider: Schema.optionalKey(TrimmedNonEmptyString),
  owner: Schema.optionalKey(TrimmedNonEmptyString),
  name: Schema.optionalKey(TrimmedNonEmptyString),
  remotes: Schema.Array(RepositoryRemote).pipe(Schema.withDecodingDefault(() => [])),
});
export type RepositoryIdentity = typeof RepositoryIdentity.Type;
```

The `withDecodingDefault(() => [])` ensures existing persisted snapshots without the field decode successfully — important because `repositoryIdentity` is not stored in SQL; it is recomputed each read, so this is mostly defensive.

- [ ] **Step 2: Build the contracts package to type-check the change**

Run: `bun --filter @ryco/contracts build` (or `bun run -F @ryco/contracts build`)
Expected: SUCCESS

- [ ] **Step 3: Commit**

```bash
git add packages/contracts/src/environment.ts
git commit -m "feat(contracts): extend RepositoryIdentity with all remotes"
```

### Task 2: Extend `OrchestrationProject` with `customAvatarContentHash` and `preferredRemoteName`

**Files:**

- Modify: `packages/contracts/src/orchestration.ts:209-224`

- [ ] **Step 1: Add the two fields**

Update `OrchestrationProject`:

```typescript
export const OrchestrationProject = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  projectMetadataDir: Schema.optional(ProjectMetadataDir).pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_PROJECT_METADATA_DIR)),
  ),
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  customSystemPrompt: Schema.optional(Schema.NullOr(ProjectCustomSystemPrompt)),
  customAvatarContentHash: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null as string | null)),
  ),
  preferredRemoteName: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null as string | null)),
  ),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
```

- [ ] **Step 2: Build to verify**

Run: `bun --filter @ryco/contracts build`
Expected: SUCCESS

- [ ] **Step 3: Commit**

```bash
git add packages/contracts/src/orchestration.ts
git commit -m "feat(contracts): add customAvatarContentHash and preferredRemoteName to OrchestrationProject"
```

### Task 3: Extend `ProjectMetaUpdateCommand` and `ProjectMetaUpdatedPayload`

**Files:**

- Modify: `packages/contracts/src/orchestration.ts:507-517` and the `ProjectMetaUpdatedPayload` near line 968

- [ ] **Step 1: Add `preferredRemoteName` to both**

In `ProjectMetaUpdateCommand`:

```typescript
const ProjectMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("project.meta.update"),
  commandId: CommandId,
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  projectMetadataDir: Schema.optional(ProjectMetadataDir),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  customSystemPrompt: Schema.optional(Schema.NullOr(ProjectCustomSystemPrompt)),
  preferredRemoteName: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
});
```

In `ProjectMetaUpdatedPayload`:

```typescript
export const ProjectMetaUpdatedPayload = Schema.Struct({
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  projectMetadataDir: Schema.optional(ProjectMetadataDir),
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  customSystemPrompt: Schema.optional(Schema.NullOr(ProjectCustomSystemPrompt)),
  preferredRemoteName: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
  updatedAt: IsoDateTime,
});
```

- [ ] **Step 2: Build to verify**

Run: `bun --filter @ryco/contracts build`
Expected: SUCCESS

- [ ] **Step 3: Commit**

```bash
git add packages/contracts/src/orchestration.ts
git commit -m "feat(contracts): allow preferredRemoteName on project.meta.update"
```

### Task 4: Add `project.avatar.set` command, event, and payload

**Files:**

- Modify: `packages/contracts/src/orchestration.ts`

- [ ] **Step 1: Define the command schema**

Add near the other project commands (close to `ProjectDeleteCommand` around line 519):

```typescript
const ProjectAvatarSetCommand = Schema.Struct({
  type: Schema.Literal("project.avatar.set"),
  commandId: CommandId,
  projectId: ProjectId,
  contentHash: Schema.NullOr(TrimmedNonEmptyString),
});
```

Then add `ProjectAvatarSetCommand` to the `DispatchableClientOrchestrationCommand` union near line 773:

```typescript
const DispatchableClientOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectAvatarSetCommand,
  ProjectDeleteCommand,
  // ...existing entries unchanged
]);
```

- [ ] **Step 2: Define the event payload**

Add near `ProjectMetaUpdatedPayload`:

```typescript
export const ProjectAvatarSetPayload = Schema.Struct({
  projectId: ProjectId,
  contentHash: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});
```

- [ ] **Step 3: Add the event variant**

Locate the `OrchestrationEvent` union (search for `project.deleted` near line 1222). Add a new variant:

```typescript
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.avatar-set"),
    payload: ProjectAvatarSetPayload,
  }),
```

- [ ] **Step 4: Build to verify**

Run: `bun --filter @ryco/contracts build`
Expected: SUCCESS

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/orchestration.ts
git commit -m "feat(contracts): add project.avatar.set command and project.avatar-set event"
```

---

## Phase 2 — Server: resolver, persistence, projector

### Task 5: Populate `remotes` in `RepositoryIdentityResolver`

**Files:**

- Modify: `apps/server/src/project/Layers/RepositoryIdentityResolver.ts`
- Modify: `apps/server/src/project/Layers/RepositoryIdentityResolver.test.ts`

- [ ] **Step 1: Add a failing test for the new `remotes` field**

Append to `RepositoryIdentityResolver.test.ts` inside the `it.layer(NodeServices.layer)("RepositoryIdentityResolverLive", ...)` block:

```typescript
it.effect("populates all remotes in addition to the auto-picked locator", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "ryco-repository-identity-remotes-test-",
    });

    yield* git(cwd, ["init"]);
    yield* git(cwd, ["remote", "add", "origin", "git@github.com:sak0a/ryco.git"]);
    yield* git(cwd, ["remote", "add", "upstream", "git@github.com:Ryco/ryco.git"]);

    const resolver = yield* RepositoryIdentityResolver;
    const identity = yield* resolver.resolve(cwd);

    expect(identity).not.toBeNull();
    // Auto-pick prefers upstream over origin.
    expect(identity?.locator.remoteName).toBe("upstream");
    const remoteNames = (identity?.remotes ?? []).map((remote) => remote.name).toSorted();
    expect(remoteNames).toEqual(["origin", "upstream"]);
    const origin = identity?.remotes.find((remote) => remote.name === "origin");
    expect(origin?.ownerRepo).toBe("sak0a/ryco");
    expect(origin?.provider).toBe("github");
  }).pipe(Effect.provide(RepositoryIdentityResolverLive)),
);
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `bun vitest run apps/server/src/project/Layers/RepositoryIdentityResolver.test.ts`
Expected: FAIL — `remotes` will be undefined.

- [ ] **Step 3: Update `buildRepositoryIdentity` and `resolveRepositoryIdentityFromCacheKey` to surface all remotes**

Replace the body of these two helpers in `RepositoryIdentityResolver.ts`:

```typescript
function buildRepositoryIdentity(input: {
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly rootPath: string;
  readonly allRemotes: ReadonlyMap<string, string>;
}): RepositoryIdentity {
  const canonicalKey = normalizeGitRemoteUrl(input.remoteUrl);
  const sourceControlProvider = detectSourceControlProviderFromGitRemoteUrl(input.remoteUrl);
  const repositoryPath = canonicalKey.split("/").slice(1).join("/");
  const repositoryPathSegments = repositoryPath.split("/").filter((segment) => segment.length > 0);
  const [owner] = repositoryPathSegments;
  const repositoryName = repositoryPathSegments.at(-1);

  const remotes = [...input.allRemotes.entries()].map(([name, url]) => {
    const provider = detectSourceControlProviderFromGitRemoteUrl(url);
    const canonical = normalizeGitRemoteUrl(url);
    const ownerRepo = canonical.split("/").slice(1).join("/");
    return {
      name,
      url,
      ...(provider ? { provider: provider.kind } : {}),
      ...(ownerRepo ? { ownerRepo } : {}),
    };
  });

  return {
    canonicalKey,
    locator: {
      source: "git-remote",
      remoteName: input.remoteName,
      remoteUrl: input.remoteUrl,
    },
    rootPath: input.rootPath,
    ...(repositoryPath ? { displayName: repositoryPath } : {}),
    ...(sourceControlProvider ? { provider: sourceControlProvider.kind } : {}),
    ...(owner ? { owner } : {}),
    ...(repositoryName ? { name: repositoryName } : {}),
    remotes,
  };
}

async function resolveRepositoryIdentityFromCacheKey(
  cacheKey: string,
): Promise<RepositoryIdentity | null> {
  try {
    const remoteResult = await runProcess("git", ["-C", cacheKey, "remote", "-v"], {
      allowNonZeroExit: true,
    });
    if (remoteResult.code !== 0) {
      return null;
    }

    const allRemotes = parseRemoteFetchUrls(remoteResult.stdout);
    const remote = pickPrimaryRemote(allRemotes);
    return remote ? buildRepositoryIdentity({ ...remote, rootPath: cacheKey, allRemotes }) : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `bun vitest run apps/server/src/project/Layers/RepositoryIdentityResolver.test.ts`
Expected: PASS for all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/project/Layers/RepositoryIdentityResolver.ts apps/server/src/project/Layers/RepositoryIdentityResolver.test.ts
git commit -m "feat(server): populate RepositoryIdentity.remotes with all git remotes"
```

### Task 6: Add SQL migration for the two new project columns

**Files:**

- Create: `apps/server/src/persistence/Migrations/034_ProjectAvatarAndPreferredRemote.ts`

- [ ] **Step 1: Write the migration**

```typescript
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  const columnNames = new Set(columns.map((column) => column.name));

  if (!columnNames.has("custom_avatar_content_hash")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN custom_avatar_content_hash TEXT
    `;
  }

  if (!columnNames.has("preferred_remote_name")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN preferred_remote_name TEXT
    `;
  }
});
```

- [ ] **Step 2: Locate and register the migration**

Search for the migrations registry:

```bash
grep -n "033_ProjectMetadataDir" apps/server/src/persistence -r
```

Expected: a file like `migrations.ts` or similar listing the migration imports.

Add the new migration to that registry in numerical order (immediately after `033`).

- [ ] **Step 3: Build the server**

Run: `bun --filter @ryco/server build`
Expected: SUCCESS

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/persistence/Migrations/034_ProjectAvatarAndPreferredRemote.ts apps/server/src/persistence/Migrations/index.ts
git commit -m "feat(server): add migration for project avatar and preferred remote columns"
```

(Adjust the `index.ts` path to wherever migrations are registered.)

### Task 7: Read/write the two new columns in `ProjectionProjects` persistence layer

**Files:**

- Modify: `apps/server/src/persistence/Layers/ProjectionProjects.ts`

- [ ] **Step 1: Add the new columns to inserts, updates, and selects**

For every `INSERT INTO projection_projects (...)` add the columns `custom_avatar_content_hash`, `preferred_remote_name` and bind from `row.customAvatarContentHash ?? null`, `row.preferredRemoteName ?? null`.

For every `SELECT ... FROM projection_projects` add:

```sql
custom_avatar_content_hash AS "customAvatarContentHash",
preferred_remote_name AS "preferredRemoteName",
```

For every `UPDATE projection_projects SET ...` make sure the two fields can be set when present (mirror the existing pattern for `customSystemPrompt`).

- [ ] **Step 2: Update the row schema (if one exists)**

Search for `ProjectionProjectDbRow`:

```bash
grep -nE "ProjectionProjectDbRow|projection_projects" apps/server/src/persistence -r
```

If a `Schema.Struct` row shape is defined, add:

```typescript
customAvatarContentHash: Schema.NullOr(Schema.String),
preferredRemoteName: Schema.NullOr(Schema.String),
```

- [ ] **Step 3: Build**

Run: `bun --filter @ryco/server build`
Expected: SUCCESS

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/persistence/Layers/ProjectionProjects.ts apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts
git commit -m "feat(server): persist project avatar hash and preferred remote name"
```

### Task 8: Surface the two new fields in projection snapshot mapping

**Files:**

- Modify: `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:214-230`

- [ ] **Step 1: Pass the new fields through `mapProjectShellRow`**

```typescript
function mapProjectShellRow(
  row: Schema.Schema.Type<typeof ProjectionProjectDbRowSchema>,
  repositoryIdentity: OrchestrationProject["repositoryIdentity"],
): OrchestrationProjectShell {
  return {
    id: row.projectId,
    title: row.title,
    workspaceRoot: row.workspaceRoot,
    projectMetadataDir: row.projectMetadataDir,
    repositoryIdentity,
    defaultModelSelection: row.defaultModelSelection,
    customSystemPrompt: row.customSystemPrompt ?? null,
    customAvatarContentHash: row.customAvatarContentHash ?? null,
    preferredRemoteName: row.preferredRemoteName ?? null,
    scripts: row.scripts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
```

If there are sibling mappers for the full-`OrchestrationProject` (not just the shell), apply the same fields. Grep for `customSystemPrompt: row.customSystemPrompt` to find every site.

- [ ] **Step 2: Build**

Run: `bun --filter @ryco/server build`
Expected: SUCCESS

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts
git commit -m "feat(server): surface customAvatarContentHash and preferredRemoteName in projection mapping"
```

### Task 9: Handle `preferredRemoteName` on `project.meta.update` in decider and projector

**Files:**

- Modify: `apps/server/src/orchestration/decider.ts:128-160`
- Modify: `apps/server/src/orchestration/projector.ts:233-260`

- [ ] **Step 1: Update the decider**

Add to the payload object inside the `project.meta.update` case:

```typescript
...(command.preferredRemoteName !== undefined
  ? { preferredRemoteName: command.preferredRemoteName }
  : {}),
```

- [ ] **Step 2: Update the projector**

Add to the project update spread inside the `project.meta-updated` case:

```typescript
...(payload.preferredRemoteName !== undefined
  ? { preferredRemoteName: payload.preferredRemoteName }
  : {}),
```

- [ ] **Step 3: Build**

Run: `bun --filter @ryco/server build`
Expected: SUCCESS

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/orchestration/decider.ts apps/server/src/orchestration/projector.ts
git commit -m "feat(server): apply preferredRemoteName on project.meta.update"
```

### Task 10: Implement `project.avatar.set` in decider and projector

**Files:**

- Modify: `apps/server/src/orchestration/decider.ts`
- Modify: `apps/server/src/orchestration/projector.ts`

- [ ] **Step 1: Add the decider case**

Add a new case immediately after the existing `project.meta.update` case (around line 160):

```typescript
case "project.avatar.set": {
  yield* requireProject({
    readModel,
    command,
    projectId: command.projectId,
  });
  const occurredAt = nowIso();
  return {
    ...withEventBase({
      aggregateKind: "project",
      aggregateId: command.projectId,
      occurredAt,
      commandId: command.commandId,
    }),
    type: "project.avatar-set",
    payload: {
      projectId: command.projectId,
      contentHash: command.contentHash,
      updatedAt: occurredAt,
    },
  };
}
```

- [ ] **Step 2: Add the projector case**

In `projector.ts`, after the `project.meta-updated` case (around line 260):

```typescript
case "project.avatar-set":
  return decodeForEvent(ProjectAvatarSetPayload, event.payload, event.type, "payload").pipe(
    Effect.map((payload) => ({
      ...nextBase,
      projects: nextBase.projects.map((project) =>
        project.id === payload.projectId
          ? {
              ...project,
              customAvatarContentHash: payload.contentHash,
              updatedAt: payload.updatedAt,
            }
          : project,
      ),
    })),
  );
```

Make sure `ProjectAvatarSetPayload` is imported at the top of the file (same place `ProjectMetaUpdatedPayload` is imported from `@ryco/contracts`).

- [ ] **Step 3: Build**

Run: `bun --filter @ryco/server build`
Expected: SUCCESS

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/orchestration/decider.ts apps/server/src/orchestration/projector.ts
git commit -m "feat(server): handle project.avatar.set command"
```

---

## Phase 3 — Server: avatar storage and HTTP routes

### Task 11: Create the `ProjectAvatarStore` service interface and implementation

**Files:**

- Create: `apps/server/src/project/Services/ProjectAvatarStore.ts`
- Create: `apps/server/src/project/Layers/ProjectAvatarStore.ts`
- Create: `apps/server/src/project/Layers/ProjectAvatarStore.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer } from "effect";

import { ProjectAvatarStore } from "../Services/ProjectAvatarStore.ts";
import { ProjectAvatarStoreLive } from "./ProjectAvatarStore.ts";

const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6300010000000500010d0a2db40000000049454e44ae426082",
  "hex",
);

it.layer(NodeServices.layer)("ProjectAvatarStoreLive", (it) => {
  it.effect("writes, reads, and deletes an avatar by projectId", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const dataDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ryco-project-avatars-test-",
      });

      const store = yield* ProjectAvatarStore;
      const written = yield* store.write({
        projectId: "proj_test" as unknown as never,
        bytes: PNG_1X1,
        contentType: "image/png",
      });
      expect(written.contentHash).toMatch(/^[0-9a-f]{64}$/);

      const read = yield* store.read("proj_test" as unknown as never);
      expect(read).not.toBeNull();
      expect(read?.contentHash).toBe(written.contentHash);

      yield* store.remove("proj_test" as unknown as never);
      const afterDelete = yield* store.read("proj_test" as unknown as never);
      expect(afterDelete).toBeNull();
    }).pipe(Effect.provide(Layer.merge(ProjectAvatarStoreLive({ dataDir: "<filled-by-test>" })))),
  );
});
```

(Note: the test passes `dataDir` via Layer config. Adjust if the live layer reads from a `Config` service — match the existing pattern in `apps/server/src/project/Layers/ProjectFaviconResolver.test.ts`.)

- [ ] **Step 2: Define the service interface**

```typescript
// apps/server/src/project/Services/ProjectAvatarStore.ts
import { Context } from "effect";
import type { Effect } from "effect";
import type { ProjectId } from "@ryco/contracts";

export interface ProjectAvatarStoreShape {
  readonly write: (input: {
    readonly projectId: ProjectId;
    readonly bytes: Buffer;
    readonly contentType: string;
  }) => Effect.Effect<{ readonly contentHash: string }, ProjectAvatarStoreError>;
  readonly read: (
    projectId: ProjectId,
  ) => Effect.Effect<{ readonly bytes: Buffer; readonly contentHash: string } | null, never>;
  readonly remove: (projectId: ProjectId) => Effect.Effect<void, never>;
}

export class ProjectAvatarStoreError extends Error {
  readonly _tag = "ProjectAvatarStoreError";
}

export const ProjectAvatarStore = Context.GenericTag<ProjectAvatarStoreShape>(
  "@ryco/server/ProjectAvatarStore",
);
```

- [ ] **Step 3: Implement the live layer**

```typescript
// apps/server/src/project/Layers/ProjectAvatarStore.ts
import { createHash } from "node:crypto";
import { Effect, FileSystem, Layer, Path } from "effect";
import sharp from "sharp";

import {
  ProjectAvatarStore,
  ProjectAvatarStoreError,
  type ProjectAvatarStoreShape,
} from "../Services/ProjectAvatarStore.ts";

const ALLOWED_INPUT_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_DIMENSION = 256;

export const makeProjectAvatarStore = (options: { readonly dataDir: string }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const avatarsDir = path.join(options.dataDir, "project-avatars");
    yield* fileSystem.makeDirectory(avatarsDir, { recursive: true });

    const filePath = (projectId: string) => path.join(avatarsDir, `${projectId}.png`);

    const write: ProjectAvatarStoreShape["write"] = (input) =>
      Effect.gen(function* () {
        if (!ALLOWED_INPUT_TYPES.has(input.contentType)) {
          return yield* Effect.fail(
            new ProjectAvatarStoreError(`unsupported content type ${input.contentType}`),
          );
        }
        const resized = yield* Effect.promise(() =>
          sharp(input.bytes)
            .rotate()
            .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: "inside", withoutEnlargement: true })
            .png({ quality: 90, compressionLevel: 9 })
            .toBuffer(),
        );
        const contentHash = createHash("sha256").update(resized).digest("hex");
        yield* fileSystem.writeFile(filePath(input.projectId as unknown as string), resized);
        return { contentHash };
      });

    const read: ProjectAvatarStoreShape["read"] = (projectId) =>
      Effect.gen(function* () {
        const target = filePath(projectId as unknown as string);
        const exists = yield* fileSystem.exists(target);
        if (!exists) return null;
        const bytes = yield* fileSystem.readFile(target);
        const buffer = Buffer.from(bytes);
        const contentHash = createHash("sha256").update(buffer).digest("hex");
        return { bytes: buffer, contentHash };
      }).pipe(Effect.orElse(() => Effect.succeed(null)));

    const remove: ProjectAvatarStoreShape["remove"] = (projectId) =>
      fileSystem
        .remove(filePath(projectId as unknown as string))
        .pipe(Effect.orElse(() => Effect.void));

    return { write, read, remove } satisfies ProjectAvatarStoreShape;
  });

export const ProjectAvatarStoreLive = (options: { readonly dataDir: string }) =>
  Layer.effect(ProjectAvatarStore, makeProjectAvatarStore(options));
```

If `sharp` is not yet a dependency, install it: `bun add -F @ryco/server sharp`.

- [ ] **Step 4: Run the test**

Run: `bun vitest run apps/server/src/project/Layers/ProjectAvatarStore.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/project/Services/ProjectAvatarStore.ts apps/server/src/project/Layers/ProjectAvatarStore.ts apps/server/src/project/Layers/ProjectAvatarStore.test.ts apps/server/package.json apps/server/../../bun.lock
git commit -m "feat(server): add ProjectAvatarStore service backed by sharp + disk"
```

### Task 12: Add HTTP routes for avatar upload and serving

**Files:**

- Modify: `apps/server/src/http.ts`

- [ ] **Step 1: Add the upload route**

After `projectFaviconRouteLayer` (around line 240 in `http.ts`):

```typescript
const PROJECT_AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const PROJECT_AVATAR_CACHE_CONTROL = "private, max-age=0, must-revalidate";

export const projectAvatarUploadRouteLayer = HttpRouter.add(
  "POST",
  "/api/project-avatar/upload",
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }
    const projectId = url.value.searchParams.get("projectId");
    if (!projectId) {
      return HttpServerResponse.text("Missing projectId", { status: 400 });
    }
    const contentLength = Number(request.headers["content-length"] ?? "0");
    if (contentLength > PROJECT_AVATAR_MAX_BYTES) {
      return HttpServerResponse.text("Payload too large", { status: 413 });
    }

    const form = yield* HttpServerRequest.schemaBodyForm(
      Schema.Struct({ avatar: Schema.instanceOf(globalThis.File) }),
    );
    const file = form.avatar;
    if (file.size > PROJECT_AVATAR_MAX_BYTES) {
      return HttpServerResponse.text("Payload too large", { status: 413 });
    }
    const bytes = Buffer.from(yield* Effect.promise(() => file.arrayBuffer()));

    const store = yield* ProjectAvatarStore;
    const result = yield* store.write({
      projectId: projectId as ProjectId,
      bytes,
      contentType: file.type,
    });
    return HttpServerResponse.json(result);
  }),
);

export const projectAvatarServeRouteLayer = HttpRouter.add(
  "GET",
  "/api/project-avatar",
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }
    const projectId = url.value.searchParams.get("projectId");
    if (!projectId) {
      return HttpServerResponse.text("Missing projectId", { status: 400 });
    }
    const store = yield* ProjectAvatarStore;
    const stored = yield* store.read(projectId as ProjectId);
    if (!stored) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    return HttpServerResponse.uint8Array(stored.bytes, {
      status: 200,
      contentType: "image/png",
      headers: {
        "Cache-Control": PROJECT_AVATAR_CACHE_CONTROL,
        ETag: `"${stored.contentHash}"`,
      },
    });
  }),
);
```

Add to the imports at the top of `http.ts`:

```typescript
import { ProjectAvatarStore } from "./project/Services/ProjectAvatarStore.ts";
import type { ProjectId } from "@ryco/contracts";
import * as Schema from "effect/Schema";
```

- [ ] **Step 2: Wire the new route layers into the router composition**

Search for where `projectFaviconRouteLayer` is included in the server bootstrap:

```bash
grep -nE "projectFaviconRouteLayer" apps/server/src
```

Add `projectAvatarUploadRouteLayer` and `projectAvatarServeRouteLayer` to the same `Layer.mergeAll(...)` call.

Also include `ProjectAvatarStoreLive({ dataDir: <server-data-dir> })` in the dependency layer composition (matching whatever pattern `ProjectFaviconResolver` uses).

- [ ] **Step 3: Build**

Run: `bun --filter @ryco/server build`
Expected: SUCCESS

- [ ] **Step 4: Smoke test with curl**

In one terminal:

```bash
bun --filter @ryco/server dev
```

In another, create a small test PNG (`/tmp/test.png`), then:

```bash
curl -X POST "http://127.0.0.1:<port>/api/project-avatar/upload?projectId=<id>" \
  -H "Authorization: Bearer <token>" \
  -F "avatar=@/tmp/test.png"
```

Expected: `{"contentHash":"<sha256>"}`

```bash
curl -OJ "http://127.0.0.1:<port>/api/project-avatar?projectId=<id>" \
  -H "Authorization: Bearer <token>"
```

Expected: a PNG file downloaded.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/http.ts apps/server/src/server.ts
git commit -m "feat(server): add HTTP routes for project avatar upload and serving"
```

(Adjust the staged server.ts path to whatever wires the router.)

---

## Phase 4 — Web: client model + favicon + remote resolution

### Task 13: Map new project fields in the web store

**Files:**

- Modify: `apps/web/src/types.ts:87-99`
- Modify: `apps/web/src/store.ts:223-244`

- [ ] **Step 1: Extend the `Project` interface**

```typescript
export interface Project {
  id: ProjectId;
  environmentId: EnvironmentId;
  name: string;
  cwd: string;
  projectMetadataDir?: string | undefined;
  repositoryIdentity?: RepositoryIdentity | null;
  defaultModelSelection: ModelSelection | null;
  customSystemPrompt?: string | null;
  customAvatarContentHash?: string | null;
  preferredRemoteName?: string | null;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
  scripts: ProjectScript[];
}
```

- [ ] **Step 2: Map them in `mapProject`**

```typescript
function mapProject(
  project:
    | OrchestrationReadModel["projects"][number]
    | OrchestrationShellSnapshot["projects"][number],
  environmentId: EnvironmentId,
): Project {
  return {
    id: project.id,
    environmentId,
    name: project.title,
    cwd: project.workspaceRoot,
    projectMetadataDir: project.projectMetadataDir,
    repositoryIdentity: project.repositoryIdentity ?? null,
    defaultModelSelection: project.defaultModelSelection
      ? normalizeModelSelection(project.defaultModelSelection)
      : null,
    customSystemPrompt: project.customSystemPrompt ?? null,
    customAvatarContentHash: project.customAvatarContentHash ?? null,
    preferredRemoteName: project.preferredRemoteName ?? null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    scripts: mapProjectScripts(project.scripts),
  };
}
```

- [ ] **Step 3: Build the web app**

Run: `bun --filter @ryco/web typecheck`
Expected: SUCCESS

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/types.ts apps/web/src/store.ts
git commit -m "feat(web): map customAvatarContentHash and preferredRemoteName on Project"
```

### Task 14: Render custom avatar in `ProjectFavicon` when set

**Files:**

- Modify: `apps/web/src/components/ProjectFavicon.tsx`

- [ ] **Step 1: Extend props and resolution chain**

```typescript
import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { FolderIcon } from "lucide-react";
import { useState } from "react";
import { resolveEnvironmentHttpUrl } from "../environments/runtime";

const loadedProjectFaviconSrcs = new Set<string>();

export function ProjectFavicon(input: {
  environmentId: EnvironmentId;
  cwd: string;
  projectId?: ProjectId;
  customAvatarContentHash?: string | null;
  className?: string;
}) {
  const src = (() => {
    try {
      if (input.customAvatarContentHash && input.projectId) {
        return resolveEnvironmentHttpUrl({
          environmentId: input.environmentId,
          pathname: "/api/project-avatar",
          searchParams: { projectId: input.projectId, v: input.customAvatarContentHash },
        });
      }
      return resolveEnvironmentHttpUrl({
        environmentId: input.environmentId,
        pathname: "/api/project-favicon",
        searchParams: { cwd: input.cwd },
      });
    } catch {
      return null;
    }
  })();
  const [status, setStatus] = useState<"loading" | "loaded" | "error">(() =>
    src && loadedProjectFaviconSrcs.has(src) ? "loaded" : "loading",
  );

  if (!src || status === "error") {
    return (
      <FolderIcon
        className={`size-3.5 shrink-0 text-muted-foreground/50 ${input.className ?? ""}`}
      />
    );
  }

  return (
    <>
      {status !== "loaded" ? (
        <FolderIcon
          className={`size-3.5 shrink-0 text-muted-foreground/50 ${input.className ?? ""}`}
        />
      ) : null}
      <img
        src={src}
        alt=""
        className={`size-3.5 shrink-0 rounded-sm object-contain ${status === "loaded" ? "" : "hidden"} ${input.className ?? ""}`}
        onLoad={() => {
          loadedProjectFaviconSrcs.add(src);
          setStatus("loaded");
        }}
        onError={() => setStatus("error")}
      />
    </>
  );
}
```

The component falls through to the `FolderIcon` on `status === "error"` so a 404 from the avatar route doesn't strand the user with a broken image. (Previously the error state simply hid the image; now it returns the fallback.)

- [ ] **Step 2: Update every call site to pass `projectId` and `customAvatarContentHash`**

Run:

```bash
grep -n "<ProjectFavicon" apps/web/src -r
```

For each call site that has access to the `Project` object, pass:

```tsx
<ProjectFavicon
  environmentId={project.environmentId}
  cwd={project.cwd}
  projectId={project.id}
  customAvatarContentHash={project.customAvatarContentHash ?? null}
/>
```

Call sites that only have a `cwd` (e.g., a draft project) can omit `projectId` and `customAvatarContentHash`; the resolution chain falls back to the auto-favicon.

- [ ] **Step 3: Build**

Run: `bun --filter @ryco/web typecheck`
Expected: SUCCESS

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/ProjectFavicon.tsx <other-affected-files>
git commit -m "feat(web): render custom project avatar when set"
```

### Task 15: Honor `preferredRemoteName` in `resolveProjectRemoteLink`

**Files:**

- Modify: `apps/web/src/components/Sidebar.tsx:1229-1246`

- [ ] **Step 1: Update the resolver**

```typescript
function resolveProjectRemoteLink(
  repositoryIdentity: RepositoryIdentity | null | undefined,
  preferredRemoteName: string | null | undefined,
): ProjectRemoteLink | null {
  if (!repositoryIdentity) return null;

  const candidate = (() => {
    if (preferredRemoteName) {
      const match = repositoryIdentity.remotes.find(
        (remote) => remote.name === preferredRemoteName,
      );
      if (match) {
        return { url: match.url, label: match.ownerRepo ?? match.url, provider: match.provider };
      }
    }
    const locatorUrl = repositoryIdentity.locator.remoteUrl;
    return {
      url: locatorUrl,
      label: repositoryIdentity.displayName ?? repositoryIdentity.canonicalKey,
      provider: repositoryIdentity.provider,
    };
  })();

  const url = resolveRemoteUrlToBrowserUrl(candidate.url);
  if (!url) return null;
  return {
    url,
    label: candidate.label,
    provider: candidate.provider ?? null,
    providerLabel: formatRepositoryProviderLabel(candidate.provider ?? null),
  };
}
```

- [ ] **Step 2: Pass `preferredRemoteName` from every call site**

Update every callsite by adding the second argument (search for `resolveProjectRemoteLink(` to find them — at minimum lines 1258, 1340, 2034, 2280, 2288 in `Sidebar.tsx`). Use `member.preferredRemoteName ?? null` (or the corresponding project's field) at each site.

- [ ] **Step 3: Build**

Run: `bun --filter @ryco/web typecheck`
Expected: SUCCESS

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/Sidebar.tsx
git commit -m "feat(web): honor preferredRemoteName in remote link resolution"
```

---

## Phase 5 — Web: new ProjectSettingsDialog

This is the largest UI task. We replace the existing `ProjectSettingsDialog` function in `apps/web/src/components/Sidebar.tsx:1317-1526` with a sidebar-nav layout and split the body into three sub-components for clarity (kept in the same file to match the current colocation pattern).

### Task 16: Build the new dialog shell

**Files:**

- Modify: `apps/web/src/components/Sidebar.tsx`

- [ ] **Step 1: Replace the `ProjectSettingsDialog` function**

Replace the entire function (lines 1317–1526) with:

```typescript
type ProjectSettingsSection = "general" | "location" | "ai";

interface ProjectSettingsDialogProps {
  open: boolean;
  saving: boolean;
  target: SidebarProjectGroupMember | null;
  // General section
  title: string;
  customAvatarContentHash: string | null;
  preferredRemoteName: string | null;
  // Location section
  workspaceRoot: string;
  projectMetadataDir: string;
  // AI section
  customSystemPrompt: string;
  // Handlers
  onClose: () => void;
  onSave: () => void;
  onTitleChange: (value: string) => void;
  onWorkspaceRootChange: (value: string) => void;
  onProjectMetadataDirChange: (value: string) => void;
  onCustomSystemPromptChange: (value: string) => void;
  onPreferredRemoteChange: (value: string | null) => void;
  onPickWorkspaceRoot: () => void;
  onOpenRemote: (member: SidebarProjectGroupMember, remoteName: string) => void;
  onUploadAvatar: (file: File) => Promise<void>;
  onRemoveAvatar: () => Promise<void>;
}

function ProjectSettingsDialog(props: ProjectSettingsDialogProps) {
  const [section, setSection] = useState<ProjectSettingsSection>("general");
  const target = props.target;
  if (!target) return null;

  const headerSubtitle = target.environmentLabel
    ? `${target.name} · ${target.environmentLabel}`
    : target.name;

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup
        className="h-[min(70vh,620px)] max-w-[760px] overflow-hidden p-0"
        bottomStickOnMobile={false}
        showCloseButton={true}
      >
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-5">
          <div className="min-w-0">
            <DialogTitle className="text-base font-semibold">Project settings</DialogTitle>
            <p className="truncate text-xs text-muted-foreground">{headerSubtitle}</p>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-row">
          <nav className="flex w-12 shrink-0 flex-col gap-1 border-r border-border p-2 sm:w-48">
            {(
              [
                { id: "general", label: "General", Icon: Settings2Icon },
                { id: "location", label: "Location", Icon: FolderOpenIcon },
                { id: "ai", label: "AI", Icon: SparklesIcon },
              ] as const
            ).map(({ id, label, Icon }) => {
              const isActive = section === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setSection(id)}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-2 py-2 text-left text-[13px] outline-hidden ring-ring transition-colors focus-visible:ring-2",
                    isActive
                      ? "bg-accent font-medium text-foreground"
                      : "text-muted-foreground/70 hover:text-foreground/80",
                  )}
                  aria-current={isActive ? "page" : undefined}
                >
                  <Icon className={cn("size-4 shrink-0", isActive ? "text-foreground" : "text-muted-foreground/60")} />
                  <span className="hidden truncate sm:inline">{label}</span>
                </button>
              );
            })}
          </nav>

          <ScrollArea className="min-h-0 flex-1 min-w-0">
            <div className="mx-auto max-w-[520px] px-6 py-6">
              {section === "general" ? (
                <ProjectSettingsGeneralSection
                  target={target}
                  title={props.title}
                  customAvatarContentHash={props.customAvatarContentHash}
                  preferredRemoteName={props.preferredRemoteName}
                  onTitleChange={props.onTitleChange}
                  onPreferredRemoteChange={props.onPreferredRemoteChange}
                  onUploadAvatar={props.onUploadAvatar}
                  onRemoveAvatar={props.onRemoveAvatar}
                  onOpenRemote={props.onOpenRemote}
                />
              ) : section === "location" ? (
                <ProjectSettingsLocationSection
                  workspaceRoot={props.workspaceRoot}
                  projectMetadataDir={props.projectMetadataDir}
                  onWorkspaceRootChange={props.onWorkspaceRootChange}
                  onProjectMetadataDirChange={props.onProjectMetadataDirChange}
                  onPickWorkspaceRoot={props.onPickWorkspaceRoot}
                  onSave={props.onSave}
                />
              ) : (
                <ProjectSettingsAiSection
                  customSystemPrompt={props.customSystemPrompt}
                  onCustomSystemPromptChange={props.onCustomSystemPromptChange}
                />
              )}
            </div>
          </ScrollArea>
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-3">
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button onClick={props.onSave} disabled={props.saving}>
            {props.saving ? "Saving…" : "Save changes"}
          </Button>
        </footer>
      </DialogPopup>
    </Dialog>
  );
}
```

Add the missing icon imports at the top of the file:

```typescript
import { FolderOpenIcon, Settings2Icon, SparklesIcon } from "lucide-react";
```

Drop now-unused imports if they were specific to the old dialog (`MapPinIcon`, `ImageIcon`, `ExternalLinkIcon`, `CopyIcon` if they aren't used elsewhere — leave them if they are).

- [ ] **Step 2: Add the three section components**

Place these immediately above the `ProjectSettingsDialog` function:

```typescript
function ProjectSettingsGeneralSection(props: {
  target: SidebarProjectGroupMember;
  title: string;
  customAvatarContentHash: string | null;
  preferredRemoteName: string | null;
  onTitleChange: (value: string) => void;
  onPreferredRemoteChange: (value: string | null) => void;
  onUploadAvatar: (file: File) => Promise<void>;
  onRemoveAvatar: () => Promise<void>;
  onOpenRemote: (member: SidebarProjectGroupMember, remoteName: string) => void;
}) {
  const remotes = props.target.repositoryIdentity?.remotes ?? [];
  const autoRemoteName = props.target.repositoryIdentity?.locator.remoteName ?? null;
  const selectedRemoteName =
    props.preferredRemoteName && remotes.some((r) => r.name === props.preferredRemoteName)
      ? props.preferredRemoteName
      : null; // null means auto
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const triggerUpload = () => fileInputRef.current?.click();
  const handleFile = async (file: File) => {
    setUploading(true);
    try {
      await props.onUploadAvatar(file);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="flex items-start gap-4">
        <div className="relative flex size-24 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border/70 bg-secondary text-muted-foreground shadow-xs">
          <ProjectFavicon
            environmentId={props.target.environmentId}
            cwd={props.target.cwd}
            projectId={props.target.id}
            customAvatarContentHash={props.customAvatarContentHash}
            className="size-12"
          />
          {uploading ? (
            <div className="absolute inset-0 grid place-items-center bg-background/60 text-xs">…</div>
          ) : null}
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="text-xs font-medium text-foreground">Project image</div>
          <p className="text-[11px] text-muted-foreground">
            {props.customAvatarContentHash
              ? "PNG, JPG, or WebP · up to 2 MB"
              : "Using auto-detected favicon · upload to override"}
          </p>
          <div className="flex gap-2 pt-1">
            <Button size="xs" variant="outline" onClick={triggerUpload} disabled={uploading}>
              Upload
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => void props.onRemoveAvatar()}
              disabled={!props.customAvatarContentHash || uploading}
            >
              Remove
            </Button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleFile(file);
              event.target.value = "";
            }}
          />
        </div>
      </section>

      <section className="space-y-1.5">
        <label htmlFor="project-display-name" className="text-xs font-medium text-foreground">
          Display name
        </label>
        <Input
          id="project-display-name"
          aria-label="Project display name"
          value={props.title}
          onChange={(event) => props.onTitleChange(event.target.value)}
        />
      </section>

      {remotes.length > 0 ? (
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium text-foreground">Linked repositories</div>
            {remotes.length > 1 ? (
              <span className="text-[11px] text-muted-foreground">{remotes.length} remotes</span>
            ) : null}
          </div>
          {remotes.length > 1 ? (
            <p className="text-[11px] text-muted-foreground">
              Pick which remote the sidebar "Open remote" uses.
            </p>
          ) : null}
          <div className="overflow-hidden rounded-lg border border-border/70">
            {remotes.length > 1 ? (
              <button
                type="button"
                onClick={() => props.onPreferredRemoteChange(null)}
                className={cn(
                  "flex w-full items-center gap-3 border-b border-border/70 px-3 py-2 text-left",
                  selectedRemoteName === null && "bg-accent/50",
                )}
              >
                <span
                  className={cn(
                    "grid size-4 shrink-0 place-items-center rounded-full border",
                    selectedRemoteName === null ? "border-foreground" : "border-muted-foreground/40",
                  )}
                  aria-hidden="true"
                >
                  {selectedRemoteName === null ? (
                    <span className="size-2 rounded-full bg-foreground" />
                  ) : null}
                </span>
                <span className="text-xs">
                  Auto-detect{autoRemoteName ? ` (currently: ${autoRemoteName})` : ""}
                </span>
              </button>
            ) : null}
            {remotes.map((remote, index) => {
              const isSelected =
                selectedRemoteName === remote.name ||
                (selectedRemoteName === null && remote.name === autoRemoteName && remotes.length === 1);
              const ProviderIcon = resolveRepositoryProviderIcon(remote.provider ?? null);
              return (
                <div
                  key={remote.name}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2",
                    index > 0 || remotes.length > 1 ? "border-t border-border/70" : "",
                    isSelected && "bg-accent/50",
                  )}
                >
                  {remotes.length > 1 ? (
                    <button
                      type="button"
                      onClick={() => props.onPreferredRemoteChange(remote.name)}
                      className="shrink-0"
                      aria-label={`Use ${remote.name} as primary`}
                    >
                      <span
                        className={cn(
                          "grid size-4 place-items-center rounded-full border",
                          isSelected ? "border-foreground" : "border-muted-foreground/40",
                        )}
                      >
                        {isSelected ? <span className="size-2 rounded-full bg-foreground" /> : null}
                      </span>
                    </button>
                  ) : null}
                  <ProviderIcon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium">{remote.name}</span>
                      {isSelected && remotes.length > 1 ? (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          primary
                        </span>
                      ) : null}
                    </div>
                    <div className="truncate font-mono text-[11px] text-muted-foreground">
                      {remote.ownerRepo ?? remote.url}
                    </div>
                  </div>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => props.onOpenRemote(props.target, remote.name)}
                  >
                    <ExternalLinkIcon className="size-3.5" />
                    Open
                  </Button>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function ProjectSettingsLocationSection(props: {
  workspaceRoot: string;
  projectMetadataDir: string;
  onWorkspaceRootChange: (value: string) => void;
  onProjectMetadataDirChange: (value: string) => void;
  onPickWorkspaceRoot: () => void;
  onSave: () => void;
}) {
  const preview = `${props.workspaceRoot || "<project-root>"}/${
    props.projectMetadataDir || ".ryco"
  }/worktrees`;
  return (
    <div className="space-y-6">
      <section className="space-y-1.5">
        <label htmlFor="project-root" className="text-xs font-medium text-foreground">
          Project root
        </label>
        <p className="text-[11px] text-muted-foreground">
          The absolute path the project is anchored to.
        </p>
        <div className="flex gap-2">
          <Input
            id="project-root"
            aria-label="Project root"
            value={props.workspaceRoot}
            onChange={(event) => props.onWorkspaceRootChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                props.onSave();
              }
            }}
          />
          <Button variant="outline" onClick={props.onPickWorkspaceRoot}>
            <FolderOpenIcon className="size-4" />
            Browse
          </Button>
        </div>
      </section>

      <section className="space-y-1.5">
        <label htmlFor="project-metadata-dir" className="text-xs font-medium text-foreground">
          Metadata folder
        </label>
        <p className="text-[11px] text-muted-foreground">
          Where worktrees and project data are stored.
        </p>
        <Input
          id="project-metadata-dir"
          aria-label="Metadata folder"
          value={props.projectMetadataDir}
          placeholder=".ryco"
          onChange={(event) => props.onProjectMetadataDirChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              props.onSave();
            }
          }}
        />
      </section>

      <div className="rounded-md border border-dashed border-border/70 bg-muted/20 px-3 py-2">
        <div className="text-[11px] text-muted-foreground">Worktrees will be created under</div>
        <div className="truncate font-mono text-xs">{preview}</div>
      </div>
    </div>
  );
}

function ProjectSettingsAiSection(props: {
  customSystemPrompt: string;
  onCustomSystemPromptChange: (value: string) => void;
}) {
  const length = props.customSystemPrompt.length;
  const limit = PROJECT_CUSTOM_SYSTEM_PROMPT_MAX_CHARS;
  const warnThreshold = Math.floor(limit * 0.9);
  const counterClass =
    length >= limit
      ? "text-destructive"
      : length >= warnThreshold
      ? "text-amber-600 dark:text-amber-400"
      : "text-muted-foreground";
  return (
    <div className="space-y-2">
      <label htmlFor="project-custom-system-prompt" className="text-xs font-medium text-foreground">
        Custom system prompt
      </label>
      <p className="text-[11px] text-muted-foreground">
        Appended to every assistant prompt for this project.
      </p>
      <div className="relative">
        <Textarea
          id="project-custom-system-prompt"
          aria-label="Custom system prompt"
          value={props.customSystemPrompt}
          maxLength={limit}
          placeholder="Always use TypeScript."
          className="min-h-32 resize-y pr-20"
          onChange={(event) => props.onCustomSystemPromptChange(event.target.value)}
        />
        <span className={cn("pointer-events-none absolute bottom-2 right-3 text-[11px]", counterClass)}>
          {length} / {limit}
        </span>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Remove the now-unused `ProjectPathRow` helper**

Delete `ProjectPathRow` (lines 1528–1552 of the original file) since the new design no longer shows worktree paths.

- [ ] **Step 4: Build the web app**

Run: `bun --filter @ryco/web typecheck`
Expected: SUCCESS (some downstream call-site errors are expected and addressed in Task 17)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/Sidebar.tsx
git commit -m "feat(web): redesign ProjectSettingsDialog with sidebar nav layout"
```

### Task 17: Wire the dialog's new props from the parent component state

**Files:**

- Modify: `apps/web/src/components/Sidebar.tsx`

The previous dialog had props for `worktrees`, `onCopyPath`, etc. The new dialog needs new handlers (`onUploadAvatar`, `onRemoveAvatar`, `onPreferredRemoteChange`) and drops several old ones.

- [ ] **Step 1: Drop the now-unused state**

Remove these `useState` calls and any references (search for each):

- `projectSettingsWorktrees` (memoized value at ~1932)
- Any state related to copy-path inside the dialog

Replace them with new state:

```typescript
const [projectSettingsCustomAvatarContentHash, setProjectSettingsCustomAvatarContentHash] =
  useState<string | null>(null);
const [projectSettingsPreferredRemoteName, setProjectSettingsPreferredRemoteName] = useState<
  string | null
>(null);
```

- [ ] **Step 2: Populate the new state when the dialog opens**

Find `openProjectSettingsDialog` (around line 2024) and `setProjectSettingsCustomSystemPrompt(member.customSystemPrompt ?? "")`. Add nearby:

```typescript
setProjectSettingsCustomAvatarContentHash(member.customAvatarContentHash ?? null);
setProjectSettingsPreferredRemoteName(member.preferredRemoteName ?? null);
```

Also reset both in `closeProjectSettingsDialog`:

```typescript
setProjectSettingsCustomAvatarContentHash(null);
setProjectSettingsPreferredRemoteName(null);
```

- [ ] **Step 3: Extend the dirty-check and the dispatched command**

In `submitProjectSettings` (around line 2979), after the existing `customSystemPromptChanged`:

```typescript
const preferredRemoteNameChanged =
  projectSettingsPreferredRemoteName !== (projectSettingsTarget.preferredRemoteName ?? null);
```

Add `preferredRemoteNameChanged` to the early-return guard. Add to the dispatched command body:

```typescript
...(preferredRemoteNameChanged
  ? { preferredRemoteName: projectSettingsPreferredRemoteName }
  : {}),
```

- [ ] **Step 4: Add avatar upload + remove handlers**

Above the JSX that renders `<ProjectSettingsDialog ... />` (around line 3483), add:

```typescript
const uploadProjectAvatar = useCallback(
  async (file: File) => {
    if (!projectSettingsTarget) return;
    const api = readEnvironmentApi(projectSettingsTarget.environmentId);
    if (!api) return;
    const httpUrl = resolveEnvironmentHttpUrl({
      environmentId: projectSettingsTarget.environmentId,
      pathname: "/api/project-avatar/upload",
      searchParams: { projectId: projectSettingsTarget.id },
    });
    const formData = new FormData();
    formData.append("avatar", file);
    try {
      const response = await fetch(httpUrl, {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(text || `Upload failed: ${response.status}`);
      }
      const { contentHash } = (await response.json()) as { contentHash: string };
      await api.orchestration.dispatchCommand({
        type: "project.avatar.set",
        commandId: newCommandId(),
        projectId: projectSettingsTarget.id,
        contentHash,
      });
      setProjectSettingsCustomAvatarContentHash(contentHash);
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to upload avatar",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  },
  [projectSettingsTarget],
);

const removeProjectAvatar = useCallback(async () => {
  if (!projectSettingsTarget) return;
  const api = readEnvironmentApi(projectSettingsTarget.environmentId);
  if (!api) return;
  try {
    await api.orchestration.dispatchCommand({
      type: "project.avatar.set",
      commandId: newCommandId(),
      projectId: projectSettingsTarget.id,
      contentHash: null,
    });
    setProjectSettingsCustomAvatarContentHash(null);
  } catch (error) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Failed to remove avatar",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }
}, [projectSettingsTarget]);
```

- [ ] **Step 5: Add a remote-opener that takes a specific remote name**

```typescript
const openProjectRemoteByName = useCallback(
  (member: SidebarProjectGroupMember, remoteName: string) => {
    const remote = member.repositoryIdentity?.remotes.find((r) => r.name === remoteName);
    if (!remote) return;
    const url = resolveRemoteUrlToBrowserUrl(remote.url);
    if (!url) return;
    const api = readLocalApi();
    if (!api) return;
    void api.shell.openExternal(url).catch((error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open remote repository",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    });
  },
  [],
);
```

- [ ] **Step 6: Replace the `<ProjectSettingsDialog ... />` props block**

```tsx
<ProjectSettingsDialog
  open={projectSettingsTarget !== null}
  target={projectSettingsTarget}
  title={projectSettingsTitle}
  customAvatarContentHash={projectSettingsCustomAvatarContentHash}
  preferredRemoteName={projectSettingsPreferredRemoteName}
  workspaceRoot={projectSettingsWorkspaceRoot}
  projectMetadataDir={projectSettingsProjectMetadataDir}
  customSystemPrompt={projectSettingsCustomSystemPrompt}
  saving={projectSettingsSaving}
  onClose={closeProjectSettingsDialog}
  onSave={() => void submitProjectSettings()}
  onTitleChange={setProjectSettingsTitle}
  onWorkspaceRootChange={setProjectSettingsWorkspaceRoot}
  onProjectMetadataDirChange={setProjectSettingsProjectMetadataDir}
  onCustomSystemPromptChange={setProjectSettingsCustomSystemPrompt}
  onPreferredRemoteChange={setProjectSettingsPreferredRemoteName}
  onPickWorkspaceRoot={() => void pickProjectSettingsWorkspaceRoot()}
  onOpenRemote={openProjectRemoteByName}
  onUploadAvatar={uploadProjectAvatar}
  onRemoveAvatar={removeProjectAvatar}
/>
```

- [ ] **Step 7: Drop obsolete state and props**

Search for and delete:

- `projectSettingsWorktrees` memo (it is no longer referenced)
- Any unused imports introduced for the old layout (e.g., `ImageIcon`, `MapPinIcon`, `CopyIcon` if not used elsewhere)

- [ ] **Step 8: Build**

Run: `bun --filter @ryco/web typecheck`
Expected: SUCCESS

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/Sidebar.tsx
git commit -m "feat(web): wire new ProjectSettingsDialog with avatar upload and preferred remote"
```

---

## Phase 6 — Verification

### Task 18: End-to-end smoke test

- [ ] **Step 1: Run the full type-check**

Run: `bun typecheck`
Expected: SUCCESS

- [ ] **Step 2: Run all unit tests**

Run: `bun test`
Expected: ALL PASS

- [ ] **Step 3: Boot the dev server and verify the dialog**

Run: `bun dev`

Open the app, right-click a project in the sidebar, choose "Project settings", and verify:

- Dialog opens at `max-w-[760px]` (narrower than before).
- Header subtitle shows display name and environment label (no cwd duplication).
- Left nav has General / Location / AI sections that switch the content panel.
- General → Project image: shows the auto-favicon when no custom is set; `Upload` opens the file picker; uploading a PNG updates the preview and persists across dialog reopens; `Remove` returns to the auto-favicon.
- General → Display name: editable; Save disabled when unchanged.
- General → Linked repositories (multi-remote project):
  - Auto-detect row shows `currently: <name>`.
  - Each remote has its own radio + Open button.
  - Selecting a remote and clicking Save persists; reopening the dialog shows the same selection.
  - Sidebar context-menu "Open remote" now uses the selected remote.
- Location → Project root / Metadata folder behave the same as before; the preview block updates live.
- AI → counter changes color near the limit.
- Worktree list is no longer visible inside the dialog.

- [ ] **Step 4: Verify the avatar fallback**

In a project with no custom avatar set, confirm `ProjectFavicon` everywhere (sidebar, chat header, command palette) still renders the auto-detected favicon.

- [ ] **Step 5: Commit any tidy-ups**

If the smoke test exposed minor regressions, fix them and commit individually before declaring done.

```bash
git status
```

Expected: clean working tree.

---

## Self-Review

(Run this after completing all tasks; do not commit anything for this section.)

**Spec coverage:**

- Sidebar-nav layout — Task 16
- Header subtitle (no cwd duplication) — Task 16
- Functional project image (upload + remove) — Tasks 4, 10, 11, 12, 14, 17
- Multi-remote display + preferred override — Tasks 1, 5, 15, 16, 17
- Worktree list removed — Task 16 (deletes `ProjectPathRow` and skips worktree props)
- Contract additions (`customAvatarContentHash`, `preferredRemoteName`, `remotes`, new command) — Tasks 1–4
- Server endpoints (`/api/project-avatar/upload`, `/api/project-avatar`) — Task 12
- `resolveProjectRemoteLink` respects `preferredRemoteName` — Task 15
- `ProjectFavicon` chain renders custom > favicon > folder — Task 14

**Placeholder scan:**

- No `TBD`, `TODO`, or "implement later" tokens.
- "Add appropriate error handling" — not used; specific error paths are described per-task.
- "Similar to Task N" — not used.

**Type consistency:**

- `customAvatarContentHash`, `preferredRemoteName` — same spelling everywhere (contracts, store, dialog props, projector).
- `RepositoryRemote` (in contracts) is consumed in `RepositoryIdentityResolver`, `resolveProjectRemoteLink`, and the General section as `repositoryIdentity.remotes[]`.
- `project.avatar.set` command and `project.avatar-set` event — verified in tasks 4 and 10.
