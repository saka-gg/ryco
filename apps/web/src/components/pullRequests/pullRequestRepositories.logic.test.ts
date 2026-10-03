import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { describe, expect, it } from "vitest";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import {
  buildPullRequestRepositoryOptions,
  pullRequestRepositoryKey,
  classifyPullRequestEnvironmentSync,
  pullRequestRepositoryQualifier,
  rankRepositoryKeysByThreadActivity,
  resolvedPullRequestRepository,
  resolvePullRequestRepository,
} from "./pullRequestRepositories.logic";

function member(environmentId: string, id: string, label: string | null) {
  return {
    id: id as ProjectId,
    environmentId: environmentId as EnvironmentId,
    name: "ryco",
    cwd: `/${environmentId}/${id}`,
    defaultModelSelection: null,
    scripts: [],
    physicalProjectKey: `${environmentId}:${id}`,
    environmentLabel: label,
  };
}

const remote = member("env-remote", "p-remote", "Build box");
const local = member("env-local", "p-local", null);
const other = member("env-local", "p-other", null);

const snapshots = [
  {
    ...local,
    projectKey: "repo:ryco",
    displayName: "ryco",
    groupedProjectCount: 2,
    environmentPresence: "mixed",
    memberProjects: [remote, local],
    memberProjectRefs: [],
    remoteEnvironmentLabels: ["Build box"],
  },
  {
    ...other,
    projectKey: "repo:other",
    displayName: "other",
    groupedProjectCount: 1,
    environmentPresence: "local-only",
    memberProjects: [other],
    memberProjectRefs: [],
    remoteEnvironmentLabels: [],
  },
] as unknown as SidebarProjectSnapshot[];

describe("buildPullRequestRepositoryOptions", () => {
  it("leads each repository with its representative checkout", () => {
    const options = buildPullRequestRepositoryOptions(snapshots);
    expect(options.map((option) => [option.projectId, option.isRepresentative])).toEqual([
      ["p-local", true],
      ["p-remote", false],
      ["p-other", true],
    ]);
    expect(options[1]?.name).toBe("ryco");
    expect(options[1]?.environmentLabel).toBe("Build box");
  });
});

describe("pullRequestRepositoryQualifier", () => {
  it("names the environment only when checkouts of one repository compete", () => {
    const options = buildPullRequestRepositoryOptions(snapshots);
    expect(options.map((option) => pullRequestRepositoryQualifier(option, options))).toEqual([
      null, // the local checkout has no environment label
      "Build box",
      null, // the only checkout of "other"
    ]);
  });
});

describe("resolvePullRequestRepository", () => {
  const options = buildPullRequestRepositoryOptions(snapshots);
  const projectOf = (resolution: ReturnType<typeof resolvePullRequestRepository>) =>
    resolvedPullRequestRepository(resolution)?.projectId ?? null;

  it("prefers the URL, then the last choice, then recent activity, then the first representative", () => {
    expect(
      resolvePullRequestRepository({
        options,
        requested: { env: "env-remote", project: "p-remote" },
        lastKey: pullRequestRepositoryKey("env-local", "p-other"),
      }),
    ).toMatchObject({ kind: "resolved", source: "url", option: { projectId: "p-remote" } });
    expect(
      resolvePullRequestRepository({
        options,
        lastKey: pullRequestRepositoryKey("env-local", "p-other"),
      }),
    ).toMatchObject({ kind: "resolved", source: "last", option: { projectId: "p-other" } });
    expect(resolvePullRequestRepository({ options })).toMatchObject({
      kind: "resolved",
      source: "first",
      option: { projectId: "p-local" },
    });
    expect(
      projectOf(
        resolvePullRequestRepository({
          options,
          recentKeys: rankRepositoryKeysByThreadActivity([
            { environmentId: "env-local", projectId: "p-local", updatedAt: "2026-01-01T00:00:00Z" },
            {
              environmentId: "env-remote",
              projectId: "p-remote",
              updatedAt: "2026-02-01T00:00:00Z",
            },
          ]),
        }),
      ),
    ).toBe("p-remote");
    expect(resolvePullRequestRepository({ options: [] })).toEqual({ kind: "empty" });
  });

  it("never substitutes another repository for one the URL names", () => {
    const lastKey = pullRequestRepositoryKey("env-local", "p-other");
    // The environment is still connecting: wait for its projects.
    expect(
      resolvePullRequestRepository({
        options,
        requested: { env: "env-late", project: "p-late" },
        requestedEnvironmentSync: "syncing",
        lastKey,
      }),
    ).toEqual({ kind: "waiting", requested: { env: "env-late", project: "p-late" } });
    // Offline, synced without it, or an environment this device does not know.
    expect(
      resolvePullRequestRepository({
        options,
        requested: { env: "env-remote", project: "p-gone" },
        requestedEnvironmentSync: "offline",
        lastKey,
      }),
    ).toMatchObject({ kind: "unavailable", reason: "offline" });
    for (const sync of ["synced", "unknown"] as const) {
      expect(
        resolvePullRequestRepository({
          options,
          requested: { project: "missing" },
          requestedEnvironmentSync: sync,
          lastKey,
        }),
      ).toMatchObject({ kind: "unavailable", reason: "missing" });
    }
    // The checkout arrives: the exact match wins.
    expect(
      projectOf(
        resolvePullRequestRepository({
          options,
          requested: { env: "env-remote", project: "p-remote" },
          requestedEnvironmentSync: "syncing",
          lastKey,
        }),
      ),
    ).toBe("p-remote");
    // A project id in another environment is not the requested checkout.
    expect(
      resolvePullRequestRepository({
        options,
        requested: { env: "env-remote", project: "p-local" },
        requestedEnvironmentSync: "synced",
      }).kind,
    ).toBe("unavailable");
  });
});

describe("classifyPullRequestEnvironmentSync", () => {
  const base = {
    bootstrapComplete: false,
    isPrimary: false,
    saved: null,
    savedKnown: false,
    registryHydrated: true,
  } as const;

  it("is synced once the live snapshot arrives, and syncing for the primary before that", () => {
    expect(classifyPullRequestEnvironmentSync({ ...base, bootstrapComplete: true })).toBe("synced");
    expect(classifyPullRequestEnvironmentSync({ ...base, isPrimary: true })).toBe("syncing");
  });

  it("tells a saved environment still connecting from one that went offline", () => {
    const saved = (connectionState: "connecting" | "connected" | "disconnected" | "error") => ({
      connectionState,
      disconnectedAt: null,
    });
    expect(classifyPullRequestEnvironmentSync({ ...base, saved: saved("connecting") })).toBe(
      "syncing",
    );
    expect(classifyPullRequestEnvironmentSync({ ...base, saved: saved("connected") })).toBe(
      "syncing",
    );
    // Never attempted yet (the runtime starts out "disconnected").
    expect(classifyPullRequestEnvironmentSync({ ...base, saved: saved("disconnected") })).toBe(
      "syncing",
    );
    expect(
      classifyPullRequestEnvironmentSync({
        ...base,
        saved: { connectionState: "disconnected", disconnectedAt: "2026-10-03T00:00:00Z" },
      }),
    ).toBe("offline");
    expect(classifyPullRequestEnvironmentSync({ ...base, saved: saved("error") })).toBe("offline");
  });

  it("waits for the saved-environment registry before calling an id unknown", () => {
    expect(classifyPullRequestEnvironmentSync({ ...base, savedKnown: true })).toBe("syncing");
    expect(classifyPullRequestEnvironmentSync({ ...base, registryHydrated: false })).toBe(
      "syncing",
    );
    expect(classifyPullRequestEnvironmentSync(base)).toBe("unknown");
  });
});
