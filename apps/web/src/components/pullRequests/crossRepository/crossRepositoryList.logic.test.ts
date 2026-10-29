import type {
  ChangeRequest,
  ChangeRequestInvolvement,
  EnvironmentId,
  ProjectId,
  SourceControlChangeRequestDetail,
  SourceControlCheckRollupItem,
  SourceControlInvolvedChangeRequestsResult,
  SourceControlInvolvedChangeRequestsSource,
} from "@ryco/contracts";
import {
  crossRepositoryHostAliases,
  mergeCrossRepositoryChangeRequests,
  type CrossRepositoryReadTarget,
} from "@ryco/client-runtime/state/pull-request-review";
import { DateTime, Option } from "effect";
import { describe, expect, it } from "vitest";

import type { ProjectCheckoutOption } from "../../../projectCheckouts.logic";
import {
  applyCrossRepositoryOverlays,
  attachCrossRepositoryCheckouts,
  crossRepositoryNotesMissRepositories,
  crossRepositoryOverlayFromDetail,
  deriveCrossRepositoryList,
  deriveCrossRepositoryNotes,
  describeCrossRepositoryNote,
  findCrossRepositoryRowForReference,
  resolveCrossRepositorySelectedKey,
  type CrossRepositoryAnswerState,
  type CrossRepositoryEnvironment,
} from "./crossRepositoryList.logic";

const STUDIO = "env-studio" as EnvironmentId;
const BUILD = "env-build" as EnvironmentId;

function option(
  environmentId: EnvironmentId,
  projectId: string,
  remote: string | null,
  representative = false,
): ProjectCheckoutOption {
  return {
    key: `${environmentId}\u0000${projectId}`,
    environmentId,
    projectId: projectId as ProjectId,
    cwd: `/${environmentId}/${projectId}`,
    name: projectId,
    environmentLabel: null,
    customAvatarContentHash: null,
    repositoryKey: `repo:${projectId}`,
    isRepresentative: representative,
    repositoryRemoteUrl: remote,
    repositoryProvider: "github",
  };
}

const checkouts = [
  option(STUDIO, "app", "git@github.com:acme/app.git", true),
  option(BUILD, "app", "https://github.com/acme/app.git"),
  option(BUILD, "api", "https://github.com/acme/api", true),
  option(STUDIO, "scratch", null, true),
];

function failing(): ReadonlyArray<SourceControlCheckRollupItem> {
  return [
    {
      kind: "check-run",
      name: "ci",
      status: Option.some("COMPLETED"),
      conclusion: Option.some("FAILURE"),
      url: Option.none(),
      startedAt: Option.none(),
      completedAt: Option.none(),
    },
  ];
}

function entry(
  repositoryKey: string,
  number: number,
  involvements: ReadonlyArray<ChangeRequestInvolvement>,
  overrides: Partial<ChangeRequest> = {},
) {
  return {
    changeRequest: {
      provider: "github",
      number,
      title: `Change ${number}`,
      url: `https://${repositoryKey}/pull/${number}`,
      baseRefName: "main",
      headRefName: `feature/${number}`,
      state: "open",
      updatedAt: Option.some(DateTime.makeUnsafe("2026-10-01T10:00:00Z")),
      author: "octocat",
      ...overrides,
    } satisfies ChangeRequest,
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

function rowsFrom(
  answers: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly result: SourceControlInvolvedChangeRequestsResult;
  }>,
  readable: ReadonlyArray<EnvironmentId> = [STUDIO, BUILD],
) {
  return attachCrossRepositoryCheckouts({
    rows: mergeCrossRepositoryChangeRequests(answers),
    checkouts,
    readable: new Set(readable),
  });
}

describe("attachCrossRepositoryCheckouts", () => {
  it("opens a row through a checkout on a node that reported it", () => {
    const rows = rowsFrom([
      { environmentId: BUILD, result: result([entry("github.com/acme/app", 12, ["authored"])]) },
    ]);
    expect(rows.get("github.com/acme/app#12")?.checkout?.environmentId).toBe(BUILD);
  });

  it("falls back to a readable node, then the representative, and to nothing outside Ryco", () => {
    const rows = rowsFrom(
      [
        {
          environmentId: STUDIO,
          result: result([
            entry("github.com/acme/api", 3, ["review-requested"]),
            entry("github.com/acme/elsewhere", 4, ["review-requested"]),
          ]),
        },
      ],
      [STUDIO],
    );
    expect(rows.get("github.com/acme/api#3")?.checkout?.key).toBe(`${BUILD}\u0000api`);
    expect(rows.get("github.com/acme/elsewhere#4")?.checkout).toBeNull();
  });

  it("opens a row through a checkout whose remote uses an SSH host alias", () => {
    const aliased = [option(STUDIO, "work", "git@github.com-work:acme/work.git", true)];
    const answers = [
      {
        environmentId: STUDIO,
        result: result(
          [entry("github.com/acme/work", 12, ["review-requested"])],
          [
            {
              scope: "host",
              provider: "github",
              name: "github.com",
              checkoutHost: "github.com-work",
              status: "ok",
              truncated: false,
            },
          ],
        ),
      },
    ];
    const hostAliases = crossRepositoryHostAliases(answers);
    const rows = attachCrossRepositoryCheckouts({
      rows: mergeCrossRepositoryChangeRequests(answers),
      checkouts: aliased,
      readable: new Set([STUDIO]),
      hostAliases,
    });
    expect(rows.get("github.com/acme/work#12")?.checkout?.key).toBe(`${STUDIO}\u0000work`);
    const list = deriveCrossRepositoryList({ rows, search: {}, foldedGroups: [] });
    expect(list.hiddenCount).toBe(0);
    expect(list.ordered.map((row) => row.rowKey)).toEqual(["github.com/acme/work#12"]);
    expect(
      resolveCrossRepositorySelectedKey({
        search: { env: STUDIO, project: "work", pr: 12 },
        rows: list.byKey,
        checkouts: aliased,
        hostAliases,
      }),
    ).toBe("github.com/acme/work#12");
  });
});

describe("deriveCrossRepositoryList", () => {
  const rows = rowsFrom([
    {
      environmentId: STUDIO,
      result: result([
        entry("github.com/acme/app", 12, ["review-requested"], { author: "alice" }),
        entry("github.com/acme/app", 13, ["authored"], {
          checkRollup: failing(),
          labels: [{ name: "bug" }],
        }),
        entry("github.com/acme/elsewhere", 1, ["review-requested"]),
      ]),
    },
    {
      environmentId: BUILD,
      result: result([entry("github.com/acme/api", 12, ["authored"])]),
    },
  ]);

  it("groups by each row's involvement and leaves out repositories not in Ryco", () => {
    const list = deriveCrossRepositoryList({ rows, search: {}, foldedGroups: [] });
    expect(list.groups.map((group) => [group.key, group.entries.map((row) => row.rowKey)])).toEqual(
      [
        ["needs-your-review", ["github.com/acme/app#12"]],
        ["yours", ["github.com/acme/api#12", "github.com/acme/app#13"]],
      ],
    );
    expect(list.hiddenCount).toBe(1);
    expect(list.labels.map((label) => label.name)).toEqual(["bug"]);
    expect([...list.byKey.keys()]).not.toContain("github.com/acme/elsewhere#1");
  });

  it("filters by only, label and query, and folds groups out of J/K order", () => {
    const keys = (search: Parameters<typeof deriveCrossRepositoryList>[0]["search"]) =>
      deriveCrossRepositoryList({ rows, search, foldedGroups: [] }).ordered.map(
        (row) => row.rowKey,
      );
    expect(keys({ only: "review" })).toEqual(["github.com/acme/app#12"]);
    expect(keys({ only: "mine" })).toEqual(["github.com/acme/api#12", "github.com/acme/app#13"]);
    expect(keys({ only: "failing" })).toEqual(["github.com/acme/app#13"]);
    expect(keys({ label: ["bug"] })).toEqual(["github.com/acme/app#13"]);
    expect(keys({ q: "Change 13" })).toEqual(["github.com/acme/app#13"]);
    expect(
      deriveCrossRepositoryList({ rows, search: {}, foldedGroups: ["yours"] }).ordered.map(
        (row) => row.rowKey,
      ),
    ).toEqual(["github.com/acme/app#12"]);
  });

  it("drops a merged row a second node still reports as open", () => {
    const stale = mergeCrossRepositoryChangeRequests([
      { environmentId: STUDIO, result: result([entry("github.com/acme/app", 12, ["authored"])]) },
      { environmentId: BUILD, result: result([entry("github.com/acme/app", 12, ["authored"])]) },
    ]);
    const detail = {
      ...entry("github.com/acme/app", 12, ["authored"], {
        state: "merged",
        updatedAt: Option.some(DateTime.makeUnsafe("2026-10-01T10:05:00Z")),
      }).changeRequest,
      body: "",
      comments: [],
      truncated: false,
    } satisfies SourceControlChangeRequestDetail;
    const overlay = crossRepositoryOverlayFromDetail(detail, 1_000);
    if (overlay === null) throw new Error("no overlay");
    const overlaid = attachCrossRepositoryCheckouts({
      rows: applyCrossRepositoryOverlays(stale, [overlay], 2_000),
      checkouts,
      readable: new Set([STUDIO, BUILD]),
    });
    expect(
      deriveCrossRepositoryList({ rows: overlaid, search: {}, foldedGroups: [] }).ordered,
    ).toEqual([]);
    // Expired, or older than what the nodes report: the answer stands.
    expect(applyCrossRepositoryOverlays(stale, [overlay], 1_000 + 4 * 60_000)).toBe(stale);
    const newer = mergeCrossRepositoryChangeRequests([
      {
        environmentId: BUILD,
        result: result([
          entry("github.com/acme/app", 12, ["authored"], {
            updatedAt: Option.some(DateTime.makeUnsafe("2026-10-01T11:00:00Z")),
          }),
        ]),
      },
    ]);
    expect(applyCrossRepositoryOverlays(newer, [overlay], 2_000)).toBe(newer);
  });

  it("never erases a row's update time with a detail that has none", () => {
    const stale = mergeCrossRepositoryChangeRequests([
      { environmentId: BUILD, result: result([entry("github.com/acme/app", 12, ["authored"])]) },
    ]);
    const detail = {
      ...entry("github.com/acme/app", 12, ["authored"], {
        state: "closed",
        updatedAt: Option.none(),
      }).changeRequest,
      body: "",
      comments: [],
      truncated: false,
    } satisfies SourceControlChangeRequestDetail;
    const overlay = crossRepositoryOverlayFromDetail(detail, 1_000);
    if (overlay === null) throw new Error("no overlay");
    const row = applyCrossRepositoryOverlays(stale, [overlay], 2_000).get("github.com/acme/app#12");
    expect(row?.state).toBe("closed");
    expect(Option.isSome(row?.updatedAt ?? Option.none())).toBe(true);
  });
});

describe("resolveCrossRepositorySelectedKey", () => {
  it("selects the URL's number in the URL's checkout's repository", () => {
    const rows = rowsFrom([
      {
        environmentId: STUDIO,
        result: result([
          entry("github.com/acme/app", 12, ["authored"]),
          entry("github.com/acme/api", 12, ["authored"]),
        ]),
      },
    ]);
    expect(
      resolveCrossRepositorySelectedKey({
        search: { env: BUILD, project: "api", pr: 12 },
        rows,
        checkouts,
      }),
    ).toBe("github.com/acme/api#12");
    expect(
      resolveCrossRepositorySelectedKey({
        search: { env: STUDIO, project: "app", pr: 12 },
        rows,
        checkouts,
      }),
    ).toBe("github.com/acme/app#12");
    expect(
      resolveCrossRepositorySelectedKey({ search: { env: STUDIO, pr: 12 }, rows, checkouts }),
    ).toBeNull();
  });
});

describe("findCrossRepositoryRowForReference", () => {
  it("finds a pasted link's row, and a number only when one row has it", () => {
    const rows = rowsFrom([
      {
        environmentId: STUDIO,
        result: result([
          entry("github.com/acme/app", 12, ["authored"]),
          entry("github.com/acme/api", 12, ["authored"]),
          entry("github.com/acme/api", 7, ["authored"]),
        ]),
      },
    ]);
    expect(
      findCrossRepositoryRowForReference(rows.values(), {
        kind: "url",
        number: 12,
        url: "https://github.com/Acme/API/pull/12/files",
      })?.rowKey,
    ).toBe("github.com/acme/api#12");
    expect(
      findCrossRepositoryRowForReference(rows.values(), { kind: "number", number: 12 }),
    ).toBeNull();
    expect(
      findCrossRepositoryRowForReference(rows.values(), { kind: "number", number: 7 })?.rowKey,
    ).toBe("github.com/acme/api#7");
  });
});

describe("deriveCrossRepositoryNotes", () => {
  function environment(
    environmentId: EnvironmentId,
    label: string,
    overrides: Partial<CrossRepositoryEnvironment> = {},
  ): CrossRepositoryEnvironment {
    return { environmentId, label, sync: "synced", admitted: true, capable: true, ...overrides };
  }
  const target = (
    environmentId: EnvironmentId,
    sources: CrossRepositoryReadTarget["sources"],
    omittedCwds = 0,
    groups: CrossRepositoryReadTarget["groups"] = [],
  ): CrossRepositoryReadTarget => ({
    environmentId,
    sources,
    cwds: groups.length > 0 ? groups.flatMap((group) => group.cwds) : ["/x"],
    omittedCwds,
    groups,
  });
  const state = (
    data: SourceControlInvolvedChangeRequestsResult | null,
    error: Error | null = null,
  ) => ({ data, error, isLoading: false, isFetching: false }) satisfies CrossRepositoryAnswerState;
  const hostSource = (
    name: string,
    overrides: Partial<SourceControlInvolvedChangeRequestsSource> = {},
  ): SourceControlInvolvedChangeRequestsSource => ({
    scope: "host",
    provider: "github",
    name,
    status: "ok",
    truncated: false,
    ...overrides,
  });

  it("says what could not be read, most actionable first", () => {
    const notes = deriveCrossRepositoryNotes({
      environments: [
        environment(STUDIO, "Studio"),
        environment(BUILD, "Build box"),
        environment("env-old" as EnvironmentId, "M4", { capable: false }),
        environment("env-away" as EnvironmentId, "Laptop", { sync: "offline" }),
        environment("env-closed" as EnvironmentId, "Mini", { admitted: false }),
        environment("env-late" as EnvironmentId, "Late", { sync: "syncing" }),
        environment("env-gone" as EnvironmentId, "Old Mac", { sync: "unknown" }),
      ],
      targets: [target(STUDIO, "hosts"), target(BUILD, "hosts"), target(BUILD, "all", 6)],
      states: [
        state(
          result(
            [],
            [hostSource("github.com", { viewerLogin: "octocat", truncated: true, skippedRows: 2 })],
          ),
        ),
        state(result([], [hostSource("github.com", { viewerLogin: "bot-x" })])),
        state(
          result(
            [],
            [
              {
                scope: "repository",
                provider: "gitlab",
                name: "acme/tools",
                status: "failed",
                truncated: false,
                message: "glab is not installed.",
              },
              {
                scope: "repository",
                provider: "gitlab",
                name: "acme/infra",
                status: "loading",
                truncated: false,
              },
            ],
          ),
        ),
      ],
      hiddenCount: 3,
    });
    expect(notes.map(describeCrossRepositoryNote)).toEqual([
      "Couldn’t read acme/tools on Build box: glab is not installed.",
      "Laptop isn’t connected",
      "Open Mini to include its repositories",
      "Old Mac isn’t connected",
      "Update Ryco on M4 to include its repositories",
      "Studio reads github.com as octocat",
      "Build box reads github.com as bot-x",
      "Still reading pull requests on Late…",
      "Still reading acme/infra on Build box…",
      "Showing the 100 most recently updated from github.com",
      "2 pull requests on github.com are in organizations this login can’t read",
      "6 more repositories on Build box weren’t read",
      "3 more in repositories not added to Ryco",
    ]);
  });

  it("names no node when one is read, and reports a node whose read failed", () => {
    const notes = deriveCrossRepositoryNotes({
      environments: [environment(STUDIO, "Studio")],
      targets: [target(STUDIO, "hosts")],
      states: [state(null, new Error("Not signed in\nmore detail"))],
      hiddenCount: 0,
    });
    expect(notes.map(describeCrossRepositoryNote)).toEqual([
      "Couldn’t read pull requests: Not signed in",
    ]);
    expect(crossRepositoryNotesMissRepositories(notes)).toBe(true);
  });

  it("says when a node could not open any checkout of a host or repository", () => {
    const notes = deriveCrossRepositoryNotes({
      environments: [environment(STUDIO, "Studio")],
      targets: [
        target(STUDIO, "hosts", 0, [
          { name: "github.com", cwds: ["/a-old", "/b-gone"] },
          // One checkout still opens: the host was read.
          { name: "ghe.example.com", cwds: ["/c-old", "/d-app"] },
        ]),
        target(STUDIO, "all", 0, [
          { name: "tools", cwds: ["/tools"] },
          { name: "infra", cwds: ["/infra"] },
        ]),
      ],
      states: [
        state({
          ...result([], [hostSource("ghe.example.com")]),
          skippedCwds: ["/a-old", "/b-gone", "/c-old"],
        }),
        state({ ...result([]), skippedCwds: ["/tools", "/scratch"] }),
      ],
      hiddenCount: 0,
    });
    expect(notes.map(describeCrossRepositoryNote)).toEqual([
      "Couldn’t read github.com: None of its checkouts could be opened.",
      "Couldn’t read tools: Its checkout couldn’t be opened.",
    ]);
    // An empty list is not the whole answer.
    expect(crossRepositoryNotesMissRepositories(notes)).toBe(true);
  });

  it("says a node still connecting is not read yet", () => {
    const notes = deriveCrossRepositoryNotes({
      environments: [
        environment(STUDIO, "Studio"),
        environment(BUILD, "Build box", { sync: "syncing" }),
      ],
      targets: [target(STUDIO, "hosts")],
      states: [state(result([]))],
      hiddenCount: 0,
    });
    expect(notes.map(describeCrossRepositoryNote)).toEqual([
      "Still reading pull requests on Build box…",
    ]);
    expect(crossRepositoryNotesMissRepositories(notes)).toBe(true);
  });

  it("says when a node's answer dropped its oldest rows", () => {
    const notes = deriveCrossRepositoryNotes({
      environments: [environment(STUDIO, "Studio"), environment(BUILD, "Build box")],
      targets: [target(STUDIO, "hosts"), target(BUILD, "hosts")],
      states: [state({ ...result([]), truncated: true }), state(result([]))],
      hiddenCount: 2,
    });
    expect(notes.map(describeCrossRepositoryNote)).toEqual([
      "Some older pull requests on Studio were left out",
      "2 more in repositories not added to Ryco",
    ]);
    // Nothing failed or went unread: an empty list is the whole answer.
    expect(crossRepositoryNotesMissRepositories(notes)).toBe(false);
  });
});
