import type {
  ChangeRequest,
  ChangeRequestInvolvement,
  EnvironmentId,
  SourceControlInvolvedChangeRequestsResult,
  SourceControlInvolvedChangeRequestsSource,
} from "@ryco/contracts";
import { DateTime, Option } from "effect";
import { describe, expect, it } from "vitest";

import {
  crossRepositoryHostAliases,
  crossRepositoryKeyHost,
  keepCrossRepositoryRowsWhileLoading,
  mergeCrossRepositoryChangeRequests,
  planCrossRepositoryReads,
  resolveCrossRepositoryCheckoutKey,
  type CrossRepositoryCheckout,
} from "./crossRepository.ts";

const LOCAL = "env-local" as EnvironmentId;
const REMOTE = "env-remote" as EnvironmentId;
const OLD = "env-old" as EnvironmentId;

function checkout(
  environmentId: EnvironmentId,
  cwd: string,
  repositoryKey: string | null,
  provider: string | null,
  representative = false,
): CrossRepositoryCheckout {
  return { environmentId, cwd, repositoryKey, provider, representative };
}

function changeRequest(
  url: string,
  number: number,
  overrides: Partial<ChangeRequest> = {},
): ChangeRequest {
  return {
    provider: "github",
    number,
    title: `Change ${number}`,
    url,
    baseRefName: "main",
    headRefName: `feature/${number}`,
    state: "open",
    updatedAt: Option.some(DateTime.makeUnsafe("2026-10-01T10:00:00Z")),
    author: "octocat",
    ...overrides,
  };
}

function entry(
  repositoryKey: string,
  number: number,
  involvements: ReadonlyArray<ChangeRequestInvolvement>,
  overrides: Partial<ChangeRequest> = {},
) {
  return {
    changeRequest: changeRequest(`https://${repositoryKey}/pull/${number}`, number, overrides),
    repositoryKey,
    repositoryLabel: repositoryKey.slice(repositoryKey.indexOf("/") + 1),
    involvements,
  };
}

function result(
  entries: SourceControlInvolvedChangeRequestsResult["entries"],
  sources: ReadonlyArray<SourceControlInvolvedChangeRequestsSource> = [],
): SourceControlInvolvedChangeRequestsResult {
  return { entries, sources, skippedCwds: [], truncated: false };
}

function hostSource(
  name: string,
  overrides: Partial<SourceControlInvolvedChangeRequestsSource> = {},
): SourceControlInvolvedChangeRequestsSource {
  return { scope: "host", provider: "github", name, status: "ok", truncated: false, ...overrides };
}

describe("planCrossRepositoryReads", () => {
  it("searches each GitHub host once per capable node, through a few of its checkouts", () => {
    const targets = planCrossRepositoryReads({
      checkouts: [
        checkout(LOCAL, "/l/web", "github.com/acme/web", "github"),
        checkout(LOCAL, "/l/api", "github.com/acme/api", "github"),
        checkout(LOCAL, "/l/ghe", "ghe.example.com:8443/acme/core", "github"),
        checkout(REMOTE, "/r/web", "github.com/acme/web", "github"),
      ],
      capableEnvironments: new Set([LOCAL, REMOTE]),
      preferredEnvironmentId: LOCAL,
    });
    expect(targets).toEqual([
      {
        environmentId: LOCAL,
        sources: "hosts",
        cwds: ["/l/api", "/l/ghe", "/l/web"],
        omittedCwds: 0,
        groups: [
          { name: "github.com", cwds: ["/l/api", "/l/web"] },
          { name: "ghe.example.com", cwds: ["/l/ghe"] },
        ],
      },
      {
        environmentId: REMOTE,
        sources: "hosts",
        cwds: ["/r/web"],
        omittedCwds: 0,
        groups: [{ name: "github.com", cwds: ["/r/web"] }],
      },
    ]);
  });

  it("sends at most four checkouts per host, so one whose folder is gone does not lose the host", () => {
    const [target] = planCrossRepositoryReads({
      checkouts: ["f", "e", "d", "c", "b", "a"].map((name) =>
        checkout(LOCAL, `/l/${name}`, `github.com/acme/${name}`, "github"),
      ),
      capableEnvironments: new Set([LOCAL]),
      preferredEnvironmentId: LOCAL,
    });
    expect(target).toEqual({
      environmentId: LOCAL,
      sources: "hosts",
      cwds: ["/l/a", "/l/b", "/l/c", "/l/d"],
      omittedCwds: 0,
      groups: [{ name: "github.com", cwds: ["/l/a", "/l/b", "/l/c", "/l/d"] }],
    });
  });

  it("reads another host's repository once, through its representative's node", () => {
    const targets = planCrossRepositoryReads({
      checkouts: [
        checkout(LOCAL, "/l/tools", "gitlab.com/acme/tools", "gitlab"),
        checkout(REMOTE, "/r/tools", "gitlab.com/acme/tools", "gitlab", true),
      ],
      capableEnvironments: new Set([LOCAL, REMOTE]),
      preferredEnvironmentId: LOCAL,
    });
    expect(targets).toEqual([
      {
        environmentId: REMOTE,
        sources: "all",
        cwds: ["/r/tools"],
        omittedCwds: 0,
        groups: [{ name: "tools", cwds: ["/r/tools"] }],
      },
    ]);
  });

  it("reads keys that differ only in case or an SSH port as one repository", () => {
    const targets = planCrossRepositoryReads({
      checkouts: [
        checkout(LOCAL, "/l/tools", "gitlab.com:22/Acme/Tools", "gitlab"),
        checkout(REMOTE, "/r/tools", "gitlab.com/acme/tools", "gitlab", true),
      ],
      capableEnvironments: new Set([LOCAL, REMOTE]),
      preferredEnvironmentId: LOCAL,
    });
    expect(targets.map((target) => [target.environmentId, target.cwds])).toEqual([
      [REMOTE, ["/r/tools"]],
    ]);
  });

  it("falls back to the preferred node when the representative's node cannot read", () => {
    const targets = planCrossRepositoryReads({
      checkouts: [
        checkout(OLD, "/o/tools", "gitlab.com/acme/tools", "gitlab", true),
        checkout(REMOTE, "/r/tools", "gitlab.com/acme/tools", "gitlab"),
        checkout(LOCAL, "/l/tools", "gitlab.com/acme/tools", "gitlab"),
      ],
      capableEnvironments: new Set([LOCAL, REMOTE]),
      preferredEnvironmentId: LOCAL,
    });
    expect(targets.map((target) => [target.environmentId, target.cwds])).toEqual([
      [LOCAL, ["/l/tools"]],
    ]);
  });

  it("caps one read at the checkout limit and counts the rest", () => {
    const checkouts = Array.from({ length: 70 }, (_, index) =>
      checkout(
        LOCAL,
        `/l/repo-${String(index).padStart(2, "0")}`,
        `gitlab.com/acme/repo-${index}`,
        "gitlab",
      ),
    ).toReversed();
    const [target] = planCrossRepositoryReads({
      checkouts,
      capableEnvironments: new Set([LOCAL]),
      preferredEnvironmentId: LOCAL,
    });
    expect(target?.cwds).toHaveLength(64);
    expect(target?.omittedCwds).toBe(6);
    expect(target?.groups.flatMap((group) => group.cwds).toSorted()).toEqual(target?.cwds);
    expect(target?.cwds).toEqual(target?.cwds.toSorted());
    expect(target?.cwds[0]).toBe("/l/repo-00");
  });

  it("asks nothing of nodes that cannot answer, and skips checkouts without a remote", () => {
    const targets = planCrossRepositoryReads({
      checkouts: [
        checkout(OLD, "/o/web", "github.com/acme/web", "github"),
        checkout(OLD, "/o/tools", "gitlab.com/acme/tools", "gitlab"),
        checkout(LOCAL, "/l/scratch", null, null),
      ],
      capableEnvironments: new Set([LOCAL]),
      preferredEnvironmentId: LOCAL,
    });
    expect(targets).toEqual([]);
  });

  it("reads a checkout of an unknown host kind with the other repositories", () => {
    const targets = planCrossRepositoryReads({
      checkouts: [checkout(LOCAL, "/l/core", "git.corp.example/acme/core", null)],
      capableEnvironments: new Set([LOCAL]),
      preferredEnvironmentId: LOCAL,
    });
    // No group: the node skipping a checkout of a host it may not know is no news.
    expect(targets).toEqual([
      { environmentId: LOCAL, sources: "all", cwds: ["/l/core"], omittedCwds: 0, groups: [] },
    ]);
  });
});

describe("crossRepositoryKeyHost", () => {
  it("reads the host without a port, and none for Azure DevOps keys", () => {
    expect(crossRepositoryKeyHost("GitHub.com/acme/app")).toBe("github.com");
    expect(crossRepositoryKeyHost("ghe.example.com:8443/acme/app")).toBe("ghe.example.com");
    expect(crossRepositoryKeyHost("azure:org/project/repo")).toBeNull();
  });
});

describe("SSH host aliases", () => {
  it("resolves a checkout's alias host with its own node's answers only", () => {
    const aliases = crossRepositoryHostAliases([
      {
        environmentId: LOCAL,
        result: result(
          [],
          [hostSource("github.com", { checkoutHost: "GitHub.com-Work" }), hostSource("github.com")],
        ),
      },
    ]);
    expect(resolveCrossRepositoryCheckoutKey("github.com-work/Acme/App", aliases.get(LOCAL))).toBe(
      "github.com/acme/app",
    );
    expect(resolveCrossRepositoryCheckoutKey("github.com-work/acme/app", aliases.get(REMOTE))).toBe(
      "github.com-work/acme/app",
    );
    expect(resolveCrossRepositoryCheckoutKey("gitlab.com:22/acme/tools", aliases.get(LOCAL))).toBe(
      "gitlab.com/acme/tools",
    );
  });
});

describe("mergeCrossRepositoryChangeRequests", () => {
  it("keeps one row per repository and number across nodes, the newer fields winning", () => {
    const rows = mergeCrossRepositoryChangeRequests([
      {
        environmentId: LOCAL,
        result: result(
          [entry("github.com/acme/app", 12, ["review-requested"], { title: "Old title" })],
          [hostSource("github.com", { viewerLogin: "octocat" })],
        ),
      },
      {
        environmentId: REMOTE,
        result: result(
          [
            entry("github.com/acme/app", 12, ["authored"], {
              title: "New title",
              updatedAt: Option.some(DateTime.makeUnsafe("2026-10-02T10:00:00Z")),
            }),
            entry("github.com/acme/api", 12, ["authored"]),
          ],
          [hostSource("github.com", { viewerLogin: "bot-x" })],
        ),
      },
    ]);
    expect([...rows.keys()]).toEqual(["github.com/acme/app#12", "github.com/acme/api#12"]);
    const row = rows.get("github.com/acme/app#12");
    expect(row?.title).toBe("New title");
    expect([...(row?.involvements ?? [])].toSorted()).toEqual(["authored", "review-requested"]);
    expect(row?.reportedBy).toEqual([LOCAL, REMOTE]);
    expect(row?.viewerLogin).toBe("octocat");
    expect(rows.get("github.com/acme/api#12")?.viewerLogin).toBe("bot-x");
  });

  it("keeps a row's object when a later answer changes nothing", () => {
    const answers = () => [
      {
        environmentId: LOCAL,
        result: result([
          entry("github.com/acme/app", 1, ["authored"]),
          entry("github.com/acme/app", 2, ["authored"]),
        ]),
      },
    ];
    const first = mergeCrossRepositoryChangeRequests(answers());
    const second = mergeCrossRepositoryChangeRequests(answers(), first);
    expect(second.get("github.com/acme/app#1")).toBe(first.get("github.com/acme/app#1"));
    const changed = mergeCrossRepositoryChangeRequests(
      [
        {
          environmentId: LOCAL,
          result: result([
            entry("github.com/acme/app", 1, ["authored"], { title: "Renamed" }),
            entry("github.com/acme/app", 2, ["authored"]),
          ]),
        },
      ],
      second,
    );
    expect(changed.get("github.com/acme/app#1")).not.toBe(second.get("github.com/acme/app#1"));
    expect(changed.get("github.com/acme/app#2")).toBe(first.get("github.com/acme/app#2"));
  });
});

describe("keepCrossRepositoryRowsWhileLoading", () => {
  it("keeps a still-loading source's previous rows and drops the rest", () => {
    const previous = result([
      entry("gitlab.com/acme/tools", 3, ["authored"], { provider: "gitlab" }),
      entry("github.com/acme/app", 4, ["authored"]),
      // Same label on another host: its own source answered, so it goes.
      entry("github.com/acme/tools", 5, ["authored"]),
    ]);
    const next = result(
      [],
      [
        {
          scope: "repository",
          provider: "gitlab",
          name: "acme/tools",
          status: "loading",
          truncated: false,
        },
        hostSource("github.com"),
      ],
    );
    const kept = keepCrossRepositoryRowsWhileLoading(previous, next);
    expect(
      kept.entries.map((item) => `${item.repositoryKey}#${item.changeRequest.number}`),
    ).toEqual(["gitlab.com/acme/tools#3"]);
    expect(keepCrossRepositoryRowsWhileLoading(previous, result([]))).toEqual(result([]));
  });

  it("keeps an aliased host's rows while it loads under the alias", () => {
    const previous = result(
      [entry("github.com/acme/app", 12, ["authored"])],
      [hostSource("github.com", { checkoutHost: "github.com-work" })],
    );
    const kept = keepCrossRepositoryRowsWhileLoading(
      previous,
      result([], [hostSource("github.com-work", { status: "loading" })]),
    );
    expect(
      kept.entries.map((item) => `${item.repositoryKey}#${item.changeRequest.number}`),
    ).toEqual(["github.com/acme/app#12"]);
    // The checkouts keep their alias until the read lands.
    expect(kept.sources).toEqual([
      hostSource("github.com", { status: "loading", checkoutHost: "github.com-work" }),
    ]);
  });
});
