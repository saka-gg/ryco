import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { describe, expect, it } from "vitest";

import type { SidebarProjectSnapshot } from "./sidebarProjectGrouping";
import {
  buildProjectCheckoutOptions,
  projectCheckoutKey,
  classifyCheckoutEnvironmentSync,
  projectCheckoutQualifier,
  rankCheckoutKeysByThreadActivity,
  resolvedProjectCheckout,
  resolveProjectCheckout,
} from "./projectCheckouts.logic";

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

describe("buildProjectCheckoutOptions", () => {
  it("leads each repository with its representative checkout", () => {
    const options = buildProjectCheckoutOptions(snapshots);
    expect(options.map((option) => [option.projectId, option.isRepresentative])).toEqual([
      ["p-local", true],
      ["p-remote", false],
      ["p-other", true],
    ]);
    expect(options[1]?.name).toBe("ryco");
    expect(options[1]?.environmentLabel).toBe("Build box");
  });
});

describe("projectCheckoutQualifier", () => {
  it("names the environment only when checkouts of one repository compete", () => {
    const options = buildProjectCheckoutOptions(snapshots);
    expect(options.map((option) => projectCheckoutQualifier(option, options))).toEqual([
      null, // the local checkout has no environment label
      "Build box",
      null, // the only checkout of "other"
    ]);
  });
});

describe("resolveProjectCheckout", () => {
  const options = buildProjectCheckoutOptions(snapshots);
  const projectOf = (resolution: ReturnType<typeof resolveProjectCheckout>) =>
    resolvedProjectCheckout(resolution)?.projectId ?? null;

  it("prefers the URL, then the last choice, then recent activity, then the first representative", () => {
    expect(
      resolveProjectCheckout({
        options,
        requested: { env: "env-remote", project: "p-remote" },
        lastKey: projectCheckoutKey("env-local", "p-other"),
      }),
    ).toMatchObject({ kind: "resolved", source: "url", option: { projectId: "p-remote" } });
    expect(
      resolveProjectCheckout({
        options,
        lastKey: projectCheckoutKey("env-local", "p-other"),
      }),
    ).toMatchObject({ kind: "resolved", source: "last", option: { projectId: "p-other" } });
    expect(resolveProjectCheckout({ options })).toMatchObject({
      kind: "resolved",
      source: "first",
      option: { projectId: "p-local" },
    });
    expect(
      projectOf(
        resolveProjectCheckout({
          options,
          recentKeys: rankCheckoutKeysByThreadActivity([
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
    expect(resolveProjectCheckout({ options: [] })).toEqual({ kind: "empty" });
  });

  it("never substitutes another repository for one the URL names", () => {
    const lastKey = projectCheckoutKey("env-local", "p-other");
    // The environment is still connecting: wait for its projects.
    expect(
      resolveProjectCheckout({
        options,
        requested: { env: "env-late", project: "p-late" },
        requestedEnvironmentSync: "syncing",
        lastKey,
      }),
    ).toEqual({ kind: "waiting", requested: { env: "env-late", project: "p-late" } });
    // Offline, synced without it, or an environment this device does not know.
    expect(
      resolveProjectCheckout({
        options,
        requested: { env: "env-remote", project: "p-gone" },
        requestedEnvironmentSync: "offline",
        lastKey,
      }),
    ).toMatchObject({ kind: "unavailable", reason: "offline" });
    for (const sync of ["synced", "unknown"] as const) {
      expect(
        resolveProjectCheckout({
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
        resolveProjectCheckout({
          options,
          requested: { env: "env-remote", project: "p-remote" },
          requestedEnvironmentSync: "syncing",
          lastKey,
        }),
      ),
    ).toBe("p-remote");
    // A project id in another environment is not the requested checkout.
    expect(
      resolveProjectCheckout({
        options,
        requested: { env: "env-remote", project: "p-local" },
        requestedEnvironmentSync: "synced",
      }).kind,
    ).toBe("unavailable");
  });
});

describe("classifyCheckoutEnvironmentSync", () => {
  const base = {
    bootstrapComplete: false,
    isPrimary: false,
    saved: null,
    savedKnown: false,
    registryHydrated: true,
  } as const;

  it("is synced once the live snapshot arrives, and syncing for the primary before that", () => {
    expect(classifyCheckoutEnvironmentSync({ ...base, bootstrapComplete: true })).toBe("synced");
    expect(classifyCheckoutEnvironmentSync({ ...base, isPrimary: true })).toBe("syncing");
  });

  it("tells a saved environment still connecting from one that went offline", () => {
    const saved = (connectionState: "connecting" | "connected" | "disconnected" | "error") => ({
      connectionState,
      disconnectedAt: null,
    });
    expect(classifyCheckoutEnvironmentSync({ ...base, saved: saved("connecting") })).toBe(
      "syncing",
    );
    expect(classifyCheckoutEnvironmentSync({ ...base, saved: saved("connected") })).toBe("syncing");
    // Never attempted yet (the runtime starts out "disconnected").
    expect(classifyCheckoutEnvironmentSync({ ...base, saved: saved("disconnected") })).toBe(
      "syncing",
    );
    expect(
      classifyCheckoutEnvironmentSync({
        ...base,
        saved: { connectionState: "disconnected", disconnectedAt: "2026-10-03T00:00:00Z" },
      }),
    ).toBe("offline");
    expect(classifyCheckoutEnvironmentSync({ ...base, saved: saved("error") })).toBe("offline");
  });

  it("waits for the saved-environment registry before calling an id unknown", () => {
    expect(classifyCheckoutEnvironmentSync({ ...base, savedKnown: true })).toBe("syncing");
    expect(classifyCheckoutEnvironmentSync({ ...base, registryHydrated: false })).toBe("syncing");
    expect(classifyCheckoutEnvironmentSync(base)).toBe("unknown");
  });
});
