import type {
  AtlassianConnectionId,
  AtlassianConnectionSummary,
  AtlassianProjectLink,
  ProjectId,
  RepositoryIdentity,
} from "@ryco/contracts";
import { DateTime } from "effect";
import { describe, expect, it } from "vite-plus/test";
import {
  ATLASSIAN_NONE_VALUE,
  atlassianConnectionsFor,
  buildJiraProjectLinkInput,
  buildJiraProjectUnlinkInput,
  buildProjectAtlassianLinkSaveInput,
  isJiraLinked,
  nullableAtlassianConnectionId,
  projectAtlassianLinkFields,
} from "./atlassianLink.ts";

const projectId = "project-1" as ProjectId;
const jiraConnectionId = "atl-jira" as AtlassianConnectionId;
const bitbucketConnectionId = "atl-bitbucket" as AtlassianConnectionId;

const existing = {
  projectId,
  jiraConnectionId,
  bitbucketConnectionId,
  jiraCloudId: "cloud-1",
  jiraSiteUrl: "https://ryco.atlassian.net",
  jiraProjectKeys: ["KAN"],
  bitbucketWorkspace: "ryco",
  bitbucketRepoSlug: "app",
  defaultIssueTypeName: "Story",
  branchNameTemplate: "{issueKey}-{titleSlug}",
  commitMessageTemplate: "{issueKey}: {summary}",
  pullRequestTitleTemplate: "{issueKey}: {summary}",
  smartLinkingEnabled: true,
  autoAttachWorkItems: true,
  createdAt: DateTime.fromDateUnsafe(new Date("2026-01-01T00:00:00.000Z")),
  updatedAt: DateTime.fromDateUnsafe(new Date("2026-01-02T00:00:00.000Z")),
} satisfies AtlassianProjectLink;

describe("atlassianProjectLinks", () => {
  it("builds a Jira link while preserving Bitbucket project settings", () => {
    const input = buildJiraProjectLinkInput({
      projectId,
      existing,
      jiraConnectionId,
      jiraSiteUrl: null,
      jiraProjectKeys: ["APP"],
    });

    expect(input.jiraConnectionId).toBe(jiraConnectionId);
    expect(input.jiraProjectKeys).toEqual(["APP"]);
    expect(input.bitbucketConnectionId).toBe(bitbucketConnectionId);
    expect(input.bitbucketWorkspace).toBe("ryco");
    expect(input.bitbucketRepoSlug).toBe("app");
    expect(input.branchNameTemplate).toBe("{issueKey}-{titleSlug}");
  });

  it("unlinks only Jira fields from an existing project link", () => {
    const input = buildJiraProjectUnlinkInput({ projectId, existing });

    expect(input.jiraConnectionId).toBeNull();
    expect(input.jiraCloudId).toBeNull();
    expect(input.jiraSiteUrl).toBeNull();
    expect(input.jiraProjectKeys).toEqual([]);
    expect(input.bitbucketConnectionId).toBe(bitbucketConnectionId);
    expect(input.bitbucketWorkspace).toBe("ryco");
    expect(input.bitbucketRepoSlug).toBe("app");
  });
});

describe("project Atlassian link form", () => {
  const connection = (connectionId: string, products: Array<"jira" | "bitbucket">) =>
    ({ connectionId, status: "connected", products }) as unknown as AtlassianConnectionSummary;

  it("lists the connected connections of one product", () => {
    const connections = [
      connection("atl-jira", ["jira"]),
      { ...connection("atl-old", ["jira"]), status: "revoked" } as AtlassianConnectionSummary,
      connection("atl-both", ["jira", "bitbucket"]),
    ];
    expect(atlassianConnectionsFor(connections, "jira").map((c) => c.connectionId)).toEqual([
      "atl-jira",
      "atl-both",
    ]);
    expect(atlassianConnectionsFor(undefined, "bitbucket")).toEqual([]);
  });

  it("seeds an unlinked project from the first connections and its Bitbucket remote", () => {
    const fields = projectAtlassianLinkFields({
      link: null,
      jiraConnections: [connection("atl-jira", ["jira"])],
      bitbucketConnections: [],
      repositoryIdentity: {
        provider: "bitbucket",
        owner: "ryco",
        name: "app",
      } as unknown as RepositoryIdentity,
    });
    expect(fields).toMatchObject({
      jiraConnectionValue: "atl-jira",
      bitbucketConnectionValue: ATLASSIAN_NONE_VALUE,
      bitbucketWorkspace: "ryco",
      bitbucketRepoSlug: "app",
      branchNameTemplate: "{issueKey}-{titleSlug}",
      smartLinkingEnabled: true,
    });
  });

  it("seeds a linked project from its saved link", () => {
    expect(
      projectAtlassianLinkFields({
        link: existing,
        jiraConnections: [],
        bitbucketConnections: [],
        repositoryIdentity: null,
      }),
    ).toMatchObject({ jiraConnectionValue: jiraConnectionId, jiraProjectKeys: "KAN" });
    expect(isJiraLinked(existing)).toBe(true);
    expect(isJiraLinked({ ...existing, jiraProjectKeys: [] })).toBe(false);
    expect(isJiraLinked(null)).toBe(false);
  });

  it("saves trimmed fields and refuses empty templates", () => {
    const fields = projectAtlassianLinkFields({
      link: existing,
      jiraConnections: [],
      bitbucketConnections: [],
      repositoryIdentity: null,
    });
    const input = buildProjectAtlassianLinkSaveInput({
      projectId,
      existing,
      fields: { ...fields, jiraProjectKeys: "kan, web  api", bitbucketWorkspace: "  " },
    });
    expect(input.jiraProjectKeys).toEqual(["KAN", "WEB", "API"]);
    expect(input.bitbucketWorkspace).toBeNull();
    expect(input.jiraCloudId).toBe("cloud-1");
    expect(input.jiraSiteUrl).toBeNull();
    expect(() =>
      buildProjectAtlassianLinkSaveInput({
        projectId,
        existing,
        fields: { ...fields, branchNameTemplate: " " },
      }),
    ).toThrow("templates cannot be empty");
    expect(nullableAtlassianConnectionId(ATLASSIAN_NONE_VALUE)).toBeNull();
  });
});
